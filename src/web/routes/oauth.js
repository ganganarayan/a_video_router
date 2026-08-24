import express from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../../config.js';
import { requirePageAuth, resolveTenant, requireTenant } from '../auth.js';
import { getChannelById, getAuthUrl, handleOAuthCallback } from '../../providers/youtube.js';
import { logError } from '../../lib/logger.js';

export const oauthRouter = express.Router();

// Start the Google consent flow for one channel row (must belong to this tenant).
oauthRouter.get('/youtube/start/:channelRowId', requirePageAuth, resolveTenant, requireTenant, async (req, res, next) => {
  try {
    const channel = await getChannelById(Number(req.params.channelRowId), req.tenantId);
    if (!channel) return res.status(404).send('Unknown channel');
    // state carries the channel row + tenant; expires quickly
    const state = jwt.sign({ ch: channel.id, t: req.tenantId }, config.jwtSecret, { expiresIn: '15m' });
    res.redirect(getAuthUrl(channel, state));
  } catch (err) {
    next(err);
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
