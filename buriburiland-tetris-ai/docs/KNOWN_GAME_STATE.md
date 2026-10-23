# KNOWN_GAME_STATE

Observed player keys:
next, sequenceIndex, clearEventId, lockDeadlineAt, pendingGarbage, lockTouchedGround, lockResetCount, hold, canHold, score, current, nextQueue, nickname, lastAttack, lines, actionSequence, playerId, eliminated, backToBack, lastClear, combo, pieceVersion, lastMoveWasRotation, lastRotation, lastSpin, board

current example:
{ rotation: 0, x: 3, y: 0, type: "I" }

nextQueue example:
["J","L","O","Z","T","J","Z","L","S","I"]

board = 20 rows × 10 columns

React path pattern:
tetrisState.players.<UUID>

Never hard-code the UUID.
