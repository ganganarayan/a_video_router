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

export async function sendPlatformMail(to, subject, text, html) {
  const from = (await getConfigValue('platform_email_from')) || '';
  const pass = decrypt((await getConfigValue('platform_email_app_password')) || '') || '';
  if (!from || !pass) throw new Error('Platform email is not configured.');
  const transporter = nodemailer.createTransport({ service: 'gmail', auth: { user: from, pass } });
  await transporter.sendMail({ from, to, subject, text, html });
}
