import express from 'express';
import crypto from 'node:crypto';
import { pool, query } from '../../db.js';

// Full-database JSON export/import, gated by the PASSWORD_RESET_KEY env var.
// Purpose: a self-service backup (and restore) on plans without managed DB backups.
// Mounted before auth so it can be pulled with just the key.

const KEY = process.env.PASSWORD_RESET_KEY || '';

function keyOk(provided) {
  if (!KEY) return false;
  const a = Buffer.from(String(provided || ''));
  const b = Buffer.from(KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export const dbadminRouter = express.Router();

// GET /dbadmin/export?key=...  → JSON dump of every public table.
dbadminRouter.get('/export', async (req, res) => {
  if (!keyOk(req.query.key)) return res.status(403).json({ error: 'bad or missing key' });
  try {
    const { rows: tbls } = await query(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    );
    const dump = { takenAt: new Date().toISOString(), counts: {}, tables: {} };
    for (const { tablename } of tbls) {
      const { rows } = await query(`SELECT * FROM "${tablename}"`);
      dump.tables[tablename] = rows;
      dump.counts[tablename] = rows.length;
    }
    res.setHeader('Content-Disposition', `attachment; filename="videorouter-backup-${Date.now()}.json"`);
    res.json(dump);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /dbadmin/import?key=...  body = a prior export → restore (rollback tool).
// Truncates the listed tables and re-inserts, with FK triggers disabled inside one
// transaction so insert order does not matter.
dbadminRouter.post('/import', express.json({ limit: '256mb' }), async (req, res) => {
  if (!keyOk(req.query.key)) return res.status(403).json({ error: 'bad or missing key' });
  const tables = req.body?.tables;
  if (!tables || typeof tables !== 'object') return res.status(400).json({ error: 'body.tables required' });
  const names = Object.keys(tables).filter((t) => t !== 'schema_migrations');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET session_replication_role = 'replica'"); // disable FK triggers
    for (const t of names) await client.query(`TRUNCATE TABLE "${t}" CASCADE`);
    const restored = {};
    for (const t of names) {
      let n = 0;
      for (const row of tables[t]) {
        const cols = Object.keys(row);
        if (!cols.length) continue;
        const ph = cols.map((_, i) => `$${i + 1}`).join(', ');
        await client.query(
          `INSERT INTO "${t}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${ph})`,
          cols.map((c) => (row[c] !== null && typeof row[c] === 'object' ? JSON.stringify(row[c]) : row[c])),
        );
        n += 1;
      }
      restored[t] = n;
    }
    await client.query("SET session_replication_role = 'origin'");
    await client.query('COMMIT');
    res.json({ ok: true, restored });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    res.status(500).json({ error: err.message });
  } finally {
    client.release();
  }
});
