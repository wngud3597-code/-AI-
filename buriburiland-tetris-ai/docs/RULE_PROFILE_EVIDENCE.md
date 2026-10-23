# BuriburiLand rule and DOM evidence

Checked on 2026-10-23 (Asia/Seoul). This investigation fetched public HTML and
JavaScript only. It did not authenticate, join a running room, create a room,
send game inputs, or produce a live-play recording.

## Sources and evidence levels

- Official guide: <https://buriburiland.com/games/tetris>.
- Public room route module:
  <https://buriburiland.com/_next/static/chunks/app/room/%5Bid%5D/page-f134eacc6884b8d9.js>.
  It maps the Tetris view to dynamic chunk 847.
- Public webpack runtime:
  <https://buriburiland.com/_next/static/chunks/webpack-79a18ac7e6a7d6ac.js>.
- Tetris view, input handler, and client prediction implementation:
  <https://buriburiland.com/_next/static/chunks/847.a5a05f14ceb3f87d.js>.
  SHA256: `223960D0C6DD0E4E5F3E8C421B12FF9DB504CF0EF0FD4E248E873D50C4DF6538`.
- Public room CSS:
  <https://buriburiland.com/_next/static/css/1bf0cd6429de0eaa.css>.
  SHA256: `E0EBB34A0576730AF00D6AD2D4FF2B702DB7ABABDFAF30F217FEF7C760DB86D4`.

The JS and room CSS are cached outside the repository in
`../.cache/buriburiland-public-2026-10-23/`. Tetris-specific CSS is embedded in
chunk 847; the external room CSS is supporting page CSS.

`documented` means the guide explicitly describes the behavior.
`client-source` means the current public frontend implements it. This is useful
evidence for matching displayed geometry and locally processed inputs, but is
not proof of matching server adjudication. `live` requires a captured normal
game transition. The screenshot and prompt supplied by the user are prior
observations; this investigation adds no live observations.

## Documented behavior

The guide describes a 10 by 20 board, five visible NEXT pieces, HOLD, SRS,
clockwise X/ArrowUp, counterclockwise Z, 180-degree A, HOLD C, and hard drop
Space. It describes one-player scoring and two-to-six-player survival, a common
piece sequence in multiplayer, immediate browser response, and server
resynchronization. For T/I/J/L/S/Z spins clearing one through four rows, it
documents attack amounts 2/4/6/8. It does not fully specify spin recognition,
combo, B2B, cancellation, insertion order, or random garbage holes.

## DOM ownership and structure

The main rendered board is the local board only when the view is not
spectating. There is no `mine` class, player ID attribute, or authoritative
revision attribute in the inspected board markup. A spectator sees the selected
other player's board in the same main position. `.is-solo-view` means there are
no other boards in the layout; it does not prove local ownership.

```text
main.tetris-root
  header.tetris-header
    .tetris-status
    .tetris-spectator-switch (spectator and at least 2 players only)
  section.tetris-stage
    aside.tetris-left-panel
      button.tetris-hold-card
        .tetris-next.tetris-hold-preview OR strong EMPTY
      .tetris-metrics
        .tetris-garbage-gauge (own player; multiplayer only)
        .tetris-mobile-opponent-slot (four or five opponents)
          .tetris-opponent
            .tetris-opponent-details
              .tetris-garbage-gauge.is-compact (opponent)
    section.tetris-board-panel
      .tetris-board-wrap
        .tetris-playfield.tetris-board.has-spawn-area
          .tetris-spawn-area (20 decorative i elements, 10 by 2)
          .tetris-visible-board
            .tetris-grid (200 cells, row-major, fixed board only)
            .tetris-piece-layer.is-ghost (optional)
            .tetris-piece-layer:not(.is-ghost) (optional)
      .tetris-pause-overlay (when paused)
    aside.tetris-right-panel
      .tetris-next-list
        .tetris-next.tetris-queue-preview (up to 5)
    .tetris-mobile-controls
    aside.tetris-opponents (optional, boards use .tetris-mini)
```

Resolve exactly one `.tetris-root` and one direct `.tetris-stage`, then read all
board/HOLD/NEXT elements inside that same stage synchronously. Exclude
`.tetris-mini` and scope the 200 cells to `.tetris-grid`; active cells also have
the `.tetris-cell` class. Opponent copies occur in desktop and mobile slots.

Source symbols: main component `I`, board component `W`, grid component `O`,
active/ghost component `D`, preview component `B`, cell component `Y`, and
garbage display `G`.

The status text provides an additional guard:

| View state | `.tetris-status` text |
| --- | --- |
| Spectating | selected nickname followed by `관전 중` |
| Playing own board | `속도 LV.` followed by a number |
| Paused | `일시정지` |
| Game over | `게임 종료` |
| Waiting | `대기 중` |

The spectator switch is absent for a one-player spectator. Do not rely on it
alone. The local frontend accepts inputs only when not spectating, the local
player exists in game state, phase is PLAYING, the game is not paused, the
player is not eliminated, and the socket is connected. Mobile action buttons
also require a currently valid displayed piece. HOLD disabled combines this
general permission with canHold, so it cannot independently identify canHold.

## Piece geometry and coordinate conversion

Source symbols: `_` shape table, `K` shape lookup, `en` frame offsets, `ee`
rotation, `ei` spawn, `eo` collision, `er` hard drop, and `ea` lock/clear.

Each shape matrix is trimmed so occupied minimum x and y are zero. Piece x/y
are the matrix bounding-box origin in visible-grid coordinates. x grows right,
y grows down. They are not directly SRS fixed-frame pivot coordinates.
The renderer translates a board-sized layer by `(x * 10%, y * 5%)`; each
occupied child uses `(column * 10%, row * 5%)`. Thus recovering occupied
absolute grid cells requires both the layer translation and child offsets.

Below, `/` separates matrix rows, `1` denotes an occupied cell, and `0` an empty
cell. Rotation order is 0/1/2/3; O has one orientation.

| Piece | 0 | 1 | 2 | 3 |
| --- | --- | --- | --- | --- |
| I | `1111` | `1/1/1/1` | `1111` | `1/1/1/1` |
| O | `11/11` | same | same | same |
| T | `010/111` | `10/11/10` | `111/010` | `01/11/01` |
| S | `011/110` | `10/11/01` | `011/110` | `10/11/01` |
| Z | `110/011` | `01/11/10` | `110/011` | `01/11/10` |
| J | `100/111` | `11/10/10` | `111/001` | `01/01/11` |
| L | `001/111` | `10/10/11` | `111/100` | `11/01/01` |

The current DOM exposes `data-piece-type` but no rotation attribute. I/S/Z
orientations 0 and 2, and 1 and 3, have identical local geometry. Their SRS
frame offsets differ. A shape match must preserve ambiguity unless observed
input history resolves it; arbitrary orientation assignment cannot establish
spin or subsequent kick fidelity.

For converting a fixed SRS frame to the trimmed bbox frame, add the following
orientation-specific offsets to the fixed frame origin. To convert a bbox
observation to fixed-frame coordinates, subtract them.

| Type | offset 0 | offset 1 | offset 2 | offset 3 |
| --- | --- | --- | --- | --- |
| I | `(0,1)` | `(2,0)` | `(0,2)` | `(1,0)` |
| J/L/S/T/Z | `(0,0)` | `(1,0)` | `(0,1)` | `(0,0)` |
| O | `(0,0)` | same | same | same |

The source rotation tests bbox candidates in order:
`oldBbox + kick + offset[to] - offset[from]`. CW adds one, CCW subtracts one,
and 180 adds two modulo four. O returns the same piece without a rotation.

The frontend 180 kick sequence, before that offset correction, is:
`(0,0), (0,-1), (1,0), (-1,0), (2,0), (-2,0), (0,1)`.
This is a separate rotation rule, not two CW rotations.

For reference, the frontend quarter-turn kicks use downward-positive y:

| Transition | J/L/S/T/Z candidates | I candidates |
| --- | --- | --- |
| 0→1 | `(0,0),(-1,0),(-1,-1),(0,2),(-1,2)` | `(0,0),(-2,0),(1,0),(-2,1),(1,-2)` |
| 1→0 | `(0,0),(1,0),(1,1),(0,-2),(1,-2)` | `(0,0),(2,0),(-1,0),(2,-1),(-1,2)` |
| 1→2 | `(0,0),(1,0),(1,1),(0,-2),(1,-2)` | `(0,0),(-1,0),(2,0),(-1,-2),(2,1)` |
| 2→1 | `(0,0),(-1,0),(-1,-1),(0,2),(-1,2)` | `(0,0),(1,0),(-2,0),(1,2),(-2,-1)` |
| 2→3 | `(0,0),(1,0),(1,-1),(0,2),(1,2)` | `(0,0),(2,0),(-1,0),(2,-1),(-1,2)` |
| 3→2 | `(0,0),(-1,0),(-1,1),(0,-2),(-1,-2)` | `(0,0),(-2,0),(1,0),(-2,1),(1,-2)` |
| 3→0 | `(0,0),(-1,0),(-1,1),(0,-2),(-1,-2)` | `(0,0),(1,0),(-2,0),(1,2),(-2,-1)` |
| 0→3 | `(0,0),(1,0),(1,-1),(0,2),(1,2)` | `(0,0),(-1,0),(2,0),(-1,-2),(2,1)` |

Client spawn starts at bbox `(3,0,rotation 0)`, then tries y=-1 and y=-2 in
that order if collision requires it. Collision rejects occupied x outside
0..9 and occupied y>=20; occupied y<0 is allowed in the client collision
function. Lock rejects a piece with any occupied cell above y=0. The board
array itself remains 20 by 10. Decorative spawn rows do not establish a
22-row logical board. Hard drop increments y until the next step collides.
Lock writes cells and removes full rows, adding empty rows at the top.

## Preview color evidence

HOLD and NEXT previews do not have a piece-type data attribute. NEXT uses a
4 by 4 padded matrix; HOLD uses the compact bounding box. Validate the four
occupied cells, shape and color rather than inferring an unreadable preview
as an empty slot.

| Piece/cell | `--cell-color` |
| --- | --- |
| I | `#22d3ee` |
| O | `#facc15` |
| T | `#a78bfa` |
| S | `#84cc16` |
| Z | `#fb7185` |
| J | `#60a5fa` |
| L | `#fb923c` |
| Garbage | `#64748b` |

## Input processing and timing

The game registers one keydown and one keyup listener on `window`. Send each
normal keydown/keyup pair through one event target; do not dispatch the same
action separately to both document and window. The source does not test
`isTrusted`, but synthetic event processing has not been tested in an actual
installed userscript during this investigation.

`es(key, code)` maps physical KeyC/KeyX/KeyZ/KeyA/Space first. Its key fallback
supports ArrowLeft, ArrowRight, ArrowDown, ArrowUp, x/X, z/Z, a/A, c/C and a
space character. Input, textarea and contenteditable targets are ignored.
The listener ignores repeated keydown events. Rotation actions additionally
use a pressed set until keyup and a shared minimum 30 ms interval between
accepted rotation keydowns. An executor should allow at least 35 ms between
rotation attempts and verify the resulting displayed pose.

Movement/soft drop maintain another held set and start frontend repeat timers.
Left/right repeat intervals are 110/90/70/40 ms, then 40 ms; soft-drop repeat
uses 45 ms. Prompt keyup avoids unintended repetitions. Holding a lateral key
while rotating I adds an extra frontend restriction against certain large
opposite displacements. Releasing movement before rotation avoids that path.

Window blur and document becoming hidden clear held actions. These frontend
handlers do not replace userscript generation cancellation and key release.

Frontend lock timing (`f`, `h`, `b`) starts a 500 ms deadline when first
grounded and allows at most 15 requested grounded movement/rotation resets.
The gravity interval is based on speed level and elapsed game time. These are
client-source findings; server timing, clock boundaries and network latency
still require separate evidence.

HOLD predicts replacement at spawn orientation, disables hold until a lock,
consumes NEXT only when HOLD is empty, and swaps the current type into HOLD.
Both HOLD and lock advance the frontend piece version, so a version change
alone cannot identify a successful placement. Same-type swaps are possible.

## Display prediction, garbage, and remaining unknowns

The frontend predicts board/current/HOLD/NEXT immediately after hard drop and
HOLD, before the server response. Rendering a new `.tetris-grid` therefore
does not prove an authoritative lock. DOM comparison must be described as
display-level validation. The source has explicit lock-result, rejected-input,
piece-position and room-state resynchronization handling. Those identifiers
are not exposed by the inspected DOM.

The multiplayer pending-garbage display includes a meter with
`aria-label="받은 공격 N줄"`. `aria-valuenow` is capped at 8, so it cannot be
used as the full pending count. Read and validate the full label/header count.
The gauge is absent in solo mode; absence is not evidence that pending is zero.

Unknown without additional source or live fixtures:

- Server collision, rotation, spawn, top-out and timing parity with the public
  client. No server implementation was fetched.
- Authoritative snapshot boundary and revision available to a DOM-only
  adapter; local fingerprints do not create server identity.
- Exact all-spin recognition, mini/full handling, last-rotation/kick rules,
  scoring, combo/B2B/perfect-clear bonuses and attack rounding/order.
- Garbage cancellation, insertion deadline/cap/order, hole distribution and
  target-selection rules. A meter change is not a complete event history.
- Userscript Worker CSP compatibility and actual synthetic input acceptance.
- Live single-step parity, sustained-play reliability, placement latency,
  PPS/APM/APP, and competitive strength.

Keep unsupported fields unknown and disable claims depending on them. Run
offline source-derived geometry checks separately from captured real-game
fixtures; do not label one as the other.
