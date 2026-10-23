# VALIDATION_PROTOCOL

Do not seriously tune competitive strategy until simulator fidelity is validated.

Per locked piece:
1. capture before state
2. simulate chosen move
3. store predicted after state
4. execute real input
5. wait for pieceVersion change
6. capture actual after state
7. compare predicted vs actual

Compare board, lastClear, lastAttack, lastSpin, pendingGarbage, combo, backToBack, hold, nextQueue progression.

On mismatch: preserve evidence, classify likely cause, switch conservative, do not hide it by tuning evaluator weights.

Suggested mismatch labels: geometry, SRS, collision, path, hard_drop, hold, line_clear, garbage_cancel, garbage_insert, spin, stale_state, input_loss, unknown.

Milestone: collect 100–300 validated locks across empty board, normal stacking, line clears, HOLD, wall rotations, high stack, incoming garbage, downstack, multiplayer.
