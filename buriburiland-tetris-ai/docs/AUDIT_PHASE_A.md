# Phase A repository audit

Audit date: 2026-08-26. Baseline inspected: `current/buriburiland_tetris_ai_FINAL_v4.user.js` (1,809 lines). The baseline remains unchanged and is not promoted as a validated build.

## Severity-ranked findings

### Critical

1. There is no lock transaction or predicted-vs-actual validator. A plan can diverge in board, clear, attack, spin, garbage, combo, or B2B without producing durable evidence.
2. The development code is one closure containing React traversal, parsing, physics, approximate versus rules, search, input, and UI. Worker code is created with `plannerWorkerMain.toString()`, which prevents normal imports and isolated unit tests.
3. Future-ply search calls `futurePlacements`, which uses direct drops and cheap rotation probes rather than the same reachable-placement model used for the current piece. Search therefore scores future boards that may not be executable.

### High

4. React traversal returns the first object that resembles a Tetris state and caches a fiber anchor. Fresh traversal does not prove that the selected state belongs to the active room or latest render. Player objects are passed between asynchronous planning and execution.
5. Invalid current-piece collision silently resets the simulated piece to `(3,0,0)`. This hides coordinate, geometry, board, or stale-state errors and can produce a plausible but unrelated plan.
6. Garbage cancellation, combo, B2B, and attack are heuristic assumptions. `learnAttack` mixes observed `lastAttack` into a table without controlling for B2B, combo, perfect clear, cancellation, or event freshness.
7. Spin prediction treats any rotation-finished non-O immobile piece as an all-spin and uses only a Boolean T three-corner rule. BuriburiLand mini/full/all-spin semantics are unverified.

### Medium

8. Board parsing treats every non-empty unrecognized object and every non-empty string as occupied. It slices the last 20 rows and first 10 cells, masking dimension/orientation changes.
9. HOLD simulation assumes replacement spawn `(3,0,0)` and queue progression without validating the actual post-HOLD state or spawn coordinates.
10. Repath accepts a placement with matching x/rotation but a different y when the exact target is absent. This converts a prediction mismatch into silent behavior.
11. Input dispatch targets `document` only and success is inferred from `pieceVersion`; no per-action pose acknowledgement detects input loss, double handling, focus problems, or wrong event target.
12. Timing includes random sleeps and repeated full-state traversal. The Worker protects most search work, but React tree scanning and polling remain on the main thread.
13. Strategy hysteresis is internal to the Worker and not gated by fidelity. Planner timeouts and mismatches do not force a durable conservative mode.

## Evidence-to-test mapping

- Stale state: provider freshness and stale decision rejection tests.
- Board parsing: exact dimensions, known encodings, ambiguous-cell rejection.
- Geometry/SRS: all seven pieces, four rotations, wall/floor kicks, collision and hard drop fixtures.
- Reachability: BFS from exact observed `(x,y,rotation)`; no fallback spawn.
- HOLD: empty/occupied hold and once-per-lock transitions.
- Line clear: deterministic board-mask fixtures.
- Prediction divergence: field-level and cell-level diff regression.
- Keyboard duplication: single in-flight executor and paired keydown/keyup port.

## Still unverified against the real engine

Board row orientation and cell schema, spawn coordinates, exact SRS variant, lock-delay/reset behavior, hard-drop spin flag behavior, mini/full/all-spin rules, HOLD version semantics, attack table, combo/B2B rules, garbage cancellation/insertion timing, garbage hole generation, and the correct DOM event target.
