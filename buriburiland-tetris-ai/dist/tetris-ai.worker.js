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
  function boardFeatures(board) {
    const heights = [];
    let holes = 0, coveredCells = 0, holeDepth = 0, occupied = 0, columnTransitions = 0;
    for (let x = 0; x < BOARD_WIDTH; x += 1) {
      let first = BOARD_HEIGHT, blocksAbove = 0, previous = true;
      for (let y = 0; y < BOARD_HEIGHT; y += 1) {
        const filled = ((board[y] ?? 0) >> x & 1) === 1;
        if (filled !== previous) columnTransitions += 1;
        previous = filled;
        if (filled) {
          first = Math.min(first, y);
          blocksAbove += 1;
          occupied += 1;
        } else if (blocksAbove > 0) {
          holes += 1;
          coveredCells += blocksAbove;
          holeDepth += y - first;
        }
      }
      if (!previous) columnTransitions += 1;
      heights.push(BOARD_HEIGHT - first);
    }
    let bumpiness = 0, wells = 0, deepCanyon = 0, rowTransitions = 0;
    for (let x = 0; x < BOARD_WIDTH; x += 1) {
      const height = heights[x] ?? 0;
      if (x > 0) bumpiness += Math.abs(height - (heights[x - 1] ?? 0));
      const left = x === 0 ? BOARD_HEIGHT : heights[x - 1] ?? 0;
      const right = x === BOARD_WIDTH - 1 ? BOARD_HEIGHT : heights[x + 1] ?? 0;
      const depth = Math.max(0, Math.min(left, right) - height);
      wells += depth * (depth + 1) / 2;
      deepCanyon += Math.max(0, depth - (x === 0 || x === BOARD_WIDTH - 1 ? 4 : 2)) ** 2;
    }
    for (let y = 0; y < BOARD_HEIGHT; y += 1) {
      let previous = true;
      for (let x = 0; x < BOARD_WIDTH; x += 1) {
        const filled = ((board[y] ?? 0) >> x & 1) === 1;
        if (filled !== previous) rowTransitions += 1;
        previous = filled;
      }
      if (!previous) rowTransitions += 1;
    }
    return { heights, aggregateHeight: heights.reduce((sum, value) => sum + value, 0), maxHeight: Math.max(...heights), holes, coveredCells, holeDepth, bumpiness, wells, deepCanyon, rowTransitions, columnTransitions, occupied };
  }
  function evaluateBoard(board, incoming = null) {
    const f = boardFeatures(board);
    const pressure = incoming === null ? 0 : Math.min(12, Math.max(0, incoming));
    const projectedHeight = f.maxHeight + pressure;
    const danger = Math.max(0, projectedHeight - 12);
    return -f.holes * 21 - f.coveredCells * 1.8 - f.holeDepth * 1.5 - f.aggregateHeight * 0.64 - f.maxHeight * 1.8 - f.bumpiness * 0.56 - f.wells * 0.12 - f.deepCanyon * 2.8 - f.rowTransitions * 0.13 - f.columnTransitions * 0.16 - danger * danger * 3.5;
  }
  function takeNode(budget) {
    if (budget.nodes >= budget.maxNodes || budget.now() >= budget.deadline) {
      budget.exhausted = true;
      return false;
    }
    budget.nodes += 1;
    return true;
  }
  var TRANSITIONS = ["LEFT", "RIGHT", "ROTATE_CW", "ROTATE_CCW", "SOFT_DROP"];
  function poseKey(piece) {
    return `${piece.x}/${piece.y}/${piece.rotation}`;
  }
  function cellKey(piece) {
    return runtimeCells(piece).map(([x, y]) => y * 32 + x).sort((a, b) => a - b).join("/");
  }
  function buildPath(queue, index) {
    const path = ["HARD_DROP"];
    let cursor = index;
    while (cursor >= 0) {
      const state = queue[cursor];
      if (!state) break;
      if (state.action) path.push(state.action);
      cursor = state.parent;
    }
    return path.reverse();
  }
  function generate(board, initial, budget, options, accept) {
    const current = initial[0];
    if (!current || initial.some((piece) => collides2(board, piece.type, piece.rotation, piece.x, piece.y))) return [];
    const initialCellKey = cellKey(current);
    if (initial.some((piece) => piece.type !== current.type || cellKey(piece) !== initialCellKey)) return [];
    const maxStates = positiveInteger(options.maxStatesPerBoard, 1600, 2e4);
    const maxPathLength = positiveInteger(options.maxPathLength, 60, 120);
    const queue = [{ poses: initial, parent: -1, action: null, steps: 0 }];
    const visited = /* @__PURE__ */ new Set([initial.map(poseKey).join("|")]);
    const placements = /* @__PURE__ */ new Map();
    for (let index = 0; index < queue.length && index < maxStates; index += 1) {
      if (!takeNode(budget)) break;
      const state = queue[index];
      const piece = state?.poses[0];
      if (!state || !piece) continue;
      const target = { ...piece, y: hardDropY2(board, piece.type, piece.rotation, piece.x, piece.y) };
      const lock = lockPiece2(board, target.type, target.rotation, target.x, target.y);
      if (lock && !lock.topOut) {
        const key = lock.board.join(",");
        if (!placements.has(key)) {
          const placement = { target, path: buildPath(queue, index), board: lock.board, cleared: lock.cleared };
          placements.set(key, placement);
          accept?.(placement);
        }
      }
      if (state.steps >= maxPathLength) continue;
      for (const action of TRANSITIONS) {
        const nextPoses = [];
        let nextCellKey = null;
        let legal = true;
        for (const pose of state.poses) {
          const next = applyRuntimeAction(board, pose, action);
          if (!next || next.y < Math.min(-4, current.y)) {
            legal = false;
            break;
          }
          if (state.poses.length > 1) {
            const occupied = cellKey(next);
            if (nextCellKey !== null && occupied !== nextCellKey) {
              legal = false;
              break;
            }
            nextCellKey = occupied;
          }
          nextPoses.push(next);
        }
        if (!legal) continue;
        const key = nextPoses.map(poseKey).join("|");
        if (visited.has(key) || visited.size >= maxStates) continue;
        visited.add(key);
        queue.push({ poses: nextPoses, parent: index, action, steps: state.steps + 1 });
      }
    }
    return [...placements.values()];
  }
  function positiveInteger(value, fallback, maximum) {
    return value !== void 0 && Number.isFinite(value) ? Math.max(1, Math.min(maximum, Math.floor(value))) : fallback;
  }
  function finitePositive(value, fallback) {
    return value !== void 0 && Number.isFinite(value) ? Math.max(0, value) : fallback;
  }
  function clearReward(cleared) {
    return [0, 5, 13, 24, 38][cleared] ?? cleared * 10;
  }
  function validRuntimePose(value) {
    if (!value || typeof value !== "object") return false;
    const piece = value;
    return PIECE_TYPES.includes(piece.type) && Number.isInteger(piece.x) && piece.x >= -4 && piece.x < BOARD_WIDTH && Number.isInteger(piece.y) && piece.y >= -4 && piece.y < BOARD_HEIGHT && Number.isInteger(piece.rotation) && piece.rotation >= 0 && piece.rotation <= 3;
  }
  function validSnapshot(value) {
    if (!value || typeof value !== "object") return false;
    const snapshot = value;
    const counter = (number) => typeof number === "number" && Number.isSafeInteger(number) && number >= 0;
    if (typeof snapshot.paused !== "boolean" || typeof snapshot.ended !== "boolean" || snapshot.paused || snapshot.ended || !Array.isArray(snapshot.board) || snapshot.board.length !== BOARD_HEIGHT || !Array.from(snapshot.board).every((row) => Number.isInteger(row) && row >= 0 && row <= FULL_ROW) || !validRuntimePose(snapshot.current) || !Array.isArray(snapshot.next) || snapshot.next.length > 5 || !Array.from(snapshot.next).every((type) => PIECE_TYPES.includes(type)) || snapshot.hold !== null && !PIECE_TYPES.includes(snapshot.hold) || snapshot.canHold !== null && typeof snapshot.canHold !== "boolean" || !["session", "player", "fingerprint"].every((key) => typeof value[key] === "string" && value[key].length > 0) || !Number.isFinite(snapshot.observedAt) || snapshot.observedAt < 0 || !counter(snapshot.observation) || snapshot.lines !== null && !counter(snapshot.lines) || snapshot.incoming !== null && !counter(snapshot.incoming)) return false;
    if (snapshot.rotationCandidates === void 0) return true;
    if (!Array.isArray(snapshot.rotationCandidates) || snapshot.rotationCandidates.length < 1 || snapshot.rotationCandidates.length > 4) return false;
    const candidates = Array.from(snapshot.rotationCandidates);
    const currentCells = cellKey(snapshot.current);
    if (!candidates.every((piece) => validRuntimePose(piece) && piece.type === snapshot.current.type && cellKey(piece) === currentCells)) return false;
    const keys = candidates.map(poseKey);
    return new Set(keys).size === keys.length && keys.includes(poseKey(snapshot.current));
  }
  function search(snapshot, options = {}) {
    if (!validSnapshot(snapshot)) return null;
    const now = options.now ?? (() => performance.now());
    const started = now();
    const budget = { started, deadline: started + finitePositive(options.budgetMs, 45), now, maxNodes: positiveInteger(options.maxNodes, 12e3, 1e6), nodes: 0, exhausted: false };
    const requestedDepth = positiveInteger(options.depth, 2, 5);
    const beamWidth = positiveInteger(options.beamWidth, 8, 64);
    const roots = [];
    const makeRoot = (placement, kind, queue, hold, rootHoldTarget) => {
      const reward = clearReward(placement.cleared) - placement.path.length * 0.025 - (kind === "hold" ? 0.4 : 0);
      roots.push({ board: placement.board, queue, hold, first: placement, kind, rootHoldTarget, reward, score: evaluateBoard(placement.board, snapshot.incoming) + reward });
    };
    const poses = snapshot.rotationCandidates && snapshot.rotationCandidates.length > 0 ? snapshot.rotationCandidates : [snapshot.current];
    generate(snapshot.board, poses, budget, options, (placement) => makeRoot(placement, "place", snapshot.next, snapshot.hold, null));
    if (snapshot.canHold === true && options.allowHold !== false && !budget.exhausted) {
      const replacement = snapshot.hold ?? snapshot.next[0];
      if (replacement) {
        const spawn = spawnPiece(snapshot.board, replacement);
        const next = snapshot.hold === null ? snapshot.next.slice(1) : snapshot.next;
        if (spawn) generate(snapshot.board, [spawn], budget, options, (placement) => makeRoot(placement, "hold", next, snapshot.current.type, spawn));
      }
    }
    if (roots.length === 0) return null;
    const depthLimit = Math.min(requestedDepth, 1 + Math.min(...roots.map((root) => root.queue.length)));
    roots.sort(compareNodes);
    let selected = roots[0];
    let completedDepth = 1;
    let beam = roots.slice(0, beamWidth);
    for (let depth = 2; depth <= depthLimit && !budget.exhausted; depth += 1) {
      const children = [];
      const transpositions = /* @__PURE__ */ new Map();
      let complete = true;
      for (const parent of beam) {
        const nextType = parent.queue[0];
        if (!nextType) {
          children.push(parent);
          continue;
        }
        const choices = [{ type: nextType, queue: parent.queue.slice(1), hold: parent.hold, cost: 0 }];
        if (options.allowHold !== false) {
          const replacement = parent.hold ?? parent.queue[1];
          if (replacement && replacement !== nextType) choices.push({ type: replacement, queue: parent.hold === null ? parent.queue.slice(2) : parent.queue.slice(1), hold: nextType, cost: 0.4 });
        }
        for (const choice of choices) {
          const spawn = spawnPiece(parent.board, choice.type);
          if (!spawn) continue;
          generate(parent.board, [spawn], budget, options, (placement) => {
            const reward = parent.reward + clearReward(placement.cleared) * 0.92 ** (depth - 1) - placement.path.length * 0.012 - choice.cost;
            const score = evaluateBoard(placement.board, snapshot.incoming) + reward;
            const key = `${placement.board.join(",")}:${choice.hold ?? "-"}:${choice.queue.join("")}`;
            if ((transpositions.get(key) ?? -Infinity) >= score) return;
            transpositions.set(key, score);
            children.push({ ...parent, board: placement.board, queue: choice.queue, hold: choice.hold, reward, score });
          });
          if (budget.exhausted) {
            complete = false;
            break;
          }
        }
        if (!complete) break;
      }
      if (!complete || children.length === 0) break;
      children.sort(compareNodes);
      beam = children.slice(0, beamWidth);
      selected = beam[0];
      completedDepth = depth;
    }
    const assumptions = ["Public client physics; server corrections and lock timing require observed validation", "No attack, spin, or random future garbage prediction"];
    if (poses.length > 1) assumptions.push("Ambiguous rotation: path must produce identical occupied cells for every candidate");
    if (completedDepth > 1) assumptions.push("Future pieces use the public client spawn rule and only the visible queue");
    if (selected.kind === "hold") assumptions.push("HOLD is a separate transition; reobserve before planning any placement");
    return {
      kind: selected.kind,
      path: selected.kind === "place" ? selected.first.path : [],
      target: selected.kind === "place" ? selected.first.target : selected.rootHoldTarget,
      expectedBoard: selected.kind === "place" ? selected.first.board : [...snapshot.board],
      cleared: selected.kind === "place" ? selected.first.cleared : 0,
      score: selected.score,
      nodes: budget.nodes,
      elapsedMs: Math.max(0, now() - started),
      fingerprint: snapshot.fingerprint,
      session: snapshot.session,
      player: snapshot.player,
      observation: snapshot.observation,
      depth: completedDepth,
      budgetExhausted: budget.exhausted,
      ruleProfile: RUNTIME_RULE_PROFILE.id,
      assumptions
    };
  }
  function compareNodes(left, right) {
    return right.score - left.score || (left.kind === "place" ? 0 : 1) - (right.kind === "place" ? 0 : 1) || left.first.path.length - right.first.path.length || left.first.target.x - right.first.target.x || left.first.target.rotation - right.first.target.rotation;
  }

  // src/runtime/worker-entry.ts
  var scope = self;
  scope.onmessage = (event) => {
    const { id, generation, snapshot } = event.data;
    try {
      const plan = search(snapshot, { budgetMs: 100, depth: 3, beamWidth: 10, maxNodes: 4e4, maxStatesPerBoard: 1500, maxPathLength: 14, allowHold: true });
      scope.postMessage({ id, generation, fingerprint: snapshot.fingerprint, plan });
    } catch (error) {
      scope.postMessage({ id, generation, fingerprint: snapshot.fingerprint, error: error instanceof Error ? error.message : String(error) });
    }
  };
})();
