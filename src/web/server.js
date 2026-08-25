import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cookieParser from 'cookie-parser';
import { requirePageAuth, login, setSessionCookie, clearSessionCookie, resetPassword, resetEnabled } from './auth.js';
import { apiRouter } from './routes/api.js';
import { oauthRouter } from './routes/oauth.js';
import { dbadminRouter } from './routes/dbadmin.js';

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

  // Self-service DB backup/restore (gated by PASSWORD_RESET_KEY).
  app.use('/dbadmin', dbadminRouter);

  app.get('/login', (_req, res) => res.render('login', { error: null, resetEnabled: resetEnabled() }));
  app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    if (await login(email, password)) {
      setSessionCookie(res, String(email).toLowerCase());
      return res.redirect('/runs');
    }
    res.status(401).render('login', { error: 'Invalid email or password.', resetEnabled: resetEnabled() });
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
