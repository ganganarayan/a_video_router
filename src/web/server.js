import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import {
  requirePageAuth, requireSessionOnly, authenticate, setOwnPassword,
  setSessionCookie, clearSessionCookie, resetPassword, resetEnabled,
  resolveTenant, requireTenant, requireSuperAdmin, getOptionalUser,
} from './auth.js';
import { apiRouter } from './routes/api.js';
import { oauthRouter } from './routes/oauth.js';
import { dbadminRouter } from './routes/dbadmin.js';
import * as billing from '../billing.js';
import { getConfigValue } from '../db.js';
import { LEGAL, LEGAL_ORDER, LAST_UPDATED } from './content/legal.js';

const LEGAL_LABELS = { privacy: 'Privacy', terms: 'Terms', refund: 'Refund', shipping: 'Shipping', contact: 'Contact us' };
const LEGAL_LINKS = LEGAL_ORDER.map((slug) => ({ href: `/${slug}`, label: LEGAL_LABELS[slug] }));

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createServer() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.use('/public', express.static(path.join(__dirname, 'public')));
  // Capture the raw body so the Razorpay webhook can verify its HMAC signature.
  app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser());

  app.get('/health', (_req, res) => res.json({ ok: true }));

  // Self-service DB backup/restore (gated by PASSWORD_RESET_KEY).
  app.use('/dbadmin', dbadminRouter);

  app.get('/login', (_req, res) => res.render('login', { error: null, resetEnabled: resetEnabled() }));
  app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    const result = await authenticate(email, password);
    if (result.ok) {
      setSessionCookie(res, result.email);
      return res.redirect(result.mustSetPassword ? '/set-password' : '/');
    }
    res.status(401).render('login', { error: 'Invalid email or password.', resetEnabled: resetEnabled() });
  });

  // First-login / forced password set. Requires a valid session; tolerant of the
  // must-change flag (that's exactly who lands here).
  app.get('/set-password', requireSessionOnly, (req, res) =>
    res.render('set-password', { error: null, email: req.user.email }));
  app.post('/set-password', requireSessionOnly, async (req, res) => {
    const result = await setOwnPassword(req.user.email, req.body.new_password);
    if (!result.ok) {
      return res.status(400).render('set-password', { error: result.error, email: req.user.email });
    }
    res.redirect('/runs');
  });

  app.get('/reset', (_req, res) => res.render('reset', { error: null, ok: null, enabled: resetEnabled() }));
  app.post('/reset', async (req, res) => {
    const { email, key, new_password } = req.body;
    const result = await resetPassword(email, key, new_password);
    if (!result.ok) {
      return res.status(400).render('reset', { error: result.error, ok: null, enabled: resetEnabled() });
    }
    res.render('reset', { error: null, ok: `Password reset for ${result.email}. You can now log in.`, enabled: resetEnabled() });
  });
  app.post('/logout', (_req, res) => {
    clearSessionCookie(res);
    res.redirect('/login');
  });

  // Public marketing landing page at the root. Logged-in users are sent into the
  // app; visitors see the sales page. The hero video URL is pulled live from
  // app_config (landing_video_url) so it can be swapped without touching the page.
  app.get('/', async (req, res, next) => {
    try {
      const user = await getOptionalUser(req);
      if (user) return res.redirect(user.isSuperAdmin ? '/admin' : '/runs');
      const videoUrl = (await getConfigValue('landing_video_url')) || '';
      res.render('landing', { videoUrl });
    } catch (err) { next(err); }
  });

  // Public policy pages (privacy / terms / refund / shipping / contact), linked in the
  // footer and required by the payment gateway. No auth — visible to visitors and users alike.
  for (const slug of LEGAL_ORDER) {
    app.get(`/${slug}`, (_req, res) => {
      const doc = LEGAL[slug];
      res.render('legal', { title: doc.title, bodyHtml: doc.html, lastUpdated: LAST_UPDATED, links: LEGAL_LINKS });
    });
  }

  // Super-admin console: all tenants + impersonation.
  app.get('/admin', requirePageAuth, resolveTenant, requireSuperAdmin,
    (req, res) => res.render('admin', { page: 'admin', title: 'Admin', user: req.user }));

  const pages = { connections: 'Connections', routing: 'Routing', runs: 'Runs', sources: 'Sources', logs: 'Logs', schedules: 'Schedules', team: 'Team', billing: 'Billing', settings: 'Settings', help: 'Help' };
  for (const [route, title] of Object.entries(pages)) {
    app.get(`/${route}`, requirePageAuth, resolveTenant, requireTenant,
      (req, res) => res.render(route, { page: route, title, user: req.user }));
  }

  // Razorpay webhook — unauthenticated (Razorpay posts here), verified by HMAC
  // signature over the raw body. Mounted before the auth-gated /api router.
  app.post('/api/billing/webhook', async (req, res) => {
    try {
      const raw = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body || {});
      const out = await billing.handleWebhook(raw, req.headers['x-razorpay-signature']);
      res.json(out);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.use('/api', apiRouter);
  app.use('/oauth', oauthRouter);

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    console.error(new Date().toISOString(), 'ERROR web:', err);
    res.status(err.status || 500).json({ error: err.message || 'internal error' });
  });

  return app;
}
