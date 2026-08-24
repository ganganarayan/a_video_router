import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query } from '../db.js';

const RESET_KEY = process.env.PASSWORD_RESET_KEY || '';
export const resetEnabled = () => Boolean(RESET_KEY);

function keyMatches(provided) {
  const a = Buffer.from(String(provided || ''));
  const b = Buffer.from(RESET_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const COOKIE = 'vr_session';
const SESSION_HOURS = 24 * 7;

export function setSessionCookie(res, email) {
  const token = jwt.sign({ sub: String(email).toLowerCase() }, config.jwtSecret, { expiresIn: `${SESSION_HOURS}h` });
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

// --- user lookups ---

export async function getUserByEmail(email) {
  const { rows } = await query(
    `SELECT id, tenant_id, email, name, password_hash, role, staff_permission,
            must_change_password, deleted_at
     FROM users WHERE email = $1`,
    [String(email || '').toLowerCase()],
  );
  return rows[0] || null;
}

// Loads the current user for a request from the session (fresh each time so
// role/tenant/deleted/must-change reflect the live DB).
async function loadSessionUser(req) {
  const session = verifySession(req);
  if (!session?.sub) return null;
  const user = await getUserByEmail(session.sub);
  if (!user || user.deleted_at) return null;
  return user;
}

function toReqUser(u) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,                              // 'super_admin' | 'admin'
    tenantId: u.tenant_id,                      // null for super admin
    staffPermission: u.staff_permission,        // null (owner) | 'view' | 'edit'
    mustChangePassword: u.must_change_password,
    isSuperAdmin: u.role === 'super_admin',
    isStaff: Boolean(u.staff_permission),
  };
}

// --- middleware ---

export async function requirePageAuth(req, res, next) {
  const u = await loadSessionUser(req).catch(() => null);
  if (!u) return res.redirect('/login');
  req.user = toReqUser(u);
  // Force the first-login password set before anything else.
  if (req.user.mustChangePassword && req.path !== '/set-password') {
    return res.redirect('/set-password');
  }
  next();
}

export async function requireApiAuth(req, res, next) {
  const u = await loadSessionUser(req).catch(() => null);
  if (!u) return res.status(401).json({ error: 'unauthorized' });
  req.user = toReqUser(u);
  if (req.user.mustChangePassword) {
    return res.status(409).json({ error: 'password change required', redirect: '/set-password' });
  }
  next();
}

// Valid session but tolerant of must-change (used by the set-password endpoints).
export async function requireSessionOnly(req, res, next) {
  const u = await loadSessionUser(req).catch(() => null);
  if (!u) return res.redirect('/login');
  req.user = toReqUser(u);
  next();
}

export function requireSuperAdmin(req, res, next) {
  if (!req.user?.isSuperAdmin) {
    const msg = 'super admin only';
    if (req.path.startsWith('/api') || req.xhr) return res.status(403).json({ error: msg });
    return res.status(403).send(msg);
  }
  next();
}

// Staff (view/edit) may not perform owner-only actions (manage staff, billing, connections).
export function requireOwner(req, res, next) {
  if (req.user?.isStaff) return res.status(403).json({ error: 'staff cannot perform this action' });
  next();
}

// --- authentication ---

// Returns { ok, mustSetPassword, email } or { ok:false }.
// Passwordless first login: a user with NULL password_hash + must_change_password
// is admitted with email only (bootstrap for the super admin and provisioned users),
// then forced to set a password.
export async function authenticate(email, password) {
  const user = await getUserByEmail(email);
  if (!user || user.deleted_at) return { ok: false };

  const passwordless = !user.password_hash && user.must_change_password;
  if (passwordless) {
    return { ok: true, mustSetPassword: true, email: user.email };
  }
  if (user.password_hash && await bcrypt.compare(String(password || ''), user.password_hash)) {
    return { ok: true, mustSetPassword: user.must_change_password, email: user.email };
  }
  return { ok: false };
}

// Set the current user's own password (clears the must-change flag).
export async function setOwnPassword(email, newPassword) {
  if (!newPassword || newPassword.length < 8) {
    return { ok: false, error: 'New password must be at least 8 characters.' };
  }
  const hash = await bcrypt.hash(newPassword, 10);
  await query(
    `UPDATE users SET password_hash = $1, must_change_password = false, updated_at = now()
     WHERE email = $2`,
    [hash, String(email).toLowerCase()],
  );
  return { ok: true };
}

// Recover a forgotten password via the deployment reset key (no email needed).
export async function resetPassword(email, key, newPassword) {
  if (!resetEnabled()) {
    return { ok: false, error: 'Password reset is not configured (no PASSWORD_RESET_KEY set).' };
  }
  if (!keyMatches(key)) {
    return { ok: false, error: 'Reset key is incorrect.' };
  }
  if (!newPassword || newPassword.length < 8) {
    return { ok: false, error: 'New password must be at least 8 characters.' };
  }
  const emailLc = String(email || '').toLowerCase();
  const user = await getUserByEmail(emailLc);
  if (!user) return { ok: false, error: 'No user with that email.' };
  const hash = await bcrypt.hash(newPassword, 10);
  await query(
    'UPDATE users SET password_hash = $1, must_change_password = false, updated_at = now() WHERE id = $2',
    [hash, user.id],
  );
  return { ok: true, email: emailLc };
}

// Change the caller's email and/or password (current password required).
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
  const auth = await authenticate(email, currentPassword);
  if (!auth.ok) return { ok: false, error: 'Current password is incorrect.' };
  const sets = [];
  const params = [];
  if (newEmail) { params.push(newEmail.toLowerCase()); sets.push(`email = $${params.length}`); }
  if (newPassword) { params.push(await bcrypt.hash(newPassword, 10)); sets.push(`password_hash = $${params.length}`); }
  params.push(String(email).toLowerCase());
  await query(`UPDATE users SET ${sets.join(', ')}, updated_at = now() WHERE email = $${params.length}`, params);
  return { ok: true, email: newEmail ? newEmail.toLowerCase() : email };
}
