import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query } from '../db.js';

const COOKIE = 'vr_session';
const SESSION_HOURS = 24 * 7;

export function setSessionCookie(res, email) {
  const token = jwt.sign({ sub: email }, config.jwtSecret, { expiresIn: `${SESSION_HOURS}h` });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.publicUrl.startsWith('https://'),
    maxAge: SESSION_HOURS * 3600 * 1000,
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(COOKIE);
}

function verifySession(req) {
  const token = req.cookies?.[COOKIE];
  if (!token) return null;
  try {
    return jwt.verify(token, config.jwtSecret);
  } catch {
    return null;
  }
}

export function requirePageAuth(req, res, next) {
  const session = verifySession(req);
  if (!session) return res.redirect('/login');
  req.user = session.sub;
  next();
}

export function requireApiAuth(req, res, next) {
  const session = verifySession(req);
  if (!session) return res.status(401).json({ error: 'unauthorized' });
  req.user = session.sub;
  next();
}

export async function login(email, password) {
  const { rows } = await query('SELECT * FROM admin_users WHERE email = $1', [
    String(email || '').toLowerCase(),
  ]);
  if (!rows[0]) return false;
  return bcrypt.compare(String(password || ''), rows[0].password_hash);
}

export async function changePassword(email, currentPassword, newPassword) {
  if (!newPassword || newPassword.length < 8) {
    return { ok: false, error: 'New password must be at least 8 characters.' };
  }
  if (!(await login(email, currentPassword))) {
    return { ok: false, error: 'Current password is incorrect.' };
  }
  const hash = await bcrypt.hash(newPassword, 10);
  await query('UPDATE admin_users SET password_hash = $1 WHERE email = $2', [hash, email]);
  return { ok: true };
}
