// ==UserScript==
// @name         BuriburiLand Tetris AI — DOM Control
// @namespace    buriburiland-tetris-ai
// @version      0.2.3
// @description  Explicit-start Worker search with display-level validation. F8 stop; F9 inspect.
// @match        https://buriburiland.com/*
// @match        https://www.buriburiland.com/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==
"use strict";
(() => {
  // src/types/game.ts
  var BOARD_WIDTH = 10;
  var BOARD_HEIGHT = 20;
  var FULL_ROW = (1 << BOARD_WIDTH) - 1;
  var PIECE_TYPES = ["I", "J", "L", "O", "S", "T", "Z"];
  function asRotation(value) {
    const number = Number(value);
    const normalized = Number.isFinite(number) ? (Math.trunc(number) % 4 + 4) % 4 : 0;
    return normalized;
  }

  // src/runtime/model.ts
  var RUNTIME_RULE_PROFILE = Object.freeze({
    id: "buriburiland-client-847.a5a05f14ceb3f87d-2026-10-23",
    evidence: "Public client chunk 847.a5a05f14ceb3f87d.js: K/en/ee/ei/eo/ea; server behavior still requires lock validation",
    verifiedAt: "2026-10-23",
    coordinateSpace: "trimmed-bounding-box",
    visibleRows: 20,
    columns: 10,
    spawn: "x=3, rotation=0; first legal y in [0,-1,-2]",
    rotation: "client SRS with bounding-box offset correction",
    rotation180: false,
    attackPrediction: false,
    spinPrediction: false,
    futureGarbage: "unknown; never invented"
  });

  // src/physics/tetrominoes.ts
  var SHAPES = {
    I: [
      [[0, 1], [1, 1], [2, 1], [3, 1]],
      [[2, 0], [2, 1], [2, 2], [2, 3]],
      [[0, 2], [1, 2], [2, 2], [3, 2]],
      [[1, 0], [1, 1], [1, 2], [1, 3]]
    ],
    J: [
      [[0, 0], [0, 1], [1, 1], [2, 1]],
      [[1, 0], [2, 0], [1, 1], [1, 2]],
      [[0, 1], [1, 1], [2, 1], [2, 2]],
      [[1, 0], [1, 1], [0, 2], [1, 2]]
    ],
    L: [
      [[2, 0], [0, 1], [1, 1], [2, 1]],
      [[1, 0], [1, 1], [1, 2], [2, 2]],
      [[0, 1], [1, 1], [2, 1], [0, 2]],
      [[0, 0], [1, 0], [1, 1], [1, 2]]
    ],
    O: [
      [[1, 0], [2, 0], [1, 1], [2, 1]],
      [[1, 0], [2, 0], [1, 1], [2, 1]],
      [[1, 0], [2, 0], [1, 1], [2, 1]],
      [[1, 0], [2, 0], [1, 1], [2, 1]]
    ],
    S: [
      [[1, 0], [2, 0], [0, 1], [1, 1]],
      [[1, 0], [1, 1], [2, 1], [2, 2]],
      [[1, 1], [2, 1], [0, 2], [1, 2]],
      [[0, 0], [0, 1], [1, 1], [1, 2]]
    ],
    T: [
      [[1, 0], [0, 1], [1, 1], [2, 1]],
      [[1, 0], [1, 1], [2, 1], [1, 2]],
      [[0, 1], [1, 1], [2, 1], [1, 2]],
      [[1, 0], [0, 1], [1, 1], [1, 2]]
    ],
    Z: [
      [[0, 0], [1, 0], [1, 1], [2, 1]],
      [[2, 0], [1, 1], [2, 1], [1, 2]],
      [[0, 1], [1, 1], [1, 2], [2, 2]],
      [[1, 0], [0, 1], [1, 1], [0, 2]]
    ]
  };
  function cellsFor(type, rotation) {
    return SHAPES[type][rotation] ?? [];
  }

  // src/physics/board.ts
  function collides(board, type, rotation, x, y) {
    for (const [cellX, cellY] of cellsFor(type, rotation)) {
      const boardX = x + cellX;
      const boardY = y + cellY;
      if (boardX < 0 || boardX >= BOARD_WIDTH || boardY >= BOARD_HEIGHT) return true;
      if (boardY >= 0 && ((board[boardY] ?? 0) & 1 << boardX) !== 0) return true;
    }
    return false;
  }
  function hardDropY(board, type, rotation, x, startY) {
    if (collides(board, type, rotation, x, startY)) throw new Error("Cannot hard-drop a colliding piece");
    let y = startY;
    while (!collides(board, type, rotation, x, y + 1)) y += 1;
    return y;
  }
  function lockPiece(board, type, rotation, x, y) {
    if (collides(board, type, rotation, x, y)) return null;
    const placed = [...board];
    let topOut = false;
    for (const [cellX, cellY] of cellsFor(type, rotation)) {
      const boardX = x + cellX;
      const boardY = y + cellY;
      if (boardY < 0) {
        topOut = true;
        continue;
      }
      placed[boardY] = (placed[boardY] ?? 0) | 1 << boardX;
    }
    const clearedRows = [];
    for (let row = 0; row < BOARD_HEIGHT; row += 1) {
      if (((placed[row] ?? 0) & FULL_ROW) === FULL_ROW) clearedRows.push(row);
    }
    const clearedSet = new Set(clearedRows);
    const after = placed.filter((_, index) => !clearedSet.has(index));
    while (after.length < BOARD_HEIGHT) after.unshift(0);
    return { board: after, preClearBoard: placed, cleared: clearedRows.length, clearedRows, topOut };
  }

  // src/physics/srs.ts
  var JLSTZ_KICKS = {
    "0>1": [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
    "1>0": [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
    "1>2": [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],
    "2>1": [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],
    "2>3": [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],
    "3>2": [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
    "3>0": [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],
    "0>3": [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]]
  };
  var I_KICKS = {
    "0>1": [[0, 0], [-2, 0], [1, 0], [-2, 1], [1, -2]],
    "1>0": [[0, 0], [2, 0], [-1, 0], [2, -1], [-1, 2]],
    "1>2": [[0, 0], [-1, 0], [2, 0], [-1, -2], [2, 1]],
    "2>1": [[0, 0], [1, 0], [-2, 0], [1, 2], [-2, -1]],
    "2>3": [[0, 0], [2, 0], [-1, 0], [2, -1], [-1, 2]],
    "3>2": [[0, 0], [-2, 0], [1, 0], [-2, 1], [1, -2]],
    "3>0": [[0, 0], [1, 0], [-2, 0], [1, 2], [-2, -1]],
    "0>3": [[0, 0], [-1, 0], [2, 0], [-1, -2], [2, 1]]
  };
  function rotateSrs(board, type, state, direction) {
    const to = asRotation(state.rotation + direction);
    if (type === "O") return { ...state, rotation: to, kickIndex: 0, kick: [0, 0] };
    const table = type === "I" ? I_KICKS : JLSTZ_KICKS;
    const kicks = table[`${state.rotation}>${to}`] ?? [[0, 0]];
    for (let kickIndex = 0; kickIndex < kicks.length; kickIndex += 1) {
      const kick = kicks[kickIndex];
      if (!kick) continue;
      const [offsetX, offsetY] = kick;
      const x = state.x + offsetX;
      const y = state.y + offsetY;
      if (!collides(board, type, to, x, y)) return { x, y, rotation: to, kickIndex, kick };
    }
    return null;
  }

  // src/runtime/engine.ts
  var offsets = /* @__PURE__ */ new Map();
  var shapes = /* @__PURE__ */ new Map();
  for (const type of PIECE_TYPES) {
    for (const rotation of [0, 1, 2, 3]) {
      const cells = cellsFor(type, rotation);
      const offset = [Math.min(...cells.map(([x]) => x)), Math.min(...cells.map(([, y]) => y))];
      offsets.set(`${type}${rotation}`, offset);
      shapes.set(`${type}${rotation}`, cells.map(([x, y]) => [x - offset[0], y - offset[1]]));
    }
  }
  function cellsFor2(type, rotation) {
    return shapes.get(`${type}${rotation}`) ?? [];
  }
  function offsetFor(type, rotation) {
    return offsets.get(`${type}${rotation}`) ?? [0, 0];
  }
  function runtimeCells(piece) {
    return cellsFor2(piece.type, piece.rotation).map(([x, y]) => [piece.x + x, piece.y + y]);
  }
  function collides2(board, type, rotation, x, y) {
    const [offsetX, offsetY] = offsetFor(type, rotation);
    return collides(board, type, rotation, x - offsetX, y - offsetY);
  }
  function hardDropY2(board, type, rotation, x, startY) {
    const [offsetX, offsetY] = offsetFor(type, rotation);
    return hardDropY(board, type, rotation, x - offsetX, startY - offsetY) + offsetY;
  }
  function lockPiece2(board, type, rotation, x, y) {
    const [offsetX, offsetY] = offsetFor(type, rotation);
    return lockPiece(board, type, rotation, x - offsetX, y - offsetY);
  }
  function rotateSrs2(board, piece, direction) {
    if (piece.type === "O") return piece;
    const [fromX, fromY] = offsetFor(piece.type, piece.rotation);
    const rotated = rotateSrs(board, piece.type, {
      x: piece.x - fromX,
      y: piece.y - fromY,
      rotation: piece.rotation
    }, direction);
    if (!rotated) return null;
    const [toX, toY] = offsetFor(piece.type, rotated.rotation);
    return { type: piece.type, x: rotated.x + toX, y: rotated.y + toY, rotation: rotated.rotation };
  }
  function applyRuntimeAction(board, current, action) {
    if (collides2(board, current.type, current.rotation, current.x, current.y)) return null;
    if (action === "ROTATE_CW" || action === "ROTATE_CCW") {
      return rotateSrs2(board, current, action === "ROTATE_CW" ? 1 : -1);
    }
    if (action === "HARD_DROP") {
      return { ...current, y: hardDropY2(board, current.type, current.rotation, current.x, current.y) };
    }
    const next = { ...current, x: current.x + (action === "LEFT" ? -1 : action === "RIGHT" ? 1 : 0), y: current.y + (action === "SOFT_DROP" ? 1 : 0) };
    return collides2(board, next.type, next.rotation, next.x, next.y) ? null : next;
  }
  function spawnPiece(board, type) {
    for (const y of [0, -1, -2]) {
      const piece = { type, x: 3, y, rotation: 0 };
      if (!collides2(board, type, 0, piece.x, piece.y)) return piece;
    }
    return null;
  }

  // src/runtime/version.ts
  var SCRIPT_VERSION = "0.2.3";

  // src/runtime/dom.ts
  var DomReadError = class extends Error {
    constructor(kind, message) {
      super(message);
      this.kind = kind;
      this.name = "DomReadError";
    }
    kind;
  };
  var COLOR_TYPES = {
    "#22d3ee": "I",
    "#facc15": "O",
    "#a78bfa": "T",
    "#84cc16": "S",
    "#fb7185": "Z",
    "#60a5fa": "J",
    "#fb923c": "L"
  };
  var TYPES = ["I", "J", "L", "O", "S", "T", "Z"];
  var STAGE = "main.tetris-root > section.tetris-stage";
  var BOARD = ":scope > section.tetris-board-panel > .tetris-board-wrap > .tetris-playfield.tetris-board.has-spawn-area";
  var LEFT = ":scope > .tetris-left-panel:not(.tetris-opponents)";
  var OWN_INCOMING = `${LEFT} > .tetris-metrics > .tetris-garbage-gauge:not(.is-compact) > .tetris-garbage-gauge-track[role="meter"]`;
  function fail(kind, message) {
    throw new DomReadError(kind, message);
  }
  function one(parent, selector, description) {
    const matches = parent.querySelectorAll(selector);
    if (matches.length !== 1) fail("invalid", `${description}: expected one element, found ${matches.length}`);
    return matches[0];
  }
  function cellKey(cells) {
    return cells.map(([x, y]) => `${x},${y}`).sort().join(";");
  }
  function snapshotCells(piece) {
    return Object.freeze(cellsFor2(piece.type, piece.rotation).map(([x, y]) => Object.freeze([piece.x + x, piece.y + y])));
  }
  function posesForCells(type, cells) {
    if (cells.length !== 4 || new Set(cells.map(([x, y]) => `${x},${y}`)).size !== 4 || cells.some(([x, y]) => !Number.isInteger(x) || !Number.isInteger(y))) {
      return Object.freeze([]);
    }
    const minX = Math.min(...cells.map(([x]) => x));
    const minY = Math.min(...cells.map(([, y]) => y));
    const key = cellKey(cells);
    const poses = [];
    for (const rotation of [0, 1, 2, 3]) {
      const shape = cellsFor2(type, rotation);
      const x = minX - Math.min(...shape.map(([cx]) => cx));
      const y = minY - Math.min(...shape.map(([, cy]) => cy));
      const pose = Object.freeze({ type, x, y, rotation });
      if (cellKey(snapshotCells(pose)) === key) poses.push(pose);
    }
    return Object.freeze(poses);
  }
  function gridInteger(value, description) {
    const rounded = Math.round(value);
    if (!Number.isFinite(value) || Math.abs(value - rounded) > 0.08) {
      fail("transition", `${description}: cell is between grid positions`);
    }
    return rounded;
  }
  function readActive(grid, visible) {
    const layers = visible.querySelectorAll(":scope > .tetris-piece-layer:not(.is-ghost)");
    if (layers.length === 0) fail("transition", "Current piece is absent during spawn, lock, or game end");
    if (layers.length !== 1) fail("invalid", "Multiple current piece layers in the selected board");
    const layer = layers[0];
    const typeValue = layer.getAttribute("data-piece-type");
    if (!TYPES.includes(typeValue)) fail("invalid", "Current piece has an unknown type");
    const cells = [...layer.querySelectorAll(":scope > .tetris-layer-cell")];
    if (cells.length !== 4 || layer.children.length !== 4) fail("invalid", `Current piece must have four cells, found ${cells.length}`);
    const rect = grid.getBoundingClientRect();
    if (!(rect.width > 0) || !(rect.height > 0) || !Number.isFinite(rect.left + rect.top + rect.width + rect.height)) {
      fail("inactive", "Selected board has no measurable visible grid");
    }
    const unitX = rect.width / 10;
    const unitY = rect.height / 20;
    const absolute = cells.map((cell) => {
      if (cell.classList.contains("is-ghost") || !cell.classList.contains("is-filled")) {
        fail("invalid", "Current layer contains an unfilled or ghost cell");
      }
      const bounds = cell.getBoundingClientRect();
      if (Math.abs(bounds.width / unitX - 1) > 0.08 || Math.abs(bounds.height / unitY - 1) > 0.08) {
        fail("invalid", "Current cell dimensions do not match the selected 10 by 20 grid");
      }
      const x = gridInteger((bounds.left - rect.left) / unitX, "Current x");
      const y = gridInteger((bounds.top - rect.top) / unitY, "Current y");
      if (x < 0 || x > 9 || y < -4 || y > 19) fail("invalid", "Current cell lies outside the visible/spawn board");
      return [x, y];
    });
    const poses = posesForCells(typeValue, absolute);
    if (poses.length === 0) fail("invalid", "Current four cells do not match the declared tetromino");
    return { poses, layer };
  }
  function previewType(preview, compact) {
    const cells = [...preview.querySelectorAll(":scope > .tetris-cell")];
    const columns = compact ? Number(preview.style.getPropertyValue("--preview-cols").trim()) : 4;
    if (!Number.isInteger(columns) || columns < 1 || columns > 4 || cells.length === 0 || cells.length > 16 || preview.children.length !== cells.length || cells.length % columns !== 0 || !compact && cells.length !== 16) {
      fail("invalid", "HOLD/NEXT preview dimensions do not match the public DOM contract");
    }
    const filled = [];
    const types = [];
    cells.forEach((cell, index) => {
      if (cell.classList.contains("is-ghost")) fail("invalid", "Unexpected ghost in HOLD/NEXT preview");
      if (!cell.classList.contains("is-filled")) return;
      const type2 = COLOR_TYPES[cell.style.getPropertyValue("--cell-color").trim().toLowerCase()];
      if (!type2) fail("invalid", "HOLD/NEXT uses an unrecognized piece color");
      types.push(type2);
      filled.push([index % columns, Math.floor(index / columns)]);
    });
    if (filled.length !== 4 || types.some((type2) => type2 !== types[0])) {
      fail("invalid", "HOLD/NEXT must contain exactly four cells of one verified color");
    }
    const type = types[0];
    if (posesForCells(type, filled).length === 0) fail("invalid", "HOLD/NEXT color and tetromino shape disagree");
    return type;
  }
  function optionalMetric(stage, label) {
    const matches = [...stage.querySelectorAll(`${LEFT} > .tetris-metrics > .tetris-card`)].filter((card) => card.querySelector(":scope > span")?.textContent?.trim() === label);
    if (matches.length === 0) return null;
    if (matches.length !== 1) fail("invalid", `Duplicate ${label} metric`);
    const text = matches[0].querySelector(":scope > strong")?.textContent?.trim() ?? "";
    if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text))) fail("invalid", `Invalid ${label} metric`);
    return Number(text);
  }
  function readIncoming(stage) {
    const gauges = stage.querySelectorAll(OWN_INCOMING);
    if (gauges.length === 0) return null;
    if (gauges.length !== 1) fail("invalid", "Multiple incoming garbage gauges in the selected board");
    const match = /^받은 공격 (\d+)줄$/.exec(gauges[0].getAttribute("aria-label") ?? "");
    if (!match || !Number.isSafeInteger(Number(match[1]))) fail("invalid", "Incoming garbage label is unreadable");
    return Number(match[1]);
  }
  function fingerprint(parts) {
    const text = JSON.stringify(parts);
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
    return `dom-${(hash >>> 0).toString(16).padStart(8, "0")}`;
  }
  var DomAdapter = class {
    constructor(doc = document) {
      this.doc = doc;
    }
    doc;
    selection = null;
    identities = /* @__PURE__ */ new WeakMap();
    identity = 0;
    observation = 0;
    generation = 0;
    scopeStage = null;
    scopeRoute = "";
    previousPhase = null;
    candidates() {
      return [...this.doc.querySelectorAll(STAGE)].filter((stage) => stage.querySelectorAll(BOARD).length === 1);
    }
    select(element) {
      const stage = element.matches(STAGE) ? element : element.closest(STAGE);
      if (!stage || !this.candidates().includes(stage)) fail("selection", "Select the main player board with its HOLD and NEXT panels");
      this.selection = stage;
    }
    selected() {
      if (this.selection) return this.selection.isConnected && this.candidates().includes(this.selection) ? this.selection : null;
      const candidates2 = this.candidates();
      return candidates2.length === 1 ? candidates2[0] : null;
    }
    requireStage() {
      const stage = this.selected();
      if (!stage) {
        if (this.selection && !this.selection.isConnected) fail("selection", "Selected board was replaced; select the current board again");
        fail("selection", this.candidates().length === 0 ? "No supported main Tetris board is visible" : "Multiple main boards exist; select your player board");
      }
      return stage;
    }
    status() {
      const stage = this.requireStage();
      const status = this.statusFor(stage);
      this.updateGeneration(stage, status);
      return status;
    }
    routeIdentity() {
      const location = this.doc.defaultView?.location;
      return location ? location.pathname + location.search : "";
    }
    updateGeneration(stage, status) {
      const route = this.routeIdentity();
      const phase = status.paused ? "paused" : status.ended ? "ended" : status.playing ? "playing" : "waiting";
      if (stage !== this.scopeStage || route !== this.scopeRoute || phase === "playing" && (this.previousPhase === "ended" || this.previousPhase === "waiting")) {
        this.generation += 1;
      }
      this.scopeStage = stage;
      this.scopeRoute = route;
      if (phase !== "paused") this.previousPhase = phase;
      return this.generation;
    }
    statusFor(stage) {
      const root = stage.parentElement;
      const status = one(root, ":scope > .tetris-header .tetris-status", "Game status").textContent?.trim() ?? "";
      const spectating = status.endsWith(" \uAD00\uC804 \uC911") || Boolean(root.querySelector(":scope > .tetris-header .tetris-spectator-switch"));
      const paused = status === "\uC77C\uC2DC\uC815\uC9C0" || Boolean(stage.querySelector(":scope > .tetris-board-panel > .tetris-pause-overlay"));
      const life = [...stage.querySelectorAll(`${LEFT} > .tetris-metrics > .tetris-card`)].find((card) => card.querySelector(":scope > span")?.textContent?.trim() === "\uC0C1\uD0DC")?.querySelector(":scope > strong")?.textContent?.trim();
      const ended = status === "\uAC8C\uC784 \uC885\uB8CC" || life === "\uD0C8\uB77D" || Boolean(root.querySelector(":scope > .tetris-result"));
      const playing = /^속도 LV\.\d+$/.test(status) && !paused && !ended && !spectating;
      const movement = [...stage.querySelectorAll(":scope > .tetris-mobile-controls .tetris-mobile-move-group > button")];
      const inputEnabled = playing && movement.length === 3 && movement.every((button) => !button.disabled);
      return Object.freeze({ playing, paused, ended, spectating, inputEnabled });
    }
    read() {
      const stage = this.requireStage();
      const status = this.statusFor(stage);
      const generation = this.updateGeneration(stage, status);
      const route = this.routeIdentity();
      if (status.spectating) fail("spectator", "Spectator board is not a controllable local-player board");
      if (!status.playing && !status.paused && !status.ended) fail("inactive", "Game is waiting or has an unrecognized status");
      const boardElement = one(stage, BOARD, "Main board");
      const visible = one(boardElement, ":scope > .tetris-visible-board", "Visible board");
      const grid = one(visible, ":scope > .tetris-grid", "Fixed grid");
      const fixedCells = [...grid.querySelectorAll(":scope > .tetris-cell")];
      if (fixedCells.length !== 200 || grid.children.length !== 200) fail("invalid", `Fixed grid must have 200 cells, found ${fixedCells.length}`);
      const board = Array(20).fill(0);
      fixedCells.forEach((cell, index) => {
        if (cell.classList.contains("is-ghost") || cell.classList.contains("tetris-layer-cell")) fail("invalid", "Fixed board contains an active or ghost cell");
        if (cell.classList.contains("is-filled")) board[Math.floor(index / 10)] |= 1 << index % 10;
      });
      const active = readActive(grid, visible);
      if (active.poses.some((pose) => collides2(board, pose.type, pose.rotation, pose.x, pose.y))) {
        fail("transition", "Current piece overlaps the fixed board during a lock or correction");
      }
      const holdButton = one(stage, `${LEFT} button.tetris-hold-card`, "HOLD control");
      const previews = holdButton.querySelectorAll(":scope > .tetris-hold-preview");
      let hold;
      if (previews.length === 1) hold = previewType(previews[0], true);
      else if (previews.length === 0 && holdButton.children.length === 1 && holdButton.querySelector(":scope > strong")?.textContent?.trim() === "EMPTY") hold = null;
      else fail("invalid", "HOLD cannot be read; an absent preview is not an empty HOLD");
      const nextList = one(stage, ":scope > .tetris-right-panel .tetris-next-list", "NEXT list");
      const nextPreviews = [...nextList.querySelectorAll(":scope > .tetris-queue-preview")];
      if (nextPreviews.length < 5) fail("transition", `Visible NEXT queue is incomplete (${nextPreviews.length}/5)`);
      if (nextPreviews.length > 5) fail("invalid", "NEXT has more than five visible previews");
      if (nextList.children.length !== nextPreviews.length) fail("invalid", "NEXT list contains an unsupported preview element");
      const next = Object.freeze(nextPreviews.map((preview) => previewType(preview, false)));
      const canHold = status.paused || status.ended || !status.inputEnabled ? null : !holdButton.disabled;
      const lines = optionalMetric(stage, "\uC81C\uAC70 \uC904");
      const incoming = readIncoming(stage);
      const after = this.statusFor(stage);
      if (!stage.isConnected || grid !== visible.querySelector(":scope > .tetris-grid") || active.layer !== visible.querySelector(":scope > .tetris-piece-layer:not(.is-ghost)") || route !== this.routeIdentity() || JSON.stringify(status) !== JSON.stringify(after)) fail("transition", "DOM changed during observation");
      let id = this.identities.get(stage);
      if (id === void 0) {
        id = ++this.identity;
        this.identities.set(stage, id);
      }
      const current = active.poses[0];
      const session = `local-dom-session-${id}-${generation}`;
      const player = `local-dom-player-${id}`;
      return Object.freeze({
        board: Object.freeze(board),
        current,
        next,
        hold,
        canHold,
        fingerprint: fingerprint([session, player, board, snapshotCells(current), next, hold, canHold, status.paused, status.ended, lines, incoming]),
        session,
        player,
        observedAt: this.doc.defaultView?.performance.now() ?? performance.now(),
        observation: ++this.observation,
        paused: status.paused,
        ended: status.ended,
        lines,
        incoming,
        rotationCandidates: active.poses
      });
    }
    /** F9-safe diagnostics: only public game fields; no URLs, nicknames, cookies, or framework objects. */
    report() {
      let status = null;
      const stage = this.selected();
      const visible = stage?.querySelector(`${BOARD} > .tetris-visible-board`);
      const render = {
        ownIncomingGauges: stage?.querySelectorAll(OWN_INCOMING).length ?? 0,
        currentLayers: visible?.querySelectorAll(":scope > .tetris-piece-layer:not(.is-ghost)").length ?? 0,
        ghostLayers: visible?.querySelectorAll(":scope > .tetris-piece-layer.is-ghost").length ?? 0,
        fixedCells: visible?.querySelectorAll(":scope > .tetris-grid > .tetris-cell").length ?? 0
      };
      const base = { scriptVersion: SCRIPT_VERSION, adapter: "public-dom", authority: "display-only", candidates: this.candidates().length, render };
      try {
        status = this.status();
        return {
          ...base,
          status,
          snapshot: this.read(),
          unknown: ["serverRevision", "pieceVersion", "lockDeadline", "rotationHistory", "combo", "backToBack", "attack"]
        };
      } catch (error) {
        return {
          ...base,
          status,
          error: error instanceof Error ? error.message : String(error),
          kind: error instanceof DomReadError ? error.kind : "invalid"
        };
      }
    }
  };

  // src/runtime/board-transition.ts
  function isDenseBoard(board) {
    if (!Array.isArray(board) || board.length !== BOARD_HEIGHT) return false;
    for (let y = 0; y < BOARD_HEIGHT; y += 1) {
      if (!Object.prototype.hasOwnProperty.call(board, y)) return false;
      const row = board[y];
      if (typeof row !== "number" || !Number.isInteger(row) || row < 0 || row > FULL_ROW) return false;
    }
    return true;
  }
  function detectGarbageRise(expected, actual) {
    if (!isDenseBoard(expected) || !isDenseBoard(actual)) return null;
    if (expected.every((row, y) => row === actual[y])) return null;
    for (let rows = 1; rows < BOARD_HEIGHT; rows += 1) {
      if (expected[rows - 1] !== 0) break;
      const retainedRows = BOARD_HEIGHT - rows;
      let bodyMatches = true;
      for (let y = 0; y < retainedRows; y += 1) {
        if (actual[y] !== expected[y + rows]) {
          bodyMatches = false;
          break;
        }
      }
      if (!bodyMatches) continue;
      const insertedRows = actual.slice(retainedRows);
      const holes = [];
      for (const row of insertedRows) {
        const missing = FULL_ROW ^ row;
        if (missing === 0 || (missing & missing - 1) !== 0) break;
        holes.push(Math.log2(missing));
      }
      if (holes.length !== rows) continue;
      return Object.freeze({
        rows,
        holes: Object.freeze(holes),
        insertedRows: Object.freeze(insertedRows)
      });
    }
    return null;
  }

  // src/move/ReachableMoveGenerator.ts
  var ACTIONS = ["LEFT", "RIGHT", "SOFT_DROP", "ROTATE_CW", "ROTATE_CCW", "HARD_DROP"];

  // src/runtime/plan-validation.ts
  function equal(left, right) {
    return left.length === right.length && left.every((value, index) => value === right[index]);
  }
  function validBoard(board) {
    return Array.isArray(board) && board.length === BOARD_HEIGHT && Array.from(board).every((row) => Number.isInteger(row) && row >= 0 && row <= FULL_ROW);
  }
  function validPose(pose) {
    return !!pose && PIECE_TYPES.includes(pose.type) && Number.isInteger(pose.x) && pose.x >= -4 && pose.x < BOARD_WIDTH && Number.isInteger(pose.y) && pose.y >= -4 && pose.y < BOARD_HEIGHT && Number.isInteger(pose.rotation) && pose.rotation >= 0 && pose.rotation <= 3;
  }
  function cellKey2(pose) {
    return runtimeCells(pose).map(([x, y]) => `${x},${y}`).sort().join(";");
  }
  function poseKey(pose) {
    return `${pose.type}/${pose.x}/${pose.y}/${pose.rotation}`;
  }
  function candidates(snapshot) {
    return snapshot.rotationCandidates ?? [snapshot.current];
  }
  function validSnapshot(snapshot) {
    const counter = (value) => Number.isSafeInteger(value) && value >= 0;
    if (!snapshot || !validBoard(snapshot.board) || !validPose(snapshot.current) || snapshot.paused !== false || snapshot.ended !== false || ![snapshot.session, snapshot.player, snapshot.fingerprint].every((value) => typeof value === "string" && value.length > 0) || !counter(snapshot.observation) || !Number.isFinite(snapshot.observedAt) || snapshot.observedAt < 0 || !Array.isArray(snapshot.next) || snapshot.next.length > 5 || !Array.from(snapshot.next).every((type) => PIECE_TYPES.includes(type)) || snapshot.hold !== null && !PIECE_TYPES.includes(snapshot.hold) || snapshot.canHold !== null && typeof snapshot.canHold !== "boolean" || snapshot.lines !== null && !counter(snapshot.lines) || snapshot.incoming !== null && !counter(snapshot.incoming)) return false;
    const poses = candidates(snapshot);
    if (!Array.isArray(poses) || poses.length < 1 || poses.length > 4) return false;
    const occupied = cellKey2(snapshot.current);
    if (!Array.from(poses).every((pose) => validPose(pose) && pose.type === snapshot.current.type && cellKey2(pose) === occupied && !collides2(snapshot.board, pose.type, pose.rotation, pose.x, pose.y))) return false;
    const keys2 = poses.map(poseKey);
    return new Set(keys2).size === keys2.length && keys2.includes(poseKey(snapshot.current));
  }
  function validPlacement(snapshot, plan) {
    if (!Array.isArray(plan.path) || plan.path.length < 1 || plan.path.length > 121 || plan.path.at(-1) !== "HARD_DROP" || plan.target.type !== snapshot.current.type || !Array.from(plan.path).every((action, index) => ACTIONS.includes(action) && (action !== "HARD_DROP" || index === plan.path.length - 1))) return false;
    let poses = candidates(snapshot);
    for (const action of plan.path) {
      const advanced = [];
      let occupied = null;
      for (const pose of poses) {
        const next = applyRuntimeAction(snapshot.board, pose, action);
        if (!next) return false;
        const cells = cellKey2(next);
        if (occupied !== null && occupied !== cells) return false;
        occupied = cells;
        advanced.push(next);
      }
      poses = advanced;
    }
    const target = cellKey2(plan.target);
    return poses.every((pose) => {
      if (cellKey2(pose) !== target) return false;
      const locked = lockPiece2(snapshot.board, pose.type, pose.rotation, pose.x, pose.y);
      return locked !== null && !locked.topOut && locked.cleared === plan.cleared && equal(locked.board, plan.expectedBoard);
    });
  }
  function rebaseGravityPlan(before, fresh, plan) {
    if (!validSnapshot(before) || !validSnapshot(fresh) || !plan || plan.ruleProfile !== RUNTIME_RULE_PROFILE.id || plan.session !== before.session || plan.player !== before.player || plan.fingerprint !== before.fingerprint || plan.observation !== before.observation || !validPose(plan.target) || !validBoard(plan.expectedBoard) || !Number.isInteger(plan.cleared) || plan.cleared < 0 || plan.cleared > 4 || fresh.session !== before.session || fresh.player !== before.player || fresh.observation <= before.observation || fresh.observedAt < before.observedAt || !equal(before.board, fresh.board) || !equal(before.next, fresh.next) || before.hold !== fresh.hold || before.canHold !== fresh.canHold || before.lines !== fresh.lines || before.incoming !== fresh.incoming || before.current.type !== fresh.current.type) return null;
    const down = fresh.current.y - before.current.y;
    if (down <= 0 || cellKey2({ ...before.current, y: before.current.y + down }) !== cellKey2(fresh.current)) return null;
    const translated = candidates(before).map((pose) => ({ ...pose, y: pose.y + down }));
    if (!equal(translated.map(poseKey).sort(), candidates(fresh).map(poseKey).sort())) return null;
    for (const pose of candidates(before)) {
      for (let amount = 1; amount <= down; amount += 1) {
        if (collides2(before.board, pose.type, pose.rotation, pose.x, pose.y + amount)) return null;
      }
    }
    if (plan.kind === "place") {
      if (!validPlacement(before, plan) || !validPlacement(fresh, plan)) return null;
    } else if (plan.kind === "hold") {
      const replacement = before.hold ?? before.next[0];
      const spawn = replacement ? spawnPiece(before.board, replacement) : null;
      if (before.canHold !== true || !Array.isArray(plan.path) || plan.path.length !== 0 || plan.cleared !== 0 || !equal(plan.expectedBoard, before.board) || !spawn || poseKey(spawn) !== poseKey(plan.target)) return null;
    } else return null;
    return {
      ...plan,
      fingerprint: fresh.fingerprint,
      session: fresh.session,
      player: fresh.player,
      observation: fresh.observation
    };
  }

  // src/runtime/control.ts
  var ReplanRequired = class extends Error {
    constructor(snapshot, recovery) {
      super(recovery.reason === "garbage-rise" ? `\uACF5\uACA9 \uC904 \uD615\uD0DC\uC758 \uBCF4\uB4DC ${recovery.rise.rows}\uC904 \uC0C1\uC2B9\uC744 \uAD00\uCE21\uD574 \uACBD\uB85C\uB97C \uB2E4\uC2DC \uACC4\uD68D\uD569\uB2C8\uB2E4.` : "\uC790\uC5F0 \uB099\uD558\uB85C \uACBD\uB85C\uAC00 \uB2EC\uB77C\uC838 \uD604\uC7AC \uC870\uAC01\uC5D0\uC11C \uB2E4\uC2DC \uACC4\uD68D\uD569\uB2C8\uB2E4.");
      this.snapshot = snapshot;
      this.recovery = recovery;
    }
    snapshot;
    recovery;
  };
  var Cancelled = class extends Error {
    constructor() {
      super("Stopped");
    }
  };
  var Cancellation = class {
    cancelled = false;
    sleepers = /* @__PURE__ */ new Map();
    check() {
      if (this.cancelled) throw new Cancelled();
    }
    cancel() {
      this.cancelled = true;
      for (const [timer, reject] of this.sleepers) {
        clearTimeout(timer);
        reject();
      }
      this.sleepers.clear();
    }
    async wait(ms) {
      this.check();
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.sleepers.delete(timer);
          resolve();
        }, ms);
        this.sleepers.set(timer, () => reject(new Cancelled()));
      });
      this.check();
    }
  };
  var keys = {
    LEFT: ["ArrowLeft", "ArrowLeft", 37],
    RIGHT: ["ArrowRight", "ArrowRight", 39],
    SOFT_DROP: ["ArrowDown", "ArrowDown", 40],
    ROTATE_CW: ["x", "KeyX", 88],
    ROTATE_CCW: ["z", "KeyZ", 90],
    HARD_DROP: [" ", "Space", 32],
    HOLD: ["c", "KeyC", 67]
  };
  function isEditable(element) {
    return Boolean(element?.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]'));
  }
  var WindowKeyboard = class {
    constructor(target, guard, intervalMs = 45) {
      this.target = target;
      this.guard = guard;
      this.intervalMs = intervalMs;
    }
    target;
    guard;
    intervalMs;
    pressed = /* @__PURE__ */ new Set();
    async tap(action, token, onSent) {
      token.check();
      this.guard();
      token.check();
      this.pressed.add(action);
      this.dispatch("keydown", action);
      onSent?.();
      try {
        await token.wait(8);
      } finally {
        if (this.pressed.delete(action)) this.dispatch("keyup", action);
      }
      await token.wait(Math.max(35, this.intervalMs - 8));
    }
    release() {
      for (const action of this.pressed) this.dispatch("keyup", action);
      this.pressed.clear();
    }
    dispatch(type, action) {
      const [key, code, keyCode] = keys[action];
      this.target.dispatchEvent(new KeyboardEvent(type, { key, code, keyCode, which: keyCode, bubbles: true, cancelable: true, repeat: false }));
    }
  };
  var Recorder = class {
    records = [];
    dropped = 0;
    add(record) {
      this.records.push(structuredClone(record));
      if (this.records.length > 1e3) {
        this.records.shift();
        this.dropped++;
      }
    }
    jsonl() {
      return this.records.map((r) => JSON.stringify(r)).join("\n");
    }
  };
  var sameBoard = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  var sameQueue = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  var cellKey3 = (p) => runtimeCells(p).map(([x, y]) => `${x},${y}`).sort().join(";");
  var samePiece = (a, b) => a.type === b.type && cellKey3(a) === cellKey3(b);
  function sameContext(a, b) {
    return samePieceContext(a, b) && sameBoard(a.board, b.board);
  }
  function samePieceContext(a, b) {
    return a.session === b.session && a.player === b.player && a.current.type === b.current.type && a.hold === b.hold && sameQueue(a.next, b.next) && a.lines === b.lines && a.canHold === b.canHold;
  }
  function sameShapeAtOrBelow(expected, actual) {
    return actual.y >= expected.y && samePiece({ ...expected, y: actual.y }, actual);
  }
  var Controller = class {
    constructor(reader, planner, keyboard, recorder = new Recorder(), onUpdate = () => {
    }, now = () => performance.now()) {
      this.reader = reader;
      this.planner = planner;
      this.keyboard = keyboard;
      this.recorder = recorder;
      this.onUpdate = onUpdate;
      this.now = now;
    }
    reader;
    planner;
    keyboard;
    recorder;
    onUpdate;
    now;
    generation = 0;
    token = null;
    busy = false;
    locks = 0;
    resyncs = 0;
    state = "STOPPED";
    lastPlan = null;
    orientation = null;
    stop(message = "\uC0AC\uC6A9\uC790\uAC00 \uC911\uC9C0\uD588\uC2B5\uB2C8\uB2E4.") {
      this.generation++;
      this.token?.cancel();
      this.planner.cancel();
      this.keyboard.release();
      this.orientation = null;
      this.update("STOPPED", message);
    }
    async start(mode) {
      if (this.busy) return;
      this.busy = true;
      const generation = ++this.generation;
      const token = new Cancellation();
      this.token = token;
      let runSession = null;
      let runPlayer = null;
      try {
        do {
          token.check();
          this.guard();
          this.update("OBSERVING", "\uC790\uAE30 \uBCF4\uB4DC\uB97C \uAD00\uCE21\uD569\uB2C8\uB2E4.");
          const observed = this.now();
          const ready = this.readReadySnapshot(token);
          let before = ready instanceof Promise ? await ready : ready;
          token.check();
          this.guard();
          const observationMs = this.now() - observed;
          if (runSession !== null && (before.session !== runSession || before.player !== runPlayer)) {
            throw new Error("\uBC29\xB7\uAC8C\uC784\xB7\uD50C\uB808\uC774\uC5B4\uAC00 \uBCC0\uACBD\uB418\uC5C8\uC2B5\uB2C8\uB2E4. \uC0C1\uD0DC \uC810\uAC80 \uD6C4 \uC9C1\uC811 \uB2E4\uC2DC \uC2DC\uC791\uD558\uC138\uC694.");
          }
          runSession = before.session;
          runPlayer = before.player;
          this.update("PLANNING", "Worker\uC5D0\uC11C \uD569\uBC95 \uBC30\uCE58\uB97C \uD0D0\uC0C9\uD569\uB2C8\uB2E4.");
          let plan = await this.planner.plan(before, generation);
          token.check();
          this.guard();
          this.lastPlan = plan;
          const refreshed = this.readReadySnapshot(token);
          const fresh = refreshed instanceof Promise ? await refreshed : refreshed;
          token.check();
          this.guard();
          if (plan.session !== before.session || plan.player !== before.player || plan.fingerprint !== before.fingerprint || fresh.fingerprint !== before.fingerprint || !sameContext(before, fresh) || !samePiece(before.current, fresh.current)) {
            const rebased = rebaseGravityPlan(before, fresh, plan);
            if (rebased) {
              before = fresh;
              plan = { ...rebased, assumptions: [...rebased.assumptions, "Path revalidated from observed gravity advance; terminal placement unchanged"] };
              this.lastPlan = plan;
            } else {
              this.update("RESYNC", "\uD0D0\uC0C9 \uC911 \uC0C1\uD0DC\uAC00 \uBC14\uB00C\uC5B4 \uC0C8\uB85C \uAD00\uCE21\uD569\uB2C8\uB2E4.");
              if (mode === "continuous") {
                await token.wait(20);
                continue;
              }
              throw new Error("\uD0D0\uC0C9 \uC911 \uC0C1\uD0DC\uAC00 \uBC14\uB00C\uC5C8\uC2B5\uB2C8\uB2E4. \uC0C1\uD0DC \uC810\uAC80 \uD6C4 \uB2E4\uC2DC \uD55C \uC218\uB97C \uC2E4\uD589\uD558\uC138\uC694.");
            }
          }
          if (mode === "shadow") {
            this.recorder.add(this.record(before, plan, [], null, "shadow", "shadow", null, observationMs, 0, 0));
            this.update("STOPPED", `\uAD00\uCE21\xB7\uD0D0\uC0C9 \uC644\uB8CC: \uAE4A\uC774 ${plan.depth}, ${plan.elapsedMs.toFixed(1)}ms. \uAC8C\uC784 \uC785\uB825 0\uD68C.`);
            return;
          }
          try {
            await this.execute(before, plan, token, observationMs);
          } catch (error) {
            if (!(error instanceof ReplanRequired)) throw error;
            token.check();
            this.guard();
            this.planner.cancel();
            this.keyboard.release();
            this.orientation = null;
            this.resyncs++;
            if (mode !== "continuous") {
              this.update("STOPPED", `${error.message} \uD55C \uC218 \uC2E4\uD589\uC744 \uB9C8\uCCE4\uC2B5\uB2C8\uB2E4. \uC0C8 \uAD00\uCE21\uC5D0\uC11C \uB2E4\uC2DC \uC2E4\uD589\uD560 \uC218 \uC788\uC2B5\uB2C8\uB2E4.`);
              return;
            }
            this.update("RESYNC", error.message);
            await this.settleForReplan(error.snapshot, token);
            token.check();
            continue;
          }
          token.check();
          if (mode !== "continuous") {
            this.update("STOPPED", "\uD55C \uC218 \uAC80\uC99D \uC644\uB8CC. DOM \uD45C\uC2DC \uACB0\uACFC\uC640 \uC77C\uCE58\uD588\uC2B5\uB2C8\uB2E4.");
            return;
          }
          await token.wait(250);
        } while (true);
      } catch (error) {
        if (!(error instanceof Cancelled) && !token.cancelled) this.update(this.state === "PAUSED" ? "PAUSED" : "ERROR", error instanceof Error ? error.message : String(error));
      } finally {
        token.cancel();
        this.planner.cancel();
        this.keyboard.release();
        this.busy = false;
        if (this.token === token) this.token = null;
      }
    }
    guard() {
      const state = this.reader.status();
      if (state.spectating) throw new Error("\uAD00\uC804 \uC911\uC5D0\uB294 \uC81C\uC5B4\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
      if (state.ended) throw new Error("\uAC8C\uC784\uC774 \uC885\uB8CC\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
      if (state.paused) {
        this.update("PAUSED", "\uAC8C\uC784 \uC77C\uC2DC\uC815\uC9C0");
        throw new Error("\uC77C\uC2DC\uC815\uC9C0\uB97C \uD574\uC81C\uD558\uACE0 \uB2E4\uC2DC \uC2DC\uC791\uD558\uC138\uC694.");
      }
      if (!state.inputEnabled) throw new Error("\uAC8C\uC784 \uC785\uB825\uC774 \uD65C\uC131\uD654\uB418\uC5B4 \uC788\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
    }
    async execute(before, plan, token, observationMs) {
      const actions = [];
      let last = before;
      let inputMs = 0;
      let confirmationStarted = this.now();
      let nonIdempotentSent = false;
      try {
        this.update("EXECUTING", plan.kind === "hold" ? "HOLD \uD55C \uBC88 \uC804\uC1A1 \uD6C4 \uC0C8 \uC0C1\uD0DC\uB97C \uD655\uC778\uD569\uB2C8\uB2E4." : "\uC785\uB825\uACFC \uC870\uAC01 \uC774\uB3D9\uC744 \uD655\uC778\uD569\uB2C8\uB2E4.");
        if (plan.kind === "hold") {
          if (before.canHold !== true) throw new Error("HOLD \uAC00\uB2A5 \uC5EC\uBD80\uAC00 \uD655\uC778\uB418\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4.");
          token.check();
          this.guard();
          const ready = this.readReadySnapshot(token);
          last = ready instanceof Promise ? await ready : ready;
          token.check();
          this.guard();
          if (!sameContext(before, last) || !samePiece(before.current, last.current)) {
            this.checkExternalRise(before, last, "before-input");
            if (sameContext(before, last) && sameShapeAtOrBelow(before.current, last.current) && last.current.y > before.current.y) this.replanForGravity(last, "before-input");
            throw new Error("HOLD \uC804 \uC0C1\uD0DC\uAC00 \uBCC0\uACBD\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
          }
          const t = this.now();
          await this.keyboard.tap("HOLD", token, () => {
            nonIdempotentSent = true;
            actions.push({ action: "HOLD", at: this.now() });
          });
          token.check();
          inputMs += this.now() - t;
          this.update("AWAITING_RESULT", "HOLD \uACB0\uACFC\uB97C \uD655\uC778\uD569\uB2C8\uB2E4. \uC7AC\uC804\uC1A1\uD558\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
          confirmationStarted = this.now();
          last = await this.waitUntil(token, (snapshot) => {
            if (snapshot.session !== before.session || snapshot.player !== before.player) throw new Error("HOLD \uD655\uC778 \uC911 \uBC29\xB7\uD50C\uB808\uC774\uC5B4\uAC00 \uBC14\uB00C\uC5C8\uC2B5\uB2C8\uB2E4.");
            const expectedType = before.hold ?? before.next[0];
            const queueOK = before.hold !== null ? sameQueue(snapshot.next, before.next) : sameQueue(snapshot.next.slice(0, 4), before.next.slice(1, 5));
            const holdOK = snapshot.hold === before.current.type && snapshot.current.type === expectedType && snapshot.canHold === false && queueOK && snapshot.lines === before.lines;
            if (!sameBoard(snapshot.board, before.board)) {
              if (holdOK && detectGarbageRise(before.board, snapshot.board)) return true;
              if (!detectGarbageRise(before.board, snapshot.board)) throw new Error("HOLD \uC911 \uC124\uBA85\uB418\uC9C0 \uC54A\uB294 \uBCF4\uB4DC \uBCC0\uD654\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4.");
              return false;
            }
            return holdOK;
          }, 1e3, 100);
          const holdRise = detectGarbageRise(before.board, last.board);
          if (holdRise) throw new ReplanRequired(last, { reason: "garbage-rise", phase: "after-hold", rise: holdRise, reference: "before", completedAction: "HOLD" });
          this.recorder.add(this.record(before, plan, actions, last, "hold", "hold-observed", null, observationMs, inputMs, this.now() - confirmationStarted));
          this.rememberSpawn(last);
          this.update("VALIDATING", "HOLD \uC804\uC774\uB97C \uD655\uC778\uD588\uC2B5\uB2C8\uB2E4. \uB2E4\uC74C \uACC4\uD68D\uC740 \uC0C8 \uAD00\uCE21\uC5D0\uC11C \uB9CC\uB4ED\uB2C8\uB2E4.");
          return;
        }
        if (plan.path.length === 0 || plan.path.at(-1) !== "HARD_DROP" || plan.path.slice(0, -1).includes("HARD_DROP")) throw new Error("\uD558\uB4DC\uB4DC\uB86D \uACBD\uB85C \uACC4\uC57D \uC704\uBC18");
        for (const action of plan.path) {
          token.check();
          this.guard();
          const ready = this.readReadySnapshot(token);
          const fresh = ready instanceof Promise ? await ready : ready;
          token.check();
          this.guard();
          if (!sameContext(before, fresh)) {
            this.checkExternalRise(before, fresh, "before-input");
            throw new Error("\uBCF4\uB4DC\xB7\uD050\xB7\uC870\uAC01\uC774 \uBC14\uB00C\uC5B4 \uC624\uB798\uB41C \uACBD\uB85C\uB97C \uC911\uB2E8\uD588\uC2B5\uB2C8\uB2E4.");
          }
          if (!sameShapeAtOrBelow(last.current, fresh.current)) throw new Error("\uC870\uAC01 \uC704\uCE58\uAC00 \uBC14\uB00C\uC5B4 \uC624\uB798\uB41C \uACBD\uB85C\uB97C \uC911\uB2E8\uD588\uC2B5\uB2C8\uB2E4.");
          if (fresh.current.y > last.current.y) this.replanForGravity(fresh, "before-input");
          const expected = applyRuntimeAction(fresh.board, fresh.current, action);
          if (!expected) throw new Error(`\uC2E4\uD589 \uC804 ${action} \uCDA9\uB3CC\uC744 \uBC1C\uACAC\uD588\uC2B5\uB2C8\uB2E4.`);
          if (action === "HARD_DROP") {
            if (!samePiece(expected, plan.target)) throw new Error("\uD604\uC7AC \uCC29\uC9C0\uAC00 \uACC4\uD68D\uD55C \uBC30\uCE58\uC640 \uB2EC\uB77C \uD558\uB4DC\uB4DC\uB86D\uC744 \uCDE8\uC18C\uD588\uC2B5\uB2C8\uB2E4.");
          }
          const t = this.now();
          await this.keyboard.tap(action, token, () => {
            if (action === "HARD_DROP") nonIdempotentSent = true;
            actions.push({ action, at: this.now() });
          });
          token.check();
          inputMs += this.now() - t;
          if (action !== "HARD_DROP") {
            last = await this.waitUntil(token, (s) => {
              if (!sameContext(before, s)) {
                this.checkExternalRise(before, s, "movement");
                throw new Error("\uC774\uB3D9 \uD655\uC778 \uC911 \uBCF4\uB4DC\xB7\uD050\uAC00 \uBCC0\uACBD\uB418\uC5C8\uC2B5\uB2C8\uB2E4.");
              }
              return sameShapeAtOrBelow(expected, s.current);
            }, 600);
            if (last.current.y > expected.y) this.replanForGravity(last, "movement");
            this.orientation = this.withOrientation(last, { ...expected, y: last.current.y });
          }
        }
        this.update("AWAITING_RESULT", "\uACE0\uC815 \uBCF4\uB4DC\xB7\uC904\xB7\uACF5\uAC1C \uD050 \uACB0\uACFC\uB97C \uD655\uC778\uD569\uB2C8\uB2E4.");
        confirmationStarted = this.now();
        last = await this.waitUntil(token, (s) => {
          if (s.session !== before.session || s.player !== before.player) throw new Error("\uACE0\uC815 \uACB0\uACFC \uD655\uC778 \uC911 \uBC29\xB7\uD50C\uB808\uC774\uC5B4\uAC00 \uBC14\uB00C\uC5C8\uC2B5\uB2C8\uB2E4.");
          const nextOK = s.current.type === before.next[0] && sameQueue(s.next.slice(0, 4), before.next.slice(1, 5));
          const linesOK = before.lines === null || s.lines === null || s.lines - before.lines === plan.cleared;
          const transitionEvidence = !sameBoard(s.board, before.board) || s.lines !== null && before.lines !== null && s.lines > before.lines || !sameQueue(s.next, before.next);
          const lockOK = s.hold === before.hold && s.canHold === true && nextOK && linesOK && transitionEvidence;
          return lockOK && (sameBoard(s.board, plan.expectedBoard) || detectGarbageRise(plan.expectedBoard, s.board) !== null);
        }, 1200, 100);
        const lockRise = detectGarbageRise(plan.expectedBoard, last.board);
        if (lockRise) throw new ReplanRequired(last, { reason: "garbage-rise", phase: "after-lock", rise: lockRise, reference: "predicted-lock", completedAction: "HARD_DROP" });
        this.update("VALIDATING", "DOM \uD45C\uC2DC \uC804\uC774\uB97C \uBE44\uAD50\uD569\uB2C8\uB2E4. \uC11C\uBC84 \uD655\uC815 \uC5EC\uBD80\uB294 \uC54C \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
        this.locks++;
        this.recorder.add(this.record(before, plan, actions, last, "placement", "display-match", null, observationMs, inputMs, this.now() - confirmationStarted));
        this.rememberSpawn(last);
      } catch (error) {
        this.orientation = null;
        if (error instanceof ReplanRequired && !token.cancelled) {
          const entry = this.record(before, plan, actions, error.snapshot, "resync", "resynced", null, observationMs, inputMs, this.now() - confirmationStarted);
          entry.recovery = error.recovery;
          entry.validation.observedRise = error.recovery.rise ? "match" : "unknown";
          if (error.recovery.completedAction !== null) {
            entry.validation.hold = "match";
            entry.validation.queue = "match";
            if (before.lines !== null && error.snapshot.lines !== null) entry.validation.clear = "match";
          }
          this.recorder.add(entry);
          throw error;
        }
        try {
          last = this.reader.read();
        } catch {
        }
        const message = error instanceof Error ? error.message : String(error);
        this.recorder.add(this.record(
          before,
          plan,
          actions,
          last,
          "failure",
          token.cancelled ? "cancelled" : "unknown",
          `${message}${nonIdempotentSent ? " \uBE44\uBA71\uB4F1 \uC785\uB825\uC740 \uC7AC\uC804\uC1A1\uD558\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4." : ""}`,
          observationMs,
          inputMs,
          this.now() - confirmationStarted
        ));
        throw error;
      }
    }
    checkExternalRise(before, after, phase) {
      if (!samePieceContext(before, after)) return;
      const rise = detectGarbageRise(before.board, after.board);
      if (rise) throw new ReplanRequired(after, { reason: "garbage-rise", phase, rise, reference: "before", completedAction: null });
    }
    replanForGravity(snapshot, phase) {
      throw new ReplanRequired(snapshot, { reason: "gravity-advance", phase, rise: null, reference: "before", completedAction: null });
    }
    async settleForReplan(anchor, token) {
      let stableSince = null;
      let stableBoard = "";
      await this.waitUntil(token, (snapshot) => {
        if (!samePieceContext(anchor, snapshot)) throw new Error("\uC7AC\uACC4\uD68D \uD655\uC778 \uC911 \uBC29\xB7\uD50C\uB808\uC774\uC5B4\xB7\uC870\uAC01 \uC804\uC774\uAC00 \uB2EC\uB77C\uC838 \uC911\uC9C0\uD588\uC2B5\uB2C8\uB2E4.");
        if (!sameBoard(anchor.board, snapshot.board) && !detectGarbageRise(anchor.board, snapshot.board)) throw new Error("\uC7AC\uACC4\uD68D \uD655\uC778 \uC911 \uC124\uBA85\uB418\uC9C0 \uC54A\uB294 \uBCF4\uB4DC \uBCC0\uD654\uAC00 \uBC1C\uC0DD\uD588\uC2B5\uB2C8\uB2E4.");
        const key = snapshot.board.join(",");
        if (stableSince === null || key !== stableBoard) {
          stableSince = this.now();
          stableBoard = key;
        }
        return this.now() - stableSince >= 80;
      }, 800);
    }
    async waitUntil(token, accept, timeoutMs = 1e3, stableMs = 0) {
      const start = this.now();
      let stableSince = null;
      let stableKey = "";
      while (this.now() - start < timeoutMs) {
        token.check();
        this.guard();
        let snapshot = null;
        try {
          snapshot = this.readSnapshot();
        } catch {
        }
        if (snapshot && accept(snapshot)) {
          const key = `${snapshot.board.join(",")}/${snapshot.next.join("")}/${snapshot.hold}/${snapshot.lines}`;
          if (stableSince === null || key !== stableKey) {
            stableSince = this.now();
            stableKey = key;
          }
          if (this.now() - stableSince >= stableMs) return snapshot;
        } else stableSince = null;
        await token.wait(12);
      }
      throw new Error("\uCC98\uB9AC \uACB0\uACFC\uB97C \uD655\uC778\uD558\uC9C0 \uBABB\uD574 \uC911\uC9C0\uD588\uC2B5\uB2C8\uB2E4. \uC0C1\uD0DC \uC810\uAC80\xB7\uAE30\uB85D\uC744 \uD655\uC778\uD558\uC138\uC694.");
    }
    withOrientation(snapshot, pose) {
      const current = Object.freeze(pose);
      return Object.freeze({
        ...snapshot,
        current,
        rotationCandidates: Object.freeze([current]),
        fingerprint: `${snapshot.fingerprint.split(":r")[0]}:r${pose.rotation}`
      });
    }
    /** Keep a valid synchronous observation adjacent to its checks and input. */
    readReadySnapshot(token) {
      token.check();
      this.guard();
      try {
        return this.readSnapshot();
      } catch (error) {
        if (!(error instanceof DomReadError) || error.kind !== "transition") throw error;
        return this.retrySnapshot(token, error);
      }
    }
    async retrySnapshot(token, initial) {
      const started = this.now();
      let last = initial;
      this.update(this.state, "\uC870\uAC01 \uC0DD\uC131\xB7\uACE0\uC815 \uD45C\uC2DC\uAC00 \uB05D\uB098\uAE30\uB97C \uAE30\uB2E4\uB9BD\uB2C8\uB2E4.");
      while (this.now() - started < 1200) {
        await token.wait(24);
        token.check();
        this.guard();
        try {
          return this.readSnapshot();
        } catch (error) {
          if (!(error instanceof DomReadError) || error.kind !== "transition") throw error;
          last = error;
        }
      }
      throw new DomReadError("transition", `1.2\uCD08 \uB3D9\uC548 \uD604\uC7AC \uC870\uAC01\uC744 \uC77D\uC9C0 \uBABB\uD588\uC2B5\uB2C8\uB2E4. F9 \uC0C1\uD0DC \uC810\uAC80\uC5D0\uC11C \uAC8C\uC784 \uC0C1\uD0DC\uB97C \uD655\uC778\uD558\uC138\uC694. (${last.message})`);
    }
    readSnapshot() {
      const fresh = this.reader.read();
      if (this.orientation && sameContext(this.orientation, fresh) && sameShapeAtOrBelow(this.orientation.current, fresh.current)) {
        return this.withOrientation(fresh, { ...fresh.current, rotation: this.orientation.current.rotation });
      }
      this.orientation = null;
      return fresh;
    }
    rememberSpawn(snapshot) {
      const spawn = spawnPiece(snapshot.board, snapshot.current.type);
      if (spawn && sameShapeAtOrBelow(spawn, snapshot.current)) this.orientation = this.withOrientation(snapshot, { ...snapshot.current, rotation: 0 });
      else this.orientation = null;
    }
    record(before, plan, actions, after, type, result, error, observationMs, inputMs, confirmationMs) {
      const matched = result === "display-match";
      const held = result === "hold-observed";
      return {
        schema: 2,
        scriptVersion: SCRIPT_VERSION,
        type,
        ruleProfile: plan.ruleProfile,
        before,
        plan,
        actions,
        after,
        result,
        error,
        validation: {
          board: matched || held ? "match" : "unknown",
          clear: matched && before.lines !== null && after?.lines !== null ? "match" : "unknown",
          hold: matched || held ? "match" : "unknown",
          queue: matched || held ? "match" : "unknown",
          spin: "unknown",
          attack: "unknown",
          cancel: "unknown",
          insertion: "unknown",
          authoritative: "unknown"
        },
        timings: { observationMs, searchMs: plan.elapsedMs, inputMs, confirmationMs }
      };
    }
    update(state, message) {
      this.state = state;
      this.onUpdate({ state, message, locks: this.locks, resyncs: this.resyncs, plan: this.lastPlan });
    }
  };

  // src/runtime/worker-client.ts
  var WorkerPlanner = class {
    worker = null;
    serial = 0;
    pending = null;
    plan(snapshot, generation) {
      this.cancel();
      const id = ++this.serial;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (id === this.serial) this.cancel();
        }, 2500);
        this.pending = { reject, timer };
        try {
          const url = URL.createObjectURL(new Blob(['"use strict";\n(() => {\n  // src/types/game.ts\n  var BOARD_WIDTH = 10;\n  var BOARD_HEIGHT = 20;\n  var FULL_ROW = (1 << BOARD_WIDTH) - 1;\n  var PIECE_TYPES = ["I", "J", "L", "O", "S", "T", "Z"];\n  function asRotation(value) {\n    const number = Number(value);\n    const normalized = Number.isFinite(number) ? (Math.trunc(number) % 4 + 4) % 4 : 0;\n    return normalized;\n  }\n\n  // src/runtime/model.ts\n  var RUNTIME_RULE_PROFILE = Object.freeze({\n    id: "buriburiland-client-847.a5a05f14ceb3f87d-2026-10-23",\n    evidence: "Public client chunk 847.a5a05f14ceb3f87d.js: K/en/ee/ei/eo/ea; server behavior still requires lock validation",\n    verifiedAt: "2026-10-23",\n    coordinateSpace: "trimmed-bounding-box",\n    visibleRows: 20,\n    columns: 10,\n    spawn: "x=3, rotation=0; first legal y in [0,-1,-2]",\n    rotation: "client SRS with bounding-box offset correction",\n    rotation180: false,\n    attackPrediction: false,\n    spinPrediction: false,\n    futureGarbage: "unknown; never invented"\n  });\n\n  // src/physics/tetrominoes.ts\n  var SHAPES = {\n    I: [\n      [[0, 1], [1, 1], [2, 1], [3, 1]],\n      [[2, 0], [2, 1], [2, 2], [2, 3]],\n      [[0, 2], [1, 2], [2, 2], [3, 2]],\n      [[1, 0], [1, 1], [1, 2], [1, 3]]\n    ],\n    J: [\n      [[0, 0], [0, 1], [1, 1], [2, 1]],\n      [[1, 0], [2, 0], [1, 1], [1, 2]],\n      [[0, 1], [1, 1], [2, 1], [2, 2]],\n      [[1, 0], [1, 1], [0, 2], [1, 2]]\n    ],\n    L: [\n      [[2, 0], [0, 1], [1, 1], [2, 1]],\n      [[1, 0], [1, 1], [1, 2], [2, 2]],\n      [[0, 1], [1, 1], [2, 1], [0, 2]],\n      [[0, 0], [1, 0], [1, 1], [1, 2]]\n    ],\n    O: [\n      [[1, 0], [2, 0], [1, 1], [2, 1]],\n      [[1, 0], [2, 0], [1, 1], [2, 1]],\n      [[1, 0], [2, 0], [1, 1], [2, 1]],\n      [[1, 0], [2, 0], [1, 1], [2, 1]]\n    ],\n    S: [\n      [[1, 0], [2, 0], [0, 1], [1, 1]],\n      [[1, 0], [1, 1], [2, 1], [2, 2]],\n      [[1, 1], [2, 1], [0, 2], [1, 2]],\n      [[0, 0], [0, 1], [1, 1], [1, 2]]\n    ],\n    T: [\n      [[1, 0], [0, 1], [1, 1], [2, 1]],\n      [[1, 0], [1, 1], [2, 1], [1, 2]],\n      [[0, 1], [1, 1], [2, 1], [1, 2]],\n      [[1, 0], [0, 1], [1, 1], [1, 2]]\n    ],\n    Z: [\n      [[0, 0], [1, 0], [1, 1], [2, 1]],\n      [[2, 0], [1, 1], [2, 1], [1, 2]],\n      [[0, 1], [1, 1], [1, 2], [2, 2]],\n      [[1, 0], [0, 1], [1, 1], [0, 2]]\n    ]\n  };\n  function cellsFor(type, rotation) {\n    return SHAPES[type][rotation] ?? [];\n  }\n\n  // src/physics/board.ts\n  function collides(board, type, rotation, x, y) {\n    for (const [cellX, cellY] of cellsFor(type, rotation)) {\n      const boardX = x + cellX;\n      const boardY = y + cellY;\n      if (boardX < 0 || boardX >= BOARD_WIDTH || boardY >= BOARD_HEIGHT) return true;\n      if (boardY >= 0 && ((board[boardY] ?? 0) & 1 << boardX) !== 0) return true;\n    }\n    return false;\n  }\n  function hardDropY(board, type, rotation, x, startY) {\n    if (collides(board, type, rotation, x, startY)) throw new Error("Cannot hard-drop a colliding piece");\n    let y = startY;\n    while (!collides(board, type, rotation, x, y + 1)) y += 1;\n    return y;\n  }\n  function lockPiece(board, type, rotation, x, y) {\n    if (collides(board, type, rotation, x, y)) return null;\n    const placed = [...board];\n    let topOut = false;\n    for (const [cellX, cellY] of cellsFor(type, rotation)) {\n      const boardX = x + cellX;\n      const boardY = y + cellY;\n      if (boardY < 0) {\n        topOut = true;\n        continue;\n      }\n      placed[boardY] = (placed[boardY] ?? 0) | 1 << boardX;\n    }\n    const clearedRows = [];\n    for (let row = 0; row < BOARD_HEIGHT; row += 1) {\n      if (((placed[row] ?? 0) & FULL_ROW) === FULL_ROW) clearedRows.push(row);\n    }\n    const clearedSet = new Set(clearedRows);\n    const after = placed.filter((_, index) => !clearedSet.has(index));\n    while (after.length < BOARD_HEIGHT) after.unshift(0);\n    return { board: after, preClearBoard: placed, cleared: clearedRows.length, clearedRows, topOut };\n  }\n\n  // src/physics/srs.ts\n  var JLSTZ_KICKS = {\n    "0>1": [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],\n    "1>0": [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],\n    "1>2": [[0, 0], [1, 0], [1, 1], [0, -2], [1, -2]],\n    "2>1": [[0, 0], [-1, 0], [-1, -1], [0, 2], [-1, 2]],\n    "2>3": [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]],\n    "3>2": [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],\n    "3>0": [[0, 0], [-1, 0], [-1, 1], [0, -2], [-1, -2]],\n    "0>3": [[0, 0], [1, 0], [1, -1], [0, 2], [1, 2]]\n  };\n  var I_KICKS = {\n    "0>1": [[0, 0], [-2, 0], [1, 0], [-2, 1], [1, -2]],\n    "1>0": [[0, 0], [2, 0], [-1, 0], [2, -1], [-1, 2]],\n    "1>2": [[0, 0], [-1, 0], [2, 0], [-1, -2], [2, 1]],\n    "2>1": [[0, 0], [1, 0], [-2, 0], [1, 2], [-2, -1]],\n    "2>3": [[0, 0], [2, 0], [-1, 0], [2, -1], [-1, 2]],\n    "3>2": [[0, 0], [-2, 0], [1, 0], [-2, 1], [1, -2]],\n    "3>0": [[0, 0], [1, 0], [-2, 0], [1, 2], [-2, -1]],\n    "0>3": [[0, 0], [-1, 0], [2, 0], [-1, -2], [2, 1]]\n  };\n  function rotateSrs(board, type, state, direction) {\n    const to = asRotation(state.rotation + direction);\n    if (type === "O") return { ...state, rotation: to, kickIndex: 0, kick: [0, 0] };\n    const table = type === "I" ? I_KICKS : JLSTZ_KICKS;\n    const kicks = table[`${state.rotation}>${to}`] ?? [[0, 0]];\n    for (let kickIndex = 0; kickIndex < kicks.length; kickIndex += 1) {\n      const kick = kicks[kickIndex];\n      if (!kick) continue;\n      const [offsetX, offsetY] = kick;\n      const x = state.x + offsetX;\n      const y = state.y + offsetY;\n      if (!collides(board, type, to, x, y)) return { x, y, rotation: to, kickIndex, kick };\n    }\n    return null;\n  }\n\n  // src/runtime/engine.ts\n  var offsets = /* @__PURE__ */ new Map();\n  var shapes = /* @__PURE__ */ new Map();\n  for (const type of PIECE_TYPES) {\n    for (const rotation of [0, 1, 2, 3]) {\n      const cells = cellsFor(type, rotation);\n      const offset = [Math.min(...cells.map(([x]) => x)), Math.min(...cells.map(([, y]) => y))];\n      offsets.set(`${type}${rotation}`, offset);\n      shapes.set(`${type}${rotation}`, cells.map(([x, y]) => [x - offset[0], y - offset[1]]));\n    }\n  }\n  function cellsFor2(type, rotation) {\n    return shapes.get(`${type}${rotation}`) ?? [];\n  }\n  function offsetFor(type, rotation) {\n    return offsets.get(`${type}${rotation}`) ?? [0, 0];\n  }\n  function runtimeCells(piece) {\n    return cellsFor2(piece.type, piece.rotation).map(([x, y]) => [piece.x + x, piece.y + y]);\n  }\n  function collides2(board, type, rotation, x, y) {\n    const [offsetX, offsetY] = offsetFor(type, rotation);\n    return collides(board, type, rotation, x - offsetX, y - offsetY);\n  }\n  function hardDropY2(board, type, rotation, x, startY) {\n    const [offsetX, offsetY] = offsetFor(type, rotation);\n    return hardDropY(board, type, rotation, x - offsetX, startY - offsetY) + offsetY;\n  }\n  function lockPiece2(board, type, rotation, x, y) {\n    const [offsetX, offsetY] = offsetFor(type, rotation);\n    return lockPiece(board, type, rotation, x - offsetX, y - offsetY);\n  }\n  function rotateSrs2(board, piece, direction) {\n    if (piece.type === "O") return piece;\n    const [fromX, fromY] = offsetFor(piece.type, piece.rotation);\n    const rotated = rotateSrs(board, piece.type, {\n      x: piece.x - fromX,\n      y: piece.y - fromY,\n      rotation: piece.rotation\n    }, direction);\n    if (!rotated) return null;\n    const [toX, toY] = offsetFor(piece.type, rotated.rotation);\n    return { type: piece.type, x: rotated.x + toX, y: rotated.y + toY, rotation: rotated.rotation };\n  }\n  function applyRuntimeAction(board, current, action) {\n    if (collides2(board, current.type, current.rotation, current.x, current.y)) return null;\n    if (action === "ROTATE_CW" || action === "ROTATE_CCW") {\n      return rotateSrs2(board, current, action === "ROTATE_CW" ? 1 : -1);\n    }\n    if (action === "HARD_DROP") {\n      return { ...current, y: hardDropY2(board, current.type, current.rotation, current.x, current.y) };\n    }\n    const next = { ...current, x: current.x + (action === "LEFT" ? -1 : action === "RIGHT" ? 1 : 0), y: current.y + (action === "SOFT_DROP" ? 1 : 0) };\n    return collides2(board, next.type, next.rotation, next.x, next.y) ? null : next;\n  }\n  function spawnPiece(board, type) {\n    for (const y of [0, -1, -2]) {\n      const piece = { type, x: 3, y, rotation: 0 };\n      if (!collides2(board, type, 0, piece.x, piece.y)) return piece;\n    }\n    return null;\n  }\n  function boardFeatures(board) {\n    const heights = [];\n    let holes = 0, coveredCells = 0, holeDepth = 0, occupied = 0, columnTransitions = 0;\n    for (let x = 0; x < BOARD_WIDTH; x += 1) {\n      let first = BOARD_HEIGHT, blocksAbove = 0, previous = true;\n      for (let y = 0; y < BOARD_HEIGHT; y += 1) {\n        const filled = ((board[y] ?? 0) >> x & 1) === 1;\n        if (filled !== previous) columnTransitions += 1;\n        previous = filled;\n        if (filled) {\n          first = Math.min(first, y);\n          blocksAbove += 1;\n          occupied += 1;\n        } else if (blocksAbove > 0) {\n          holes += 1;\n          coveredCells += blocksAbove;\n          holeDepth += y - first;\n        }\n      }\n      if (!previous) columnTransitions += 1;\n      heights.push(BOARD_HEIGHT - first);\n    }\n    let bumpiness = 0, wells = 0, deepCanyon = 0, rowTransitions = 0;\n    for (let x = 0; x < BOARD_WIDTH; x += 1) {\n      const height = heights[x] ?? 0;\n      if (x > 0) bumpiness += Math.abs(height - (heights[x - 1] ?? 0));\n      const left = x === 0 ? BOARD_HEIGHT : heights[x - 1] ?? 0;\n      const right = x === BOARD_WIDTH - 1 ? BOARD_HEIGHT : heights[x + 1] ?? 0;\n      const depth = Math.max(0, Math.min(left, right) - height);\n      wells += depth * (depth + 1) / 2;\n      deepCanyon += Math.max(0, depth - (x === 0 || x === BOARD_WIDTH - 1 ? 4 : 2)) ** 2;\n    }\n    for (let y = 0; y < BOARD_HEIGHT; y += 1) {\n      let previous = true;\n      for (let x = 0; x < BOARD_WIDTH; x += 1) {\n        const filled = ((board[y] ?? 0) >> x & 1) === 1;\n        if (filled !== previous) rowTransitions += 1;\n        previous = filled;\n      }\n      if (!previous) rowTransitions += 1;\n    }\n    return { heights, aggregateHeight: heights.reduce((sum, value) => sum + value, 0), maxHeight: Math.max(...heights), holes, coveredCells, holeDepth, bumpiness, wells, deepCanyon, rowTransitions, columnTransitions, occupied };\n  }\n  function evaluateBoard(board, incoming = null) {\n    const f = boardFeatures(board);\n    const pressure = incoming === null ? 0 : Math.min(12, Math.max(0, incoming));\n    const projectedHeight = f.maxHeight + pressure;\n    const danger = Math.max(0, projectedHeight - 12);\n    return -f.holes * 21 - f.coveredCells * 1.8 - f.holeDepth * 1.5 - f.aggregateHeight * 0.64 - f.maxHeight * 1.8 - f.bumpiness * 0.56 - f.wells * 0.12 - f.deepCanyon * 2.8 - f.rowTransitions * 0.13 - f.columnTransitions * 0.16 - danger * danger * 3.5;\n  }\n  function takeNode(budget) {\n    if (budget.nodes >= budget.maxNodes || budget.now() >= budget.deadline) {\n      budget.exhausted = true;\n      return false;\n    }\n    budget.nodes += 1;\n    return true;\n  }\n  var TRANSITIONS = ["LEFT", "RIGHT", "ROTATE_CW", "ROTATE_CCW", "SOFT_DROP"];\n  function poseKey(piece) {\n    return `${piece.x}/${piece.y}/${piece.rotation}`;\n  }\n  function cellKey(piece) {\n    return runtimeCells(piece).map(([x, y]) => y * 32 + x).sort((a, b) => a - b).join("/");\n  }\n  function buildPath(queue, index) {\n    const path = ["HARD_DROP"];\n    let cursor = index;\n    while (cursor >= 0) {\n      const state = queue[cursor];\n      if (!state) break;\n      if (state.action) path.push(state.action);\n      cursor = state.parent;\n    }\n    return path.reverse();\n  }\n  function generate(board, initial, budget, options, accept) {\n    const current = initial[0];\n    if (!current || initial.some((piece) => collides2(board, piece.type, piece.rotation, piece.x, piece.y))) return [];\n    const initialCellKey = cellKey(current);\n    if (initial.some((piece) => piece.type !== current.type || cellKey(piece) !== initialCellKey)) return [];\n    const maxStates = positiveInteger(options.maxStatesPerBoard, 1600, 2e4);\n    const maxPathLength = positiveInteger(options.maxPathLength, 60, 120);\n    const queue = [{ poses: initial, parent: -1, action: null, steps: 0 }];\n    const visited = /* @__PURE__ */ new Set([initial.map(poseKey).join("|")]);\n    const placements = /* @__PURE__ */ new Map();\n    for (let index = 0; index < queue.length && index < maxStates; index += 1) {\n      if (!takeNode(budget)) break;\n      const state = queue[index];\n      const piece = state?.poses[0];\n      if (!state || !piece) continue;\n      const target = { ...piece, y: hardDropY2(board, piece.type, piece.rotation, piece.x, piece.y) };\n      const lock = lockPiece2(board, target.type, target.rotation, target.x, target.y);\n      if (lock && !lock.topOut) {\n        const key = lock.board.join(",");\n        if (!placements.has(key)) {\n          const placement = { target, path: buildPath(queue, index), board: lock.board, cleared: lock.cleared };\n          placements.set(key, placement);\n          accept?.(placement);\n        }\n      }\n      if (state.steps >= maxPathLength) continue;\n      for (const action of TRANSITIONS) {\n        const nextPoses = [];\n        let nextCellKey = null;\n        let legal = true;\n        for (const pose of state.poses) {\n          const next = applyRuntimeAction(board, pose, action);\n          if (!next || next.y < Math.min(-4, current.y)) {\n            legal = false;\n            break;\n          }\n          if (state.poses.length > 1) {\n            const occupied = cellKey(next);\n            if (nextCellKey !== null && occupied !== nextCellKey) {\n              legal = false;\n              break;\n            }\n            nextCellKey = occupied;\n          }\n          nextPoses.push(next);\n        }\n        if (!legal) continue;\n        const key = nextPoses.map(poseKey).join("|");\n        if (visited.has(key) || visited.size >= maxStates) continue;\n        visited.add(key);\n        queue.push({ poses: nextPoses, parent: index, action, steps: state.steps + 1 });\n      }\n    }\n    return [...placements.values()];\n  }\n  function positiveInteger(value, fallback, maximum) {\n    return value !== void 0 && Number.isFinite(value) ? Math.max(1, Math.min(maximum, Math.floor(value))) : fallback;\n  }\n  function finitePositive(value, fallback) {\n    return value !== void 0 && Number.isFinite(value) ? Math.max(0, value) : fallback;\n  }\n  function clearReward(cleared) {\n    return [0, 5, 13, 24, 38][cleared] ?? cleared * 10;\n  }\n  function validRuntimePose(value) {\n    if (!value || typeof value !== "object") return false;\n    const piece = value;\n    return PIECE_TYPES.includes(piece.type) && Number.isInteger(piece.x) && piece.x >= -4 && piece.x < BOARD_WIDTH && Number.isInteger(piece.y) && piece.y >= -4 && piece.y < BOARD_HEIGHT && Number.isInteger(piece.rotation) && piece.rotation >= 0 && piece.rotation <= 3;\n  }\n  function validSnapshot(value) {\n    if (!value || typeof value !== "object") return false;\n    const snapshot = value;\n    const counter = (number) => typeof number === "number" && Number.isSafeInteger(number) && number >= 0;\n    if (typeof snapshot.paused !== "boolean" || typeof snapshot.ended !== "boolean" || snapshot.paused || snapshot.ended || !Array.isArray(snapshot.board) || snapshot.board.length !== BOARD_HEIGHT || !Array.from(snapshot.board).every((row) => Number.isInteger(row) && row >= 0 && row <= FULL_ROW) || !validRuntimePose(snapshot.current) || !Array.isArray(snapshot.next) || snapshot.next.length > 5 || !Array.from(snapshot.next).every((type) => PIECE_TYPES.includes(type)) || snapshot.hold !== null && !PIECE_TYPES.includes(snapshot.hold) || snapshot.canHold !== null && typeof snapshot.canHold !== "boolean" || !["session", "player", "fingerprint"].every((key) => typeof value[key] === "string" && value[key].length > 0) || !Number.isFinite(snapshot.observedAt) || snapshot.observedAt < 0 || !counter(snapshot.observation) || snapshot.lines !== null && !counter(snapshot.lines) || snapshot.incoming !== null && !counter(snapshot.incoming)) return false;\n    if (snapshot.rotationCandidates === void 0) return true;\n    if (!Array.isArray(snapshot.rotationCandidates) || snapshot.rotationCandidates.length < 1 || snapshot.rotationCandidates.length > 4) return false;\n    const candidates = Array.from(snapshot.rotationCandidates);\n    const currentCells = cellKey(snapshot.current);\n    if (!candidates.every((piece) => validRuntimePose(piece) && piece.type === snapshot.current.type && cellKey(piece) === currentCells)) return false;\n    const keys = candidates.map(poseKey);\n    return new Set(keys).size === keys.length && keys.includes(poseKey(snapshot.current));\n  }\n  function search(snapshot, options = {}) {\n    if (!validSnapshot(snapshot)) return null;\n    const now = options.now ?? (() => performance.now());\n    const started = now();\n    const budget = { started, deadline: started + finitePositive(options.budgetMs, 45), now, maxNodes: positiveInteger(options.maxNodes, 12e3, 1e6), nodes: 0, exhausted: false };\n    const requestedDepth = positiveInteger(options.depth, 2, 5);\n    const beamWidth = positiveInteger(options.beamWidth, 8, 64);\n    const roots = [];\n    const makeRoot = (placement, kind, queue, hold, rootHoldTarget) => {\n      const reward = clearReward(placement.cleared) - placement.path.length * 0.025 - (kind === "hold" ? 0.4 : 0);\n      roots.push({ board: placement.board, queue, hold, first: placement, kind, rootHoldTarget, reward, score: evaluateBoard(placement.board, snapshot.incoming) + reward });\n    };\n    const poses = snapshot.rotationCandidates && snapshot.rotationCandidates.length > 0 ? snapshot.rotationCandidates : [snapshot.current];\n    generate(snapshot.board, poses, budget, options, (placement) => makeRoot(placement, "place", snapshot.next, snapshot.hold, null));\n    if (snapshot.canHold === true && options.allowHold !== false && !budget.exhausted) {\n      const replacement = snapshot.hold ?? snapshot.next[0];\n      if (replacement) {\n        const spawn = spawnPiece(snapshot.board, replacement);\n        const next = snapshot.hold === null ? snapshot.next.slice(1) : snapshot.next;\n        if (spawn) generate(snapshot.board, [spawn], budget, options, (placement) => makeRoot(placement, "hold", next, snapshot.current.type, spawn));\n      }\n    }\n    if (roots.length === 0) return null;\n    const depthLimit = Math.min(requestedDepth, 1 + Math.min(...roots.map((root) => root.queue.length)));\n    roots.sort(compareNodes);\n    let selected = roots[0];\n    let completedDepth = 1;\n    let beam = roots.slice(0, beamWidth);\n    for (let depth = 2; depth <= depthLimit && !budget.exhausted; depth += 1) {\n      const children = [];\n      const transpositions = /* @__PURE__ */ new Map();\n      let complete = true;\n      for (const parent of beam) {\n        const nextType = parent.queue[0];\n        if (!nextType) {\n          children.push(parent);\n          continue;\n        }\n        const choices = [{ type: nextType, queue: parent.queue.slice(1), hold: parent.hold, cost: 0 }];\n        if (options.allowHold !== false) {\n          const replacement = parent.hold ?? parent.queue[1];\n          if (replacement && replacement !== nextType) choices.push({ type: replacement, queue: parent.hold === null ? parent.queue.slice(2) : parent.queue.slice(1), hold: nextType, cost: 0.4 });\n        }\n        for (const choice of choices) {\n          const spawn = spawnPiece(parent.board, choice.type);\n          if (!spawn) continue;\n          generate(parent.board, [spawn], budget, options, (placement) => {\n            const reward = parent.reward + clearReward(placement.cleared) * 0.92 ** (depth - 1) - placement.path.length * 0.012 - choice.cost;\n            const score = evaluateBoard(placement.board, snapshot.incoming) + reward;\n            const key = `${placement.board.join(",")}:${choice.hold ?? "-"}:${choice.queue.join("")}`;\n            if ((transpositions.get(key) ?? -Infinity) >= score) return;\n            transpositions.set(key, score);\n            children.push({ ...parent, board: placement.board, queue: choice.queue, hold: choice.hold, reward, score });\n          });\n          if (budget.exhausted) {\n            complete = false;\n            break;\n          }\n        }\n        if (!complete) break;\n      }\n      if (!complete || children.length === 0) break;\n      children.sort(compareNodes);\n      beam = children.slice(0, beamWidth);\n      selected = beam[0];\n      completedDepth = depth;\n    }\n    const assumptions = ["Public client physics; server corrections and lock timing require observed validation", "No attack, spin, or random future garbage prediction"];\n    if (poses.length > 1) assumptions.push("Ambiguous rotation: path must produce identical occupied cells for every candidate");\n    if (completedDepth > 1) assumptions.push("Future pieces use the public client spawn rule and only the visible queue");\n    if (selected.kind === "hold") assumptions.push("HOLD is a separate transition; reobserve before planning any placement");\n    return {\n      kind: selected.kind,\n      path: selected.kind === "place" ? selected.first.path : [],\n      target: selected.kind === "place" ? selected.first.target : selected.rootHoldTarget,\n      expectedBoard: selected.kind === "place" ? selected.first.board : [...snapshot.board],\n      cleared: selected.kind === "place" ? selected.first.cleared : 0,\n      score: selected.score,\n      nodes: budget.nodes,\n      elapsedMs: Math.max(0, now() - started),\n      fingerprint: snapshot.fingerprint,\n      session: snapshot.session,\n      player: snapshot.player,\n      observation: snapshot.observation,\n      depth: completedDepth,\n      budgetExhausted: budget.exhausted,\n      ruleProfile: RUNTIME_RULE_PROFILE.id,\n      assumptions\n    };\n  }\n  function compareNodes(left, right) {\n    return right.score - left.score || (left.kind === "place" ? 0 : 1) - (right.kind === "place" ? 0 : 1) || left.first.path.length - right.first.path.length || left.first.target.x - right.first.target.x || left.first.target.rotation - right.first.target.rotation;\n  }\n\n  // src/runtime/worker-entry.ts\n  var scope = self;\n  scope.onmessage = (event) => {\n    const { id, generation, snapshot } = event.data;\n    try {\n      const plan = search(snapshot, { budgetMs: 100, depth: 3, beamWidth: 10, maxNodes: 4e4, maxStatesPerBoard: 1500, maxPathLength: 14, allowHold: true });\n      scope.postMessage({ id, generation, fingerprint: snapshot.fingerprint, plan });\n    } catch (error) {\n      scope.postMessage({ id, generation, fingerprint: snapshot.fingerprint, error: error instanceof Error ? error.message : String(error) });\n    }\n  };\n})();\n'], { type: "text/javascript" }));
          try {
            this.worker = new Worker(url, { name: "buriburiland-tetris-search" });
          } finally {
            URL.revokeObjectURL(url);
          }
          this.worker.onerror = (event) => {
            if (id !== this.serial) return;
            event.preventDefault();
            this.finish();
            reject(new Error("Worker \uC2E4\uD589 \uC2E4\uD328. \uBE0C\uB77C\uC6B0\uC800 CSP\xB7userscript \uC2E4\uD589 \uC124\uC815\uC744 \uD655\uC778\uD558\uC138\uC694."));
          };
          this.worker.onmessage = (event) => {
            const data = event.data;
            if (!data || typeof data !== "object") return;
            if (id !== this.serial || data.id !== id || data.generation !== generation || data.fingerprint !== snapshot.fingerprint) return;
            this.finish();
            if (data.error || !data.plan) reject(new Error(data.error ?? "Worker \uACC4\uD68D\uC774 \uC5C6\uC2B5\uB2C8\uB2E4."));
            else resolve(data.plan);
          };
          this.worker.postMessage({ id, generation, snapshot });
        } catch (error) {
          this.finish();
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    }
    cancel() {
      this.serial++;
      const pending = this.pending;
      this.finish();
      pending?.reject(new Error("Worker \uC694\uCCAD\uC774 \uCDE8\uC18C\uB418\uC5C8\uAC70\uB098 \uC81C\uD55C \uC2DC\uAC04\uC744 \uCD08\uACFC\uD588\uC2B5\uB2C8\uB2E4."));
    }
    finish() {
      if (this.pending) clearTimeout(this.pending.timer);
      this.pending = null;
      this.worker?.terminate();
      this.worker = null;
    }
  };

  // src/userscript/main.ts
  if (!document.getElementById("buriburi-ai-host")) {
    let inspect2 = function() {
      try {
        const report = adapter.report();
        status.textContent = JSON.stringify(report, null, 2);
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : String(error);
      }
    }, stop2 = function(message) {
      selecting = false;
      controller.stop(message);
    }, stopForEnvironment2 = function(message) {
      if (!selecting && ["STOPPED", "ERROR", "PAUSED"].includes(controller.state)) return;
      const previous = controller.state;
      stop2(`${message}
\uC9C1\uC804 \uB2E8\uACC4: ${previous}. \uAC8C\uC784 \uD654\uBA74\uC5D0\uC11C \uC5F0\uC18D \uC2E4\uD589\uC744 \uB20C\uB7EC \uC7AC\uC2DC\uC791\uD558\uC138\uC694.`);
    };
    inspect = inspect2, stop = stop2, stopForEnvironment = stopForEnvironment2;
    const host = document.createElement("div");
    host.id = "buriburi-ai-host";
    host.style.cssText = "position:fixed;right:14px;bottom:14px;z-index:2147483646;max-width:calc(100vw - 28px)";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>
    :host{color-scheme:dark}*{box-sizing:border-box}.panel{width:318px;padding:16px;border:1px solid #37758c;border-radius:12px;background:#0b1626f5;color:#e6f0ff;font:13px/1.55 system-ui,sans-serif;box-shadow:0 8px 32px #0007}h2{margin:0;font-size:16px}.tag{font-size:11px;color:#94b6d1;margin:3px 0 12px}.buttons{display:grid;grid-template-columns:1fr 1fr;gap:7px}button{cursor:pointer;border:1px solid #45637f;border-radius:6px;padding:8px;background:#19314a;color:#f1f7ff;font:inherit}button:hover{background:#294b6c}.stop{background:#6b2734}.start{background:#175b50}.status{margin-top:10px;white-space:pre-wrap;overflow-wrap:anywhere;max-height:190px;overflow:auto}small{display:block;color:#a4bed4;margin-top:8px}.min{float:right;padding:0 8px}.hidden{display:none}
    </style><section class="panel" aria-label="\uD14C\uD2B8\uB9AC\uC2A4 AI"><button class="min" aria-label="\uD328\uB110 \uC811\uAE30">\u2212</button><h2>\uD14C\uD2B8\uB9AC\uC2A4 AI v${SCRIPT_VERSION}</h2><div class="body"><p class="tag">\uC9C1\uC811 \uC2DC\uC791 \xB7 F8 \uC989\uC2DC \uC911\uC9C0 \xB7 F9 \uC0C1\uD0DC \uC810\uAC80</p><div class="buttons"><button data-action="inspect">\uC0C1\uD0DC \uC810\uAC80</button><button data-action="select">\uB0B4 \uBCF4\uB4DC \uC120\uD0DD</button><button data-action="shadow">\uAD00\uCE21\xB7\uD0D0\uC0C9\uB9CC</button><button data-action="single">\uD55C \uC218 \uC2E4\uD589</button><button data-action="continuous" class="start">\uC5F0\uC18D \uC2E4\uD589</button><button data-action="stop" class="stop">\uC911\uC9C0 F8</button><button data-action="export">\uAC80\uC99D \uAE30\uB85D \uC800\uC7A5</button></div><div class="status" role="status">STOPPED
\uAC8C\uC784\uC744 \uC2DC\uC791\uD55C \uB4A4 F9\uB85C \uC790\uAE30 \uBCF4\uB4DC\uB97C \uD655\uC778\uD558\uC138\uC694.</div><small>DOM \uD45C\uC2DC \uACB0\uACFC\uB97C \uAC80\uC99D\uD569\uB2C8\uB2E4. \uC11C\uBC84 \uD655\uC815\xB7\uACF5\uACA9 \uADDC\uCE59\xB7\uB300\uC804 \uC2E4\uB825\uC740 \uBBF8\uAC80\uC99D\uC785\uB2C8\uB2E4.</small></div></section>`;
    document.body.append(host);
    const status = root.querySelector(".status");
    const adapter = new DomAdapter(document);
    const planner = new WorkerPlanner();
    let selecting = false;
    const focusGuard = () => {
      if (!document.hasFocus() || document.visibilityState !== "visible") throw new Error("\uAC8C\uC784 \uD0ED\uC774 \uD65C\uC131\uD654\uB418\uC5B4 \uC788\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
      if (isEditable(document.activeElement)) throw new Error("\uCC44\uD305\xB7\uC785\uB825\uCC3D\uC5D0 \uD3EC\uCEE4\uC2A4\uAC00 \uC788\uC2B5\uB2C8\uB2E4.");
      if (!adapter.status().inputEnabled) throw new Error("\uC790\uAE30 \uAC8C\uC784 \uC785\uB825\uC774 \uD65C\uC131\uD654\uB418\uC5B4 \uC788\uC9C0 \uC54A\uC2B5\uB2C8\uB2E4.");
    };
    const keyboard = new WindowKeyboard(window, focusGuard);
    const controller = new Controller(adapter, planner, keyboard, void 0, (update) => {
      const plan = update.plan;
      status.textContent = `${update.state} \xB7 \uD45C\uC2DC \uAC80\uC99D ${update.locks}\uD68C \xB7 \uC7AC\uACC4\uD68D ${update.resyncs}\uD68C
${update.message}${plan ? `
\uD0D0\uC0C9 ${plan.elapsedMs.toFixed(1)}ms \xB7 \uAE4A\uC774 ${plan.depth} \xB7 \uB178\uB4DC ${plan.nodes}` : ""}`;
    });
    root.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button) return;
      const action = button.dataset.action;
      button.blur();
      if (action === "stop") stop2();
      else if (action === "inspect") inspect2();
      else if (action === "select") {
        stop2();
        selecting = true;
        status.textContent = "\uC790\uAE30 \uBCF4\uB4DC\uC758 \uACE0\uC815 \uC140 \uC601\uC5ED\uC744 \uD074\uB9AD\uD558\uC138\uC694. \uC0C1\uB300 \uBBF8\uB2C8 \uBCF4\uB4DC\uB294 \uC120\uD0DD\uD560 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.";
      } else if (action === "export") {
        const content = controller.recorder.jsonl();
        if (!content) {
          status.textContent = "\uC800\uC7A5\uD560 \uAC80\uC99D \uAE30\uB85D\uC774 \uC5C6\uC2B5\uB2C8\uB2E4. \uAD00\uCE21\xB7\uD0D0\uC0C9 \uB610\uB294 \uD55C \uC218 \uC2E4\uD589 \uD6C4 \uC800\uC7A5\uD558\uC138\uC694.";
          return;
        }
        const url = URL.createObjectURL(new Blob([content + "\n"], { type: "application/x-ndjson" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = `tetris-evidence-${Date.now()}.jsonl`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1e3);
      } else if (action === "single" || action === "continuous" || action === "shadow") {
        selecting = false;
        void controller.start(action);
      }
    });
    root.querySelector(".min").addEventListener("click", () => root.querySelector(".body").classList.toggle("hidden"));
    document.addEventListener("click", (event) => {
      if (!selecting || !(event.target instanceof HTMLElement) || event.composedPath().includes(host)) return;
      event.preventDefault();
      event.stopPropagation();
      selecting = false;
      try {
        adapter.select(event.target);
        inspect2();
      } catch (error) {
        status.textContent = error instanceof Error ? error.message : String(error);
      }
    }, true);
    window.addEventListener("keydown", (event) => {
      if (event.code === "F8") {
        event.preventDefault();
        stop2("F8 \uAE34\uAE09 \uC911\uC9C0. \uB20C\uB9B0 \uD0A4\uB97C \uD574\uC81C\uD588\uC2B5\uB2C8\uB2E4.");
      } else if (event.code === "F9") {
        event.preventDefault();
        inspect2();
      } else if (["ArrowLeft", "ArrowRight", "ArrowDown", "ArrowUp", "Space", "KeyX", "KeyZ", "KeyA", "KeyC"].includes(event.code) && event.isTrusted) {
        stop2("\uC9C1\uC811 \uC870\uC791\uC744 \uAC10\uC9C0\uD574 AI\uB97C \uC911\uC9C0\uD588\uC2B5\uB2C8\uB2E4.");
      }
    }, true);
    window.addEventListener("blur", () => stopForEnvironment2("\uD0ED \uD3EC\uCEE4\uC2A4\uAC00 \uC0AC\uB77C\uC838 \uC911\uC9C0\uD588\uC2B5\uB2C8\uB2E4."));
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) stopForEnvironment2("\uAC8C\uC784 \uD0ED\uC774 \uC228\uACA8\uC838 \uC911\uC9C0\uD588\uC2B5\uB2C8\uB2E4.");
    });
    document.addEventListener("focusin", () => {
      if (isEditable(document.activeElement)) stopForEnvironment2("\uC785\uB825\uCC3D \uD3EC\uCEE4\uC2A4\uB85C \uC911\uC9C0\uD588\uC2B5\uB2C8\uB2E4.");
    });
    window.addEventListener("pagehide", () => stopForEnvironment2("\uD398\uC774\uC9C0 \uC885\uB8CC\uB85C \uC911\uC9C0\uD588\uC2B5\uB2C8\uB2E4."));
  }
  var inspect;
  var stop;
  var stopForEnvironment;
})();
