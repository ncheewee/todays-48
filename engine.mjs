// Walk from the wall inward so each tile merges at most once.
const DIRS = {
  left: { axis: "c", toward: 0 },
  right: { axis: "c", toward: 3 },
  up: { axis: "r", toward: 0 },
  down: { axis: "r", toward: 3 },
};

const DAY = /^\d{4}-\d{2}-\d{2}$/;

// The day's tile stream is a counter, not Math.random. Undo rewinds the
// counter, or the same swipe would spawn a different tile.
export function hashDay(day) {
  let hash = 2166136261;
  const text = `today48:${day}`;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function seededRng(seed) {
  const origin = seed >>> 0;
  let state = origin;
  let draw = 0;

  function step() {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), state | 1);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), state | 61)) ^ mixed;
    draw += 1;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  }

  step.draw = () => draw;
  step.rewind = (count) => {
    state = origin;
    draw = 0;
    for (let i = 0; i < count; i += 1) step();
  };
  return step;
}

const MOVE_NAMES = new Set(["left", "right", "up", "down"]);

export function replay(day, moves) {
  if (!DAY.test(day)) throw new Error("bad day");
  if (!Array.isArray(moves) || moves.length > 2000) throw new Error("bad moves");
  const game = createDaily(day);
  for (const dir of moves) {
    if (!MOVE_NAMES.has(dir)) throw new Error("bad move");
    move(game, dir);
  }
  return game.score;
}

export function dayKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Singapore",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function makeGame(tiles, rng = Math.random, score = 0) {
  let nextId = 1;
  for (const tile of tiles) nextId = Math.max(nextId, tile.id + 1);
  return {
    tiles: tiles.map((tile) => ({
      id: tile.id,
      value: tile.value,
      r: tile.r,
      c: tile.c,
    })),
    score,
    nextId,
    rng,
  };
}

export function createGame(rng = Math.random) {
  const game = makeGame([], rng, 0);
  spawn(game);
  spawn(game);
  return game;
}

export function createDaily(day) {
  if (!DAY.test(day)) throw new Error("bad day");
  const game = createGame(seededRng(hashDay(day)));
  game.day = day;
  return game;
}

export function resumeDaily(day, tiles, score, draw) {
  if (!DAY.test(day)) throw new Error("bad day");
  const rng = seededRng(hashDay(day));
  rng.rewind(draw);
  const game = makeGame(tiles, rng, score);
  game.day = day;
  return game;
}

function spawn(game) {
  const taken = new Set(game.tiles.map((tile) => tile.r * 4 + tile.c));
  const empty = [];
  for (let i = 0; i < 16; i += 1) if (!taken.has(i)) empty.push(i);
  if (!empty.length) return null;
  const cell = empty[Math.floor(game.rng() * empty.length)];
  const value = game.rng() < 0.9 ? 2 : 4;
  const tile = {
    id: game.nextId,
    value,
    r: Math.floor(cell / 4),
    c: cell % 4,
    fresh: true,
  };
  game.nextId += 1;
  game.tiles.push(tile);
  return tile;
}

export function move(game, dir) {
  const spec = DIRS[dir];
  if (!spec) return { moved: false, gained: 0, removed: [] };

  for (const tile of game.tiles) {
    delete tile.fresh;
    delete tile.merged;
  }

  const before = new Map(game.tiles.map((tile) => [tile.id, tile.r * 4 + tile.c]));
  const lines = [[], [], [], []];
  for (const tile of game.tiles) {
    const index = spec.axis === "c" ? tile.r : tile.c;
    lines[index].push(tile);
  }

  let gained = 0;
  const removed = [];
  const next = [];
  const step = spec.toward === 0 ? 1 : -1;

  for (const line of lines) {
    line.sort((a, b) =>
      spec.toward === 0 ? a[spec.axis] - b[spec.axis] : b[spec.axis] - a[spec.axis],
    );
    let cursor = spec.toward;
    for (let i = 0; i < line.length; i += 1) {
      const tile = line[i];
      if (i + 1 < line.length && line[i + 1].value === tile.value) {
        const eaten = line[i + 1];
        i += 1;
        tile.value *= 2;
        gained += tile.value;
        tile.merged = true;
        tile[spec.axis] = cursor;
        removed.push({
          id: eaten.id,
          value: eaten.value,
          toR: tile.r,
          toC: tile.c,
        });
      } else {
        tile[spec.axis] = cursor;
      }
      cursor += step;
      next.push(tile);
    }
  }

  const moved =
    removed.length > 0 || next.some((tile) => before.get(tile.id) !== tile.r * 4 + tile.c);
  if (!moved) {
    for (const tile of next) delete tile.merged;
    return { moved: false, gained: 0, removed: [] };
  }

  game.tiles = next;
  game.score += gained;
  spawn(game);
  return { moved: true, gained, removed };
}

export function canMove(game) {
  if (game.tiles.length < 16) return true;
  const grid = Array.from({ length: 4 }, () => Array(4).fill(0));
  for (const tile of game.tiles) grid[tile.r][tile.c] = tile.value;
  for (let r = 0; r < 4; r += 1) {
    for (let c = 0; c < 4; c += 1) {
      if (c < 3 && grid[r][c] === grid[r][c + 1]) return true;
      if (r < 3 && grid[r][c] === grid[r + 1][c]) return true;
    }
  }
  return false;
}

export function snapshot(game) {
  return {
    tiles: game.tiles.map(({ id, value, r, c }) => ({ id, value, r, c })),
    score: game.score,
    nextId: game.nextId,
    draw: typeof game.rng.draw === "function" ? game.rng.draw() : 0,
  };
}

export function restore(game, snap) {
  game.tiles = snap.tiles.map((tile) => ({ ...tile }));
  game.score = snap.score;
  game.nextId = snap.nextId;
  if (typeof game.rng.rewind === "function") game.rng.rewind(snap.draw || 0);
}
