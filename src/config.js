const REQUIRED = [
  'DATABASE_URL',
  'SETTINGS_ENCRYPTION_KEY',
  'JWT_SECRET',
  'PUBLIC_URL',
  'ADMIN_EMAIL',
  'ADMIN_PASSWORD',
];

export function loadConfig() {
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  return {
    databaseUrl: process.env.DATABASE_URL,
    encryptionKey: process.env.SETTINGS_ENCRYPTION_KEY,
    jwtSecret: process.env.JWT_SECRET,
    publicUrl: process.env.PUBLIC_URL.replace(/\/+$/, ''),
    adminEmail: process.env.ADMIN_EMAIL,
    adminPassword: process.env.ADMIN_PASSWORD,
    port: Number(process.env.PORT || 8080),
  };
}

export const config = loadConfig();
