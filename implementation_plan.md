# Game mode "Classic" — official rules alongside the current "Modernized" rules

## Context

The app implements a house-ruled Tutto. This plan adds a second ruleset, **Classic**,
implementing the official Abacusspiele rules, and names the current ruleset
**Modernized**. Rules verified against the official rulebooks (2004 Volle-Lotte DE and
2024 EN editions — they agree on everything relevant):
<https://abacusspiele.de/wp-content/uploads/2024/08/Tutto2024_Regel_EN_080524_klein.pdf>

Decisions taken with the user (2026-08-09):

- **Fireworks = official rule.** Tutto during Feuerwerk → forced reroll of all six on
  the same card, never a new card; the null ends the whole TURN with all points
  banked. The app already rolls-until-null and banks (`canStop` excludes Feuerwerk,
  `diceTurnControls.ts:51-53`; bust banks `DiceGame.tsx:185-186`) — classic only adds
  **forced keeping of ALL scoring dice** each roll.
- **Plus/Minus = atomic turn.** Success adds exactly +1000 to the running turn total
  (dice points during that card segment don't count); the player may chain on; if the
  turn later busts, everything is forfeited and the leader deduction never happens —
  deductions apply only when the turn banks.
- **Stats: 4 buckets.** Per ruleset AND per normalized/custom: `normalized`, `custom`
  (existing rows = modernized), `classic`, `classic_custom`. Global stats: one row per
  ruleset, each with full sums/records + its own custom-games counter.
- **Default ruleset: Modernized** (no behavior change for existing players).

### The Classic ruleset (deltas vs current behavior)

1. **Tutto continuation** (the big one): after ANY tutto (bonus, x2, Plus/Minus
   success, completed Straight) the player chooses: **bank** the turn total, or **flip
   the next card** and reroll all six dice. Points accumulate; a later null or a drawn
   Stop card forfeits the ENTIRE turn. Unlimited chain length (2004: "Ansonsten kann
   man so lange weitermachen wie man möchte").
2. **Straight (Kniffel)**: a valid die is ANY number not yet put aside — no
   consecutive/1-asc/6-desc requirement (current impl enforces runs,
   `diceLogic.ts:29-83`). Keep ≥1 valid die per roll, may keep several (≤1 die per
   missing number), no early stop; roll without a missing number = null. Completing =
   +2000 and counts as a tutto → chain choice.
3. **Fireworks**: forced keep-all valid dice (auto-kept, no manual subset). The null
   banks the whole accumulated turn — also when Feuerwerk was drawn mid-chain
   (official: "you score all points you have rolled on this turn"). The turn always
   ends when the fireworks ends; no chaining after it.
4. **x2 in a chain**: doubles the ENTIRE accumulated turn total at its tutto (2004:
   "alle bisher in diesem Durchgang erzielten Punkte verdoppelt").
5. **Bonus in a chain**: adds its bonus to the accumulated total on tutto.
6. **Plus/Minus in a chain**: atomic (above). Multiple successes in one chain each
   queue their own leader deduction; all applied only at bank.
7. **Stop drawn mid-chain**: entire turn forfeited (0).
8. **Kleeblatt drawn mid-chain**: the two-in-a-row tutto counter starts fresh at the
   draw; success = instant win (accumulated points irrelevant); failure = forfeit.
9. **Modernized stays byte-for-byte today's behavior**, incl. subset-keeping on
   Feuerwerk and turn-end after every tutto.

---

## Wave 1 — the `ruleset` config field + lobby selector

New host-owned, synced room config `ruleset: 'modernized' | 'classic'`, default
`'modernized'`. Type name `Ruleset` — `GameMode` is taken twice (`src/types.ts:22`
stats, `src/store/storeTypes.ts:13` local/online).

**Deliberately NOT on `CoreGameState` in this wave** (analog `enforcedDiceMode` lives
on `GameStore` only, `storeTypes.ts:57`). Wave 3 moves it into `CoreGameState` when the
engine needs it — see the `turnTimers.ts` trap there.

Touchpoints (analog: `enforcedDiceMode`, plus two places where ruleset diverges):

- `src/types.ts` — `Ruleset` type + `RULESETS` const + `DEFAULT_RULESET`.
- `src/utils/configValidation.ts` — `isValidRuleset`. `isNormalizedConfig` stays
  blind to ruleset (zero code change — structural `NormalizableConfig`;
  ruleset picks the bucket PAIR, normalized/custom stays winningScore+deck).
- `src/store/storeTypes.ts:32` `ConfigKeys` + `GameStore` field.
- `src/store/configSlice.ts` — `setRuleset` one-liner (pattern `:67`); `updateConfig`
  emit bundle `:50-58`.
- `src/store/persistence.ts` — `validateOnlineConfig` `:147-175` (copy the
  old-save-undefined-rejected comment style from enforcedDiceMode `:162`); saved host
  config subscriber `:227-234`; **divergence from the analog:** ruleset is meaningful
  offline → add to `STABLE_LOCAL_GAME_KEYS` `:21-29` + `LOCAL_GAME_VALIDATORS`
  `:82-110`, else a saved local classic game silently resumes as modernized.
- `src/store/useGameStore.ts` — `createInitialLocalState` `:27-65`; mode-switch reset
  `:188-198`.
- `src/store/socketSlice.ts` — `GAME_STATE_SYNC_KEYS` `:28-36`; pushState bundle
  `:358-376`; lobby config toast `game.toastRuleset` (diff pattern `:74-107`).
- `server/roomTypes.ts` — `RoomState.ruleset` + frozen `Room.ruleset` (precedent
  `normalizedGame` `:76`).
- `server/rooms.ts` — `createRoom` default `:26-66` (`ruleset: 'modernized'`,
  `Room.ruleset` init). `emitRoomState` broadcasts new RoomState fields for free.
- `server/pushValidation.ts` — `HOST_ONLY_FIELDS` `:147-150` + per-field validation;
  `applyValidatedConfig` `:34-42` (covers both `updateConfig` and joinRoom
  `initialConfig` at once).
  **Mid-game gameplay flip must be impossible.** Today `applyPushedState` writes
  HOST_ONLY_FIELDS mid-game with no status gate (winningScore `:278-279`,
  enforcedDiceMode `:388-390`); the normalizedGame downgrade protects only the stats
  label. Do NOT read `state.status` inside the field loop — `status` is applied first
  (Set insertion order) so it already holds the pushed value. Instead compute
  `allowRulesetWrite = startingGame || prePushStatus === 'lobby'` in
  `socketGameStateHandlers.ts` (pre-push status available at `:39-40`) and pass it via
  `applyPushedState`'s options.
- `server/socketGameStateHandlers.ts` — freeze `room.ruleset = room.state.ruleset`
  inside the existing `startingGame` block `:56-60` (also covers Play Again, which
  never returns to lobby).
- `server/socketConfigHandlers.ts` — payload type `:14-25` + lobby-branch destructure
  `:25-29`. Lobby-only behavior comes free (mid-game branch applies turnDuration only).

**Lobby UI**: new `RulesetSelector` segmented control ("Rules: Modernized | Classic")
as a top-level row ABOVE the settings row in both lobbies (`LocalLobby.tsx:94-99`,
`OnlineLobby.tsx:425-449`) — not inside AdvancedOptionsPanel: it changes gameplay
fundamentally and must be visible unexpanded. One-line description of the selected
ruleset beneath. Host-only editable online; guests get an **always-visible** read-only
badge (unlike the conditional `DiceModeEnforcedBadge` `LobbyShared.tsx:212` — ruleset
always has a value), own component + i18n keys in `LobbyShared.tsx`. In-game: small
ruleset badge near the goal line (`Game.tsx:477-481`).

i18n: `lobby.ruleset*`, `game.toastRuleset` (en+de, flat dotted keys).

### Wave 1 tests (mirror each enumeration point)

- `src/utils/configValidation.test.ts` — `isValidRuleset`; extend `:458-466` to pin
  `isNormalizedConfig` blindness to ruleset.
- `src/store/useGameStore.test.ts` — **`:470-478` breaks** (exact `updateConfig`
  payload assertion — add ruleset); add cases to mode-switch reset `:1025-1047`,
  joinRoom initialConfig `:1812-1826`, toast diff `:2250-2299`; local-save round-trip
  via `pickLocalGameState`.
- `server/pushValidation.test.ts` — per-field acceptance (template `:308-318`
  enforcedDiceMode); active-player rejection `:69-79`; `applyValidatedConfig`
  `:627-654`; **mid-game ruleset push rejected, kickoff push accepted**.
- `server/sockets.config.test.ts` — mid-game rejection wire-level (pattern
  `:336-358`); `server/sockets.room.test.ts` — initialConfig carries ruleset
  (`:26-96`). (No Room literals in harnesses — all use `createRoom()`, nothing else
  breaks.)
- `LobbyShared.test.tsx` / `OnlineLobby.test.tsx` / `LocalLobby.test.tsx` — selector
  render, host-only gating, guest badge.

Everything still plays modernized after this wave.

---

## Wave 2 — classic dice logic (pure functions)

The runtime entry points are `checkValidityAndScore` (`DiceGame.tsx:122`), `isBust`
(`DiceGame.tsx:178`) and `getMaxValidSelection` (`DiceGame.tsx:301`) — `checkKniffel`
is only called through `checkValidityAndScore` (`diceLogic.ts:93`). So:

- Add a `ruleset` param (default `'modernized'`) to `isBust`, `checkValidityAndScore`,
  `getMaxValidSelection` in `src/utils/diceLogic.ts`. Internally:
  - `checkKniffelClassic(progress, selection)`: valid = numbers not yet collected,
    ≤1 die per missing number; any invalid die invalidates the selection (matches the
    modernized all-or-nothing style).
  - `isBust` classic-Kniffel branch: bust = every rolled value already collected.
    (The current branch computes a single `nextNeeded` successor — wrong for sets.)
  - `getMaxValidSelection` classic-straight branch: one die per missing number.
- `kniffelProgress` becomes an order-free set under classic. Server validation and
  snapshot parsing already tolerate that (`pushValidation.ts:66,85`,
  `diceTurnState.ts:54-55`) — only diceLogic's three Kniffel branches and
  `sortKeptDiceForDisplay` assume run semantics.
- `sortKeptDiceForDisplay` (`diceTurnControls.ts:69-79`) gains the ruleset: classic →
  always ascending (the current direction heuristic reads `kniffelProgress[0] === 1`
  and would sort descending for a set starting at 3). Both call sites need the wire-up
  later: `DiceGame.tsx:358` and the **spectator** view `GameControls.tsx:237`.
- Classic Feuerwerk forced keep-all, two concrete hooks in DiceGame (wave 3):
  auto-apply `getMaxValidSelection` after `finalizeRoll` (or at roll creation
  `DiceGame.tsx:137-143`) + no-op guard in `toggleDie` `:294-297`. Select-all button
  and `a` shortcut already produce exactly the max selection; `s` is already
  unreachable for Feuerwerk. Verified sound: max selection is never empty on a
  non-bust roll, always passes `checkValidityAndScore` (4-of-a-kind → keeps the
  triplet, rerolls the 4th die).

Tests: new classic describe blocks in `diceLogic.test.ts` (set collection from both
ends, duplicates in one roll, multi-number keeps, bust-on-no-missing-number,
max-selection) and `diceTurnControls.test.ts` (classic sort ascending). Existing
modernized tests stay untouched/green (they exercise the default param).

---

## Wave 3 — the chain engine (digital dice)

### Turn flow

- `DiceGame` gains a `ruleset` prop from `Game.tsx` (it currently reads nothing from
  the store), forwarded to the diceLogic calls (`:122/:178/:301`) and the sort
  (`:358`).
- Chain state in DiceGame: accumulated `turnScore` persists across cards;
  `cardsThisTurn: CardType[]`; `tuttosThisTurn` (reset when Kleeblatt is drawn);
  `plusMinusSuccesses: number`.
- Tutto decision point is `handleAction`'s branch at `DiceGame.tsx:247-272` — for
  classic non-Feuerwerk/non-Kleeblatt tuttos, instead of jumping to the summary,
  show the choice: **"Bank N points"** vs **"Draw next card"**. Kniffel completion
  flows through the same branch, so one insertion covers it. **Idle behavior: keep
  `useAutoContinueCountdown` running with Bank as the timeout default** — consistent
  with the auto-continue and server-timer philosophy (AFK protection).
- Card-segment semantics per the deltas: bonus adds; x2 doubles the accumulated
  total; Plus/Minus success sets segment contribution to exactly +1000 and increments
  `plusMinusSuccesses`; classic adds Kniffel's +2000 and Plus/Minus's +1000
  **client-side** (modernized keeps them engine-side, test-pinned
  `DiceGame.test.tsx:530`).
- New store action `drawCardMidTurn()` (active player): pops the deck — reshuffle rule
  copied from `coreGameEngine.ts:332` (`if empty → buildDeck(initialCards)`) — sets
  `currentCard`, re-stamps the localStorage snapshot immediately (no stale-key
  window), calls `get().syncOnlineTimers()` after its `set()` (same as `nextTurn`,
  `gameSlice.ts:266`), and pushes state. Server side already works: active player may
  push `currentCard`+`cards` (`pushValidation.ts:152-153`); server restarts the turn
  timer on `cardChanged` with the new card's multiplier
  (`socketGameStateHandlers.ts:70-78`); client countdown resets via the existing
  `cardChanged` check (`timers.ts:78-96`). **No local-timer work: local games have no
  turn countdown** (`startLocalTimers` ticks the game clock only, `timers.ts:31-39`).
- Stop drawn mid-chain → forfeit summary in DiceGame, `onComplete(0, false)`.
- Keyboard: extend `primaryAction` (`Game.tsx:357-374`) and DiceGame shortcuts with a
  chain-choice branch (Space/Enter = Bank, `d` = draw or similar) so the old mapping
  can't commit the turn while the choice is pending.

### Turn commit (engine)

Additive optional param — **not** a signature replacement — so ~60 pinned 3-arg engine
calls, ~35 store/component call sites and the server timeout path compile unchanged:

- `nextTurn(score, isSuccess, turnSummary?)` (`storeTypes.ts:116`, `gameSlice.ts:210`)
  and `calculateNextTurn(state, score, isSuccess, turnSummary?)`.
- `TurnSummary = { cards: CardType[], outcomes: per-card success/fail,
  tuttoCount, plusMinusSuccesses, forfeited: boolean, forfeitedScore?: number }`.
- Classic branch consumes it: applies N leader deductions at bank only, increments
  per-card counters (e.g. `timesKniffelCompleted` per straight in the chain), builds
  ONE history entry carrying the card list, skips engine per-card scoring (score is
  final client-side). Absent summary (legacy call) = modernized semantics; the server
  timeout call `calculateNextTurn(state, 0, false)` (`turnTimers.ts:56-60`) therefore
  forfeits correctly. Accepted degraded behavior: the timeout path increments
  received/skip counters for the current card only — the rule is **per-card counters
  increment at commit from the summary**; a timed-out chain loses the earlier cards'
  received counts.
- `CoreGameState` gains `ruleset` in THIS wave. **Trap:** `server/turnTimers.ts:33-52`
  hand-copies fields into `stateForCalc` behind an `as` cast — tsc will NOT flag the
  omission; add `ruleset: room.state.ruleset` there explicitly or the timeout path
  silently runs modernized.

### Undo

`calculateUndo` is incompatible with chains as-is (single `previousCard` branching
`coreGameEngine.ts:385-424`, success inferred via score equality `:408/:415`,
single-card deck restore `:436-437`, single deduction event `:397-405`). Changes:

- New `previousTurnSummary` (cards consumed in order, per-card outcomes, deduction
  events) in the previous* state. Full plumbing like every previous* field:
  `CoreGameState` (`types.ts:112-137`), `NextTurnResult` (`types.ts:182-199`),
  gameSlice set/reset blocks (`gameSlice.ts:151-158, 195-200, 222-229, 287-294`),
  `GAME_STATE_SYNC_KEYS`, `ACTIVE_PLAYER_FIELDS` + validation, `STABLE_LOCAL_GAME_KEYS`
  + `LOCAL_GAME_VALIDATORS`, `turnTimers.ts` stateForCalc.
- Classic undo consumes it: restore ALL consumed cards to the deck front (in order),
  reverse per-card counters from the summary (not from previousCard/score equality),
  reverse N deductions.
- **Chained-Stop turns become undoable.** Decision: the Stop guard (three layers:
  `coreGameEngine.ts:359`, `gameSlice.ts:272`, `Game.tsx:377`) keys on history type
  `'skip'` (nothing happened) instead of `previousCard === 'Stop'`. A chain ending on
  a drawn Stop commits as a forfeit (type `'bust'`, cards list incl. Stop) and can be
  undone like any bust; a modernized/first-card Stop stays type `'skip'` and stays
  un-undoable. Kleeblatt-win un-undoability unchanged.

### Sync/snapshot/history — the server strips unknown fields (three mirrors)

- **Dice snapshot**: extend `isValidDiceSnapshot` `pushValidation.ts:78-92` +
  `sanitizeDiceSnapshot` `:98-109` with the chain fields (`cardsThisTurn` bounded by
  VALID_CARD_TYPES + length cap, `plusMinusSuccesses` bounded int), else the active
  player's own mid-chain reconnect loses the chain (restore path rebuilds from
  server-echoed liveTurnState, `Game.tsx:237-243`). Mirror in `parseSavedDiceState`
  (`diceTurnState.ts:68-85`) per its own sync comment. Update fixtures
  `pushValidation.test.ts:686-751`.
- **History entry**: `HistoryEntry` gains optional `cards: CardType[]` (precedent:
  `deductedPlayers`); extend `isValidHistoryEntry` `:111-129` (VALID_CARD_TYPES,
  length cap) + `sanitizeHistoryEntry` `:131-143`, else guests see chain-less history.
  `HistoryLog.tsx` `getLogMessage` renders the chain (e.g. "300 → x2 → Straße ✓").
- **Turn key**: `buildTurnKey` (`diceTurnState.ts:19-24`) currently includes
  `currentCard` — a mid-turn draw would evict the pre-draw snapshot (~300ms debounce
  window) and a lobby ruleset flip could restore a classic snapshot into a modernized
  game. Change: include `ruleset`, and key chain-capable turns on the chain's FIRST
  card (or drop the card component). Call sites: `gameSlice.ts:120`,
  `Game.tsx:241/264/503`, DiceGame tests passing turnKey.

### Spectators

Snapshot `turnScore` = **accumulated turn total** (that's the headline number
spectators see, `GameControls.tsx:225-280`); add a small "card N of the chain"
indicator there; thread ruleset into the spectator `sortKeptDiceForDisplay` call
(`GameControls.tsx:237`). Chain card itself reaches spectators via store
`currentCard` → `CardDisplay` already.

### Accepted risk (pre-existing, worsened marginally)

Host-race on pushState: if the server timeout fires while a HOST's `drawCardMidTurn`
push is in flight, the stale host push can overwrite the server's advance
(authorization is isHost || isActivePlayer, `socketGameStateHandlers.ts:26-31`). This
race exists today at every turn boundary; chains add one racing push per draw. Accepted
for now — noted here; a turn-epoch guard is a possible follow-up.

### Wave 3 tests

- `coreGameEngine.test.ts`: chain commits (multi-card summary → counters, N
  deductions at bank, forfeit voids deductions, history entry with cards), undo of
  chained turns (deck restore of N cards, counter reversal, N-deduction reversal,
  chained-Stop undoable, plain-Stop still not).
- `DiceGame.test.tsx` (rollQueue pattern `:20-35`): classic tutto → choice UI; bank;
  draw-next-card continues with accumulated score; x2 doubles accumulated; Plus/Minus
  atomic segment; Stop mid-chain forfeit; Kleeblatt mid-chain counter reset; classic
  Feuerwerk auto-keep + null banks accumulated total; countdown banks by default.
- `useGameStore.test.ts`: `drawCardMidTurn` (deck pop, reshuffle-when-empty, push,
  timer resync); snapshot round-trip with chain fields.
- `server/pushValidation.test.ts`: new snapshot/history fields validated/sanitized;
  `sockets.*` test for a mid-chain draw push restarting the timer.
- `server/turnTimers.test.ts`: timeout mid-chain forfeits, no double draw.

---

## Wave 4 — physical dice chains

The current physical UI is card-driven and turn-terminal: score input renders only
when `hasScoreInput(currentCard)` (`GameControls.tsx:118`), special cards are yes/no
only (`GameControls.tsx:168-190`) and `handleYesNo` → `nextTurn(0, isSuccess)`
(`Game.tsx:339-341`) — so a chain ending on a special card would have **nowhere to
enter the accumulated total**. Classic physical therefore decouples entry from the
current card:

- Mid-chain special-card yes/no answers go to a NEW non-committing handler that
  records the segment outcome, then shows the bank/draw choice. Only Kleeblatt keeps
  the committing path (success = instant win, failure = forfeit — genuinely terminal).
- The turn commits only from an always-available "bank: enter final total" step (or
  forfeit). Success stays derived from the entered total (`parsedScore > 0`,
  `Game.tsx:334`); the committing call passes the same `TurnSummary` as digital.
- "Draw next card" button in GameControls, threaded from `Game.tsx` as a prop
  (GameControls has no store access, props at `GameControls.tsx:13-33`).
- **Hide the "Apply bonus" checkbox for classic** (`GameControls.tsx:133-140`,
  `Game.tsx:330-337`): it applies `applyTuttoBonus` keyed to the card showing at entry
  time — wrong mid-chain (classic x2 doubles the whole accumulated total). The player
  enters the fully-computed total; modernized keeps the checkbox.
- Stop mid-chain: reuse the existing Stop flow (auto online / Continue button locally,
  both already forfeit) — no new path.
- Extend `primaryAction` (`Game.tsx:357-369`) with the chain-state branch so
  Space/Enter can't commit mid-chain.

Tests: `Game.test.tsx` physical blocks (pattern `:384-505`) — chain across
bonus→x2→special card, final total entry, apply-bonus hidden for classic, Plus/Minus
segment recorded without commit; `GameControls.test.tsx` render surfaces.

---

## Wave 5 — statistics

### New stat fields (all three requested by the user, "most consecutive cards" etc.)

| Field | Kind | Wiring |
|---|---|---|
| `totalTuttos` | counter | `ZEROED_PLAYER_STATS` (`playerStats.ts:17-35`) → flows into `PLAYER_STAT_FIELDS` and, via the spread at `pushValidation.ts:197`, into `PLAYER_MUTABLE` automatically. Required `Player` field. |
| `mostCardsInTurn` | MAX record, nullable | **NOT** zero-started: optional `Player` field next to `highestTurnScore` (`types.ts:91-93`) + explicit `PLAYER_MUTABLE` entry (`pushValidation.ts:206`). |
| `highestForfeitedTurnScore` | MAX record, nullable, classic-only | Same shape as `mostCardsInTurn`; biggest accumulated turn lost to a null/Stop after choosing to continue. |

Data sources: `tuttosThisTurn` already rides the snapshot (`types.ts:46`); chain
length + forfeit size come from the wave-3 `TurnSummary` in `calculateNextTurn`.

**Both payload builders** must carry the new fields (each is a literal key list):
`sendOnlineStats` (`socketSlice.ts:387-408`) and `buildGlobalStatsPayload`
(`coreGameEngine.ts:116-195`) + `GlobalStatsPayload` (`types.ts:151-180`). For the
classic-only record, **omit the key from modernized-game payloads** (don't send
`|| 0` — `updateDeviceStats` stamps incoming values on row insert, `database.ts:154-158`,
and would freeze a 0 where NULL/— is meant; `nullSafeExtreme` handles null fine).
`sanitizeStats` needs nothing (no allowlist — passes any finite value).

DB: one additive migration — counters `defaultTo(0)`, records nullable no-default
(convention `20260809000000:11-22`); extend `deviceCols :105-112`,
`deviceExtremeCols :145-153`, `globalMapping :246-270`, `globalExtremeCols :277-285`,
row interfaces (`database.ts:44-78, 172-203`).

### Bucketing (4 device buckets)

- `GameMode` extends to `'normalized' | 'custom' | 'classic' | 'classic_custom'`
  (`types.ts:22-24`). **No device-table migration** (mode is TEXT, no CHECK, PK
  already `(deviceId, mode)` — verified `20260809000000:41-44`).
- Server decides: `socketStatsHandlers.ts:81` becomes a map over
  `(room.ruleset, room.normalizedGame)`; `submitGlobalStats` `:48` injects the frozen
  ruleset alongside `isDefaultGame`.
- Choke points that silently swallow unknown modes — **extend in the same commit as
  the server mapping**: `requestedMode` (`api.ts:83-84`, coerces unknown →
  normalized!), `deviceStatsUrl` typing (`statsApi.ts:10`), `MODE_TABS`
  (`Statistics.tsx:102-105`), `DeviceStatsRow.mode` (`database.ts:46`).
- `gameModeOf` (`statsApi.ts:16-17`) gains the ruleset input and returns the 4-value
  mode. Client fixes that otherwise fetch the wrong bucket for classic games:
  `EndScreen.tsx:98` (`isCustomGame` → is-custom-bucket predicate covering
  `classic_custom`), `Game.tsx:196` (pre-game snapshot gate must admit `classic`),
  `Game.tsx:201` (**currently omits the mode arg entirely** — pass `modeAtStart`).
  Otherwise EndScreen celebrates records against the wrong bucket and its retry loop
  (`:146-148`) burns all 5 retries.

### Global stats per ruleset

Rebuild `global_statistics` keyed by ruleset (2 rows), each with full sums/records +
`defaultGamesPlayed`/`customGamesPlayed`. Transactional table swap with explicit
column lists (precedent `20260809000000:37-61`); existing row → `'modernized'`;
**the migration must SEED the classic row too** — `updateGlobalStats` never inserts
and hard-fails on 0 rows (`database.ts:236-238, 293-294`); ensure-row precedent
`20260625000000`. Update `getGlobalStats` (`database.ts:205-213`), `updateGlobalStats`
`where` sites (`:207, :236, :293`), API routes (`api.ts:119-137`, GET gains a mode
param), `submitGlobalStats`, `Statistics.tsx:325` fetch. `database.test.ts:355-363`
(direct `where({id:1})` fixture) must be rewritten.

### Win streak

`joinRoom`'s streak fetch is deliberately hoisted BEFORE any room read
(`socketRoomHandlers.ts:168-185` documents the two races) and the room may not even
exist yet — so: **fetch both rulesets' streaks in the one hoisted await**
(`getDeviceStats(deviceId,'normalized')` + `(…, 'classic')`), store both on
`ServerPlayer` (`winStreak`, `winStreakClassic`), and let the client badge pick by
the currently synced ruleset (lobby flips then cost zero server work). Extend the
post-game refresh (`socketStatsHandlers.ts:92-96`) to refresh the matching non-custom
bucket (`normalized` OR `classic`) and field.

### Statistics UI

- Second segmented control "Modernized | Classic" next to the existing Normal|Custom
  tabs (`Statistics.tsx:102-105, 308, 420-437`) — 4 combos; same for the global tab.
- Classic personal view: hide the per-card attribution tiles that are ill-defined
  across chains — `highestFeuerwerkTurnScore`, `highestX2TurnScore`, `feuerwerkBusts`,
  `x2Busts`, `feuerwerkPointsScored`, `x2PointsScored` (columns stay; classic games
  don't populate them). Show the new tiles (most cards in a turn, total tuttos,
  biggest forfeited turn). Card-received counters stay (well-defined per draw).
- EndScreen per-game table gains chain columns where cheap (cards drawn).

### Wave 5 tests

- `database.test.ts`: 4-bucket independence; global two-row seeding; classic row
  updates don't touch modernized row; new-column null-safety.
- Migration test (pattern `deviceModeMigration.test.ts`): old global row survives as
  modernized; classic row seeded with defaults.
- **Real-server test** (à la `sockets.stats.test.ts:136-203`): a classic custom game
  lands in `classic_custom`, the global CLASSIC row moves (assert content, not just
  200 — `api.ts` coerces unknown modes silently); a classic default game refreshes
  `winStreakClassic` only.
- `Statistics.test.tsx` / `EndScreen.test.tsx` / `Game.test.tsx`: ruleset tabs fetch
  the right `?mode=`, classic tile set, record celebration diffs against the classic
  bucket, pre-game snapshot uses `modeAtStart`.

---

## Wave 6 — help, docs, polish

- **HelpPopup** (store access exists, `HelpPopup.tsx:77-78`): new "Game Modes"
  section (ToC pill `:116-124` + `<Section>` pattern `:222-246`); per-mode card texts
  via **literal keys picked by ternary** — never `` t(`…${ruleset}`) ``: the
  used-key scan regex (`translations.test.ts:32`) captures template literals verbatim
  and fails. Parity = `i18n.test.ts:42-50`; existence = `translations.test.ts`; keys
  stay flat.
- Strings to update beyond the card texts (en+de): `help.cards.fireworksDesc` — the
  auto-keep claim is FALSE for modernized today (`en:299`; move auto-keep wording to
  the classic variant); `help.faq.q5/a5` (`en:348-349` — "No. Your turn consists of
  exactly one card draw" contradicts classic); `help.faq.a1` (`en:341`);
  `help.statistics.s7` (`en:338` — describe 4 buckets); `statistics.customGamesExplainer`
  (`en:219`); `statistics.globalDescription` (`en:256`). README needs the
  Modernized/Classic rules subsections + 4-bucket stats note (its Feuerwerk line
  `README.md:40` is fine as-is).
- In-game ruleset badge styling; `help.general.step4a/4b` turn-flow steps per mode.
- **Version bump 1.4.0** per repo convention: `package.json`, `package-lock.json`,
  `server/package.json`, `server/package-lock.json` move together; changelog prose in
  the release commit message; `appVersion.test.ts:8-18` pins the Help footer.

---

## Verification

- `npm test` (vitest) green before every commit; `npm run build` + tsc clean per wave.
- Wave 3 is the risk center: engine chain/undo unit tests + DiceGame component chain
  tests + server snapshot/history sanitization tests before wiring UI polish.
- Wave 5: the real-server + in-memory-DB socket test proves the full classic path
  (frozen ruleset → 4-bucket mode → device row + global classic row + streak field).
- e2e: extend `e2e/lobby.spec.js` minimally (selector visible, badge for guest);
  `e2e/wiki.spec.js` tolerates the new ToC pill (verified — it asserts layout only).
- Manual smoke via `npm run dev`: one classic online game with a chain, a mid-chain
  reconnect, and an undo of a chained turn.

## Accepted risks / explicitly out of scope

- Host-race on pushState vs server timeout (pre-existing; chains add one racing push
  per draw). Possible follow-up: turn-epoch guard.
- Timed-out chains under-count per-card received counters (counters commit from the
  summary; the timeout path knows only the current card).
- A patched host client can still fake games (documented pre-existing limitation).
- No AI/bot play, no per-mode deck presets, no migration of historic stats into the
  classic buckets (they start empty).
