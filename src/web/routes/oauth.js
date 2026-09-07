import express from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../../config.js';
import {
  requirePageAuth, resolveTenant, requireTenant,
  signInWithGoogle, setSessionCookie, recordLogin,
} from '../auth.js';
import { getChannelById, getAuthUrl, handleOAuthCallback } from '../../providers/youtube.js';
import { getZoomAuthUrl, handleZoomOAuthCallback } from '../../providers/zoom.js';
import { getConfigValue } from '../../db.js';
import { signupAttribution } from '../track.js';
import { decrypt } from '../../lib/secrets.js';
import * as meta from '../../lib/meta.js';
import { logError } from '../../lib/logger.js';

export const oauthRouter = express.Router();

// ---- Google Sign-In (self-serve signup / login) ----
const GOOGLE_REDIRECT = () => `${config.publicUrl}/oauth/google/callback`;

async function googleConfig() {
  const clientId = (await getConfigValue('google_client_id')) || '';
  const clientSecret = decrypt((await getConfigValue('google_client_secret')) || '') || '';
  return { clientId, clientSecret };
}

oauthRouter.get('/google/start', async (req, res) => {
  try {
    const { clientId } = await googleConfig();
    if (!clientId) return res.redirect('/register');
    const state = jwt.sign({ g: 1 }, config.jwtSecret, { expiresIn: '15m' });
    const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
      client_id: clientId,
      redirect_uri: GOOGLE_REDIRECT(),
      response_type: 'code',
      scope: 'openid email profile',
      access_type: 'online',
      prompt: 'select_account',
      state,
    }).toString();
    res.redirect(url);
  } catch (err) {
    logError('google oauth start:', err.message);
    res.redirect('/register');
  }
});

oauthRouter.get('/google/callback', async (req, res) => {
  const { code, state, error } = req.query;
  try {
    if (error) throw new Error(`Google returned: ${error}`);
    if (!code || !state) throw new Error('Missing code/state');
    jwt.verify(String(state), config.jwtSecret); // CSRF guard
    const { clientId, clientSecret } = await googleConfig();
    if (!clientId || !clientSecret) throw new Error('Google sign-in is not configured.');

    // Exchange the code for tokens.
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code: String(code), client_id: clientId, client_secret: clientSecret,
        redirect_uri: GOOGLE_REDIRECT(), grant_type: 'authorization_code',
      }).toString(),
      signal: AbortSignal.timeout(8000),
    });
    const tokens = await tokenRes.json();
    if (!tokenRes.ok || !tokens.access_token) throw new Error(tokens.error_description || 'Token exchange failed.');

    // Fetch the verified profile.
    const infoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: `Bearer ${tokens.access_token}` }, signal: AbortSignal.timeout(8000),
    });
    const info = await infoRes.json();
    if (!info.email || info.email_verified === false) throw new Error('Google did not return a verified email.');

    const attribution = await signupAttribution(req);
    const result = await signInWithGoogle({ email: info.email, name: info.name || '', attribution });
    if (!result.ok) throw new Error(result.error);
    setSessionCookie(res, result.email);
    recordLogin(result.email, req.ip);
    // Fire the signup conversions only for a brand-new account.
    if (result.created) {
      meta.fireSignupConversions(req, { email: result.email, name: info.name || '',
        sourceUrl: `${config.publicUrl}/register` }).catch(() => {});
    }
    res.redirect('/runs');
  } catch (err) {
    logError('google oauth callback:', err.message);
    res.redirect(`/register?err=${encodeURIComponent(err.message)}`);
  }
});

// Start the Google consent flow for one channel row (must belong to this tenant).
oauthRouter.get('/youtube/start/:channelRowId', requirePageAuth, resolveTenant, requireTenant, async (req, res, next) => {
  try {
    const channel = await getChannelById(Number(req.params.channelRowId), req.tenantId);
    if (!channel) return res.status(404).send('Unknown channel');
    // state carries the channel row + tenant; expires quickly
    const state = jwt.sign({ ch: channel.id, t: req.tenantId }, config.jwtSecret, { expiresIn: '15m' });
    res.redirect(await getAuthUrl(channel, state));
  } catch (err) {
    next(err);
  }
});

// ---- Zoom (single platform OAuth app; client just consents) ----
oauthRouter.get('/zoom/start', requirePageAuth, resolveTenant, requireTenant, async (req, res, next) => {
  try {
    const state = jwt.sign({ z: 1, t: req.tenantId }, config.jwtSecret, { expiresIn: '15m' });
    res.redirect(await getZoomAuthUrl(state));
  } catch (err) {
    next(err);
  }
});

// Zoom redirects here (register {PUBLIC_URL}/oauth/zoom/callback on the platform app).
oauthRouter.get('/zoom/callback', async (req, res) => {
  const { code, state, error } = req.query;
  try {
    if (error) throw new Error(`Zoom returned: ${error}`);
    if (!code || !state) throw new Error('Missing code/state');
    const { t } = jwt.verify(String(state), config.jwtSecret);
    const result = await handleZoomOAuthCallback(t, String(code));
    res.redirect(`/connections?zoom=connected&email=${encodeURIComponent(result.email || '')}`);
  } catch (err) {
    logError('zoom oauth callback:', err.message);
    res.redirect(`/connections?zoom=error&message=${encodeURIComponent(err.message)}`);
  }
});

// Google redirects here (must be registered as an authorized redirect URI on
// each channel's OAuth client): {PUBLIC_URL}/oauth/youtube/callback
oauthRouter.get('/youtube/callback', async (req, res) => {
  const { code, state, error } = req.query;
  try {
    if (error) throw new Error(`Google returned: ${error}`);
    if (!code || !state) throw new Error('Missing code/state');
    const { ch, t } = jwt.verify(String(state), config.jwtSecret);
    const channel = await getChannelById(ch, t);
    if (!channel) throw new Error('Unknown channel row in state');
    const result = await handleOAuthCallback(channel, String(code));
    res.redirect(`/connections?yt=connected&title=${encodeURIComponent(result.title || '')}`);
  } catch (err) {
    logError('youtube oauth callback:', err.message);
    res.redirect(`/connections?yt=error&message=${encodeURIComponent(err.message)}`);
  }
});
