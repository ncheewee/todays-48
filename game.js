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
let undoStack = [];
let busy = false;
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

function save() {
  try {
    localStorage.setItem(
      SAVE_KEY,
      JSON.stringify({
        v: 1,
        day: puzzleDay,
        tiles: game.tiles.map(({ id, value, r, c }) => ({ id, value, r, c })),
        score: game.score,
        nextId: game.nextId,
        draw: game.rng.draw(),
        best,
        continued,
      }),
    );
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
    save();
    return;
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
}

function startNew() {
  if (dayKey() !== puzzleDay) {
    beginToday();
    return;
  }
  queued = null;
  busy = false;
  continued = false;
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
  if (modalKind) return;
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

window.addEventListener("online", syncNet);
window.addEventListener("offline", syncNet);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && dayKey() !== puzzleDay && modalKind !== "nextday") {
    openModal("nextday");
  }
});

const standalone =
  window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
if (standalone) note.textContent = "Arrow keys, WASD, or a swipe.";
else if (ios) {
  note.textContent = "Swipe to play. To keep it: Share, then Add to Home Screen. It works offline after that.";
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
  note.textContent = "Arrow keys, WASD, or a swipe.";
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" }).catch(() => {
    // Registration fails on file:// and on a few locked-down browsers. The game still plays online.
  });
}

boot();
paintDate();
render();
paintScore();
syncUndo();
syncNet();
maybeModalOnLoad();
