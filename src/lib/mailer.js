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
    host: (await getConfigValue('platform_email_host')) || '',
    port: Number(await getConfigValue('platform_email_port')) || 0,
  };
}

export async function sendPlatformMail(to, subject, text, html) {
  const from = (await getConfigValue('platform_email_from')) || '';
  const pass = decrypt((await getConfigValue('platform_email_app_password')) || '') || '';
  const host = (await getConfigValue('platform_email_host')) || '';
  const port = Number(await getConfigValue('platform_email_port')) || 465;
  if (!from || !pass) throw new Error('Platform email is not configured.');
  // Explicit SMTP host (e.g. Zoho: smtp.zoho.in / smtp.zoho.com) when set; otherwise
  // fall back to Gmail. secure=true for 465 (SSL), STARTTLS for 587.
  const transporter = host
    ? nodemailer.createTransport({ host, port, secure: port === 465, auth: { user: from, pass } })
    : nodemailer.createTransport({ service: 'gmail', auth: { user: from, pass } });
  await transporter.sendMail({ from, to, subject, text, html });
}
