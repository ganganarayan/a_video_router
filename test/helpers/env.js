// Dummy bootstrap env so modules that import src/config.js can load in tests.
// Import this FIRST (side-effect import) in any test that touches such modules.
process.env.DATABASE_URL ??= 'postgresql://test:test@localhost:5432/test';
process.env.SETTINGS_ENCRYPTION_KEY ??= 'a'.repeat(64);
process.env.JWT_SECRET ??= 'test-jwt-secret';
process.env.PUBLIC_URL ??= 'https://videorouter.test';
process.env.ADMIN_EMAIL ??= 'admin@test.local';
process.env.ADMIN_PASSWORD ??= 'test-password';
