import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import {
  requirePageAuth, requireSessionOnly, authenticate, setOwnPassword,
  setSessionCookie, clearSessionCookie, resetPassword, resetEnabled,
} from './auth.js';
import { apiRouter } from './routes/api.js';
import { oauthRouter } from './routes/oauth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createServer() {
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.use('/public', express.static(path.join(__dirname, 'public')));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false }));
  app.use(cookieParser());

  app.get('/health', (_req, res) => res.json({ ok: true }));

  app.get('/login', (_req, res) => res.render('login', { error: null, resetEnabled: resetEnabled() }));
  app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    const result = await authenticate(email, password);
    if (result.ok) {
      setSessionCookie(res, result.email);
      return res.redirect(result.mustSetPassword ? '/set-password' : '/runs');
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

  app.get('/', (_req, res) => res.redirect('/runs'));
  const pages = { connections: 'Connections', routing: 'Routing', runs: 'Runs', sources: 'Sources', logs: 'Logs', schedules: 'Schedules', settings: 'Settings' };
  for (const [route, title] of Object.entries(pages)) {
    app.get(`/${route}`, requirePageAuth, (_req, res) => res.render(route, { page: route, title }));
  }

  app.use('/api', apiRouter);
  app.use('/oauth', oauthRouter);

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    console.error(new Date().toISOString(), 'ERROR web:', err);
    res.status(err.status || 500).json({ error: err.message || 'internal error' });
  });

  return app;
}
