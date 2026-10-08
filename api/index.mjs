import pg from "pg";
import { dayKey, replay } from "../engine.mjs";

const CLIENT_ID = "309032431650-0lbuaj6igc4s9tc0gddv92ffe6ngkrr4.apps.googleusercontent.com";
const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ORIGINS = new Set([
  "https://ncheewee.github.io",
  "http://127.0.0.1:8734",
  "http://localhost:8734",
]);

const pool = process.env.DATABASE_URL
  ? new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 })
  : null;
pool?.on("error", () => {});

let keyCache = null;

function cors(origin) {
  if (!ORIGINS.has(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(origin, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...cors(origin),
    },
  });
}

function bytesFromBase64Url(value) {
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    throw new Error("bad credential");
  }
}

function decodePart(value) {
  try {
    return JSON.parse(new TextDecoder().decode(bytesFromBase64Url(value)));
  } catch (error) {
    if (error instanceof Error && error.message === "bad credential") throw error;
    throw new Error("bad credential");
  }
}

async function googleKeys() {
  const now = Date.now();
  if (keyCache && keyCache.until > now + 60_000) return keyCache.keys;
  const response = await fetch(JWKS_URL, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error("Google certs unavailable");
  const payload = await response.json();
  const maxAge = Number(response.headers.get("Cache-Control")?.match(/max-age=(\d+)/)?.[1] ?? 3600);
  keyCache = { keys: payload.keys ?? [], until: now + Math.max(300, maxAge) * 1000 };
  return keyCache.keys;
}

async function verify(credential) {
  const parts = String(credential).split(".");
  if (parts.length !== 3 || credential.length > 8000) throw new Error("bad credential");
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodePart(encodedHeader);
  const payload = decodePart(encodedPayload);
  if (header?.alg !== "RS256" || !header?.kid) throw new Error("bad credential");
  const key = (await googleKeys()).find((candidate) => candidate.kid === header.kid);
  if (!key) throw new Error("bad credential");
  let valid = false;
  try {
    const cryptoKey = await crypto.subtle.importKey(
      "jwk",
      key,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
    valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      cryptoKey,
      bytesFromBase64Url(encodedSignature),
      new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
    );
  } catch (error) {
    if (error instanceof Error && error.message === "bad credential") throw error;
    throw new Error("bad credential");
  }
  if (!valid) throw new Error("bad credential");
  if (payload?.aud !== CLIENT_ID) throw new Error("bad credential");
  if (payload?.iss !== "accounts.google.com" && payload?.iss !== "https://accounts.google.com") {
    throw new Error("bad credential");
  }
  if (!payload?.exp || payload.exp * 1000 <= Date.now()) throw new Error("bad credential");
  if (!payload?.sub || !payload?.email) throw new Error("bad credential");
  if (payload.email_verified !== true && payload.email_verified !== "true") throw new Error("bad credential");
  return payload;
}

function displayName(value) {
  const cleaned = String(value || "").replace(/[<>]/g, "").trim().slice(0, 40);
  return cleaned || "Player";
}

function displayPicture(value) {
  if (typeof value !== "string" || value.length > 500) return null;
  try {
    const url = new URL(value);
    const host = url.hostname;
    if (url.protocol !== "https:") return null;
    if (host !== "googleusercontent.com" && !host.endsWith(".googleusercontent.com")) return null;
    return url.href;
  } catch {
    return null;
  }
}

function wholeNumber(value) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 ? number : null;
}

async function standings(day, sub) {
  const listed = await pool.query(
    `select s.google_sub, s.name, s.picture, s.score, b.pb
     from challenge_scores s
     join (
       select google_sub, max(score)::int as pb
       from challenge_scores
       group by google_sub
     ) b on b.google_sub = s.google_sub
     where s.day = $1
     order by s.score desc, s.updated_at asc
     limit 20`,
    [day],
  );
  let me = null;
  if (sub) {
    const mine = await pool.query(
      `select name, score,
              1 + (select count(*)::int from challenge_scores other
                   where other.day = $1 and other.score > challenge_scores.score) as rank,
              (select max(score)::int from challenge_scores earlier
               where earlier.google_sub = challenge_scores.google_sub) as pb
       from challenge_scores
       where day = $1 and google_sub = $2`,
      [day, sub],
    );
    if (mine.rows[0]) {
      me = {
        name: mine.rows[0].name,
        score: mine.rows[0].score,
        rank: mine.rows[0].rank,
        pb: wholeNumber(mine.rows[0].pb),
      };
    } else {
      const earlier = await pool.query(
        `select max(score)::int as pb from challenge_scores where google_sub = $1`,
        [sub],
      );
      const pb = wholeNumber(earlier.rows[0]?.pb);
      if (pb) me = { pb };
    }
  }
  let lastScore = null;
  let lastRank = 0;
  const rows = listed.rows.map((row, index) => {
    const rank = row.score === lastScore ? lastRank : index + 1;
    lastScore = row.score;
    lastRank = rank;
    return {
      rank,
      name: row.name,
      picture: row.picture,
      score: row.score,
      pb: wholeNumber(row.pb),
      you: sub != null && row.google_sub === sub,
    };
  });
  return { day, me, rows };
}

async function caller(request) {
  const header = request.headers.get("Authorization") || "";
  if (!header) return null;
  if (!header.startsWith("Bearer ")) throw new Error("bad credential");
  const token = header.slice("Bearer ".length).trim();
  if (!token) throw new Error("bad credential");
  return verify(token);
}

export default {
  async fetch(request) {
    const origin = request.headers.get("Origin") || "";
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(origin) });
    }
    if (!pool) return json(origin, { error: "unavailable" }, 500);
    try {
      const day = dayKey();
      if (request.method === "GET") {
        const user = await caller(request);
        return json(origin, await standings(day, user?.sub ?? null));
      }
      if (request.method !== "POST") return json(origin, { error: "method" }, 405);
      const user = await caller(request);
      if (!user) return json(origin, { error: "unauthorized" }, 401);
      const text = await request.text();
      if (text.length > 64_000) return json(origin, { error: "bad moves" }, 400);
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        return json(origin, { error: "bad moves" }, 400);
      }
      const score = replay(day, body?.moves);
      if (score > 0) {
        await pool.query(
          `insert into challenge_scores (day, google_sub, name, picture, score)
           values ($1, $2, $3, $4, $5)
           on conflict (day, google_sub) do update
             set name = excluded.name,
                 picture = excluded.picture,
                 score = excluded.score,
                 updated_at = now()
             where challenge_scores.score < excluded.score`,
          [day, user.sub, displayName(user.name), displayPicture(user.picture), score],
        );
      }
      return json(origin, await standings(day, user.sub));
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message === "bad credential") return json(origin, { error: "unauthorized" }, 401);
      if (message === "bad moves" || message === "bad move" || message === "bad day") {
        return json(origin, { error: "bad moves" }, 400);
      }
      return json(origin, { error: "unavailable" }, 500);
    }
  },
};
