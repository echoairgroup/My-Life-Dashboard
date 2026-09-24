import crypto from "crypto";
import pg from "pg";

const { Pool } = pg;
const pool = process.env.DATABASE_URL ? new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes("localhost") ? false : { rejectUnauthorized: false }
}) : null;

let ready = false;
export async function initSync() {
  if (!pool || ready) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS my_life_sync (
      sync_id TEXT PRIMARY KEY,
      payload JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  ready = true;
}

export function createSyncId() {
  return crypto.randomBytes(18).toString("hex");
}

export async function putSync(syncId, payload) {
  if (!pool) throw new Error("DATABASE_URL ontbreekt.");
  if (!/^[a-f0-9]{20,80}$/i.test(String(syncId || ""))) throw new Error("Ongeldige sync-code.");
  const clean = JSON.stringify(payload || {});
  if (clean.length > 5_000_000) throw new Error("Sync-data is te groot.");
  await initSync();
  await pool.query(
    `INSERT INTO my_life_sync(sync_id,payload,updated_at)
     VALUES($1,$2::jsonb,NOW())
     ON CONFLICT(sync_id) DO UPDATE SET payload=EXCLUDED.payload,updated_at=NOW()`,
    [syncId, clean]
  );
  return { ok: true, syncId, updatedAt: new Date().toISOString() };
}

export async function getSync(syncId) {
  if (!pool) throw new Error("DATABASE_URL ontbreekt.");
  await initSync();
  const r = await pool.query("SELECT payload, updated_at FROM my_life_sync WHERE sync_id=$1", [syncId]);
  if (!r.rows[0]) return null;
  return { state: r.rows[0].payload, updatedAt: r.rows[0].updated_at };
}
