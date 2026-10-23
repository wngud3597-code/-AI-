# Modular architecture

The modular TypeScript source is a validation harness, not a replacement userscript.

```text
src/
  adapter/       GameAdapter, strict board parser
  physics/       board/collision/lock, tetrominoes, SRS, spin, HOLD
  garbage/       evidence-gated GarbageEngine contract
  move/          reachable BFS and executable paths
  evaluation/    deferred Evaluator contract
  search/        deferred SearchEngine contract
  strategy/      prediction-fidelity gate
  executor/      single-flight input execution and fresh-state checks
  telemetry/     JSONL records, prediction builder, validator
  replay/        recorded-lock replay validation
  worker/        typed request/response protocol
  userscript/    disabled integration seam
```

## Lock validation flow

1. `GameAdapter.capture()` reads a fresh state object and creates `actualBefore`.
2. A reachable placement and explicitly resolved server outcome create `predictedAfter`.
3. `JsonlTelemetry.begin()` writes a `lock-pending` JSONL record before input.
4. `Executor` rejects stale decisions, prevents concurrent execution, and issues one paired tap per action.
5. A changed `pieceVersion` triggers a fresh `actualAfter` capture.
6. `PredictionValidator` compares board, clear, attack, spin, pending garbage, combo, B2B, HOLD, and queue.
7. A mismatch retains cell/field evidence and immediately returns `StrategyManager` to conservative mode.

The server-specific outcome is mandatory input to `PredictionBuilder`; there is no hidden default garbage or attack rule. This makes missing knowledge visible instead of embedding it as a strategy assumption.
