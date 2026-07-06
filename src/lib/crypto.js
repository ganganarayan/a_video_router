import crypto from 'node:crypto';

const PREFIX = 'enc:v1:';

// Accepts a 64-char hex key directly; any other string is derived to 32 bytes via SHA-256.
export function deriveKey(keyMaterial) {
  if (/^[0-9a-fA-F]{64}$/.test(keyMaterial)) return Buffer.from(keyMaterial, 'hex');
  return crypto.createHash('sha256').update(keyMaterial, 'utf8').digest();
}

export function encryptWithKey(keyMaterial, plaintext) {
  if (plaintext == null || plaintext === '') return plaintext;
  const key = deriveKey(keyMaterial);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + [iv, tag, ciphertext].map((b) => b.toString('base64')).join(':');
}

export function decryptWithKey(keyMaterial, stored) {
  if (stored == null || stored === '') return stored;
  if (!stored.startsWith(PREFIX)) return stored; // legacy/plaintext value
  const key = deriveKey(keyMaterial);
  const [ivB64, tagB64, ctB64] = stored.slice(PREFIX.length).split(':');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}

export function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}
