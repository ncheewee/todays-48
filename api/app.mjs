import { MAX_MOVES, canMove, dayKey, play } from "../engine.mjs";

const CLIENT_ID = "309032431650-0lbuaj6igc4s9tc0gddv92ffe6ngkrr4.apps.googleusercontent.com";
const JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const ORIGINS = new Set([
  "https://ncheewee.github.io",
  "http://127.0.0.1:8734",
  "http://localhost:8734",
]);

// A JSON move list costs at most 8 characters a move ("right",).
const MAX_BODY = MAX_MOVES * 8 + 1024;

// Signing in with Google trades the hour-long Google ID token for one of our
// own session tokens, so a returning player stays signed in. Each use pushes
// the expiry out again; signing out deletes it. Only a SHA-256 of the token
// is stored, so a database leak can't be replayed as anyone's session.
export const SESSION_DAYS = 60;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;
// Don't rewrite the row on every request; once an hour is plenty.
const SLIDE_AFTER_MS = 60 * 60 * 1000;
export const SESSION_PREFIX = "c48s_";
const SESSION_TOKEN = /^c48s_[A-Za-z0-9_-]{43}$/;

let keyCache = null;

function cors(origin) {
  if (!ORIGINS.has(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
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

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function newSessionToken() {
  return SESSION_PREFIX + base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function hashSessionToken(token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return base64Url(new Uint8Array(digest));
}

export function isSessionToken(token) {
  return typeof token === "string" && SESSION_TOKEN.test(token);
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

export async function verifyGoogle(credential) {
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

function settled(value) {
  if (value === true) return true;
  if (value === false) return false;
  return null;
}

async function standings(pool, day, sub) {
  const listed = await pool.query(
    `select s.google_sub, s.name, s.picture, s.score, s.done, b.pb
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
      `select name, score, done,
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
        done: settled(mine.rows[0].done),
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
      done: settled(row.done),
      you: sub != null && row.google_sub === sub,
    };
  });
  return { day, me, rows };
}

function bearer(request) {
  const header = request.headers.get("Authorization") || "";
  if (!header) return null;
  if (!header.startsWith("Bearer ")) throw new Error("bad credential");
  const token = header.slice("Bearer ".length).trim();
  if (!token) throw new Error("bad credential");
  return token;
}

export function createApp({
  pool,
  verify = verifyGoogle,
  now = () => Date.now(),
  today = () => dayKey(),
}) {
  async function startSession(user) {
    const token = newSessionToken();
    const expires = new Date(now() + SESSION_MS);
    await pool.query(
      `insert into challenge_sessions (token_hash, google_sub, name, picture, expires_at)
       values ($1, $2, $3, $4, $5)`,
      [
        await hashSessionToken(token),
        user.sub,
        displayName(user.name),
        displayPicture(user.picture),
        expires,
      ],
    );
    return { token, expires: expires.getTime() };
  }

  async function useSession(token) {
    const hash = await hashSessionToken(token);
    const found = await pool.query(
      `select google_sub, name, picture, expires_at, refreshed_at
       from challenge_sessions where token_hash = $1`,
      [hash],
    );
    const row = found.rows[0];
    const at = now();
    if (!row || new Date(row.expires_at).getTime() <= at) {
      if (row) await pool.query(`delete from challenge_sessions where token_hash = $1`, [hash]);
      throw new Error("bad credential");
    }
    let expires = new Date(row.expires_at).getTime();
    if (at - new Date(row.refreshed_at).getTime() >= SLIDE_AFTER_MS) {
      expires = at + SESSION_MS;
      await pool.query(
        `update challenge_sessions set expires_at = $2, refreshed_at = $3 where token_hash = $1`,
        [hash, new Date(expires), new Date(at)],
      );
    }
    return {
      user: { sub: row.google_sub, name: row.name, picture: row.picture },
      session: { expires },
    };
  }

  // Returns { user, session } where session is set only for our own tokens.
  async function caller(request) {
    const token = bearer(request);
    if (!token) return { user: null, session: null };
    if (isSessionToken(token)) return useSession(token);
    return { user: await verify(token), session: null };
  }

  return {
    async fetch(request) {
      const origin = request.headers.get("Origin") || "";
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: cors(origin) });
      }
      if (!pool) return json(origin, { error: "unavailable" }, 500);
      try {
        const sessionRoute = new URL(request.url).searchParams.has("session");
        if (sessionRoute) {
          if (request.method === "POST") {
            // Only a fresh Google sign-in can start a session.
            const token = bearer(request);
            if (!token || isSessionToken(token)) return json(origin, { error: "unauthorized" }, 401);
            const user = await verify(token);
            const session = await startSession(user);
            return json(origin, {
              session: {
                ...session,
                sub: user.sub,
                name: displayName(user.name),
                picture: displayPicture(user.picture),
              },
            });
          }
          if (request.method === "DELETE") {
            const token = bearer(request);
            if (isSessionToken(token)) {
              await pool.query(`delete from challenge_sessions where token_hash = $1`, [
                await hashSessionToken(token),
              ]);
            }
            return json(origin, { ok: true });
          }
          return json(origin, { error: "method" }, 405);
        }
        const day = today();
        if (request.method === "GET") {
          const { user, session } = await caller(request);
          return json(origin, { ...(await standings(pool, day, user?.sub ?? null)), session });
        }
        if (request.method !== "POST") return json(origin, { error: "method" }, 405);
        const { user, session } = await caller(request);
        if (!user) return json(origin, { error: "unauthorized" }, 401);
        const text = await request.text();
        if (text.length > MAX_BODY) return json(origin, { error: "bad moves" }, 400);
        let body;
        try {
          body = JSON.parse(text);
        } catch {
          return json(origin, { error: "bad moves" }, 400);
        }
        const played = play(day, body?.moves);
        const score = played.score;
        const done = !canMove(played);
        if (score > 0) {
          await pool.query(
            `insert into challenge_scores (day, google_sub, name, picture, score, done)
             values ($1, $2, $3, $4, $5, $6)
             on conflict (day, google_sub) do update
               set name = excluded.name,
                   picture = excluded.picture,
                   score = excluded.score,
                   done = excluded.done,
                   updated_at = case
                     when challenge_scores.score < excluded.score then now()
                     else challenge_scores.updated_at
                   end
               where challenge_scores.score < excluded.score
                  or (
                    challenge_scores.score = excluded.score
                    and excluded.done
                    and challenge_scores.done is not true
                  )
                  or (
                    challenge_scores.score = excluded.score
                    and not excluded.done
                    and challenge_scores.done is null
                  )`,
            [day, user.sub, displayName(user.name), displayPicture(user.picture), score, done],
          );
        }
        return json(origin, { ...(await standings(pool, day, user.sub)), session });
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
}
