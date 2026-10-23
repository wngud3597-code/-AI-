# BuriburiLand Competitive Tetris AI

## Mission
Build a stable competitive AI for BuriburiLand web Tetris. The final deployment target is a Tampermonkey userscript, but development must be modular, testable, and validated against the real game.

## Most important rule
Simulation fidelity comes before AI strength. Do not strengthen search/evaluation until predicted state matches actual BuriburiLand results.

Required loop:
actual before → simulate → predicted after → execute → actual after → diff → fix simulator if mismatched

## Confirmed player state
Observed fields:
next, sequenceIndex, clearEventId, lockDeadlineAt, pendingGarbage, lockTouchedGround, lockResetCount, hold, canHold, score, current, nextQueue, nickname, lastAttack, lines, actionSequence, playerId, eliminated, backToBack, lastClear, combo, pieceVersion, lastMoveWasRotation, lastRotation, lastSpin, board

current = { rotation, x, y, type }
board = 20 x 10
React path pattern = tetrisState.players.<playerId>
Never hard-code a player UUID.

## Known failures
1. Deep central canyon and tall side towers.
2. Hole accumulation.
3. Garbage panic / unstable strategy after incoming attacks.
4. ATTACK/DEFENSE oscillation.
5. Stale React state.
6. Duplicate key dispatch in old versions.
7. No systematic predicted-vs-actual validation.
8. Weak versus performance against a real human.
9. Overfitting to flat stack + right I-well.
10. Longer code without validation did not guarantee stronger play.

## Required architecture
src/adapter, physics, garbage, move, evaluation, search, strategy, executor, telemetry, worker, userscript

Suggested modules:
- GameAdapter
- PlayerSelector
- Bitboard / Tetromino / SRS / Collision / LineClear / Hold
- GarbageModel / GarbageCancel / GarbageInsertion
- ReachableMoveGenerator / PathRebuilder
- BoardFeatures / Downstack / AttackModel / Evaluator
- TranspositionTable / BeamSearch / IterativeDeepening / SearchEngine
- StrategyManager with hysteresis
- Executor / Keyboard / Watchdog
- Telemetry / PredictionValidator / ReplayRecorder
- Worker

## Development phases
1. GameAdapter + Telemetry
2. PredictionValidator
3. Physics fidelity
4. Garbage fidelity
5. Stable survival/downstack AI
6. Versus attack AI
7. Spin/T-spin and advanced placements
8. Performance optimization
9. Self-play / weight tuning
10. Regression testing

## Telemetry
Every locked piece should log: before state, decision, predicted after, actual after, validation diff. Compare board, clear, attack, spin, pendingGarbage, combo, backToBack. Prefer JSONL.

## Failsafe
On repeated prediction mismatch: stop aggressive strategy, preserve telemetry, switch conservative, do not spam inputs, do not oscillate modes.

## Search baseline
- SRS reachable placement generation
- Beam search
- Iterative deepening
- Transposition table
- HOLD/NEXT lookahead
- Garbage-aware evaluation
- Time budget
Current piece must start from actual current.x/current.y/current.rotation.

## Evaluator features
Holes, new holes, covered cells, hole depth, aggregate/max height, bumpiness, transitions, cavities, wells, overhangs, downstack accessibility, garbage-hole accessibility, line clears, garbage cancel, outgoing attack, B2B, combo, Tetris, spin, perfect-clear opportunity, hold opportunity cost, top-out risk, execution complexity, opponent KO pressure.

## Garbage strategy
Distinguish incoming garbage, current-move attack, cancelled garbage, remaining incoming, outgoing attack, projected height, downstack opportunity, garbage-hole accessibility. Use hysteresis.

## Human-like execution
Do not intentionally weaken the AI. Safe: brief pause → move → hard drop. Danger: reduce delay. Emergency: immediate. Avoid long random waits.

## Tooling
Primary developer: OpenAI Codex. Local: JS/TS, Node, npm, Git. Prefer Vitest. Browser/debugging: DevTools/CDP when available, Console, Network, Performance, WebSocket behavior. Automation when useful: Playwright. Final deployment: Tampermonkey userscript.

## Algorithm policy
Runtime AI should be deterministic/search-based. Baseline: SRS BFS, beam search, iterative deepening, transposition table, heuristic evaluation, garbage-aware search, HOLD/NEXT. Research later only if justified: MCTS, evolutionary tuning, self-play, RL.

## Research targets
Cold Clear, Cold Clear 2, modern Guideline bots, TETR.IO/Jstris multiplayer strategy, SRS reachability, downstack, garbage cancellation/hole management, T-spin search, evaluator features, transposition search. Extract principles; do not blindly copy code.

## Measurement
Prediction accuracy, board/clear/attack/spin/garbage match rate, decision latency, search nodes, transposition hit rate, holes per piece, max height, top-out rate, garbage cancelled/sent, attack per piece, B2B, combo, downstack efficiency, survival, head-to-head win rate.

## Working style
Before large edits: inspect current code, explain root cause, identify proving tests. After edits: run relevant tests and regressions, report what passed and what remains unverified. Prefer experiments over assumptions. Do not call the AI final/human-beating without evidence.
