// ==UserScript==
// @name         BuriburiLand Tetris AI FINAL v4.0 Research Engine
// @namespace    https://buriburiland.com/
// @version      4.0.0
// @description  Research-based versus Tetris AI: worker search, SRS reachability, hold, garbage defense, B2B/combo, T-spin/all-spin opportunities, transposition beam search.
// @match        https://buriburiland.com/room/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(() => {
  'use strict';

  // ============================================================
  // 0. MAIN CONFIG
  // ============================================================

  const CFG = {
    pollMs: 45,
    plannerTimeoutMs: 320,
    repathTimeoutMs: 120,
    debug: true,

    // Human-readable tempo, not intentionally sluggish.
    pacing: {
      STACK:      { think: [95, 180], keyHold: [14, 24], keyGap: [24, 42], beforeDrop: [14, 32] },
      PRESSURE:   { think: [70, 145], keyHold: [12, 21], keyGap: [20, 35], beforeDrop: [10, 27] },
      DEFENSE:    { think: [32, 82],  keyHold: [10, 18], keyGap: [13, 26], beforeDrop: [5, 18]  },
      EMERGENCY:  { think: [5, 24],   keyHold: [6, 12],  keyGap: [6, 14],  beforeDrop: [1, 7]   },
    },
  };

  // ============================================================
  // 1. RUNTIME STATE
  // ============================================================

  let enabled = false;
  let busy = false;
  let loopTimer = null;
  let lastHandledVersion = null;
  let selectedPlayerId = sessionStorage.getItem('bb-ai-v4-player-id') || null;
  let anchorElement = null;
  let anchorKey = null;
  let executionFailures = 0;
  let lastObservedPieceVersion = null;

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const randi = (a, b) => Math.floor(a + Math.random() * (b - a + 1));

  function log(...args) {
    if (CFG.debug) console.log('[BB Tetris AI FINAL v4.0]', ...args);
  }

  function pieceType(value) {
    if (!value) return null;
    if (typeof value === 'string') {
      const t = value.toUpperCase();
      return /^[IJLOSTZ]$/.test(t) ? t : null;
    }
    if (typeof value === 'object') {
      return pieceType(value.type ?? value.kind ?? value.name ?? value.piece ?? value.tetromino);
    }
    return null;
  }

  // ============================================================
  // 2. REACT / GAME STATE ADAPTER
  // ============================================================

  function looksLikeTetrisState(v) {
    return !!(v && typeof v === 'object' && v.players && typeof v.players === 'object');
  }

  function findStateFromRoot(root) {
    if (!root) return null;
    const seen = new WeakSet();
    let found = null;

    function walk(obj, depth = 0) {
      if (found) return;
      if (obj == null || (typeof obj !== 'object' && typeof obj !== 'function') || depth > 13 || seen.has(obj)) return;
      seen.add(obj);

      try {
        if (looksLikeTetrisState(obj.tetrisState)) {
          found = obj.tetrisState;
          return;
        }
        if (looksLikeTetrisState(obj.pendingProps?.tetrisState)) {
          found = obj.pendingProps.tetrisState;
          return;
        }
        if (looksLikeTetrisState(obj.memoizedProps?.tetrisState)) {
          found = obj.memoizedProps.tetrisState;
          return;
        }

        const priority = ['return', 'child', 'sibling', 'alternate', 'stateNode', 'pendingProps', 'memoizedProps', 'memoizedState'];
        for (const key of priority) {
          let child;
          try { child = obj[key]; } catch { continue; }
          walk(child, depth + 1);
          if (found) return;
        }

        for (const key of Object.keys(obj).slice(0, 60)) {
          if (priority.includes(key)) continue;
          let child;
          try { child = obj[key]; } catch { continue; }
          walk(child, depth + 1);
          if (found) return;
        }
      } catch {}
    }

    walk(root, 0);
    return found;
  }

  function getTetrisState() {
    if (anchorElement && anchorKey) {
      try {
        const state = findStateFromRoot(anchorElement[anchorKey]);
        if (state) return state;
      } catch {}
      anchorElement = null;
      anchorKey = null;
    }

    for (const el of document.querySelectorAll('*')) {
      for (const key of Object.keys(el)) {
        if (!key.startsWith('__reactFiber$') && !key.startsWith('__reactProps$') && !key.startsWith('__reactContainer$')) continue;
        try {
          const state = findStateFromRoot(el[key]);
          if (state) {
            anchorElement = el;
            anchorKey = key;
            return state;
          }
        } catch {}
      }
    }
    return null;
  }

  function looksLikePlayer(p) {
    return !!(
      p && typeof p === 'object' && Array.isArray(p.board) && Array.isArray(p.nextQueue) &&
      Object.prototype.hasOwnProperty.call(p, 'current') &&
      Object.prototype.hasOwnProperty.call(p, 'pieceVersion')
    );
  }

  function playerEntries(state) {
    if (!state?.players) return [];
    return Object.entries(state.players).filter(([, p]) => looksLikePlayer(p));
  }

  function discoverLocalPlayerId(state) {
    const entries = playerEntries(state);
    if (!entries.length) return null;

    if (selectedPlayerId && looksLikePlayer(state.players[selectedPlayerId])) return selectedPlayerId;

    for (const k of ['localPlayerId', 'myPlayerId', 'selfPlayerId', 'currentPlayerId', 'playerId', 'userId', 'ownerPlayerId']) {
      const id = state[k];
      if (typeof id === 'string' && looksLikePlayer(state.players[id])) return id;
    }

    if (entries.length === 1) return entries[0][0];

    const ids = new Set(entries.map(([id]) => id));
    let best = null;

    function scanStorage(storage) {
      try {
        for (let i = 0; i < storage.length; i++) {
          const k = storage.key(i);
          const v = storage.getItem(k);
          if (!v) continue;
          for (const id of ids) {
            if (!v.includes(id)) continue;
            const score = /player|user|client|self|local|session/i.test(k) ? 10 : 1;
            if (!best || score > best.score) best = { id, score };
          }
        }
      } catch {}
    }

    scanStorage(localStorage);
    scanStorage(sessionStorage);
    return best?.id ?? null;
  }

  function getGameContext() {
    const state = getTetrisState();
    if (!state) return { state: null, player: null, playerId: null, opponents: [] };

    const playerId = discoverLocalPlayerId(state);
    if (!playerId) return { state, player: null, playerId: null, opponents: [] };

    selectedPlayerId = playerId;
    sessionStorage.setItem('bb-ai-v4-player-id', playerId);

    const player = state.players[playerId];
    const opponents = playerEntries(state)
      .filter(([id]) => id !== playerId)
      .map(([id, p]) => ({ id, player: p }));

    return { state, player, playerId, opponents };
  }

  function cyclePlayer() {
    const state = getTetrisState();
    const entries = playerEntries(state);
    if (!entries.length) {
      alert('선택 가능한 Player가 없습니다.');
      return;
    }

    let index = entries.findIndex(([id]) => id === selectedPlayerId);
    index = (index + 1) % entries.length;
    const [id, player] = entries[index];
    selectedPlayerId = id;
    sessionStorage.setItem('bb-ai-v4-player-id', id);

    alert([
      '✅ AI 조작 Player 선택',
      '',
      `닉네임: ${player.nickname ?? '(없음)'}`,
      `현재 블록: ${pieceType(player.current) ?? '-'}`,
      `Player ID: ${id}`,
    ].join('\n'));
  }

  // ============================================================
  // 3. BOARD SERIALIZATION FOR WORKER
  // ============================================================

  function cellFilled(v) {
    if (v == null || v === false || v === 0 || v === '' || v === '0') return 0;
    if (typeof v === 'number') return v !== 0 ? 1 : 0;
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'string') return 1;
    if (typeof v === 'object') {
      if ('filled' in v) return v.filled ? 1 : 0;
      if ('occupied' in v) return v.occupied ? 1 : 0;
      if ('isFilled' in v) return v.isFilled ? 1 : 0;
      for (const key of ['type', 'piece', 'tetromino', 'color']) {
        if (key in v) return (v[key] == null || v[key] === '') ? 0 : 1;
      }
      if (Object.keys(v).length === 0) return 0;
      return 1;
    }
    return 0;
  }

  function normalizeBoard(raw) {
    if (!Array.isArray(raw) || raw.length < 20) return null;
    const rows = raw.slice(-20);
    if (!rows.every(row => Array.isArray(row) && row.length >= 10)) return null;

    return rows.map(row => {
      let bits = 0;
      for (let x = 0; x < 10; x++) {
        if (cellFilled(row[x])) bits |= (1 << x);
      }
      return bits;
    });
  }

  function summarizeOpponent(p) {
    const rows = normalizeBoard(p.board);
    if (!rows) return null;
    return {
      rows,
      eliminated: !!p.eliminated,
      pendingGarbage: Number(p.pendingGarbage ?? 0),
      combo: Number(p.combo ?? 0),
      b2b: !!p.backToBack,
    };
  }

  function snapshotFromContext(ctx) {
    const p = ctx.player;
    const rows = normalizeBoard(p.board);
    if (!rows || !p.current) return null;

    return {
      rows,
      current: {
        type: pieceType(p.current),
        x: Number(p.current.x ?? 3),
        y: Number(p.current.y ?? 0),
        rotation: Number(p.current.rotation ?? 0) & 3,
      },
      hold: pieceType(p.hold),
      canHold: !!p.canHold,
      nextQueue: (p.nextQueue || []).map(pieceType).filter(Boolean).slice(0, 10),
      pendingGarbage: Math.max(0, Number(p.pendingGarbage ?? 0)),
      combo: Math.max(0, Number(p.combo ?? 0)),
      b2b: !!p.backToBack,
      lastAttack: Number(p.lastAttack ?? 0),
      lastClear: p.lastClear,
      lastSpin: p.lastSpin,
      opponents: ctx.opponents.map(x => summarizeOpponent(x.player)).filter(Boolean),
    };
  }

  // ============================================================
  // 4. SEARCH WORKER
  // ============================================================

  function plannerWorkerMain() {
    'use strict';

    // ----------------------------------------------------------
    // Worker configuration
    // ----------------------------------------------------------

    const FULL = 0x3FF;

    const SETTINGS = {
      budget: {
        STACK: 62,
        PRESSURE: 70,
        DEFENSE: 58,
        EMERGENCY: 34,
      },
      maxDepth: {
        STACK: 4,
        PRESSURE: 4,
        DEFENSE: 4,
        EMERGENCY: 3,
      },
      rootReachableLimit: 1400,
      rootPathLimit: 28,
      beamWidth: 64,
      firstWidth: 64,
      childWidth: 13,
      transpositionLimit: 5000,
    };

    const ACTION = {
      LEFT: 'L',
      RIGHT: 'R',
      DOWN: 'D',
      CW: 'CW',
      CCW: 'CCW',
      HARD: 'HD',
    };

    const SHAPES = {
      I: [
        [[0,1],[1,1],[2,1],[3,1]],
        [[2,0],[2,1],[2,2],[2,3]],
        [[0,2],[1,2],[2,2],[3,2]],
        [[1,0],[1,1],[1,2],[1,3]],
      ],
      O: [
        [[1,0],[2,0],[1,1],[2,1]],
        [[1,0],[2,0],[1,1],[2,1]],
        [[1,0],[2,0],[1,1],[2,1]],
        [[1,0],[2,0],[1,1],[2,1]],
      ],
      T: [
        [[1,0],[0,1],[1,1],[2,1]],
        [[1,0],[1,1],[2,1],[1,2]],
        [[0,1],[1,1],[2,1],[1,2]],
        [[1,0],[0,1],[1,1],[1,2]],
      ],
      S: [
        [[1,0],[2,0],[0,1],[1,1]],
        [[1,0],[1,1],[2,1],[2,2]],
        [[1,1],[2,1],[0,2],[1,2]],
        [[0,0],[0,1],[1,1],[1,2]],
      ],
      Z: [
        [[0,0],[1,0],[1,1],[2,1]],
        [[2,0],[1,1],[2,1],[1,2]],
        [[0,1],[1,1],[1,2],[2,2]],
        [[1,0],[0,1],[1,1],[0,2]],
      ],
      J: [
        [[0,0],[0,1],[1,1],[2,1]],
        [[1,0],[2,0],[1,1],[1,2]],
        [[0,1],[1,1],[2,1],[2,2]],
        [[1,0],[1,1],[0,2],[1,2]],
      ],
      L: [
        [[2,0],[0,1],[1,1],[2,1]],
        [[1,0],[1,1],[1,2],[2,2]],
        [[0,1],[1,1],[2,1],[0,2]],
        [[0,0],[1,0],[1,1],[1,2]],
      ],
    };

    const JLSTZ_KICKS = {
      '0>1': [[0,0],[-1,0],[-1,-1],[0,2],[-1,2]],
      '1>0': [[0,0],[1,0],[1,1],[0,-2],[1,-2]],
      '1>2': [[0,0],[1,0],[1,1],[0,-2],[1,-2]],
      '2>1': [[0,0],[-1,0],[-1,-1],[0,2],[-1,2]],
      '2>3': [[0,0],[1,0],[1,-1],[0,2],[1,2]],
      '3>2': [[0,0],[-1,0],[-1,1],[0,-2],[-1,-2]],
      '3>0': [[0,0],[-1,0],[-1,1],[0,-2],[-1,-2]],
      '0>3': [[0,0],[1,0],[1,-1],[0,2],[1,2]],
    };

    const I_KICKS = {
      '0>1': [[0,0],[-2,0],[1,0],[-2,1],[1,-2]],
      '1>0': [[0,0],[2,0],[-1,0],[2,-1],[-1,2]],
      '1>2': [[0,0],[-1,0],[2,0],[-1,-2],[2,1]],
      '2>1': [[0,0],[1,0],[-2,0],[1,2],[-2,-1]],
      '2>3': [[0,0],[2,0],[-1,0],[2,-1],[-1,2]],
      '3>2': [[0,0],[-2,0],[1,0],[-2,1],[1,-2]],
      '3>0': [[0,0],[1,0],[-2,0],[1,2],[-2,-1]],
      '0>3': [[0,0],[-1,0],[2,0],[-1,-2],[2,1]],
    };

    // Adaptive server-specific attack estimates.
    const learnedAttack = new Map([
      ['N1', 0], ['N2', 1], ['N3', 2], ['N4', 4],
      ['S1', 2], ['S2', 4], ['S3', 6], ['S4', 8],
    ]);

    let lastMode = 'STACK';

    // ----------------------------------------------------------
    // Basic board operations
    // ----------------------------------------------------------

    const cellsFor = (type, r) => SHAPES[type]?.[r & 3] ?? [];

    function popcount10(v) {
      let n = 0;
      while (v) { n += v & 1; v >>>= 1; }
      return n;
    }

    function boardKey(rows) {
      return rows.join('.');
    }

    function collides(rows, type, r, x, y) {
      for (const [cx, cy] of cellsFor(type, r)) {
        const px = x + cx;
        const py = y + cy;
        if (px < 0 || px >= 10 || py >= 20) return true;
        if (py >= 0 && (rows[py] & (1 << px))) return true;
      }
      return false;
    }

    function rotateSRS(rows, type, state, dir) {
      if (type === 'O') return { x: state.x, y: state.y, r: (state.r + dir + 4) & 3 };
      const from = state.r & 3;
      const to = (from + dir + 4) & 3;
      const table = type === 'I' ? I_KICKS : JLSTZ_KICKS;
      const tests = table[`${from}>${to}`] ?? [[0,0]];
      for (const [kx, ky] of tests) {
        const nx = state.x + kx;
        const ny = state.y + ky;
        if (!collides(rows, type, to, nx, ny)) return { x: nx, y: ny, r: to };
      }
      return null;
    }

    function hardDropY(rows, type, r, x, startY) {
      let y = startY;
      while (!collides(rows, type, r, x, y + 1)) y++;
      return y;
    }

    function occupiedOrWall(rows, x, y) {
      if (x < 0 || x >= 10 || y >= 20) return true;
      if (y < 0) return false;
      return !!(rows[y] & (1 << x));
    }

    function detectTSpin(preClearRows, x, y) {
      const px = x + 1;
      const py = y + 1;
      const corners = [
        [px - 1, py - 1], [px + 1, py - 1],
        [px - 1, py + 1], [px + 1, py + 1],
      ];
      let count = 0;
      for (const [cx, cy] of corners) if (occupiedOrWall(preClearRows, cx, cy)) count++;
      return count >= 3;
    }

    function immobileSpin(rowsBefore, type, r, x, y) {
      return (
        collides(rowsBefore, type, r, x - 1, y) &&
        collides(rowsBefore, type, r, x + 1, y) &&
        collides(rowsBefore, type, r, x, y + 1)
      );
    }

    function lockPiece(rows, type, r, x, y, lastAction = null) {
      const pre = rows.slice();
      const placedCells = [];

      for (const [cx, cy] of cellsFor(type, r)) {
        const px = x + cx;
        const py = y + cy;
        if (px < 0 || px >= 10 || py < 0 || py >= 20) return null;
        pre[py] |= (1 << px);
        placedCells.push([px, py]);
      }

      const rotationFinish = lastAction === ACTION.CW || lastAction === ACTION.CCW;
      let spin = false;
      if (rotationFinish && type !== 'O') {
        spin = type === 'T' ? detectTSpin(pre, x, y) : immobileSpin(rows, type, r, x, y);
      }

      const fullRows = [];
      for (let row = 0; row < 20; row++) {
        if ((pre[row] & FULL) === FULL) fullRows.push(row);
      }
      const fullSet = new Set(fullRows);
      const erasedPieceBlocks = placedCells.filter(([, py]) => fullSet.has(py)).length;
      const kept = pre.filter((_, idx) => !fullSet.has(idx));
      while (kept.length < 20) kept.unshift(0);

      let occupied = 0;
      for (const row of kept) occupied += popcount10(row);

      return {
        rows: kept,
        preClearRows: pre,
        cleared: fullRows.length,
        erodedPieceCells: fullRows.length * erasedPieceBlocks,
        perfectClear: occupied === 0,
        spin,
      };
    }

    // ----------------------------------------------------------
    // Root reachable-placement BFS
    // ----------------------------------------------------------

    function stateKey(s) {
      const lastRot = (s.lastAction === ACTION.CW || s.lastAction === ACTION.CCW) ? 1 : 0;
      return `${s.x},${s.y},${s.r},${lastRot}`;
    }
    function lockKey(p) { return `${p.x},${p.y},${p.rotation},${p.spin ? 1 : 0}`; }

    function reachablePlacements(rows, type, start, deadline, needPath = true) {
      if (!SHAPES[type]) return [];

      const init = {
        x: Number(start.x ?? 3),
        y: Number(start.y ?? 0),
        r: Number(start.r ?? 0) & 3,
        path: [],
        softDrops: 0,
        lastAction: null,
      };

      if (collides(rows, type, init.r, init.x, init.y)) {
        init.x = 3; init.y = 0; init.r = 0;
        if (collides(rows, type, init.r, init.x, init.y)) return [];
      }

      const queue = [init];
      let head = 0;
      const visited = new Set([stateKey(init)]);
      const locks = new Map();

      while (head < queue.length && visited.size <= SETTINGS.rootReachableLimit) {
        if (performance.now() > deadline) break;
        const s = queue[head++];

        const landingY = hardDropY(rows, type, s.r, s.x, s.y);
        const locked = lockPiece(rows, type, s.r, s.x, landingY, s.lastAction);
        if (locked) {
          const candidate = {
            x: s.x,
            y: landingY,
            rotation: s.r,
            path: needPath ? [...s.path, ACTION.HARD] : null,
            softDrops: s.softDrops,
            complexity: s.path.length + 1 + s.softDrops * 0.45,
            lastAction: s.lastAction,
            ...locked,
          };
          const key = lockKey(candidate);
          const old = locks.get(key);
          if (!old || candidate.complexity < old.complexity) locks.set(key, candidate);
        }

        if (s.path.length >= SETTINGS.rootPathLimit) continue;

        const neighbors = [];
        if (!collides(rows, type, s.r, s.x - 1, s.y)) neighbors.push({ x: s.x - 1, y: s.y, r: s.r, a: ACTION.LEFT, soft: 0 });
        if (!collides(rows, type, s.r, s.x + 1, s.y)) neighbors.push({ x: s.x + 1, y: s.y, r: s.r, a: ACTION.RIGHT, soft: 0 });

        const cw = rotateSRS(rows, type, s, +1);
        if (cw) neighbors.push({ ...cw, a: ACTION.CW, soft: 0 });
        const ccw = rotateSRS(rows, type, s, -1);
        if (ccw) neighbors.push({ ...ccw, a: ACTION.CCW, soft: 0 });

        if (!collides(rows, type, s.r, s.x, s.y + 1)) neighbors.push({ x: s.x, y: s.y + 1, r: s.r, a: ACTION.DOWN, soft: 1 });

        for (const n of neighbors) {
          const key = stateKey(n);
          if (visited.has(key)) continue;
          visited.add(key);
          queue.push({
            x: n.x, y: n.y, r: n.r,
            path: needPath ? [...s.path, n.a] : [],
            softDrops: s.softDrops + n.soft,
            lastAction: n.a,
          });
        }
      }

      return [...locks.values()];
    }

    // ----------------------------------------------------------
    // Future placements: direct drops + cheap grounded rotations
    // ----------------------------------------------------------

    function futurePlacements(rows, type) {
      if (!SHAPES[type]) return [];
      const out = new Map();
      const rotationCount = type === 'O' ? 1 : 4;

      function addCandidate(x, y, r, lastAction, complexity) {
        const locked = lockPiece(rows, type, r, x, y, lastAction);
        if (!locked) return;
        const p = {
          x, y, rotation: r, path: null,
          softDrops: 0,
          complexity,
          lastAction,
          ...locked,
        };
        const key = lockKey(p);
        const old = out.get(key);
        if (!old || p.complexity < old.complexity) out.set(key, p);
      }

      for (let r = 0; r < rotationCount; r++) {
        const cells = cellsFor(type, r);
        const minX = Math.min(...cells.map(([x]) => x));
        const maxX = Math.max(...cells.map(([x]) => x));

        for (let x = -minX; x <= 9 - maxX; x++) {
          let y = -4;
          while (!collides(rows, type, r, x, y + 1)) y++;
          addCandidate(x, y, r, null, 1);

          // Cheap spin/tuck probe at ground and one row above.
          for (const probeY of [y, y - 1]) {
            if (collides(rows, type, r, x, probeY)) continue;
            const base = { x, y: probeY, r };
            for (const [dir, action] of [[+1, ACTION.CW], [-1, ACTION.CCW]]) {
              const rot = rotateSRS(rows, type, base, dir);
              if (!rot) continue;
              const ly = hardDropY(rows, type, rot.r, rot.x, rot.y);
              addCandidate(rot.x, ly, rot.r, action, 2.2);
            }
          }
        }
      }

      return [...out.values()];
    }

    // ----------------------------------------------------------
    // Features inspired by strong versus engines
    // ----------------------------------------------------------

    function heights(rows) {
      const h = Array(10).fill(0);
      for (let x = 0; x < 10; x++) {
        for (let y = 0; y < 20; y++) {
          if (rows[y] & (1 << x)) { h[x] = 20 - y; break; }
        }
      }
      return h;
    }

    function holesAndCovered(rows) {
      let holes = 0;
      let covered = 0;
      let holeDepth = 0;

      for (let x = 0; x < 10; x++) {
        let blocksAbove = 0;
        for (let y = 0; y < 20; y++) {
          const filled = !!(rows[y] & (1 << x));
          if (filled) {
            blocksAbove++;
          } else if (blocksAbove > 0) {
            holes++;
            holeDepth += blocksAbove;
            covered += blocksAbove;
          }
        }
      }

      return { holes, holeDepth, covered };
    }

    function transitions(rows) {
      let rowT = 0;
      let colT = 0;

      for (let y = 0; y < 20; y++) {
        let prev = 1;
        for (let x = 0; x < 10; x++) {
          const cur = (rows[y] >> x) & 1;
          if (cur !== prev) rowT++;
          prev = cur;
        }
        if (prev !== 1) rowT++;
      }

      for (let x = 0; x < 10; x++) {
        let prev = 1;
        for (let y = 0; y < 20; y++) {
          const cur = (rows[y] >> x) & 1;
          if (cur !== prev) colT++;
          prev = cur;
        }
        if (prev !== 1) colT++;
      }

      return { rowT, colT };
    }

    function wellFeatures(h) {
      let wellSum = 0;
      let maxWell = 0;
      let interiorWell = 0;
      const columns = Array(10).fill(0);

      for (let x = 0; x < 10; x++) {
        const left = x === 0 ? 20 : h[x - 1];
        const right = x === 9 ? 20 : h[x + 1];
        const d = Math.max(0, Math.min(left, right) - h[x]);
        columns[x] = d;
        wellSum += d * (d + 1) / 2;
        maxWell = Math.max(maxWell, d);
        if (x >= 1 && x <= 8) interiorWell += d * (d + 1) / 2;
      }

      return { wellSum, maxWell, interiorWell, columns };
    }

    function overhangCells(rows) {
      let n = 0;
      for (let y = 0; y < 19; y++) {
        for (let x = 0; x < 10; x++) {
          if ((rows[y] & (1 << x)) && !(rows[y + 1] & (1 << x))) n++;
        }
      }
      return n;
    }

    function cheeseFeatures(rows) {
      let bottomCheese = 0;
      let totalCheese = 0;
      let lastHole = -1;
      let holeChanges = 0;
      let bottomRunActive = true;

      for (let y = 19; y >= 0; y--) {
        const count = popcount10(rows[y]);
        if (count === 9) {
          totalCheese++;
          if (bottomRunActive) bottomCheese++;
          let hole = -1;
          for (let x = 0; x < 10; x++) {
            if (!(rows[y] & (1 << x))) { hole = x; break; }
          }
          if (lastHole >= 0 && hole !== lastHole) holeChanges++;
          lastHole = hole;
        } else {
          bottomRunActive = false;
        }
      }

      return { bottomCheese, totalCheese, holeChanges };
    }

    function tSlotPotential(rows) {
      let count = 0;
      // Conservative 3-corner empty-center slot count.
      for (let py = 1; py < 19; py++) {
        for (let px = 1; px < 9; px++) {
          if (rows[py] & (1 << px)) continue;
          let corners = 0;
          for (const [dx, dy] of [[-1,-1],[1,-1],[-1,1],[1,1]]) {
            if (occupiedOrWall(rows, px + dx, py + dy)) corners++;
          }
          if (corners < 3) continue;

          // At least one T orientation must have its four cells empty.
          let viable = false;
          for (let r = 0; r < 4 && !viable; r++) {
            let ok = true;
            for (const [cx, cy] of cellsFor('T', r)) {
              const x = (px - 1) + cx;
              const y = (py - 1) + cy;
              if (x < 0 || x >= 10 || y < 0 || y >= 20 || (rows[y] & (1 << x))) { ok = false; break; }
            }
            if (ok) viable = true;
          }
          if (viable) count++;
        }
      }
      return count;
    }

    function features(rows) {
      const h = heights(rows);
      const hc = holesAndCovered(rows);
      const tr = transitions(rows);
      const wf = wellFeatures(h);
      const cheese = cheeseFeatures(rows);

      let bump = 0;
      let bumpSq = 0;
      for (let x = 0; x < 9; x++) {
        const d = Math.abs(h[x] - h[x + 1]);
        bump += d;
        bumpSq += d * d;
      }

      const aggregate = h.reduce((a, b) => a + b, 0);
      const maxHeight = Math.max(...h);
      let topHalf = 0;
      let topQuarter = 0;
      for (let y = 0; y < 10; y++) topHalf += popcount10(rows[y]);
      for (let y = 0; y < 5; y++) topQuarter += popcount10(rows[y]);

      return {
        h,
        aggregate,
        maxHeight,
        bump,
        bumpSq,
        holes: hc.holes,
        holeDepth: hc.holeDepth,
        covered: hc.covered,
        rowT: tr.rowT,
        colT: tr.colT,
        wellSum: wf.wellSum,
        maxWell: wf.maxWell,
        interiorWell: wf.interiorWell,
        wellColumns: wf.columns,
        overhang: overhangCells(rows),
        topHalf,
        topQuarter,
        jeopardy: Math.max(0, maxHeight - 12),
        bottomCheese: cheese.bottomCheese,
        totalCheese: cheese.totalCheese,
        cheeseHoleChanges: cheese.holeChanges,
        tSlots: tSlotPotential(rows),
      };
    }

    function opponentSummary(opponents) {
      let vulnerable = 0;
      let strongest = 0;
      for (const opp of opponents || []) {
        if (!opp || opp.eliminated || !opp.rows) continue;
        const f = features(opp.rows);
        vulnerable = Math.max(vulnerable, f.maxHeight + f.holes * 0.65);
        strongest = Math.max(strongest, Math.max(0, 12 - f.maxHeight) + Math.max(0, 3 - f.holes));
      }
      return { vulnerable, strongest };
    }

    // ----------------------------------------------------------
    // Strategic mode with hysteresis
    // ----------------------------------------------------------

    function chooseMode(snapshot, f, opp) {
      const pending = snapshot.pendingGarbage;
      const risk = f.maxHeight + pending * 1.15 + f.holes * 1.55 + Math.min(6, f.holeDepth * 0.07);

      if (risk >= 19 || f.maxHeight >= 15 || pending >= 7) {
        lastMode = 'EMERGENCY';
        return lastMode;
      }

      if (lastMode === 'EMERGENCY' && (risk >= 13 || pending > 0 || f.holes >= 2)) {
        lastMode = 'DEFENSE';
        return lastMode;
      }

      if (risk >= 13 || pending >= 3 || f.holes >= 3 || f.bottomCheese >= 4) {
        lastMode = 'DEFENSE';
        return lastMode;
      }

      if (lastMode === 'DEFENSE' && (risk >= 9.5 || pending > 0 || f.holes >= 2)) return lastMode;

      const safe = pending === 0 && f.maxHeight <= 9 && f.holes <= 1;
      const offenseReady = snapshot.b2b || f.tSlots > 0 || f.wellColumns[9] >= 2 || opp.vulnerable >= 14;

      if (safe && offenseReady) {
        lastMode = 'PRESSURE';
        return lastMode;
      }

      if (lastMode === 'PRESSURE' && safe && f.maxHeight <= 10) return lastMode;

      lastMode = 'STACK';
      return lastMode;
    }

    // ----------------------------------------------------------
    // Attack / cancellation model
    // ----------------------------------------------------------

    function attackKey(cleared, spin) {
      return `${spin ? 'S' : 'N'}${cleared}`;
    }

    function estimateAttack(cleared, spin, b2b, combo) {
      if (cleared <= 0) return 0;
      let attack = Number(learnedAttack.get(attackKey(cleared, spin)) ?? 0);
      const difficult = spin || cleared === 4;
      if (difficult && b2b) attack += 1;
      const c = Math.max(0, combo) + 1;
      if (c >= 2) attack += Math.min(4, Math.floor(c / 2));
      return attack;
    }

    function nextMeta(meta, placement) {
      const attack = estimateAttack(placement.cleared, placement.spin, meta.b2b, meta.combo);
      const cancel = Math.min(meta.pending, attack);
      const outgoing = Math.max(0, attack - cancel);
      const pending = Math.max(0, meta.pending - cancel);
      const difficult = placement.spin || placement.cleared === 4;

      return {
        combo: placement.cleared > 0 ? Math.max(0, meta.combo) + 1 : 0,
        b2b: difficult ? true : (placement.cleared > 0 ? false : meta.b2b),
        pending,
        attack,
        cancel,
        outgoing,
      };
    }

    // ----------------------------------------------------------
    // Evaluation
    // ----------------------------------------------------------

    const W = {
      STACK: {
        height: -0.30, bump: -0.42, bumpSq: -0.055, holes: -13.0, holeDepth: -0.72,
        covered: -0.22, rowT: -0.10, colT: -0.16, well: -0.24, maxWell: -0.58,
        interiorWell: -0.72, overhang: -0.20, topHalf: -0.45, topQuarter: -1.9,
        jeopardy: -4.8, tSlot: 1.35, moveTime: -0.035,
      },
      PRESSURE: {
        height: -0.28, bump: -0.36, bumpSq: -0.045, holes: -12.4, holeDepth: -0.68,
        covered: -0.20, rowT: -0.09, colT: -0.14, well: -0.18, maxWell: -0.45,
        interiorWell: -0.58, overhang: -0.15, topHalf: -0.40, topQuarter: -1.7,
        jeopardy: -4.5, tSlot: 2.4, moveTime: -0.028,
      },
      DEFENSE: {
        height: -0.48, bump: -0.40, bumpSq: -0.050, holes: -16.5, holeDepth: -0.95,
        covered: -0.32, rowT: -0.10, colT: -0.16, well: -0.34, maxWell: -0.78,
        interiorWell: -0.95, overhang: -0.26, topHalf: -0.75, topQuarter: -2.8,
        jeopardy: -7.2, tSlot: 0.45, moveTime: -0.024,
      },
      EMERGENCY: {
        height: -0.78, bump: -0.34, bumpSq: -0.040, holes: -20.0, holeDepth: -1.15,
        covered: -0.42, rowT: -0.09, colT: -0.14, well: -0.50, maxWell: -1.0,
        interiorWell: -1.20, overhang: -0.34, topHalf: -1.15, topQuarter: -4.5,
        jeopardy: -10.5, tSlot: 0.0, moveTime: -0.015,
      },
    };

    function baseBoardScore(f, mode, complexity) {
      const w = W[mode] ?? W.STACK;
      return (
        f.aggregate * w.height +
        f.bump * w.bump +
        f.bumpSq * w.bumpSq +
        f.holes * w.holes +
        f.holeDepth * w.holeDepth +
        f.covered * w.covered +
        f.rowT * w.rowT +
        f.colT * w.colT +
        f.wellSum * w.well +
        f.maxWell * w.maxWell +
        f.interiorWell * w.interiorWell +
        f.overhang * w.overhang +
        f.topHalf * w.topHalf +
        f.topQuarter * w.topQuarter +
        f.jeopardy * w.jeopardy +
        f.tSlots * w.tSlot +
        complexity * w.moveTime
      );
    }

    function evaluatePlacement(p, mode, context, meta) {
      const before = context.before;
      const f = features(p.rows);
      const nmeta = nextMeta(meta, p);
      let score = baseBoardScore(f, mode, p.complexity ?? 1);

      // New holes/covered cells are especially harmful.
      score -= Math.max(0, f.holes - before.holes) * (mode === 'EMERGENCY' ? 13 : 8.5);
      score -= Math.max(0, f.covered - before.covered) * 0.38;

      // Downstacking: expose/remove garbage-like rows instead of merely skimming the top.
      const cheeseRemoved = Math.max(0, before.totalCheese - f.totalCheese);
      const bottomCheeseRemoved = Math.max(0, before.bottomCheese - f.bottomCheese);
      const dsWeight = mode === 'EMERGENCY' ? 10.0 : mode === 'DEFENSE' ? 7.5 : 2.0;
      score += cheeseRemoved * dsWeight;
      score += bottomCheeseRemoved * dsWeight * 1.4;
      score -= f.cheeseHoleChanges * (mode === 'DEFENSE' || mode === 'EMERGENCY' ? 0.25 : 0.10);

      // Attack and garbage cancellation are separate objectives.
      const cancelW = mode === 'EMERGENCY' ? 13.0 : mode === 'DEFENSE' ? 10.0 : 6.0;
      const outW = mode === 'PRESSURE' ? 7.0 : mode === 'STACK' ? 4.1 : 3.0;
      score += nmeta.cancel * cancelW;
      score += nmeta.outgoing * outW;

      // Remaining garbage is dangerous proportional to current height.
      score -= nmeta.pending * (2.0 + f.maxHeight * 0.38);
      const projected = f.maxHeight + Math.min(8, nmeta.pending);
      if (projected >= 19) score -= 620;
      else if (projected >= 17) score -= 180;
      else if (projected >= 15) score -= 55;

      // Line-clear utility. Defensive skimming is allowed; offensive skimming is not overrewarded.
      const lineTable = {
        STACK:     [0, 1.5, 5.5, 10, 26],
        PRESSURE:  [0, 0.5, 4.5, 9, 34],
        DEFENSE:   [0, 8, 17, 27, 42],
        EMERGENCY: [0, 13, 25, 39, 57],
      }[mode] ?? [0,1,5,10,25];
      score += lineTable[p.cleared] ?? 0;
      score += p.erodedPieceCells * 1.6;

      // Difficult clears preserve pressure.
      if (p.spin && p.cleared > 0) score += mode === 'PRESSURE' ? 12 + p.cleared * 3 : 6 + p.cleared * 1.8;
      if (p.cleared === 4) score += meta.b2b ? 8 : 4;
      if (p.perfectClear) score += 42;

      // Wasted T: if a T-slot exists, burning T without a spin gets a small penalty.
      if (context.currentType === 'T' && before.tSlots > 0 && !p.spin && mode !== 'EMERGENCY') score -= 3.2;

      // Edge well preference is mild, not a rigid strategy.
      const hasISoon = [context.currentType, context.holdType, ...(context.queue || []).slice(0, 4)].includes('I');
      const rightWell = f.wellColumns[9];
      if (
        (mode === 'STACK' || mode === 'PRESSURE') &&
        hasISoon &&
        f.holes === 0 &&
        rightWell <= 4 &&
        (mode === 'PRESSURE' || before.aggregate >= 10)
      ) {
        // Do not build a Tetris well from an empty field just because an I is visible.
        // Mid-game well value matters only after a useful stack already exists.
        score += rightWell * (mode === 'PRESSURE' ? 1.05 : 0.38);
      }
      score -= Math.max(0, rightWell - 4) ** 2 * 4.2;

      // Finish pressure when opponent is near top-out, but only if our board is safe.
      if (context.opponentVulnerable >= 14 && nmeta.outgoing > 0 && f.maxHeight <= 10 && f.holes <= 1) {
        score += nmeta.outgoing * 1.3;
      }

      return { score, features: f, meta: nmeta };
    }

    // ----------------------------------------------------------
    // Search helpers
    // ----------------------------------------------------------

    function evaluateCandidates(candidates, mode, context, meta) {
      return candidates.map(p => {
        const e = evaluatePlacement(p, mode, context, meta);
        return { ...p, immediate: e.score, resultFeatures: e.features, nextMeta: e.meta };
      });
    }

    function transpositionPrune(nodes, maxCount) {
      const map = new Map();
      for (const n of nodes) {
        const key = `${boardKey(n.rows)}|${n.meta.b2b ? 1 : 0}|${Math.min(6,n.meta.combo)}|${Math.min(10,n.meta.pending)}`;
        const old = map.get(key);
        if (!old || n.total > old.total) map.set(key, n);
        if (map.size > SETTINGS.transpositionLimit) break;
      }
      return [...map.values()].sort((a,b) => b.total - a.total).slice(0, maxCount);
    }

    function searchAtDepth(rootCandidates, futureTypes, mode, context, startMeta, depthLimit, deadline) {
      let first = evaluateCandidates(rootCandidates, mode, context, startMeta)
        .sort((a,b) => b.immediate - a.immediate)
        .slice(0, SETTINGS.firstWidth);
      if (!first.length) return null;

      let frontier = first.map(p => ({ first: p, rows: p.rows, meta: p.nextMeta, total: p.immediate }));

      for (let depth = 1; depth < depthLimit && depth <= futureTypes.length; depth++) {
        if (performance.now() > deadline) return { incomplete: true };
        const type = futureTypes[depth - 1];
        if (!SHAPES[type]) break;
        const discount = Math.pow(0.79, depth);
        const expanded = [];

        for (const node of frontier) {
          if (performance.now() > deadline) return { incomplete: true };

          const before = features(node.rows);
          const childContext = {
            ...context,
            before,
            currentType: type,
            queue: futureTypes.slice(depth),
          };

          const raw = futurePlacements(node.rows, type);
          const children = evaluateCandidates(raw, mode, childContext, node.meta)
            .sort((a,b) => b.immediate - a.immediate)
            .slice(0, SETTINGS.childWidth);

          if (!children.length) {
            expanded.push({ ...node, total: node.total - 1000 });
            continue;
          }

          for (const child of children) {
            expanded.push({
              first: node.first,
              rows: child.rows,
              meta: child.nextMeta,
              total: node.total + child.immediate * discount,
            });
          }
        }

        frontier = transpositionPrune(expanded, SETTINGS.beamWidth);
        if (!frontier.length) break;
      }

      frontier.sort((a,b) => b.total - a.total);
      const best = frontier[0];
      const second = frontier[1];
      if (!best) return null;
      return {
        plan: {
          ...best.first,
          total: best.total,
          margin: second ? best.total - second.total : 99,
        },
        incomplete: false,
      };
    }

    function iterativeSearch(rootCandidates, futureTypes, mode, context, startMeta, deadline) {
      const maxDepth = SETTINGS.maxDepth[mode] ?? 3;
      let best = null;

      for (let depth = 2; depth <= maxDepth; depth++) {
        if (performance.now() > deadline) break;
        const result = searchAtDepth(rootCandidates, futureTypes, mode, context, startMeta, depth, deadline);
        if (!result) break;
        if (result.incomplete) break;
        best = result.plan;
      }

      // Always have a root fallback even if deeper search timed out.
      if (!best) {
        const root = evaluateCandidates(rootCandidates, mode, context, startMeta)
          .sort((a,b) => b.immediate - a.immediate);
        if (root.length) best = { ...root[0], total: root[0].immediate, margin: root[1] ? root[0].immediate - root[1].immediate : 99 };
      }

      return best;
    }

    // ----------------------------------------------------------
    // Main planner
    // ----------------------------------------------------------

    function plan(snapshot) {
      const startTime = performance.now();
      const base = features(snapshot.rows);
      const opp = opponentSummary(snapshot.opponents);
      const mode = chooseMode(snapshot, base, opp);
      const deadline = startTime + (SETTINGS.budget[mode] ?? 55);

      const startMeta = {
        combo: snapshot.combo,
        b2b: snapshot.b2b,
        pending: snapshot.pendingGarbage,
      };

      const common = {
        before: base,
        holdType: snapshot.hold,
        queue: snapshot.nextQueue,
        opponentVulnerable: opp.vulnerable,
        opponentStrength: opp.strongest,
      };

      const root = reachablePlacements(
        snapshot.rows,
        snapshot.current.type,
        { x: snapshot.current.x, y: snapshot.current.y, r: snapshot.current.rotation },
        deadline,
        true
      );

      let best = iterativeSearch(
        root,
        snapshot.nextQueue,
        mode,
        { ...common, currentType: snapshot.current.type },
        startMeta,
        deadline
      );

      if (best) {
        best.useHold = false;
        best.plannedType = snapshot.current.type;
      }

      // Root hold comparison.
      if (snapshot.canHold && performance.now() < deadline) {
        const holdPiece = snapshot.hold || snapshot.nextQueue[0];
        const future = snapshot.hold ? snapshot.nextQueue : snapshot.nextQueue.slice(1);

        if (holdPiece) {
          const holdRoot = reachablePlacements(
            snapshot.rows,
            holdPiece,
            { x: 3, y: 0, r: 0 },
            deadline,
            true
          );

          const holdPlan = iterativeSearch(
            holdRoot,
            future,
            mode,
            { ...common, currentType: holdPiece, holdType: snapshot.current.type, queue: future },
            startMeta,
            deadline
          );

          if (holdPlan) {
            const required = mode === 'EMERGENCY' ? 0.10 : mode === 'DEFENSE' ? 0.25 : mode === 'PRESSURE' ? 0.45 : 0.70;
            if (!best || holdPlan.total > best.total + required) {
              best = { ...holdPlan, useHold: true, plannedType: holdPiece };
            }
          }
        }
      }

      if (!best) return null;
      return {
        ...best,
        mode,
        searchMs: performance.now() - startTime,
        rootCount: root.length,
        baseFeatures: base,
      };
    }

    // ----------------------------------------------------------
    // Repath exact target after gravity / hold
    // ----------------------------------------------------------

    function repath(payload) {
      const deadline = performance.now() + 18;
      const root = reachablePlacements(
        payload.rows,
        payload.current.type,
        { x: payload.current.x, y: payload.current.y, r: payload.current.rotation },
        deadline,
        true
      );

      const exact = root.find(p => p.x === payload.target.x && p.y === payload.target.y && p.rotation === payload.target.rotation);
      if (exact) return exact.path;

      const compatible = root
        .filter(p => p.x === payload.target.x && p.rotation === payload.target.rotation)
        .sort((a,b) => Math.abs(a.y - payload.target.y) - Math.abs(b.y - payload.target.y));
      return compatible[0]?.path ?? null;
    }

    // ----------------------------------------------------------
    // Attack learner
    // ----------------------------------------------------------

    function learnAttack(key, actual) {
      if (!key || !Number.isFinite(actual) || actual < 0 || actual > 20) return;
      const old = Number(learnedAttack.get(key) ?? actual);
      learnedAttack.set(key, old * 0.65 + actual * 0.35);
    }

    self.onmessage = event => {
      const msg = event.data;
      try {
        if (msg.type === 'plan') {
          const result = plan(msg.snapshot);
          self.postMessage({ type: 'result', id: msg.id, result });
          return;
        }
        if (msg.type === 'repath') {
          const path = repath(msg.payload);
          self.postMessage({ type: 'repathResult', id: msg.id, path });
          return;
        }
        if (msg.type === 'learnAttack') {
          learnAttack(msg.key, Number(msg.actual));
          return;
        }
        if (msg.type === 'resetMode') {
          lastMode = 'STACK';
          return;
        }
      } catch (error) {
        self.postMessage({ type: 'error', id: msg.id, error: String(error?.stack || error) });
      }
    };
  }

  const workerBlob = new Blob([`(${plannerWorkerMain.toString()})()`], { type: 'application/javascript' });
  const plannerWorker = new Worker(URL.createObjectURL(workerBlob));
  let requestSeq = 0;
  const pendingRequests = new Map();

  plannerWorker.onmessage = event => {
    const msg = event.data;
    const pending = pendingRequests.get(msg.id);
    if (!pending) {
      if (msg.type === 'error') console.error('[BB AI Worker]', msg.error);
      return;
    }
    pendingRequests.delete(msg.id);
    clearTimeout(pending.timeout);
    if (msg.type === 'error') pending.reject(new Error(msg.error));
    else pending.resolve(msg.result ?? msg.path ?? null);
  };

  function workerRequest(type, data, timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = ++requestSeq;
      const timeout = setTimeout(() => {
        pendingRequests.delete(id);
        reject(new Error(`${type} timeout`));
      }, timeoutMs);
      pendingRequests.set(id, { resolve, reject, timeout });
      plannerWorker.postMessage({ type, id, ...data });
    });
  }

  // ============================================================
  // 5. ONLINE ATTACK MODEL OBSERVATION
  // ============================================================

  function parseClearCount(lastClear) {
    if (typeof lastClear === 'number' && Number.isFinite(lastClear)) return Math.max(0, Math.min(4, Math.round(lastClear)));
    if (typeof lastClear === 'string') {
      const lower = lastClear.toLowerCase();
      const m = lower.match(/([1-4])/);
      if (m) return Number(m[1]);
      if (lower.includes('single')) return 1;
      if (lower.includes('double')) return 2;
      if (lower.includes('triple')) return 3;
      if (lower.includes('tetris') || lower.includes('quad')) return 4;
    }
    if (lastClear && typeof lastClear === 'object') {
      for (const key of ['lines', 'count', 'cleared', 'lineCount']) {
        if (Number.isFinite(Number(lastClear[key]))) return Math.max(0, Math.min(4, Number(lastClear[key])));
      }
    }
    return 0;
  }

  function parseSpin(lastSpin) {
    if (typeof lastSpin === 'boolean') return lastSpin;
    if (typeof lastSpin === 'number') return lastSpin > 0;
    if (typeof lastSpin === 'string') return !['', 'none', 'false', '0', 'no'].includes(lastSpin.toLowerCase());
    return !!lastSpin;
  }

  function observeAttackModel(player) {
    if (!player) return;
    const version = player.pieceVersion;
    if (lastObservedPieceVersion == null) {
      lastObservedPieceVersion = version;
      return;
    }
    if (version === lastObservedPieceVersion) return;
    lastObservedPieceVersion = version;

    const clear = parseClearCount(player.lastClear);
    const spin = parseSpin(player.lastSpin);
    const actual = Number(player.lastAttack);
    if (clear > 0 && Number.isFinite(actual) && actual >= 0) {
      plannerWorker.postMessage({ type: 'learnAttack', key: `${spin ? 'S' : 'N'}${clear}`, actual });
    }
  }

  // ============================================================
  // 6. INPUT ENGINE
  // ============================================================

  const ACTION_KEYS = {
    L: ['ArrowLeft', 'ArrowLeft', 37],
    R: ['ArrowRight', 'ArrowRight', 39],
    D: ['ArrowDown', 'ArrowDown', 40],
    CW: ['ArrowUp', 'ArrowUp', 38],
    CCW: ['z', 'KeyZ', 90],
    HD: [' ', 'Space', 32],
    HOLD: ['c', 'KeyC', 67],
  };

  function dispatchKey(type, action) {
    const data = ACTION_KEYS[action];
    if (!data) return;
    const [key, code, keyCode] = data;
    document.dispatchEvent(new KeyboardEvent(type, {
      key, code, keyCode, which: keyCode,
      bubbles: true, cancelable: true, composed: true, repeat: false,
    }));
  }

  async function tap(action, timing, fast = false) {
    dispatchKey('keydown', action);
    await sleep(fast ? Math.min(9, timing.keyHold) : timing.keyHold);
    dispatchKey('keyup', action);

    let gap = fast ? Math.min(12, timing.keyGap) : timing.keyGap;
    if (action === 'D') gap = Math.min(gap, 11);
    if (action === 'HD') gap = Math.min(gap, 15);
    await sleep(Math.max(3, gap + randi(-3, 5)));
  }

  async function waitFor(predicate, timeoutMs, interval = 12) {
    const start = performance.now();
    while (performance.now() - start < timeoutMs) {
      try {
        const value = predicate();
        if (value) return value;
      } catch {}
      await sleep(interval);
    }
    return null;
  }

  function timingFor(mode, plan, player) {
    const c = CFG.pacing[mode] ?? CFG.pacing.STACK;
    let think = randi(...c.think);

    // Ambiguous choices receive only a tiny hesitation.
    if ((mode === 'STACK' || mode === 'PRESSURE') && Number(plan?.margin ?? 99) < 0.8) think += randi(12, 30);

    const y = Number(player.current?.y ?? 0);
    const pending = Number(player.pendingGarbage ?? 0);
    if (y >= 6 || pending >= 4) think = Math.min(think, 55);
    if (y >= 10 || pending >= 7) think = Math.min(think, 22);

    return {
      mode,
      think,
      keyHold: randi(...c.keyHold),
      keyGap: randi(...c.keyGap),
      beforeDrop: randi(...c.beforeDrop),
    };
  }

  // ============================================================
  // 7. PLAN / REPATH / EXECUTE
  // ============================================================

  async function requestPlan(ctx) {
    const snapshot = snapshotFromContext(ctx);
    if (!snapshot) return null;
    return workerRequest('plan', { snapshot }, CFG.plannerTimeoutMs);
  }

  async function requestRepath(ctx, target, plannedType) {
    const snapshot = snapshotFromContext(ctx);
    if (!snapshot || snapshot.current.type !== plannedType) return null;
    return workerRequest('repath', {
      payload: {
        rows: snapshot.rows,
        current: snapshot.current,
        target: { x: target.x, y: target.y, rotation: target.rotation },
      },
    }, CFG.repathTimeoutMs);
  }

  async function executePlan(ctx, plan, timing) {
    let currentCtx = ctx;
    let player = currentCtx.player;
    let version = player.pieceVersion;

    // HOLD first, then repath from the actual spawned replacement.
    if (plan.useHold) {
      await tap('HOLD', timing, timing.mode === 'EMERGENCY');

      const swapped = await waitFor(() => {
        const fresh = getGameContext();
        if (!fresh.player?.current) return null;
        return pieceType(fresh.player.current) === plan.plannedType ? fresh : null;
      }, 220);

      if (!swapped) {
        log('Hold synchronization failed', { expected: plan.plannedType });
        return false;
      }

      currentCtx = swapped;
      player = swapped.player;
      version = player.pieceVersion;
    }

    // Fresh path prevents stale-y and SRS execution errors.
    const path = await requestRepath(currentCtx, plan, plan.plannedType);
    if (!path?.length) {
      log('Target not reachable after repath', { plan, current: currentCtx.player?.current });
      return false;
    }

    for (let i = 0; i < path.length; i++) {
      const action = path[i];

      // Version-only validation every few inputs: stable, no x/rotation thrash.
      if (i > 0 && i % 3 === 0) {
        const fresh = getGameContext();
        if (!fresh.player?.current || fresh.player.pieceVersion !== version) return true;
      }

      const liveY = Number(getGameContext().player?.current?.y ?? 0);
      const fast = timing.mode === 'EMERGENCY' || timing.mode === 'DEFENSE' || liveY >= 9;

      if (action === 'HD') {
        await sleep(timing.beforeDrop);
        await tap(action, timing, true);
      } else {
        await tap(action, timing, fast);
      }
    }

    const changed = await waitFor(() => {
      const fresh = getGameContext();
      return (fresh.player && fresh.player.pieceVersion !== version) ? fresh : null;
    }, 250);

    return !!changed;
  }

  // ============================================================
  // 8. MAIN LOOP
  // ============================================================

  async function tick() {
    if (!enabled || busy || document.hidden) return;

    const initial = getGameContext();
    const player = initial.player;

    if (!player) {
      setStatus('Player 선택 필요 · F10', false);
      return;
    }

    observeAttackModel(player);

    if (player.eliminated) {
      setStatus('게임 종료 / 탈락', false);
      return;
    }
    if (!player.current) return;

    const version = player.pieceVersion;
    if (version === lastHandledVersion) return;

    busy = true;

    try {
      // Search happens off the main thread.
      const planPromise = requestPlan(initial);

      // Planner mode is unknown until the result arrives; wait only a small baseline amount.
      await sleep(28);
      const plan = await planPromise;

      if (!plan) {
        setStatus('배치 계산 실패', false);
        return;
      }

      const fresh = getGameContext();
      if (!fresh.player?.current || fresh.player.pieceVersion !== version) return;

      const timing = timingFor(plan.mode, plan, fresh.player);
      const elapsedThink = 28;
      if (timing.think > elapsedThink) await sleep(timing.think - elapsedThink);

      // Verify once more after deliberate think-time.
      const latest = getGameContext();
      if (!latest.player?.current || latest.player.pieceVersion !== version) return;

      lastHandledVersion = version;
      const holdText = plan.useHold ? ` HOLD→${plan.plannedType}` : '';
      const spinText = plan.spin ? ' SPIN' : '';
      const x = Object.is(plan.x, -0) ? 0 : plan.x;

      setStatus(
        `${plan.mode} · ${pieceType(latest.player.current)}${holdText}${spinText} · x=${x} · G${latest.player.pendingGarbage ?? 0}`,
        true
      );

      log('PLAN', {
        version,
        mode: plan.mode,
        searchMs: Number(plan.searchMs?.toFixed?.(1) ?? plan.searchMs),
        rootCount: plan.rootCount,
        current: { ...latest.player.current },
        hold: latest.player.hold,
        next: [...(latest.player.nextQueue || [])],
        garbage: latest.player.pendingGarbage,
        combo: latest.player.combo,
        b2b: latest.player.backToBack,
        plan,
      });

      const success = await executePlan(latest, plan, timing);

      if (!success) {
        executionFailures++;
        lastHandledVersion = null;
        setStatus(`재동기화 ${executionFailures}/5`, false);
        await sleep(70);

        if (executionFailures >= 5) {
          stop();
          setStatus('안전 중지 · 입력/상태 불일치', false);
          console.warn('[BB Tetris AI FINAL v4.0] 실행 실패 5회로 안전 중지했습니다.');
        }
      } else {
        executionFailures = 0;
      }
    } catch (error) {
      console.error('[BB Tetris AI FINAL v4.0]', error);
      lastHandledVersion = null;
      executionFailures++;
      setStatus('오류 · Console 확인', false);
    } finally {
      busy = false;
    }
  }

  // ============================================================
  // 9. START / STOP / INSPECT
  // ============================================================

  function start() {
    if (loopTimer) clearInterval(loopTimer);
    enabled = true;
    lastHandledVersion = null;
    executionFailures = 0;
    plannerWorker.postMessage({ type: 'resetMode' });
    loopTimer = setInterval(tick, CFG.pollMs);
    setStatus('AI 실행 중 · 새 블록 대기', true);
    log('STARTED');
  }

  function stop() {
    enabled = false;
    if (loopTimer) clearInterval(loopTimer);
    loopTimer = null;
    setStatus('AI 중지 (F8 시작)', false);
    log('STOPPED');
  }

  function toggle() {
    enabled ? stop() : start();
  }

  async function inspect() {
    const ctx = getGameContext();
    const p = ctx.player;
    if (!p) {
      alert('❌ Player를 자동 선택하지 못했습니다.\n게임 시작 후 F10으로 본인 Player를 선택해주세요.');
      return;
    }

    const snapshot = snapshotFromContext(ctx);
    let plan = null;
    try { plan = snapshot ? await workerRequest('plan', { snapshot }, CFG.plannerTimeoutMs) : null; } catch {}

    console.log('========== BB TETRIS AI FINAL v4.0 INSPECT ==========', { ctx, snapshot, plan });

    alert([
      '✅ BuriburiLand AI FINAL v4.0 연결 성공',
      '',
      `Player: ${p.nickname ?? '(닉네임 없음)'}`,
      `현재: ${pieceType(p.current) ?? '-'}`,
      `x=${p.current?.x ?? '-'} / y=${p.current?.y ?? '-'} / r=${p.current?.rotation ?? '-'}`,
      `HOLD: ${pieceType(p.hold) ?? '(없음)'}`,
      `NEXT: ${(p.nextQueue || []).slice(0, 10).map(pieceType).filter(Boolean).join(' ')}`,
      '',
      `Incoming: ${p.pendingGarbage ?? 0}`,
      `Combo: ${p.combo ?? 0}`,
      `B2B: ${p.backToBack ?? false}`,
      `상대 수: ${ctx.opponents.length}`,
      `AI MODE: ${plan?.mode ?? '-'}`,
      `AI Search: ${plan?.searchMs ? Number(plan.searchMs).toFixed(1) + 'ms' : '-'}`,
      `Root placements: ${plan?.rootCount ?? '-'}`,
      '',
      'F8 = 시작/중지',
      'F9 = 상태/AI 검사',
      'F10 = Player 선택',
    ].join('\n'));
  }

  // ============================================================
  // 10. UI
  // ============================================================

  document.getElementById('bb-tetris-ai-panel')?.remove();

  const panel = document.createElement('div');
  panel.id = 'bb-tetris-ai-panel';
  panel.style.cssText = `
    position:fixed;
    right:14px;
    bottom:14px;
    z-index:2147483647;
    min-width:350px;
    padding:11px 13px;
    border:1px solid rgba(255,255,255,.20);
    border-radius:11px;
    background:rgba(12,14,18,.94);
    color:#fff;
    box-shadow:0 10px 28px rgba(0,0,0,.34);
    font:12px/1.45 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  `;

  panel.innerHTML = `
    <div style="font-weight:800;font-size:13px;margin-bottom:5px">
      Buriburi Tetris AI <span style="opacity:.65">FINAL v4.0 Research Engine</span>
    </div>
    <div id="bbtai-status">AI 중지 (F8 시작)</div>
    <div style="opacity:.62;margin-top:6px">F8 시작/중지 · F9 검사 · F10 Player 선택</div>
  `;

  document.body.appendChild(panel);

  function setStatus(text, active) {
    const el = document.getElementById('bbtai-status');
    if (!el) return;
    el.textContent = text;
    el.style.fontWeight = active ? '700' : '400';
  }

  // ============================================================
  // 11. HOTKEYS / SAFETY
  // ============================================================

  window.addEventListener('keydown', event => {
    if (event.key === 'F8') {
      event.preventDefault();
      event.stopPropagation();
      toggle();
      return;
    }
    if (event.key === 'F9') {
      event.preventDefault();
      event.stopPropagation();
      inspect();
      return;
    }
    if (event.key === 'F10') {
      event.preventDefault();
      event.stopPropagation();
      cyclePlayer();
    }
  }, true);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden && enabled) {
      stop();
      setStatus('탭 비활성화로 안전 중지', false);
    }
  });

  window.addEventListener('beforeunload', () => {
    try { plannerWorker.terminate(); } catch {}
  });

  console.log('[BB Tetris AI FINAL v4.0] loaded. F8=toggle, F9=inspect, F10=player.');
})();
