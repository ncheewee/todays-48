import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  SESSION_DAYS,
  createApp,
  hashSessionToken,
  isSessionToken,
  newSessionToken,
} from "../api/app.mjs";
import { play } from "../engine.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
const ORIGIN = "https://ncheewee.github.io";
const GOOGLE = "google.id.token";
const PLAYER = { sub: "g-1", name: "Wee", picture: null, email: "w@example.com" };

// Just enough of Postgres for the queries the API makes.
function fakePool() {
  const sessions = new Map();
  const scores = new Map();
  return {
    sessions,
    scores,
    async query(sql, params = []) {
      const text = sql.replace(/\s+/g, " ").trim();
      if (text.startsWith("insert into challenge_sessions")) {
        const [hash, sub, name, picture, expires] = params;
        sessions.set(hash, {
          google_sub: sub,
          name,
          picture,
          expires_at: expires,
          refreshed_at: new Date(clock.now),
        });
        return { rows: [] };
      }
      if (text.startsWith("select google_sub, name, picture, expires_at")) {
        const row = sessions.get(params[0]);
        return { rows: row ? [row] : [] };
      }
      if (text.startsWith("update challenge_sessions")) {
        const row = sessions.get(params[0]);
        row.expires_at = params[1];
        row.refreshed_at = params[2];
        return { rows: [] };
      }
      if (text.startsWith("delete from challenge_sessions")) {
        sessions.delete(params[0]);
        return { rows: [] };
      }
      if (text.startsWith("insert into challenge_scores")) {
        const [day, sub, name, picture, score, done] = params;
        const key = `${day}|${sub}`;
        const old = scores.get(key);
        if (!old || old.score < score) {
          scores.set(key, { day, google_sub: sub, name, picture, score, done });
        }
        return { rows: [] };
      }
      if (text.startsWith("select s.google_sub")) {
        const rows = [...scores.values()]
          .filter((row) => row.day === params[0])
          .sort((a, b) => b.score - a.score)
          .map((row) => ({ ...row, pb: row.score }));
        return { rows };
      }
      if (text.startsWith("select name, score, done")) {
        const row = scores.get(`${params[0]}|${params[1]}`);
        return { rows: row ? [{ ...row, rank: 1, pb: row.score }] : [] };
      }
      if (text.startsWith("select max(score)::int as pb")) return { rows: [{ pb: null }] };
      throw new Error(`unexpected query: ${text}`);
    },
  };
}

const clock = { now: Date.parse("2026-10-09T02:00:00Z") };

function setup() {
  const pool = fakePool();
  const app = createApp({
    pool,
    today: () => "2026-10-10",
    now: () => clock.now,
    verify: async (token) => {
      if (token !== GOOGLE) throw new Error("bad credential");
      return PLAYER;
    },
  });
  return { pool, app };
}

function call(app, method, { token, query = "", body } = {}) {
  const headers = { Origin: ORIGIN };
  if (token) headers.Authorization = `Bearer ${token}`;
  return app.fetch(
    new Request(`https://board.example/${query}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  );
}

async function signIn(app) {
  const response = await call(app, "POST", { token: GOOGLE, query: "?session" });
  assert.equal(response.status, 200);
  return (await response.json()).session;
}

test("session tokens are random, well formed and stored only as a hash", async () => {
  const a = newSessionToken();
  const b = newSessionToken();
  assert.notEqual(a, b);
  assert.ok(isSessionToken(a));
  assert.equal(isSessionToken(GOOGLE), false);
  const { pool, app } = setup();
  const session = await signIn(app);
  assert.ok(isSessionToken(session.token));
  assert.equal(session.sub, PLAYER.sub);
  assert.equal(session.expires, clock.now + SESSION_DAYS * DAY_MS);
  assert.deepEqual([...pool.sessions.keys()], [await hashSessionToken(session.token)]);
  assert.ok(![...pool.sessions.keys()].includes(session.token));
});

test("a session can only be started with a Google sign-in", async () => {
  const { app } = setup();
  assert.equal((await call(app, "POST", { query: "?session" })).status, 401);
  assert.equal((await call(app, "POST", { token: "forged", query: "?session" })).status, 401);
  const session = await signIn(app);
  const again = await call(app, "POST", { token: session.token, query: "?session" });
  assert.equal(again.status, 401);
});

test("a session signs the player in and stays alive while used", async () => {
  const start = clock.now;
  try {
    const { app } = setup();
    const session = await signIn(app);
    clock.now += 50 * DAY_MS;
    const response = await call(app, "GET", { token: session.token });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.session.expires, clock.now + SESSION_DAYS * DAY_MS);
    clock.now += 50 * DAY_MS;
    assert.equal((await call(app, "GET", { token: session.token })).status, 200);
  } finally {
    clock.now = start;
  }
});

test("an unused session runs out", async () => {
  const start = clock.now;
  try {
    const { pool, app } = setup();
    const session = await signIn(app);
    clock.now += (SESSION_DAYS + 1) * DAY_MS;
    assert.equal((await call(app, "GET", { token: session.token })).status, 401);
    assert.equal(pool.sessions.size, 0);
  } finally {
    clock.now = start;
  }
});

test("signing out deletes the session", async () => {
  const { pool, app } = setup();
  const session = await signIn(app);
  const out = await call(app, "DELETE", { token: session.token, query: "?session" });
  assert.equal(out.status, 200);
  assert.equal(pool.sessions.size, 0);
  assert.equal((await call(app, "GET", { token: session.token })).status, 401);
});

test("a long game posts its full score with a session", async () => {
  const { pool, app } = setup();
  const session = await signIn(app);
  const names = { l: "left", r: "right", u: "up", d: "down" };
  const text = readFileSync(new URL("./fixtures/long-game-2026-10-10.txt", import.meta.url), "utf8");
  const moves = [...text.trim()].map((letter) => names[letter]);
  assert.ok(moves.length > 2000);
  const response = await call(app, "POST", { token: session.token, body: { moves } });
  assert.equal(response.status, 200);
  const stored = pool.scores.get(`2026-10-10|${PLAYER.sub}`);
  assert.equal(stored.score, play("2026-10-10", moves).score);
  assert.ok(stored.score > 100_000);
  assert.equal(stored.done, true);
});

test("the old Google token still works for posting", async () => {
  const { app } = setup();
  const response = await call(app, "POST", { token: GOOGLE, body: { moves: ["left"] } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).session, null);
});
