import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { query, pool } from '../db.js';
import { canUseStaff } from '../billing.js';

const RESET_KEY = process.env.PASSWORD_RESET_KEY || '';
export const resetEnabled = () => Boolean(RESET_KEY);

function keyMatches(provided) {
  const a = Buffer.from(String(provided || ''));
  const b = Buffer.from(RESET_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const COOKIE = 'vr_session';
export const SESSION_COOKIE_NAME = COOKIE; // used by the tracking middleware to skip logged-in users
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
  res.clearCookie(IMP_COOKIE);
}

// --- super-admin impersonation (which tenant the super admin is acting within) ---
const IMP_COOKIE = 'vr_imp';

export function setImpersonation(res, tenantId) {
  const token = jwt.sign({ imp: Number(tenantId) }, config.jwtSecret, { expiresIn: '24h' });
  res.cookie(IMP_COOKIE, token, {
    httpOnly: true, sameSite: 'lax',
    secure: config.publicUrl.startsWith('https://'), maxAge: 24 * 3600 * 1000,
  });
}
export function clearImpersonation(res) { res.clearCookie(IMP_COOKIE); }

function readImpersonation(req) {
  const t = req.cookies?.[IMP_COOKIE];
  if (!t) return null;
  try { return Number(jwt.verify(t, config.jwtSecret).imp) || null; } catch { return null; }
}

// Resolves the active tenant for the request. Tenant users are always their own
// tenant; a super admin's tenant is whichever one they're impersonating (or null).
// Run AFTER requirePageAuth / requireApiAuth (needs req.user).
export function resolveTenant(req, _res, next) {
  if (req.user.role === 'admin') {
    req.tenantId = req.user.tenantId;
  } else {
    req.tenantId = readImpersonation(req); // super admin: impersonated tenant or null
  }
  next();
}

// Enforces that a tenant context exists (super admin must impersonate first).
export function requireTenant(req, res, next) {
  if (!req.tenantId) {
    if (req.path.startsWith('/api') || req.baseUrl?.startsWith('/api')) {
      return res.status(409).json({ error: 'Pick a tenant first.', redirect: '/admin' });
    }
    return res.redirect('/admin');
  }
  next();
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

// Staff seats are an Always-On feature: a staff user whose workspace is not on
// Always-On (subscription or comped/unlimited) is locked out until the owner
// subscribes. Owners are never gated here (they can log in and subscribe).
const STAFF_LOCK_MSG = 'Staff access needs Always-On or a ₹1,000+ top-up. Ask the workspace owner to enable it on the Billing page.';
async function staffLocked(user) {
  return user.isStaff && !(await canUseStaff(user.tenantId).catch(() => false));
}

export async function requirePageAuth(req, res, next) {
  const u = await loadSessionUser(req).catch(() => null);
  if (!u) return res.redirect('/login');
  req.user = toReqUser(u);
  // Force the first-login password set before anything else.
  if (req.user.mustChangePassword && req.path !== '/set-password') {
    return res.redirect('/set-password');
  }
  if (await staffLocked(req.user)) return res.status(403).send(STAFF_LOCK_MSG);
  next();
}

export async function requireApiAuth(req, res, next) {
  const u = await loadSessionUser(req).catch(() => null);
  if (!u) return res.status(401).json({ error: 'unauthorized' });
  req.user = toReqUser(u);
  if (req.user.mustChangePassword) {
    return res.status(409).json({ error: 'password change required', redirect: '/set-password' });
  }
  if (await staffLocked(req.user)) return res.status(403).json({ error: STAFF_LOCK_MSG, needsAlwaysOn: true });
  next();
}

// Returns the logged-in user (req-shape) or null, without redirecting. Used by
// the public landing page to send authenticated users into the app.
export async function getOptionalUser(req) {
  const u = await loadSessionUser(req).catch(() => null);
  return u ? toReqUser(u) : null;
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

// Record a successful login. One row per user, overwritten each time: the prior
// last_login_at rolls into previous_login_at so the user can see their last login,
// while last_login_at tracks the current one. Best-effort — never blocks sign-in.
export async function recordLogin(email, ip) {
  try {
    await query(
      `UPDATE users
         SET previous_login_at = last_login_at,
             last_login_at = now(),
             last_login_ip = $2
       WHERE email = $1`,
      [String(email).toLowerCase(), ip || null],
    );
  } catch { /* login recording is best-effort */ }
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

// --- staff management (tenant owner provisions staff within their tenant) ---

export async function listTenantUsers(tenantId) {
  const { rows } = await query(
    `SELECT id, email, name, staff_permission, must_change_password, deleted_at,
            last_login_at, created_at
     FROM users
     WHERE tenant_id = $1
     ORDER BY (staff_permission IS NULL) DESC, id`,  // owner first, then staff
    [tenantId],
  );
  return rows;
}

async function staffRow(tenantId, id) {
  const { rows } = await query(
    'SELECT id, staff_permission FROM users WHERE id = $1 AND tenant_id = $2', [id, tenantId],
  );
  return rows[0] || null;
}

// Create a staff user (passwordless first login + forced set-password, like the seeds).
// --- self-serve signup: create a tenant + owner + wallet atomically ---

function slugify(s) {
  return String(s || '').toLowerCase().normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40) || 'workspace';
}

async function uniqueSlug(base) {
  const root = base === 'admin' ? 'workspace' : base;
  for (let i = 0; i < 60; i++) {
    const candidate = i === 0 ? root : `${root}-${i + 1}`;
    const { rowCount } = await query('SELECT 1 FROM tenants WHERE slug = $1', [candidate]);
    if (!rowCount) return candidate;
  }
  return `${root}-${Date.now().toString(36)}`;
}

// Create a brand-new workspace for a self-serve signup. passwordHash is null for
// Google-OAuth accounts (they sign in via Google). Returns the new tenant + email.
export async function createTenantOwner({ email, name, workspaceName, passwordHash = null }) {
  const emailLc = String(email || '').toLowerCase().trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailLc)) return { ok: false, error: 'A valid email is required.' };
  if (await getUserByEmail(emailLc)) return { ok: false, error: 'An account with that email already exists — please log in.' };
  const displayName = String(name || '').trim() || emailLc.split('@')[0];
  const wsName = String(workspaceName || '').trim() || displayName;
  const slug = await uniqueSlug(slugify(wsName || emailLc.split('@')[0]));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id', [slug, wsName]);
    const tenantId = rows[0].id;
    await client.query(
      `INSERT INTO users (tenant_id, email, name, role, password_hash, must_change_password)
       VALUES ($1, $2, $3, 'admin', $4, false)`,
      [tenantId, emailLc, displayName, passwordHash],
    );
    await client.query('INSERT INTO wallets (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING', [tenantId]);
    await client.query('COMMIT');
    return { ok: true, tenantId, slug, email: emailLc };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err.code === '23505') return { ok: false, error: 'An account with that email already exists — please log in.' };
    return { ok: false, error: 'Could not create the workspace. Please try again.' };
  } finally {
    client.release();
  }
}

// Owner-side sign-up for a hashed password (kept next to createTenantOwner).
export async function hashPassword(pw) { return bcrypt.hash(String(pw), 10); }

// --- self-serve password reset (email link) ---
const resetTokenHash = (t) => crypto.createHash('sha256').update(String(t || '')).digest('hex');

// Create a single-use reset token (1h). Returns { sent, token, email, name } — sent
// is false when no such user (caller shows a generic message, no account enumeration).
export async function createPasswordReset(email) {
  const emailLc = String(email || '').toLowerCase().trim();
  const user = await getUserByEmail(emailLc);
  if (!user || user.deleted_at) return { ok: true, sent: false };
  const token = crypto.randomBytes(32).toString('hex');
  await query(
    `INSERT INTO password_resets (email, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')`,
    [emailLc, resetTokenHash(token)],
  );
  return { ok: true, sent: true, token, email: emailLc, name: user.name };
}

export async function resetTokenValid(token) {
  const { rowCount } = await query(
    `SELECT 1 FROM password_resets WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()`,
    [resetTokenHash(token)],
  );
  return rowCount > 0;
}

// Consume a valid token and set the user's new password (single-use).
export async function consumePasswordReset(token, newPassword) {
  if (!newPassword || String(newPassword).length < 8) return { ok: false, error: 'Password must be at least 8 characters.' };
  const { rows } = await query(
    `SELECT * FROM password_resets WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now()
     ORDER BY id DESC LIMIT 1`,
    [resetTokenHash(token)],
  );
  const row = rows[0];
  if (!row) return { ok: false, error: 'This reset link is invalid or has expired — request a new one.' };
  const hash = await bcrypt.hash(String(newPassword), 10);
  await query('UPDATE users SET password_hash = $1, must_change_password = false, updated_at = now() WHERE email = $2', [hash, row.email]);
  await query('UPDATE password_resets SET used_at = now() WHERE id = $1', [row.id]);
  return { ok: true, email: row.email };
}

// Google sign-in: find the user by email; create a new workspace if none exists.
// Returns { ok, email, created } — `created` true only for a brand-new signup.
export async function signInWithGoogle({ email, name }) {
  const emailLc = String(email || '').toLowerCase().trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailLc)) return { ok: false, error: 'Google did not return a valid email.' };
  const existing = await getUserByEmail(emailLc);
  if (existing) {
    if (existing.deleted_at) return { ok: false, error: 'This account is disabled.' };
    return { ok: true, email: emailLc, created: false };
  }
  const created = await createTenantOwner({ email: emailLc, name, workspaceName: name });
  if (!created.ok) return created;
  return { ok: true, email: emailLc, created: true, tenantId: created.tenantId };
}

export async function createStaff(tenantId, { email, name, permission }) {
  const emailLc = String(email || '').toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailLc)) return { ok: false, error: 'A valid email is required.' };
  if (!['view', 'edit'].includes(permission)) return { ok: false, error: 'Permission must be view or edit.' };
  if (await getUserByEmail(emailLc)) return { ok: false, error: 'A user with that email already exists.' };
  const { rows } = await query(
    `INSERT INTO users (tenant_id, email, name, role, staff_permission, password_hash, must_change_password)
     VALUES ($1, $2, $3, 'admin', $4, NULL, true) RETURNING id`,
    [tenantId, emailLc, String(name || '').trim() || emailLc, permission],
  );
  return { ok: true, id: rows[0].id };
}

export async function updateStaff(tenantId, id, { name, permission }) {
  if (permission && !['view', 'edit'].includes(permission)) return { ok: false, error: 'bad permission' };
  const row = await staffRow(tenantId, id);
  if (!row) return { ok: false, error: 'user not found' };
  if (row.staff_permission === null) return { ok: false, error: 'The owner cannot be modified here.' };
  const sets = [];
  const params = [];
  if (name) { params.push(name.trim()); sets.push(`name = $${params.length}`); }
  if (permission) { params.push(permission); sets.push(`staff_permission = $${params.length}`); }
  if (!sets.length) return { ok: false, error: 'nothing to update' };
  params.push(id, tenantId);
  await query(`UPDATE users SET ${sets.join(', ')}, updated_at = now() WHERE id = $${params.length - 1} AND tenant_id = $${params.length}`, params);
  return { ok: true };
}

// Reset a staff member's password → back to passwordless first login.
export async function resetStaffPassword(tenantId, id) {
  const row = await staffRow(tenantId, id);
  if (!row) return { ok: false, error: 'user not found' };
  if (row.staff_permission === null) return { ok: false, error: 'Use Account settings to change the owner password.' };
  await query('UPDATE users SET password_hash = NULL, must_change_password = true, updated_at = now() WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
  return { ok: true };
}

export async function deleteStaff(tenantId, id) {
  const row = await staffRow(tenantId, id);
  if (!row) return { ok: false, error: 'user not found' };
  if (row.staff_permission === null) return { ok: false, error: 'The owner cannot be removed.' };
  await query('UPDATE users SET deleted_at = now(), updated_at = now() WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
  return { ok: true };
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
