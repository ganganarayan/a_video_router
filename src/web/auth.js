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

// Change the admin email and/or password (current password required for either).
export async function updateAccount(email, currentPassword, { newEmail, newPassword }) {
  if (!newEmail && !newPassword) {
    return { ok: false, error: 'Provide a new email and/or a new password.' };
  }
  if (newPassword && newPassword.length < 8) {
    return { ok: false, error: 'New password must be at least 8 characters.' };
  }
  if (newEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
    return { ok: false, error: 'New email is not a valid address.' };
  }
  if (!(await login(email, currentPassword))) {
    return { ok: false, error: 'Current password is incorrect.' };
  }
  const sets = [];
  const params = [];
  if (newEmail) { params.push(newEmail.toLowerCase()); sets.push(`email = $${params.length}`); }
  if (newPassword) { params.push(await bcrypt.hash(newPassword, 10)); sets.push(`password_hash = $${params.length}`); }
  params.push(email);
  await query(`UPDATE admin_users SET ${sets.join(', ')} WHERE email = $${params.length}`, params);
  return { ok: true, email: newEmail ? newEmail.toLowerCase() : email };
}
