import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  MAX_DRAWS,
  MAX_MOVES,
  canMove,
  createDaily,
  createGame,
  dayKey,
  hashDay,
  makeGame,
  move,
  play,
  replay,
  resumeDaily,
  restore,
  seededRng,
  snapshot,
} from "../engine.mjs";

function cells(game) {
  return game.tiles
    .map((tile) => `${tile.r},${tile.c}:${tile.value}`)
    .sort()
    .join(" ");
}

function scripted(values) {
  let index = 0;
  return () => {
    const value = values[index % values.length];
    index += 1;
    return value;
  };
}

function overlaps(game) {
  const seen = new Set();
  for (const tile of game.tiles) {
    const key = `${tile.r},${tile.c}`;
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

function firstMove(day) {
  const probe = createDaily(day);
  for (const dir of ["left", "right", "up", "down"]) {
    if (move(probe, dir).moved) return dir;
  }
  throw new Error("opening board has no move");
}

test("left merges a pair once and does not chain the result", () => {
  const game = makeGame(
    [
      { id: 1, value: 2, r: 0, c: 0 },
      { id: 2, value: 2, r: 0, c: 1 },
      { id: 3, value: 2, r: 0, c: 2 },
      { id: 4, value: 2, r: 0, c: 3 },
    ],
    () => 0,
  );
  const result = move(game, "left");
  assert.equal(result.moved, true);
  assert.equal(result.gained, 8);
  assert.equal(result.removed.length, 2);
  const row = game.tiles.filter((tile) => tile.r === 0).sort((a, b) => a.c - b.c);
  assert.deepEqual(
    row.slice(0, 2).map((tile) => tile.value),
    [4, 4],
  );
  assert.equal(game.score, 8);
  assert.equal(game.tiles.length, 3);
});

test("three twos become a four and a two, not an eight", () => {
  const game = makeGame(
    [
      { id: 1, value: 2, r: 0, c: 0 },
      { id: 2, value: 2, r: 0, c: 1 },
      { id: 3, value: 2, r: 0, c: 2 },
    ],
    () => 0.95,
  );
  move(game, "left");
  const row = game.tiles.filter((tile) => tile.r === 0).sort((a, b) => a.c - b.c);
  assert.deepEqual(
    row.slice(0, 2).map((tile) => [tile.c, tile.value]),
    [
      [0, 4],
      [1, 2],
    ],
  );
});

test("right merges the pair closest to the wall", () => {
  const game = makeGame(
    [
      { id: 1, value: 2, r: 1, c: 0 },
      { id: 2, value: 2, r: 1, c: 1 },
      { id: 3, value: 2, r: 1, c: 2 },
    ],
    () => 0,
  );
  const result = move(game, "right");
  assert.equal(result.gained, 4);
  const row = game.tiles.filter((tile) => tile.r === 1).sort((a, b) => a.c - b.c);
  assert.deepEqual(
    row.filter((tile) => tile.value !== 2 || tile.c >= 2).map((tile) => [tile.c, tile.value]),
    [
      [2, 2],
      [3, 4],
    ],
  );
});

test("up slides a tile to the top wall", () => {
  const game = makeGame([{ id: 1, value: 8, r: 3, c: 2 }], () => 0);
  move(game, "up");
  const moved = game.tiles.find((tile) => tile.value === 8);
  assert.equal(moved.r, 0);
  assert.equal(moved.c, 2);
});

test("a packed row does not spawn or score", () => {
  const tiles = [
    { id: 1, value: 2, r: 0, c: 0 },
    { id: 2, value: 4, r: 0, c: 1 },
    { id: 3, value: 8, r: 0, c: 2 },
    { id: 4, value: 16, r: 0, c: 3 },
  ];
  const game = makeGame(tiles, () => 0);
  const before = cells(game);
  const result = move(game, "left");
  assert.equal(result.moved, false);
  assert.equal(result.gained, 0);
  assert.equal(game.score, 0);
  assert.equal(cells(game), before);
  assert.equal(game.nextId, 5);
});

test("a full board with no neighbors cannot move", () => {
  const tiles = [];
  let id = 1;
  for (let r = 0; r < 4; r += 1) {
    for (let c = 0; c < 4; c += 1) {
      tiles.push({ id, value: (r + c) % 2 === 0 ? 2 : 4, r, c });
      id += 1;
    }
  }
  const game = makeGame(tiles);
  assert.equal(canMove(game), false);
  tiles[1].value = 2;
  const open = makeGame(tiles);
  assert.equal(canMove(open), true);
});

test("snapshot and restore rewind a merge", () => {
  const game = makeGame(
    [
      { id: 1, value: 16, r: 2, c: 0 },
      { id: 2, value: 16, r: 2, c: 3 },
    ],
    () => 0,
  );
  const before = snapshot(game);
  move(game, "left");
  assert.equal(game.score, 32);
  restore(game, before);
  assert.equal(game.score, 0);
  assert.equal(cells(game), "2,0:16 2,3:16");
});

test("opening deal places two tiles and random play stays legal", () => {
  let seed = 7;
  const rng = () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const game = createGame(rng);
  assert.equal(game.tiles.length, 2);
  assert.equal(overlaps(game), false);

  const dirs = ["left", "up", "right", "down"];
  for (let turn = 0; turn < 200 && canMove(game); turn += 1) {
    const before = game.tiles.length;
    const score = game.score;
    let result = { moved: false, removed: [] };
    for (const dir of dirs) {
      result = move(game, dir);
      if (result.moved) break;
    }
    if (!result.moved) break;
    assert.equal(game.tiles.length, before - result.removed.length + 1);
    assert.equal(game.score, score + result.gained);
    assert.equal(overlaps(game), false);
    for (const tile of game.tiles) assert.equal(Math.log2(tile.value) % 1, 0);
  }
});

test("scripted rolls can spawn a four", () => {
  const game = createGame(scripted([0, 0.95]));
  assert.equal(game.tiles.length, 2);
  assert.ok(game.tiles.some((tile) => tile.value === 4));
});

test("the same day deals the same board and the same later tiles", () => {
  const dirs = ["left", "up", "right", "down", "left", "left", "down", "right", "up", "left"];
  function play(day) {
    const game = createDaily(day);
    for (const dir of dirs) move(game, dir);
    return [cells(game), game.score, game.rng.draw()];
  }
  assert.deepEqual(play("2026-10-05"), play("2026-10-05"));
  assert.notDeepEqual(play("2026-10-05"), play("2026-10-06"));
});

test("the day hash stays put", () => {
  assert.equal(hashDay("2026-10-05"), 614918700);
  assert.notEqual(hashDay("2026-10-05"), hashDay("2026-10-06"));
});

test("undo puts the same tile back", () => {
  const day = "2026-10-05";
  const game = createDaily(day);
  const dir = firstMove(day);
  const before = snapshot(game);
  move(game, dir);
  const after = cells(game);
  const draws = game.rng.draw();
  assert.notEqual(after, cellsFrom(before));
  restore(game, before);
  assert.equal(game.rng.draw(), before.draw);
  assert.equal(cells(game), cellsFrom(before));
  move(game, dir);
  assert.equal(cells(game), after);
  assert.equal(game.rng.draw(), draws);
});

test("a move that does nothing does not spend a tile", () => {
  const rng = seededRng(1);
  const game = makeGame(
    [
      { id: 1, value: 2, r: 0, c: 0 },
      { id: 2, value: 4, r: 0, c: 1 },
      { id: 3, value: 8, r: 0, c: 2 },
      { id: 4, value: 16, r: 0, c: 3 },
    ],
    rng,
  );
  const draw = rng.draw();
  const result = move(game, "left");
  assert.equal(result.moved, false);
  assert.equal(rng.draw(), draw);
});

test("resuming a day continues its tile stream", () => {
  const day = "2026-10-05";
  const game = createDaily(day);
  const dir = firstMove(day);
  const saved = snapshot(game);
  move(game, dir);
  const resumed = resumeDaily(day, saved.tiles, saved.score, saved.draw);
  move(resumed, dir);
  assert.equal(cells(resumed), cells(game));
  assert.equal(resumed.score, game.score);
  assert.equal(resumed.rng.draw(), game.rng.draw());
});

test("the puzzle flips at midnight in Singapore", () => {
  assert.equal(dayKey(new Date("2026-10-04T15:59:00Z")), "2026-10-04");
  assert.equal(dayKey(new Date("2026-10-04T16:30:00Z")), "2026-10-05");
});

test("a day that is not a date is rejected", () => {
  assert.throws(() => createDaily("yesterday"), /bad day/);
});

test("replay scores the same moves the game would", () => {
  const day = "2026-10-06";
  const moves = ["left", "up", "right", "down", "left", "left", "up"];
  const game = createDaily(day);
  for (const dir of moves) move(game, dir);
  assert.equal(replay(day, moves), game.score);
  assert.throws(() => replay(day, ["sideways"]), /bad move/);
});

test("a replay knows when no moves remain", () => {
  const day = "2026-10-08";
  const dirs = ["left", "right", "up", "down"];
  const moves = [];
  const game = createDaily(day);
  assert.equal(canMove(play(day, [])), true);
  for (let turn = 0; turn < 2000 && canMove(game); turn += 1) {
    for (const dir of dirs) {
      const result = move(game, dir);
      if (!result.moved) continue;
      moves.push(dir);
      break;
    }
  }
  assert.equal(canMove(game), false);
  const played = play(day, moves);
  assert.equal(played.score, game.score);
  assert.equal(canMove(played), false);
  assert.equal(replay(day, moves), played.score);
});

function cellsFrom(snap) {
  return snap.tiles
    .map((tile) => `${tile.r},${tile.c}:${tile.value}`)
    .sort()
    .join(" ");
}

// A real game on the 2026-10-10 board that runs to 4652 moves and an 8192
// tile. Before the fix the 2000-move cap stopped it at 46,204 points.
function longGame() {
  const text = readFileSync(new URL("./fixtures/long-game-2026-10-10.txt", import.meta.url), "utf8");
  const names = { l: "left", r: "right", u: "up", d: "down" };
  return [...text.trim()].map((letter) => names[letter]);
}

test("a game longer than 2000 moves still counts in full", () => {
  const day = "2026-10-10";
  const moves = longGame();
  assert.ok(moves.length > 2000);
  const game = createDaily(day);
  for (const dir of moves) assert.equal(move(game, dir).moved, true);
  const played = play(day, moves);
  assert.equal(played.score, game.score);
  assert.ok(played.score > 100_000);
  assert.ok(played.score > play(day, moves.slice(0, 2000)).score);
  assert.ok(Math.max(...played.tiles.map((tile) => tile.value)) >= 8192);
  assert.equal(canMove(played), false);
  assert.ok(game.rng.draw() <= MAX_DRAWS);
});

test("the move cap still turns away lists no game could produce", () => {
  assert.ok(MAX_MOVES >= 100_000);
  assert.throws(() => play("2026-10-10", Array(MAX_MOVES + 1).fill("left")), /bad moves/);
});
