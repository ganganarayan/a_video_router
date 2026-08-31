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

export async function sendPlatformMail(to, subject, text, html) {
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
  // Explicit SMTP host (e.g. Zoho: smtp.zoho.in / smtp.zoho.com) when set; otherwise Gmail.
  const transporter = host
    ? nodemailer.createTransport({
      host, port,
      secure: security === 'ssl',
      requireTLS: security === 'starttls',
      auth: { user, pass },
    })
    : nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
  await transporter.sendMail({ from: fromHeader, to, subject, text, html });
}
