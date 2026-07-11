import fs from 'node:fs';
import { Transform } from 'node:stream';
import { google } from 'googleapis';
import { config } from '../config.js';
import { query } from '../db.js';
import { encrypt, decrypt } from '../lib/secrets.js';
import { log } from '../lib/logger.js';

export const OAUTH_SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube',
];

export const redirectUri = () => `${config.publicUrl}/oauth/youtube/callback`;

export async function getChannels() {
  const { rows } = await query('SELECT * FROM youtube_channels ORDER BY id');
  return rows;
}

export async function getChannelById(id) {
  const { rows } = await query('SELECT * FROM youtube_channels WHERE id = $1', [id]);
  return rows[0] || null;
}

// The OAuth client is built strictly from ONE channel row — there is no global
// token anywhere. The uploader always receives the routed channel's row.
export function buildOAuthClient(channelRow) {
  const client = new google.auth.OAuth2(
    channelRow.oauth_client_id,
    decrypt(channelRow.oauth_client_secret),
    redirectUri(),
  );
  if (channelRow.refresh_token) {
    client.setCredentials({ refresh_token: decrypt(channelRow.refresh_token) });
  }
  return client;
}

export function getAuthUrl(channelRow, state) {
  return buildOAuthClient(channelRow).generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // always issue a refresh token
    scope: OAUTH_SCOPES,
    state,
  });
}

export async function handleOAuthCallback(channelRow, code) {
  const client = buildOAuthClient(channelRow);
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error('Google did not return a refresh token. Remove prior access at myaccount.google.com/permissions and try again.');
  }
  client.setCredentials(tokens);
  const yt = google.youtube({ version: 'v3', auth: client });
  const { data } = await yt.channels.list({ part: 'snippet', mine: true });
  const ch = data.items?.[0];
  if (!ch) throw new Error('No YouTube channel found for the account you authorized.');
  await query(
    `UPDATE youtube_channels
     SET refresh_token = $1, channel_id = $2, channel_handle = $3, status = 'connected'
     WHERE id = $4`,
    [encrypt(tokens.refresh_token), ch.id, ch.snippet?.customUrl || null, channelRow.id],
  );
  log(`youtube channel connected: ${ch.snippet?.title} (${ch.id}) -> row ${channelRow.id}`);
  return { channelId: ch.id, title: ch.snippet?.title, handle: ch.snippet?.customUrl };
}

export class QuotaExceededError extends Error {
  constructor(message) {
    super(message);
    this.name = 'QuotaExceededError';
    this.quotaExceeded = true;
  }
}

function throwIfQuota(status, bodyText) {
  if (/quotaExceeded|uploadLimitExceeded|rateLimitExceeded/.test(bodyText)) {
    throw new QuotaExceededError(`YouTube quota/upload limit hit (${status}): ${bodyText.slice(0, 300)}`);
  }
}

async function putChunk(sessionUrl, token, filePath, offset, size, onProgress) {
  const fileStream = fs.createReadStream(filePath, { start: offset });
  let body = fileStream;
  if (onProgress) {
    let sent = offset;
    const counter = new Transform({
      transform(chunk, _enc, cb) {
        sent += chunk.length;
        onProgress(sent, size);
        cb(null, chunk);
      },
    });
    body = fileStream.pipe(counter);
  }
  return fetch(sessionUrl, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Length': String(size - offset),
      'Content-Range': `bytes ${offset}-${size - 1}/${size}`,
    },
    body,
    duplex: 'half',
  });
}

async function queryResumeOffset(sessionUrl, token, size) {
  const res = await fetch(sessionUrl, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Length': '0',
      'Content-Range': `bytes */${size}`,
    },
  });
  if (res.status === 308) {
    const range = res.headers.get('range'); // "bytes=0-12345"
    if (range) return Number(range.split('-')[1]) + 1;
    return 0;
  }
  if (res.ok) return size; // already complete
  return 0;
}

// True resumable upload: init a session, stream the file, and on transient
// failure query the session for the confirmed offset and resume from there.
export async function uploadVideo(channelRow, filePath, { title, description = '', privacy = 'unlisted', onProgress }) {
  const auth = buildOAuthClient(channelRow);
  const { token } = await auth.getAccessToken();
  const size = fs.statSync(filePath).size;

  const initRes = await fetch(
    'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Length': String(size),
        'X-Upload-Content-Type': 'video/mp4',
      },
      body: JSON.stringify({
        snippet: { title: String(title).slice(0, 100), description },
        status: { privacyStatus: privacy, selfDeclaredMadeForKids: false },
      }),
    },
  );
  if (!initRes.ok) {
    const text = await initRes.text();
    throwIfQuota(initRes.status, text);
    throw new Error(`YouTube upload init failed (${initRes.status}): ${text.slice(0, 300)}`);
  }
  const sessionUrl = initRes.headers.get('location');
  if (!sessionUrl) throw new Error('YouTube upload init returned no session URL');

  let offset = 0;
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const res = await putChunk(sessionUrl, token, filePath, offset, size, onProgress);
      if (res.ok) {
        const data = await res.json();
        if (!data.id) throw new Error('YouTube upload finished without a video id');
        // Authoritative confirmation: ask YouTube for the video's own uploadStatus
        // so "complete" means YouTube itself acknowledges the bytes, not just our
        // HTTP response. (videos.list costs 1 quota unit vs 1600 for the insert.)
        let uploadStatus = data.status?.uploadStatus || null;
        try {
          const yt = google.youtube({ version: 'v3', auth });
          const chk = await yt.videos.list({ part: 'status,processingDetails', id: data.id });
          uploadStatus = chk.data.items?.[0]?.status?.uploadStatus || uploadStatus;
        } catch (e) {
          log(`youtube upload confirm check failed (non-fatal): ${e.message}`);
        }
        if (uploadStatus === 'rejected' || uploadStatus === 'failed') {
          throw new Error(`YouTube did not accept the upload (status: ${uploadStatus})`);
        }
        log(`youtube upload complete: ${data.id} (${size} bytes, status: ${uploadStatus || 'unknown'})`);
        return { videoId: data.id, url: `https://youtu.be/${data.id}`, uploadStatus };
      }
      const text = await res.text();
      throwIfQuota(res.status, text);
      if (res.status === 308 || res.status >= 500) {
        offset = await queryResumeOffset(sessionUrl, token, size);
        log(`youtube upload interrupted (${res.status}), resuming at byte ${offset} (attempt ${attempt})`);
        continue;
      }
      throw new Error(`YouTube upload failed (${res.status}): ${text.slice(0, 300)}`);
    } catch (err) {
      if (err.quotaExceeded || attempt === 6) throw err;
      offset = await queryResumeOffset(sessionUrl, token, size).catch(() => offset);
      log(`youtube upload error (${err.message}), resuming at byte ${offset} (attempt ${attempt})`);
      await new Promise((r) => setTimeout(r, attempt * 3000));
    }
  }
  throw new Error('YouTube upload failed after retries');
}

// Find a playlist by exact title on the channel, create it (unlisted) if missing.
export async function ensurePlaylist(channelRow, playlistName) {
  const auth = buildOAuthClient(channelRow);
  const yt = google.youtube({ version: 'v3', auth });
  let pageToken;
  do {
    const { data } = await yt.playlists.list({ part: 'snippet', mine: true, maxResults: 50, pageToken });
    const hit = data.items?.find((p) => p.snippet?.title === playlistName);
    if (hit) return hit.id;
    pageToken = data.nextPageToken;
  } while (pageToken);
  const { data: created } = await yt.playlists.insert({
    part: 'snippet,status',
    requestBody: { snippet: { title: playlistName }, status: { privacyStatus: 'unlisted' } },
  });
  log(`playlist created: "${playlistName}" (${created.id})`);
  return created.id;
}

// Read a video's current title/description (for the edit-later UI).
export async function getVideoSnippet(channelRow, videoId) {
  const yt = google.youtube({ version: 'v3', auth: buildOAuthClient(channelRow) });
  const { data } = await yt.videos.list({ part: 'snippet', id: videoId });
  const s = data.items?.[0]?.snippet;
  if (!s) throw new Error('Video not found on this channel.');
  return { title: s.title, description: s.description || '', categoryId: s.categoryId || '22' };
}

// Update title/description. videos.update requires categoryId on the snippet,
// so preserve the current one.
export async function updateVideoSnippet(channelRow, videoId, { title, description }) {
  const yt = google.youtube({ version: 'v3', auth: buildOAuthClient(channelRow) });
  const current = await getVideoSnippet(channelRow, videoId);
  await yt.videos.update({
    part: 'snippet',
    requestBody: {
      id: videoId,
      snippet: {
        title: (title ?? current.title).slice(0, 100),
        description: description ?? current.description,
        categoryId: current.categoryId,
      },
    },
  });
}

export async function addToPlaylist(channelRow, playlistId, videoId) {
  const auth = buildOAuthClient(channelRow);
  const yt = google.youtube({ version: 'v3', auth });
  await yt.playlistItems.insert({
    part: 'snippet',
    requestBody: {
      snippet: { playlistId, resourceId: { kind: 'youtube#video', videoId } },
    },
  });
}
