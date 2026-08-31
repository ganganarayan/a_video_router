// Platform email sender (Gmail app password) — for account emails like the
// self-serve password reset. Distinct from notifier.js, which sends per-TENANT run
// summaries. Config lives in app_config (platform_email_from, platform_email_app_password
// [encrypted]) and is set by the super admin. Inert (throws 'not configured') until set.
import nodemailer from 'nodemailer';
import { getConfigValue } from '../db.js';
import { decrypt } from './secrets.js';

export async function platformEmailConfigured() {
  return Boolean((await getConfigValue('platform_email_from'))
    && (await getConfigValue('platform_email_app_password')));
}

export async function getPlatformEmailFrom() {
  return (await getConfigValue('platform_email_from')) || '';
}

export async function getPlatformSmtp() {
  return {
    fromName: (await getConfigValue('platform_email_from_name')) || '',
    host: (await getConfigValue('platform_email_host')) || '',
    port: Number(await getConfigValue('platform_email_port')) || '',
    security: (await getConfigValue('platform_email_secure')) || '',
    username: (await getConfigValue('platform_email_user')) || '',
  };
}

// Build a nodemailer transport from stored config + a From header. Shared by
// send and verify so both use identical settings. Short timeouts turn an
// unreachable host/port into a fast ETIMEDOUT instead of a long hang.
async function buildTransport() {
  const from = (await getConfigValue('platform_email_from')) || '';
  const fromName = (await getConfigValue('platform_email_from_name')) || '';
  const pass = decrypt((await getConfigValue('platform_email_app_password')) || '') || '';
  const host = (await getConfigValue('platform_email_host')) || '';
  const port = Number(await getConfigValue('platform_email_port')) || 465;
  // Auth username defaults to the From address (many providers use the same value).
  const user = (await getConfigValue('platform_email_user')) || from;
  // Security: 'ssl' (implicit TLS, port 465), 'starttls' (upgrade, port 587), or 'none'.
  const security = (await getConfigValue('platform_email_secure')) || (port === 465 ? 'ssl' : 'starttls');
  if (!from || !pass) throw new Error('Platform email is not configured.');
  const fromHeader = fromName ? `"${fromName.replace(/"/g, '')}" <${from}>` : from;
  const timeouts = { connectionTimeout: 12000, greetingTimeout: 12000, socketTimeout: 20000 };
  // Explicit SMTP host (e.g. Zoho: smtp.zoho.in / smtp.zoho.com) when set; otherwise Gmail.
  const transporter = host
    ? nodemailer.createTransport({
      host, port,
      secure: security === 'ssl',
      requireTLS: security === 'starttls',
      auth: { user, pass },
      ...timeouts,
    })
    : nodemailer.createTransport({ service: 'gmail', auth: { user, pass }, ...timeouts });
  return { transporter, fromHeader, host: host || 'gmail', port: host ? port : 465, security, user };
}

export async function sendPlatformMail(to, subject, text, html) {
  const { transporter, fromHeader } = await buildTransport();
  await transporter.sendMail({ from: fromHeader, to, subject, text, html });
}

// Diagnostic: verify SMTP connectivity + auth, then send a test message to `to`.
// Returns the settings used and any failure with its error code so the operator
// can tell ETIMEDOUT (host/port unreachable) from EAUTH (bad credentials) apart.
export async function testPlatformMail(to) {
  const { transporter, fromHeader, host, port, security, user } = await buildTransport();
  const used = { host, port, security, user };
  try {
    await transporter.verify();
    await transporter.sendMail({
      from: fromHeader, to,
      subject: 'AVideoRouter — test email',
      text: 'This is a test from AVideoRouter. Your platform email is working.',
      html: '<p>This is a test from <b>AVideoRouter</b>. Your platform email is working.</p>',
    });
    return { ok: true, to, used };
  } catch (e) {
    const err = new Error(`${e.code || 'ERR'}: ${e.message}`);
    err.used = used;
    err.code = e.code;
    throw err;
  }
}
