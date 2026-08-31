// Platform email sender (Gmail app password) — for account emails like the
// self-serve password reset. Distinct from notifier.js, which sends per-TENANT run
// summaries. Config lives in app_config (platform_email_from, platform_email_app_password
// [encrypted]) and is set by the super admin. Inert (throws 'not configured') until set.
import nodemailer from 'nodemailer';
import { getConfigValue } from '../db.js';
import { decrypt } from './secrets.js';

export async function platformEmailConfigured() {
  const from = (await getConfigValue('platform_email_from')) || '';
  if (!from) return false;
  // Either the ZeptoMail HTTP token (preferred on hosts that block SMTP egress,
  // e.g. Railway) or an SMTP/Gmail app password is enough to send.
  return Boolean((await getConfigValue('platform_email_zepto_token'))
    || (await getConfigValue('platform_email_app_password')));
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
    zeptoRegion: (await getConfigValue('platform_email_zepto_region')) || 'in',
    hasZeptoToken: Boolean(await getConfigValue('platform_email_zepto_token')),
  };
}

// ZeptoMail (Zoho) HTTP API sender. Works where SMTP egress is blocked (Railway)
// because it POSTs over HTTPS/443. Auth uses the account "Send Mail Token"; the
// region host is api.zeptomail.in (Zoho India) or api.zeptomail.com (global).
async function sendViaZepto({ token, region, from, fromName, to, subject, text, html }) {
  const url = `https://api.zeptomail.${region === 'com' ? 'com' : 'in'}/v1.1/email`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 15000);
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      signal: ac.signal,
      headers: {
        Authorization: `Zoho-enczapikey ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        from: fromName ? { address: from, name: fromName } : { address: from },
        to: [{ email_address: { address: to } }],
        subject,
        ...(text ? { textbody: text } : {}),
        ...(html ? { htmlbody: html } : {}),
      }),
    });
  } catch (e) {
    throw new Error(e.name === 'AbortError'
      ? 'ETIMEDOUT: ZeptoMail API did not respond in 15s'
      : `ZeptoMail request failed: ${e.message}`);
  } finally { clearTimeout(timer); }
  const bodyText = await resp.text();
  if (!resp.ok) {
    let detail = bodyText.slice(0, 300);
    try {
      const j = JSON.parse(bodyText);
      detail = j?.error?.details?.[0]?.message || j?.error?.message || j?.message || detail;
    } catch { /* keep raw text */ }
    throw new Error(`HTTP ${resp.status}: ${detail}`);
  }
}

async function loadEmailCfg() {
  return {
    from: (await getConfigValue('platform_email_from')) || '',
    fromName: (await getConfigValue('platform_email_from_name')) || '',
    zeptoToken: decrypt((await getConfigValue('platform_email_zepto_token')) || '') || '',
    zeptoRegion: (await getConfigValue('platform_email_zepto_region')) || 'in',
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
  // family:4 forces IPv4 at the socket in case DNS still hands back an IPv6 the
  // container can't route (see the ipv4first note in index.js).
  const timeouts = { connectionTimeout: 12000, greetingTimeout: 12000, socketTimeout: 20000, family: 4 };
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
  const { from, fromName, zeptoToken, zeptoRegion } = await loadEmailCfg();
  if (!from) throw new Error('Platform email is not configured.');
  // Prefer the ZeptoMail HTTP API when a token is set (SMTP is blocked on Railway).
  if (zeptoToken) {
    return sendViaZepto({ token: zeptoToken, region: zeptoRegion, from, fromName, to, subject, text, html });
  }
  const { transporter, fromHeader } = await buildTransport();
  await transporter.sendMail({ from: fromHeader, to, subject, text, html });
}

const TEST_SUBJECT = 'AVideoRouter — test email';
const TEST_TEXT = 'This is a test from AVideoRouter. Your platform email is working.';
const TEST_HTML = '<p>This is a test from <b>AVideoRouter</b>. Your platform email is working.</p>';

// Diagnostic: send a test message to `to`, echoing the method/settings used and,
// on failure, the provider error. For SMTP it verifies connectivity+auth first so
// ETIMEDOUT (host/port unreachable) reads apart from EAUTH (bad credentials).
export async function testPlatformMail(to) {
  const { from, fromName, zeptoToken, zeptoRegion } = await loadEmailCfg();
  if (!from) throw new Error('Set the From address first.');
  if (zeptoToken) {
    const used = { provider: 'zeptomail', region: zeptoRegion === 'com' ? 'com' : 'in', from };
    try {
      await sendViaZepto({ token: zeptoToken, region: zeptoRegion, from, fromName, to, subject: TEST_SUBJECT, text: TEST_TEXT, html: TEST_HTML });
      return { ok: true, to, used };
    } catch (e) { const err = new Error(e.message); err.used = used; throw err; }
  }
  const { transporter, fromHeader, host, port, security, user } = await buildTransport();
  const used = { provider: 'smtp', host, port, security, user };
  try {
    await transporter.verify();
    await transporter.sendMail({ from: fromHeader, to, subject: TEST_SUBJECT, text: TEST_TEXT, html: TEST_HTML });
    return { ok: true, to, used };
  } catch (e) {
    const err = new Error(`${e.code || 'ERR'}: ${e.message}`);
    err.used = used;
    err.code = e.code;
    throw err;
  }
}
