import './helpers/env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ejs from 'ejs';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('entire module graph loads (no missing imports / bad syntax)', async () => {
  for (const mod of [
    'src/web/server.js', 'src/pipeline/run.js', 'src/scheduler.js', 'src/notifier.js',
    'src/providers/zoom.js', 'src/providers/fathom.js', 'src/providers/youtube.js', 'src/providers/lms.js',
  ]) {
    await import(new URL(`../${mod}`, import.meta.url));
  }
});

test('express app constructs with all routes mounted', async () => {
  const { createServer } = await import('../src/web/server.js');
  const app = createServer();
  assert.ok(app);
});

test('every EJS view renders', async () => {
  const views = path.join(root, 'src', 'web', 'views');
  await ejs.renderFile(path.join(views, 'login.ejs'), { error: null, resetEnabled: false });
  await ejs.renderFile(path.join(views, 'login.ejs'), { error: 'Bad password', resetEnabled: true });
  await ejs.renderFile(path.join(views, 'reset.ejs'), { error: null, ok: null, enabled: true });
  await ejs.renderFile(path.join(views, 'reset.ejs'), { error: null, ok: 'done', enabled: true });
  await ejs.renderFile(path.join(views, 'reset.ejs'), { error: null, ok: null, enabled: false });
  await ejs.renderFile(path.join(views, 'set-password.ejs'), { error: null, email: 'a@b.com' });
  await ejs.renderFile(path.join(views, 'set-password.ejs'), { error: 'too short', email: 'a@b.com' });
  for (const page of ['runs', 'connections', 'routing', 'sources', 'logs', 'schedules', 'settings', 'admin']) {
    const html = await ejs.renderFile(path.join(views, `${page}.ejs`), { page, title: page });
    assert.ok(html.includes('</html>'), `${page} view did not render fully`);
  }
});
