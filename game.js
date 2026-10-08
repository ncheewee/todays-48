import {
  canMove,
  createDaily,
  dayKey,
  move,
  restore,
  resumeDaily,
  snapshot,
} from "./engine.mjs";

const SAVE_KEY = "today48-save";
const SESSION_KEY = "challenge48-session";
const CLIENT_ID = "309032431650-0lbuaj6igc4s9tc0gddv92ffe6ngkrr4.apps.googleusercontent.com";
const BOARD_API = "https://br-silent-salad-az0i47x7-board.compute.c-3.ap-southeast-1.aws.neon.tech/";
const MOVE_NAMES = new Set(["left", "right", "up", "down"]);

const board = document.getElementById("board");
const tilesEl = document.getElementById("tiles");
const scoreEl = document.getElementById("score");
const bestEl = document.getElementById("best");
const scoreBox = document.getElementById("score-box");
const whenEl = document.getElementById("when");
const newBtn = document.getElementById("new");
const undoBtn = document.getElementById("undo");
const installBtn = document.getElementById("install");
const note = document.getElementById("note");
const googleEl = document.getElementById("google");
const whoYou = document.getElementById("who-you");
const whoPic = document.getElementById("who-pic");
const whoName = document.getElementById("who-name");
const signOutBtn = document.getElementById("sign-out");
const rankEl = document.getElementById("rank");
const openBoardBtn = document.getElementById("open-board");
const standings = document.getElementById("standings");
const standingsWhen = document.getElementById("standings-when");
const standingsList = document.getElementById("standings-list");
const standingsEmpty = document.getElementById("standings-empty");
const standingsClose = document.getElementById("standings-close");
const net = document.getElementById("net");
const status = document.getElementById("status");
const app = document.getElementById("app");
const modal = document.getElementById("modal");
const modalTitle = document.getElementById("modal-title");
const modalBody = document.getElementById("modal-body");
const modalActions = document.getElementById("modal-actions");

let puzzleDay = dayKey();
let game = createDaily(puzzleDay);
let best = 0;
let bestMark = 0;
let continued = false;
let moves = [];
let movesTrusted = true;
let undoStack = [];
let busy = false;
let boardMe = null;
let knownPb = null;
let boardEpoch = 0;
let submitTimer = 0;
let googleReady = false;
let queued = null;
let modalKind = null;
let deferredPrompt = null;

function isPowerOfTwo(value) {
  if (!Number.isInteger(value) || value < 2) return false;
  return Math.log2(value) % 1 === 0;
}

function prettyDay(day) {
  const [year, month, date] = day.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  }).format(new Date(Date.UTC(year, month - 1, date)));
}

function paintDate() {
  whenEl.textContent = `${prettyDay(puzzleDay)} · one board for everyone`;
}

function readSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || data.v !== 1 || data.day !== dayKey()) return null;
    if (!Array.isArray(data.tiles) || data.tiles.length > 16) return null;
    if (!Number.isInteger(data.draw) || data.draw < 0 || data.draw > 10000) return null;
    const seen = new Set();
    for (const tile of data.tiles) {
      if (!tile || !Number.isInteger(tile.id) || !isPowerOfTwo(tile.value)) return null;
      if (tile.r < 0 || tile.r > 3 || tile.c < 0 || tile.c > 3) return null;
      const key = `${tile.r},${tile.c}`;
      if (seen.has(key)) return null;
      seen.add(key);
    }
    return data;
  } catch {
    return null;
  }
}

function validMoves(list) {
  if (!Array.isArray(list) || list.length > 2000) return null;
  if (!list.every((dir) => MOVE_NAMES.has(dir))) return null;
  return list.slice();
}

function save() {
  try {
    const payload = {
      v: 1,
      day: puzzleDay,
      tiles: game.tiles.map(({ id, value, r, c }) => ({ id, value, r, c })),
      score: game.score,
      nextId: game.nextId,
      draw: game.rng.draw(),
      best,
      continued,
    };
    if (movesTrusted) payload.moves = moves;
    localStorage.setItem(SAVE_KEY, JSON.stringify(payload));
  } catch {
    // Private mode can block storage. The board still plays for this visit.
  }
}

function boot() {
  puzzleDay = dayKey();
  const saved = readSave();
  if (!saved) {
    game = createDaily(puzzleDay);
    best = 0;
    bestMark = 0;
    continued = false;
    moves = [];
    movesTrusted = true;
    save();
    return;
  }
  const tracked = validMoves(saved.moves);
  if (tracked) {
    moves = tracked;
    movesTrusted = true;
  } else if ((saved.score || 0) === 0 && !Array.isArray(saved.moves)) {
    moves = [];
    movesTrusted = true;
  } else {
    moves = [];
    movesTrusted = false;
  }
  game = resumeDaily(puzzleDay, saved.tiles, saved.score || 0, saved.draw);
  const maxId = saved.tiles.reduce((max, tile) => Math.max(max, tile.id), 0);
  game.nextId = Math.max(saved.nextId || 1, maxId + 1);
  bestMark = saved.best || 0;
  best = Math.max(bestMark, game.score);
  continued = !!saved.continued;
}

function sizeClass(value) {
  if (value >= 1024) return "tiny";
  if (value >= 128) return "small";
  return "";
}

function paintTile(el, tile) {
  el.dataset.value = String(tile.value);
  el.textContent = String(tile.value);
  el.style.setProperty("--r", tile.r);
  el.style.setProperty("--c", tile.c);
  el.classList.remove("fresh", "pop", "small", "tiny", "legend");
  const sized = sizeClass(tile.value);
  if (sized) el.classList.add(sized);
  if (tile.value > 8192) el.classList.add("legend");
  if (tile.fresh) el.classList.add("fresh");
  if (tile.merged) {
    void el.offsetWidth;
    el.classList.add("pop");
  }
  delete tile.fresh;
  delete tile.merged;
}

function render(removed = []) {
  const nodes = new Map([...tilesEl.querySelectorAll(".tile")].map((el) => [el.dataset.id, el]));
  const dying = new Map(removed.map((tile) => [String(tile.id), tile]));

  for (const tile of game.tiles) {
    let el = nodes.get(String(tile.id));
    if (!el) {
      el = document.createElement("div");
      el.className = "tile";
      el.dataset.id = String(tile.id);
      tilesEl.appendChild(el);
    } else {
      nodes.delete(String(tile.id));
    }
    paintTile(el, tile);
  }

  for (const [id, el] of nodes) {
    const ghost = dying.get(id);
    if (!ghost) {
      el.remove();
      continue;
    }
    el.classList.add("dying");
    el.classList.remove("fresh", "pop");
    el.style.setProperty("--r", ghost.toR);
    el.style.setProperty("--c", ghost.toC);
    const drop = () => el.remove();
    el.addEventListener("transitionend", drop, { once: true });
    setTimeout(drop, 200);
  }
}

function paintScore(gained = 0) {
  scoreEl.textContent = String(game.score);
  bestEl.textContent = String(best);
  if (gained > 0) {
    scoreBox.classList.remove("bump");
    void scoreBox.offsetWidth;
    scoreBox.classList.add("bump");
    const floater = document.createElement("em");
    floater.className = "gain";
    floater.textContent = `+${gained}`;
    scoreBox.appendChild(floater);
    floater.addEventListener("animationend", () => floater.remove());
    setTimeout(() => floater.remove(), 700);
  }
}

function syncUndo() {
  undoBtn.disabled = undoStack.length === 0 || busy;
}

function setStatus(text) {
  status.textContent = text;
}

function hasWon() {
  return game.tiles.some((tile) => tile.value >= 2048);
}

function scoreLine() {
  const line = `Score ${game.score}.`;
  if (Number.isInteger(knownPb) && game.score > knownPb) return `${line} That’s a new personal best.`;
  if (game.score > bestMark) return `${line} That’s a new best for today.`;
  return line;
}

function syncNet() {
  net.hidden = navigator.onLine;
}

function closeModal() {
  modalKind = null;
  modal.hidden = true;
  app.removeAttribute("aria-hidden");
  newBtn.focus({ preventScroll: true });
}

function focusables() {
  return [...modalActions.querySelectorAll("button:not([disabled])")];
}

function openModal(kind) {
  modalKind = kind;
  queued = null;
  const copy = {
    win: ["2048", "That tile is yours. Today’s board is still open.", ["keep", "undo", "fresh"]],
    winlose: ["2048", `You made it, and the board is full. ${scoreLine()}`, ["fresh", "undo"]],
    lose: ["No moves left", scoreLine(), ["fresh", "undo"]],
    confirm: ["Replay today?", "The board goes back to this morning’s deal. Your best for today stays.", ["fresh", "dismiss"]],
    nextday: ["New day", "Yesterday’s board is over. Today’s puzzle is ready.", ["roll"]],
  };
  const [title, body, actions] = copy[kind];
  modalTitle.textContent = title;
  modalBody.textContent = body;
  modalActions.replaceChildren();
  const labels = {
    keep: ["Keep going", false],
    undo: ["Undo", true],
    fresh: [kind === "confirm" ? "Start over" : "Replay", kind === "win"],
    dismiss: ["Keep playing", true],
    roll: ["Play today", false],
  };
  for (const action of actions) {
    if (action === "undo" && undoStack.length === 0) continue;
    const [label, ghost] = labels[action];
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    if (ghost) button.className = "ghost";
    button.addEventListener("click", () => runAction(action));
    modalActions.appendChild(button);
  }
  modal.hidden = false;
  app.setAttribute("aria-hidden", "true");
  focusables()[0]?.focus();
}

function maybeModalOnLoad() {
  const dead = !canMove(game);
  const won = !continued && hasWon();
  if (won && dead) openModal("winlose");
  else if (dead) openModal("lose");
  else if (won) openModal("win");
}

function beginToday() {
  puzzleDay = dayKey();
  best = 0;
  bestMark = 0;
  continued = false;
  moves = [];
  movesTrusted = true;
  undoStack = [];
  queued = null;
  busy = false;
  game = createDaily(puzzleDay);
  save();
  closeModal();
  render();
  paintScore();
  paintDate();
  syncUndo();
  setStatus(`Today’s board, ${prettyDay(puzzleDay)}.`);
  loadBoard();
}

function startNew() {
  if (dayKey() !== puzzleDay) {
    beginToday();
    return;
  }
  queued = null;
  busy = false;
  continued = false;
  moves = [];
  movesTrusted = true;
  undoStack = [];
  bestMark = best;
  game = createDaily(puzzleDay);
  save();
  closeModal();
  render();
  paintScore();
  syncUndo();
  setStatus("Back to this morning’s deal.");
}

function undo() {
  if (!undoStack.length) return;
  const snap = undoStack.pop();
  if (movesTrusted && moves.length) moves.pop();
  restore(game, snap);
  if (!hasWon()) continued = false;
  busy = false;
  queued = null;
  save();
  closeModal();
  render();
  paintScore();
  syncUndo();
  setStatus(`Undone. Score ${game.score}.`);
  if (movesTrusted && readSession() && game.score > 0) scheduleSubmit();
  else clearTimeout(submitTimer);
}

function runAction(action) {
  if (action === "roll") {
    beginToday();
    return;
  }
  if (action === "keep" || action === "dismiss") {
    if (action === "keep") {
      continued = true;
      save();
      setStatus("Continuing past 2048.");
    }
    closeModal();
    return;
  }
  if (action === "undo") {
    undo();
    return;
  }
  if (action === "fresh") startNew();
}

function ensureToday() {
  if (dayKey() === puzzleDay) return true;
  openModal("nextday");
  return false;
}

function tryMove(dir) {
  const before = snapshot(game);
  const result = move(game, dir);
  if (!result.moved) return null;
  if (movesTrusted) {
    if (moves.length >= 2000) {
      movesTrusted = false;
      moves = [];
    } else {
      moves.push(dir);
    }
  }
  undoStack.push(before);
  if (undoStack.length > 40) undoStack.shift();
  if (game.score > best) best = game.score;
  const won = !continued && hasWon();
  const dead = !canMove(game);
  save();
  render(result.removed);
  paintScore(result.gained);
  syncUndo();
  const way = dir.charAt(0).toUpperCase() + dir.slice(1);
  if (won && dead) setStatus(`${way}. You made 2048 and no moves remain. ${scoreLine()}`);
  else if (dead) setStatus(`No moves left. ${scoreLine()}`);
  else if (won) setStatus(`${way}. You made 2048. ${scoreLine()}`);
  else if (result.gained) setStatus(`${way}. Plus ${result.gained}. Score ${game.score}.`);
  else setStatus(`${way}. Score ${game.score}.`);
  if (won && dead) openModal("winlose");
  else if (dead) openModal("lose");
  else if (won) openModal("win");
  if (movesTrusted && readSession() && game.score > 0) scheduleSubmit();
  return result;
}

function release() {
  busy = false;
  syncUndo();
  if (modalKind) {
    queued = null;
    return;
  }
  const next = queued;
  queued = null;
  if (next) onInput(next);
}

function onInput(dir) {
  if (modalKind || !standings.hidden) return;
  if (!ensureToday()) return;
  if (busy) {
    queued = dir;
    return;
  }
  const result = tryMove(dir);
  if (!result) return;
  busy = true;
  syncUndo();
  setTimeout(release, 130);
}

const KEYS = {
  ArrowLeft: "left",
  ArrowRight: "right",
  ArrowUp: "up",
  ArrowDown: "down",
  a: "left",
  d: "right",
  w: "up",
  s: "down",
};

window.addEventListener("keydown", (event) => {
  if (!modalKind && !standings.hidden && event.key === "Escape") {
    event.preventDefault();
    closeStandings();
    return;
  }
  if (modalKind && event.key === "Escape") {
    event.preventDefault();
    if (modalKind === "win") runAction("keep");
    else if (modalKind === "confirm") runAction("dismiss");
    else if (modalKind === "nextday") runAction("roll");
    else if (undoStack.length) undo();
    return;
  }
  if (modalKind && event.key === "Tab") {
    const items = focusables();
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
    return;
  }
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  const dir = KEYS[key];
  if (!dir) return;
  event.preventDefault();
  onInput(dir);
});

let pointer = null;
board.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  pointer = { x: event.clientX, y: event.clientY, id: event.pointerId };
  try {
    board.setPointerCapture(event.pointerId);
  } catch {
    // A few browsers reject capture for an untrusted pointer. The swipe still ends on pointerup.
  }
});

function finishPointer(event) {
  if (!pointer || pointer.id !== event.pointerId) return;
  const dx = event.clientX - pointer.x;
  const dy = event.clientY - pointer.y;
  pointer = null;
  if (Math.hypot(dx, dy) < 24) return;
  onInput(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up");
}

board.addEventListener("pointerup", finishPointer);
board.addEventListener("pointercancel", () => {
  pointer = null;
});

newBtn.addEventListener("click", () => {
  if (modalKind) return;
  if (!ensureToday()) return;
  if (game.score === 0 && undoStack.length === 0) startNew();
  else openModal("confirm");
});
undoBtn.addEventListener("click", () => {
  if (!busy) undo();
});

window.addEventListener("online", () => {
  syncNet();
  loadBoard();
});
window.addEventListener("offline", () => {
  syncNet();
  paintRank();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && dayKey() !== puzzleDay && modalKind !== "nextday") {
    openModal("nextday");
  }
});

const standalone =
  window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
if (ios && !standalone) {
  note.textContent = "Swipe to play. To keep it: Share, then Add to Home Screen. Sign in to put a score on today’s board.";
}

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredPrompt = event;
  installBtn.hidden = false;
});

installBtn.addEventListener("click", async () => {
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  try {
    await deferredPrompt.userChoice;
  } catch {
    // The prompt can be dismissed before a choice comes back.
  }
  deferredPrompt = null;
  installBtn.hidden = true;
});

window.addEventListener("appinstalled", () => {
  installBtn.hidden = true;
});

if ("serviceWorker" in navigator) {
  let hadController = Boolean(navigator.serviceWorker.controller);
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (!hadController) {
      hadController = true;
      return;
    }
    window.location.reload();
  });
  navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" }).catch(() => {
    // Registration fails on file:// and on a few locked-down browsers. The game still plays online.
  });
}

function cleanName(value) {
  const cleaned = String(value || "").replace(/[<>]/g, "").trim().slice(0, 40);
  return cleaned || "Player";
}

function formatScore(value) {
  const score = Number(value);
  return Number.isFinite(score) ? score.toLocaleString("en-GB") : "0";
}

function faceFor(name) {
  const face = document.createElement("span");
  face.className = "face";
  face.setAttribute("aria-hidden", "true");
  face.textContent = cleanName(name).slice(0, 1).toUpperCase();
  return face;
}

function safePicture(value) {
  if (typeof value !== "string" || value.length > 500) return "";
  try {
    const url = new URL(value);
    const host = url.hostname;
    if (url.protocol !== "https:") return "";
    if (host !== "googleusercontent.com" && !host.endsWith(".googleusercontent.com")) return "";
    return url.href;
  } catch {
    return "";
  }
}

function decodePart(part) {
  const normalized = part.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

function readSession() {
  try {
    const data = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
    if (!data || typeof data.credential !== "string" || !Number.isInteger(data.exp)) return null;
    if (data.exp * 1000 < Date.now() + 30_000) {
      sessionStorage.removeItem(SESSION_KEY);
      return null;
    }
    return data;
  } catch {
    return null;
  }
}

function pbPhrase() {
  if (!Number.isInteger(boardMe?.pb) || boardMe.pb <= 0) return "";
  return ` PB ${formatScore(boardMe.pb)}.`;
}

function paintRank() {
  const session = readSession();
  if (!navigator.onLine) {
    rankEl.textContent = "The board needs a connection.";
    return;
  }
  if (!session) {
    rankEl.textContent = "Sign in to join today’s board.";
    return;
  }
  if (!movesTrusted && game.score > 0) {
    rankEl.textContent = `Replay today to put a score on the board.${pbPhrase()}`;
    return;
  }
  if (boardMe?.rank) {
    rankEl.textContent = `On the board, rank ${boardMe.rank}.${pbPhrase()}`;
    return;
  }
  if (boardMe?.pb) {
    rankEl.textContent = `PB ${formatScore(boardMe.pb)}. Play to join today’s board.`;
    return;
  }
  rankEl.textContent = "Signed in. Play to join today’s board.";
}

function paintWho() {
  const session = readSession();
  googleEl.hidden = !!session;
  whoYou.hidden = !session;
  signOutBtn.hidden = !session;
  if (!session) {
    whoPic.hidden = true;
    whoPic.removeAttribute("src");
    whoName.textContent = "";
  } else {
    whoName.textContent = session.name || "Player";
    const picture = safePicture(session.picture);
    if (picture) {
      whoPic.src = picture;
      whoPic.referrerPolicy = "no-referrer";
      whoPic.hidden = false;
    } else {
      whoPic.hidden = true;
      whoPic.removeAttribute("src");
    }
  }
  paintRank();
}

function signOut() {
  boardMe = null;
  knownPb = null;
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // The board still shows. The next visit simply asks again.
  }
  paintWho();
  loadBoard();
}

function onCredential(response) {
  const credential = response?.credential;
  if (!credential) return;
  let payload;
  try {
    payload = decodePart(credential.split(".")[1] || "");
  } catch {
    return;
  }
  if (typeof payload.sub !== "string" || !Number.isInteger(payload.exp)) return;
  try {
    sessionStorage.setItem(
      SESSION_KEY,
      JSON.stringify({
        credential,
        name: cleanName(payload.name),
        picture: safePicture(payload.picture),
        sub: payload.sub,
        exp: payload.exp,
      }),
    );
  } catch {
    return;
  }
  paintWho();
  if (movesTrusted && game.score > 0) scheduleSubmit(0);
  else loadBoard();
}

function startGoogle() {
  if (googleReady || !window.google?.accounts?.id) return;
  googleReady = true;
  try {
    window.google.accounts.id.initialize({
      client_id: CLIENT_ID,
      callback: onCredential,
      auto_select: false,
      cancel_on_tap_outside: true,
    });
    window.google.accounts.id.renderButton(googleEl, {
      theme: "filled_black",
      size: "medium",
      shape: "pill",
      text: "signin_with",
      width: 220,
    });
  } catch {
    googleReady = false;
  }
}

function applyBoard(data) {
  const next = data?.me || null;
  if (knownPb == null && Number.isInteger(next?.pb) && next.pb > 0) knownPb = next.pb;
  boardMe = next;
  paintRank();
  if (standings.hidden) return;
  standingsWhen.textContent = prettyDay(data?.day || puzzleDay);
  standingsList.replaceChildren();
  const rows = Array.isArray(data?.rows) ? data.rows : [];
  standingsEmpty.hidden = rows.length > 0;
  standingsEmpty.textContent = "No scores yet. Sign in and play.";
  for (const row of rows) {
    const item = document.createElement("li");
    if (row.rank === 1) item.classList.add("lead");
    if (row.you) item.classList.add("you");
    const place = document.createElement("span");
    place.className = "place";
    place.textContent = String(row.rank);
    const person = document.createElement("span");
    person.className = "person";
    const picture = safePicture(row.picture);
    const identity = document.createElement("span");
    identity.className = "identity";
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = cleanName(row.name);
    identity.appendChild(name);
    if (Number.isInteger(row.pb) && row.pb > 0) {
      const pb = document.createElement("span");
      pb.className = "pb";
      pb.textContent = `PB ${formatScore(row.pb)}`;
      identity.appendChild(pb);
    }
    if (picture) {
      const img = document.createElement("img");
      img.alt = "";
      img.width = 36;
      img.height = 36;
      img.referrerPolicy = "no-referrer";
      img.src = picture;
      img.addEventListener("error", () => img.replaceWith(faceFor(row.name)));
      person.appendChild(img);
    } else {
      person.appendChild(faceFor(row.name));
    }
    person.appendChild(identity);
    const result = document.createElement("span");
    result.className = "result";
    const score = document.createElement("strong");
    score.textContent = formatScore(row.score);
    result.appendChild(score);
    if (row.done === true || row.done === false) {
      const state = document.createElement("span");
      state.className = row.done ? "state finished" : "state";
      state.textContent = row.done ? "Finished" : "Ongoing";
      result.appendChild(state);
    }
    item.append(place, person, result);
    standingsList.appendChild(item);
  }
}

function showBoardError() {
  if (standings.hidden) return;
  standingsList.replaceChildren();
  standingsEmpty.hidden = false;
  standingsEmpty.textContent = navigator.onLine
    ? "The board didn’t load. Try again."
    : "The board needs a connection.";
}

async function loadBoard() {
  paintRank();
  if (!BOARD_API || !navigator.onLine) {
    showBoardError();
    return;
  }
  const epoch = ++boardEpoch;
  const headers = {};
  const session = readSession();
  if (session) headers.Authorization = `Bearer ${session.credential}`;
  try {
    const response = await fetch(BOARD_API, { headers });
    if (epoch !== boardEpoch) return;
    if (response.status === 401) {
      if (session) signOut();
      return;
    }
    if (!response.ok) {
      showBoardError();
      return;
    }
    applyBoard(await response.json());
  } catch {
    if (epoch === boardEpoch) showBoardError();
  }
}

function scheduleSubmit(delay = 500) {
  clearTimeout(submitTimer);
  submitTimer = setTimeout(submitScore, delay);
}

async function submitScore() {
  const session = readSession();
  if (!session || !BOARD_API || !movesTrusted || !navigator.onLine || game.score <= 0) return;
  const epoch = ++boardEpoch;
  const body = JSON.stringify({ moves: moves.slice() });
  try {
    const response = await fetch(BOARD_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session.credential}`,
        "Content-Type": "application/json",
      },
      body,
    });
    if (epoch !== boardEpoch) return;
    if (response.status === 401) {
      signOut();
      return;
    }
    if (!response.ok) return;
    applyBoard(await response.json());
  } catch {
    if (epoch === boardEpoch) showBoardError();
  }
}

function openStandings() {
  if (modalKind) return;
  standings.hidden = false;
  app.setAttribute("aria-hidden", "true");
  standingsWhen.textContent = prettyDay(puzzleDay);
  standingsClose.focus();
  loadBoard();
}

function closeStandings() {
  standings.hidden = true;
  if (!modalKind) app.removeAttribute("aria-hidden");
  openBoardBtn.focus({ preventScroll: true });
}

whoYou.addEventListener("click", openStandings);
openBoardBtn.addEventListener("click", openStandings);
signOutBtn.addEventListener("click", signOut);
standingsClose.addEventListener("click", closeStandings);
standings.addEventListener("click", (event) => {
  if (event.target === standings) closeStandings();
});

const googleScript = document.querySelector("script[src*='accounts.google.com/gsi/client']");
if (window.google?.accounts?.id) startGoogle();
else googleScript?.addEventListener("load", startGoogle, { once: true });

boot();
paintDate();
render();
paintScore();
syncUndo();
syncNet();
paintWho();
loadBoard();
maybeModalOnLoad();
