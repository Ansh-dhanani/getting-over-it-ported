// Fastest full-completion leaderboard - Neon PostgreSQL backend.
//
//   GET  /api/leaderboard  -> { ok: true, top: [{ name, ms, at }], count }
//   POST /api/leaderboard  -> body: { name, ms }  ->  { ok: true, rank: n }
//
// Storage: two tables in the Neon database (goi_leaderboard, goi_rl), created
// automatically on first request. Writes use raw fetch through the Neon
// serverless driver (HTTP, no sockets - serverless friendly).
//
// Env vars (Vercel - Project - Settings - Environment Variables):
//   NEON_CONNECTION_STRING   postgresql://user:pass@host/db?sslmode=require
//   (NEON_DATABASE_URL and DATABASE_URL are also accepted)
//
// Anti-cheat: entries are client-reported, so times are only trusted loosely.
// Sane bounds are enforced server-side and writes are rate limited per IP
// (fixed 60s window). A determined cheater can forge a request - unavoidable
// without server-side replay, which is out of scope.

const TOP = 50;
const MIN_MS = 60 * 1000;                       // 1 minute - no real run is faster
const MAX_MS = 7 * 24 * 60 * 60 * 1000;         // one week
const MAX_WRITES_PER_MINUTE = 5;                // per IP
const MAX_NAME_LEN = 18;

const CONN = process.env.NEON_CONNECTION_STRING ||
             process.env.NEON_DATABASE_URL ||
             process.env.DATABASE_URL || "";

let sql = null;
function getSql() {
  if (sql) return sql;
  if (!CONN) throw new Error("leaderboard not configured (missing Neon connection string)");
  const { neon } = require("@neondatabase/serverless");
  sql = neon(CONN);
  return sql;
}

let schemaReady = null;
function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      const s = getSql();
      await s`CREATE TABLE IF NOT EXISTS goi_leaderboard (
        id BIGSERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        ms BIGINT NOT NULL CHECK (ms > 0),
        created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
      await s`CREATE INDEX IF NOT EXISTS goi_leaderboard_ms_idx ON goi_leaderboard (ms)`;
      await s`CREATE TABLE IF NOT EXISTS goi_rl (
        ip TEXT PRIMARY KEY,
        hits INT NOT NULL DEFAULT 0,
        window_started TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
    })().catch((e) => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

function cleanName(raw) {
  let s = String(raw == null ? "" : raw);
  s = s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/[<>]/g, "");
  s = s.replace(/\s+/g, " ").trim();
  if (!s) s = "Anonymous";
  return s.slice(0, MAX_NAME_LEN);
}

function clientIp(req) {
  const fwd = (req.headers && (req.headers["x-forwarded-for"] || req.headers["x-vercel-forwarded-for"])) || "";
  const first = String(fwd).split(",")[0].trim();
  return first || (req.socket && req.socket.remoteAddress) || "unknown";
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body && typeof req.body === "object") return resolve(req.body);
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 4096) { reject(new Error("body too large")); req.destroy(); }
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch (e) { reject(new Error("invalid JSON")); }
    });
    req.on("error", reject);
  });
}

function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(obj));
}

module.exports = async function handler(req, res) {
  try {
    await ensureSchema();
    const s = getSql();

    if (req.method === "GET") {
      const rows = await s`
        SELECT name, ms, EXTRACT(EPOCH FROM created_at) * 1000 AS at_ms
        FROM goi_leaderboard
        ORDER BY ms ASC, id ASC
        LIMIT ${TOP}`;
      const top = rows.map((r) => ({
        name: cleanName(r.name),
        ms: Number(r.ms),
        at: new Date(Number(r.at_ms)).toISOString(),
      }));
      return send(res, 200, { ok: true, top, count: top.length });
    }

    if (req.method === "POST") {
      const ip = clientIp(req);
      const rl = await s`
        INSERT INTO goi_rl (ip, hits, window_started) VALUES (${ip}, 1, now())
        ON CONFLICT (ip) DO UPDATE SET
          hits = CASE WHEN goi_rl.window_started < now() - INTERVAL '60 seconds'
                      THEN 1 ELSE goi_rl.hits + 1 END,
          window_started = CASE WHEN goi_rl.window_started < now() - INTERVAL '60 seconds'
                      THEN now() ELSE goi_rl.window_started END
        RETURNING hits`;
      if (Number(rl[0].hits) > MAX_WRITES_PER_MINUTE) {
        return send(res, 429, { ok: false, error: "Too many submissions. Try again in a minute." });
      }

      const body = await parseBody(req);
      const ms = Math.round(Number(body && body.ms));
      if (!Number.isFinite(ms) || ms < MIN_MS || ms > MAX_MS) {
        return send(res, 400, { ok: false, error: "Time is out of the allowed range." });
      }
      const name = cleanName(body && body.name);
      await s`INSERT INTO goi_leaderboard (name, ms) VALUES (${name}, ${ms})`;
      const rankRows = await s`SELECT COUNT(*)::int AS faster FROM goi_leaderboard WHERE ms < ${ms}`;
      const rank = Number(rankRows[0].faster);
      return send(res, 200, { ok: true, rank });
    }

    res.setHeader("Allow", "GET, POST");
    return send(res, 405, { ok: false, error: "Method not allowed." });
  } catch (err) {
    console.error("[leaderboard]", err && err.message ? err.message : err);
    return send(res, 500, { ok: false, error: "Leaderboard is unavailable right now." });
  }
};
