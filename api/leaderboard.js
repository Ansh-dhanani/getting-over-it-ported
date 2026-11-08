// Fastest full-completion leaderboard for the Getting Over It WebGL port.
//
//   GET  /api/leaderboard        - { ok: true, top: [{ name, ms, at }], count }
//   POST /api/leaderboard        - body: { name, ms }  -  { ok: true, rank: n | null }
//
// Storage: a single Redis sorted set `goi:fastest` (score = ms, member =
// JSON) plus rate-limit keys, via the Upstash REST API. No dependencies -
// raw fetch against the REST endpoint.
//
// Env vars (set in Vercel - Project - Settings - Environment Variables):
//   UPSTASH_REDIS_REST_URL    e.g. https://kind-cat-12345.upstash.io
//   UPSTASH_REDIS_REST_TOKEN  the "REST API token" from the Upstash console
//
// LEADERBOARD_MOCK=1 switches storage to an in-memory map (local testing
// only, never set in production). The mock resets on every cold start.
//
// Anti-cheat: entries are client-reported, so times are only trusted
// loosely - sane bounds are enforced server-side and writes are rate
// limited per IP, but a determined cheater can forge a request. That is
// unavoidable without server-side replay, which is out of scope.

const KEY = "goi:fastest";
const MAX_ENTRIES = 500;          // only the best MAX_ENTRIES are kept
const TOP = 50;                   // GET returns at most TOP
const MIN_MS = 60 * 1000;         // 1 minute - no real run is faster
const MAX_MS = 7 * 24 * 60 * 60 * 1000;  // 1 week cap
const MAX_WRITES_PER_MINUTE = 5;  // per IP
const MAX_NAME_LEN = 18;

const restUrl = () => (process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/+$/, "");

async function upstash(commands) {
  const res = await fetch(restUrl() + "/pipeline", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + process.env.UPSTASH_REDIS_REST_TOKEN,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(commands),
  });
  if (!res.ok) throw new Error("upstash HTTP " + res.status);
  const out = await res.json();
  return (out || []).map((o) => (o && o.error ? Promise.reject(new Error(o.error)) : o.result));
}

// ---- in-memory mock for local dev -----------------------------------------
const mock = { z: [] };
const mockStore = {
  async pipeline(commands) {
    const out = [];
    for (const cmd of commands) {
      const [op, ...args] = cmd.map((a) => String(a));
      switch (op.toLowerCase()) {
        case "zadd": {
          // ZADD key score member
          const [key, score, member] = args;
          if (key !== KEY) throw new Error("mock: unknown key " + key);
          mock.z.push({ score: Number(score), member });
          mock.z.sort((a, b) => a.score - b.score);
          out.push(1);
          break;
        }
        case "zrange": {
          // ZRANGE key start stop WITHSCORES
          const [key, start, stop] = args;
          if (key !== KEY) throw new Error("mock: unknown key " + key);
          const end = stop === "-1" ? mock.z.length : Number(stop) + 1;
          const slice = mock.z.slice(Number(start), end);
          const flat = [];
          slice.forEach((e) => flat.push(e.member, String(e.score)));
          out.push(flat);
          break;
        }
        case "zcard":
          out.push(mock.z.length);
          break;
        case "zremrangebyrank": {
          const [key, start, stop] = args;
          if (key !== KEY) throw new Error("mock: unknown key " + key);
          if (stop !== "-1") throw new Error("mock: only -1 stop supported");
          const removed = Math.max(0, mock.z.length - Number(start));
          mock.z.splice(Number(start));
          out.push(removed);
          break;
        }
        case "zrank": {
          const [key, member] = args;
          if (key !== KEY) throw new Error("mock: unknown key " + key);
          const i = mock.z.findIndex((e) => e.member === member);
          out.push(i === -1 ? null : i);
          break;
        }
        case "incr":
          mock.rl = mock.rl || {};
          mock.rl[args[0]] = (mock.rl[args[0]] || 0) + 1;
          out.push(mock.rl[args[0]]);
          break;
        case "expire":
          out.push(1);
          break;
        default:
          throw new Error("mock: unsupported command " + op);
      }
    }
    return out;
  },
};

async function redis(commands) {
  if (process.env.LEADERBOARD_MOCK === "1") return mockStore.pipeline(commands);
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    throw new Error("leaderboard not configured (missing Upstash env vars)");
  }
  return upstash(commands);
}

// ---- helpers ----------------------------------------------------------------
function clientIp(req) {
  const fwd = (req.headers && (req.headers["x-forwarded-for"] || req.headers["x-vercel-forwarded-for"])) || "";
  const first = String(fwd).split(",")[0].trim();
  return first || (req.socket && req.socket.remoteAddress) || "unknown";
}

function cleanName(raw) {
  let s = String(raw == null ? "" : raw);
  // strip control chars and angle brackets, collapse whitespace
  s = s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/[<>]/g, "");
  s = s.replace(/\s+/g, " ").trim();
  if (!s) s = "Anonymous";
  return s.slice(0, MAX_NAME_LEN);
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
  const body = JSON.stringify(obj);
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(body);
}

module.exports = async function handler(req, res) {
  try {
    if (req.method === "GET") {
      const flat = await redis([["ZRANGE", KEY, "0", String(TOP - 1), "WITHSCORES"]]);
      const top = [];
      const list = Array.isArray(flat[0]) ? flat[0] : [];
      for (let i = 0; i + 1 < list.length; i += 2) {
        let entry = null;
        try { entry = JSON.parse(list[i]); } catch (e) { continue; }
        const ms = Number(list[i + 1]);
        if (!entry || !isFinite(ms)) continue;
        top.push({ name: cleanName(entry.name), ms: Math.round(ms), at: entry.at || null });
      }
      return send(res, 200, { ok: true, top, count: top.length });
    }

    if (req.method === "POST") {
      const ip = clientIp(req);
      const windowKey = "goi:rl:" + ip;
      const countRes = await redis([["INCR", windowKey]]);
      const count = Number(countRes[0]);
      if (count === 1) {
        // fixed 60s window from the first write; do not refresh on retries
        try { await redis([["EXPIRE", windowKey, "60"]]); } catch (e) { /* best effort */ }
      }
      if (count > MAX_WRITES_PER_MINUTE) {
        return send(res, 429, { ok: false, error: "Too many submissions. Try again in a minute." });
      }

      const body = await parseBody(req);
      const ms = Math.round(Number(body && body.ms));
      if (!Number.isFinite(ms) || ms < MIN_MS || ms > MAX_MS) {
        return send(res, 400, { ok: false, error: "Time is out of the allowed range." });
      }
      const entry = {
        name: cleanName(body && body.name),
        ms,
        at: new Date().toISOString(),
        r: Math.random().toString(36).slice(2, 10),
      };
      const member = JSON.stringify(entry);
      const results = await redis([
        ["ZADD", KEY, String(ms), member],
        ["ZREMRANGEBYRANK", KEY, String(MAX_ENTRIES), "-1"],
      ]);
      const rankRes = await redis([["ZRANK", KEY, member]]);
      const rank = rankRes[0] == null ? null : Number(rankRes[0]);
      return send(res, 200, { ok: true, rank, total: MAX_ENTRIES });
    }

    res.setHeader("Allow", "GET, POST");
    return send(res, 405, { ok: false, error: "Method not allowed." });
  } catch (err) {
    console.error("[leaderboard]", err && err.message ? err.message : err);
    return send(res, 500, { ok: false, error: "Leaderboard is unavailable right now." });
  }
};
