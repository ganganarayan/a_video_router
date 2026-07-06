import nodemailer from 'nodemailer';
import { getConfigMap } from './db.js';
import { decryptWithKey } from './lib/crypto.js';
import { config } from './config.js';
import { log } from './lib/logger.js';

function fmtList(items, line) {
  return items.length ? items.map(line).join('\n') : null;
}

export function buildSummaryText(counts, details) {
  const parts = [];
  const posted = fmtList(details.posted, (p) => `  • ${p.title} (${p.source})\n    ${p.url}`);
  const skipped = fmtList(details.skipped, (s) => `  • ${s.title} (${s.source}) — ${s.reason}`);
  const errors = fmtList(details.errors, (e) => `  • ${e.title || '(run)'} — ${e.message}`);
  const warnings = fmtList(details.warnings, (w) => `  • ${w.title} — ${w.message}`);

  if (!details.posted.length && !details.skipped.length && !details.errors.length) {
    parts.push('No new recordings.');
  }
  if (posted) parts.push(`Posted (${details.posted.length}):\n${posted}`);
  if (skipped) parts.push(`Skipped (${details.skipped.length}):\n${skipped}`);
  if (errors) parts.push(`Errors (${details.errors.length}):\n${errors}`);
  if (warnings) parts.push(`Warnings (${details.warnings.length}):\n${warnings}`);
  parts.push(`Totals: found ${counts.found}, uploaded ${counts.uploaded}, skipped ${counts.skipped}, errors ${counts.errors}`);
  return parts.join('\n\n');
}

// Always sends when email is configured — including the "No new recordings" case.
export async function sendRunSummary(runType, counts, details) {
  const cfg = await getConfigMap();
  const to = cfg.email_to;
  const from = cfg.email_from;
  const appPassword = decryptWithKey(config.encryptionKey, cfg.gmail_app_password || '');
  if (!to || !from || !appPassword) {
    log('email not configured — skipping run summary email');
    return false;
  }
  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: from, pass: appPassword },
  });
  const subject = `VideoRouter ${runType} run: ${counts.uploaded} uploaded, ${counts.errors} errors`;
  await transporter.sendMail({ from, to, subject, text: buildSummaryText(counts, details) });
  log(`run summary emailed to ${to}`);
  return true;
}
