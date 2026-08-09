# Normalized vs. custom games in the statistics

## Why

Right now a game played to 1000 points with a one-card deck writes into exactly the
same counters as a normal game: the same personal averages, the same global totals,
and — worst — the same *records* (`highestTurnScore`, `fastestWinTurns`,
`longestGameRounds`). A tweaked deck can hand someone a global record in two turns.

The only existing distinction is `isDefaultGame`, computed client-side in
[`gameSlice.ts`](src/store/gameSlice.ts) and used by
[`updateGlobalStats`](server/database.ts) to bump either `defaultGamesPlayed` or
`customGamesPlayed`. Neither column is displayed anywhere. Everything else is merged.

## The rule

A game is **normalized** when it is played on the default deck for the default
winning score:

| setting | changing it… |
| --- | --- |
| `winningScore` | → custom |
| `initialCards` (deck) | → custom |
| `turnDuration` (turn timer) | stays normalized |
| `reconnectTimeout` (kick timer) | stays normalized |
| `randomOrder` | stays normalized |
| `enforcedDiceMode` | stays normalized |

The exempt four change pacing or input, not the rules, the deck or the win
condition — nothing that makes a score easier to reach.

Note this is *exactly* today's `isDefaultGame` expression. Nothing about the
detection changes; what changes is who evaluates it, when, and what it gates.

Decisions taken (2026-08-09):

- **Global, custom game** → bump `global_statistics.customGamesPlayed` by 1 and
  touch nothing else. Keeps "how many custom games get played" visible without
  polluting a single total, average or record.
- **Personal, custom game** → recorded in full, in a separate bucket, behind a
  switch in the personal statistics tab.
- **Existing stored history** → becomes the *normalized* bucket. Custom buckets
  start empty. Nobody's numbers visibly change.

Local (offline) games still record nothing at all — unchanged, by design.

---

## Wave 1 — name the config that makes a game normalized

**`src/utils/configValidation.ts`** — one shared predicate, so client and server
can never disagree about what "normalized" means:

```ts
export interface NormalizableConfig {
  winningScore: number;
  initialCards: InitialCards;
}

/**
 * Whether a game counts toward the statistics. Deliberately blind to
 * turnDuration, reconnectTimeout, randomOrder and enforcedDiceMode: those
 * change how a game is paced and played, not what it takes to win it.
 */
export const isNormalizedConfig = (config: NormalizableConfig): boolean =>
  config.winningScore === DEFAULT_WINNING_SCORE &&
  areInitialCardsEqual(config.initialCards, DEFAULT_INITIAL_CARDS);
```

**`src/store/gameSlice.ts`** — `buildGlobalStatsPayload` calls it instead of
inlining the comparison. No behaviour change.

**Type** — `export type GameMode = 'normalized' | 'custom';` in `src/types.ts`,
plus `const GAME_MODES` for validation. Used as a DB column value and a query
parameter, so it needs one home.

### Tests
- default config → `true`.
- non-default `winningScore` → `false`; each single-card deviation in the deck →
  `false`; a deck with the same counts in a different key order → still `true`
  (`areInitialCardsEqual` already covers key order — keep a case here so the two
  can't drift).
- each of `turnDuration` / `reconnectTimeout` / `randomOrder` /
  `enforcedDiceMode` changed alone → still `true`.
- existing `useGameStore.test.ts` "default vs custom game detection" block keeps
  passing untouched.

---

## Wave 2 — decide the mode on the server, at kickoff

The client's `isDefaultGame` cannot be trusted once it gates real stats, and
evaluating it at *submission* time is not enough either: `applyPushedState`
lets the host rewrite `winningScore` and `initialCards` at any time
([`pushValidation.ts:278-287`](server/pushValidation.ts:278)). A host could play
to 1000, win in two turns, push `6000` back, and then submit. So the mode is
frozen when the game starts.

**`server/roomTypes.ts`** — `Room` gains `normalizedGame: boolean`.

**`server/rooms.ts`** — `createRoom` initialises it (default config → `true`).

**`server/socketGameStateHandlers.ts`** — the evaluation must run **after**
`applyPushedState`, not inside the existing `startingGame` block (which sits
*before* it, line 40): the opening push itself carries `winningScore` and
`initialCards`, so reading `room.state` pre-push would freeze the *lobby's*
config — a host could keep the lobby default and smuggle the custom config in
with the opening push.

Kickoff alone is still not enough. `applyPushedState` accepts `winningScore` /
`initialCards` from the host on *any* push, mid-game included (proven by
`pushValidation.test.ts:63`), so "start default → push winningScore 1000
mid-game → win in two turns" would still count as normalized. Hence a sticky
downgrade on every accepted push:

```ts
applyPushedState(room.state, newState, { isHost, startingGame });

if (startingGame) {
  // Frozen from the state the game actually starts with…
  room.normalizedGame = isNormalizedConfig(room.state);
} else if (room.state.status === 'playing') {
  // …and once custom, custom for the rest of this game. Never upgraded:
  // flipping the config back before the end must not relabel the game.
  room.normalizedGame &&= isNormalizedConfig(room.state);
}
```

One hook point suffices: mid-game, pushState is the only path that can write
these two fields — `updateConfig` outside the lobby applies `turnDuration`
only ([socketConfigHandlers.ts:40](server/socketConfigHandlers.ts:40)), and
turnDuration is exempt anyway.

**`server/socketStatsHandlers.ts`** — both handlers stop trusting the payload:

- `submitGlobalStats` → `updateGlobalStats({ ...sanitizeStats(payload), isDefaultGame: room.normalizedGame })`.
- `endGameStats` → passes `room.normalizedGame ? 'normalized' : 'custom'` as the
  mode (wave 4).

`isDefaultGame` stays the field name in the `StatsPayload` contract: the admin
HTTP route has no room to read from, and `updateGlobalStats`' `recordsGame` gate
keys off its presence.

### Tests (`server/sockets.stats.test.ts`)
- host starts a custom game, then pushes the default config back before the
  game ends → still recorded as custom.
- host starts a **default** game, pushes a custom config mid-game → custom
  (the sticky downgrade).
- lobby left at defaults but the *opening push* carries a custom config →
  custom (the ordering case above).
- host lies (`isDefaultGame: true` in the payload of a custom game) → server
  overrides it.
- host starts a normalized game after a custom one in the same room ("Play
  Again" path, which never returns to the lobby) → mode is re-evaluated.
- a room that never starts a game → no stats, `normalizedGame` untouched.

Also in this wave: any test or harness constructing a `Room` object literally
(`socketTestHarness.ts`, rooms tests) gains the new field — `tsc` will point at
every site.

---

## Wave 3 — keep custom games out of the global totals

**`server/database.ts`**, in `updateGlobalStats`, right after `recordsGame`:

```ts
// A custom game leaves exactly one mark on the global statistics: that it
// happened. None of its sums and none of its records — a shortened winning
// score or a stacked deck would otherwise own every "fastest"/"highest".
if (recordsGame && !stats.isDefaultGame) {
  const changes = await knex('global_statistics').where({ id: 1 })
    .update({ customGamesPlayed: knex.raw('global_statistics.customGamesPlayed + 1') });
  if (changes === 0) throw new Error('global_statistics row missing — run migrations');
  return changes;
}
```

(Same missing-row guard as the main path — the branch must not silently
succeed against an unmigrated database.) Wrapped in the existing try/catch.

The branch lives in the DB layer so the socket path and the admin HTTP path
behave identically.

**Audit existing tests in this wave**: the server now decides the flag, and the
DB layer now discards custom games' sums — every existing submission-path test
that passes `isDefaultGame` (`stats-integration.test.ts`,
`full-stats.integration.test.ts`, `sockets.stats.test.ts`, `api.test.ts`)
must be re-checked. Most send `true` for default-config rooms and stay green;
any that don't are asserting pre-feature behaviour and need updating, not
deleting.

**`src/components/Statistics.tsx`** — the global tab gains a quiet line under
the header: *"… plus N custom games, not counted"*, rendered only when
`customGamesPlayed > 0`. `GlobalStats` gains `defaultGamesPlayed?` /
`customGamesPlayed?`.

### Tests (`server/database.test.ts`)
- `isDefaultGame: false` → `customGamesPlayed` +1; `totalGamesPlayed`,
  `totalPlaytime`, `totalScore`, `defaultGamesPlayed` unchanged.
- `isDefaultGame: false` carrying a huge `highestTurnScore` and a tiny
  `fastestWinTurns` → both extremes unchanged.
- `isDefaultGame: false` against a fresh row → no accidental row creation, and
  the missing-row error path still throws.
- `isDefaultGame: true` → today's behaviour, byte for byte.
- partial admin update without `isDefaultGame` → neither counter moves (existing
  test must still pass).

---

## Wave 4 — give custom games their own personal bucket

### Schema

`device_statistics` gets a `mode` column and a composite primary key
`(deviceId, mode)`. SQLite cannot alter a primary key, so the migration is the
standard table swap, in one transaction:

1. `createTable('device_statistics_new')` — `deviceId`, `mode`
   (`defaultTo('normalized')`), every existing stat column, `primary(['deviceId','mode'])`.
2. copy with **explicit column lists on both sides** —
   `INSERT INTO device_statistics_new (deviceId, mode, gamesPlayed, …) SELECT deviceId, 'normalized', gamesPlayed, … FROM device_statistics`.
   Never `SELECT *`: it binds by physical column order, and the initial-schema
   migration's `hasColumn`-by-`hasColumn` construction means that order is not
   even guaranteed identical across databases migrated at different points in
   history.
3. drop the old table, rename the new one.

The alternative — a second `device_custom_statistics` table with identical
columns — avoids the primary-key surgery but doubles the schema forever: every
future stat column has to be added twice, and `updateDeviceStats` would need two
code paths. The composite key is a one-time cost.

The migration must enumerate the column set as it stands after
`20260707000000_add_game_stats.js`. It is written once and frozen; later columns
are added by later migrations as usual.

### Query layer (`server/database.ts`)

- `DeviceStatsRow` gains `mode: GameMode`.
- `getDeviceStats(deviceId, mode = 'normalized')` — the filter becomes
  `.where({ deviceId, mode })`. Not optional: with two rows per device,
  `.where({ deviceId }).first()` returns whichever row SQLite feels like.
- `updateDeviceStats(deviceId, stats, mode = 'normalized')` — `data.mode = mode`,
  `.onConflict(['deviceId', 'mode'])`.

Defaulting to `'normalized'` keeps every existing caller and the admin HTTP route
meaning what they mean today.

### Win streak

`player.winStreak` — broadcast to the room and shown on the leaderboard — always
reads the **normalized** row. So:

- `socketRoomHandlers.ts` joinRoom → `getDeviceStats(deviceId)` (unchanged).
- `socketStatsHandlers.ts` → the post-game refresh + `emitRoomState` only run for
  a normalized game. After a custom game the displayed streak is still correct,
  because a custom game neither extends nor breaks it. That is the point of the
  feature.

The custom row keeps its own `currentWinStreak`/`bestWinStreak` for its own tab,
for free.

### API (`server/api.ts`)

`GET /api/stats/:deviceId?mode=custom` — absent or unrecognised `mode` falls back
to `'normalized'`, so old clients and the existing smoke test keep working.
Same for `POST` (admin).

### Client fetches

`Statistics.tsx`, `EndScreen.tsx` and `Game.tsx` all hit
`/api/stats/${deviceId}` and must pass the mode they mean:

- `Game.tsx` (pre-game record snapshot) → **skipped entirely for a custom
  game**. Its only consumer is the record-celebration diff, and wave 6
  suppresses that for custom games — fetching the custom bucket for it would
  be dead work feeding a hidden feature. Capture the mode in the existing
  `atGameStartRef` (config at mount) and bail like the offline path does.
- `EndScreen.tsx` (post-game lifetime block, `deviceStats` state) → the mode
  just played, so the numbers shown match the bucket the game landed in.
- `Statistics.tsx` → whichever tab is showing (wave 5).

The store needs the current game's mode client-side for this: add a derived
`isNormalizedGame` selector over `winningScore`/`initialCards` rather than a
second piece of state. (Client-side derivation is display-only — the server's
`room.normalizedGame` stays the authority for what gets recorded. For an
honest client the two agree.)

`setupTests.tsx`'s fetch mock matches `url.startsWith('/api/stats/')`, so the
new `?mode=` query passes through it untouched; wave-5 tests that need
different numbers per mode extend the mock to read the query.

### Tests
- migration test (pattern: `server/gameStatsMigration.test.ts`) — a pre-migration
  row survives with every value intact and `mode = 'normalized'`.
- `updateDeviceStats` writes to the right row; the same `deviceId` in both modes
  keeps two independent rows; streaks advance independently.
- `getDeviceStats` defaults to normalized; returns `null` for a device with only
  custom games when asked for normalized.
- `endGameStats` for a custom game → writes the custom row, does **not** touch
  the normalized row, does **not** re-broadcast the roster.
- `endGameStats` dedup (`statsRecordedForGame.devices`) still holds per game.
- API: `?mode=custom`, `?mode=` (empty), `?mode=bogus`, no param.

---

## Wave 5 — the switch in the personal tab

**`src/components/Statistics.tsx`**:

- `const [mode, setMode] = useState<GameMode>('normalized')` — a two-button
  segmented control above the personal tiles, same visual language as the
  existing Personal/Global tabs.
- The fetch effect keys off `[deviceId, mode]`; the global fetch stays where it
  is (it doesn't depend on the mode).
- Empty state per mode: *"No custom games played on this device yet."*
- The "Global Record!" badges (`isRecordHolder`) and the
  better/worse-than-global comparisons must be **hidden in the custom view** —
  the global row no longer contains custom games, so comparing them is
  meaningless.

**i18n** — new keys in `src/locales/en/translation.json` and `de`:
`statistics.normalGames`, `statistics.customGames`, `statistics.noCustomGames`,
`statistics.customGamesNotCounted`, `game.customGameBadge`,
`endScreen.customGameNotice`.

### Tests (`src/components/Statistics.test.tsx`)
- switching to Custom refetches with `?mode=custom` and renders that row's numbers.
- custom view hides record badges and global comparisons.
- empty custom bucket renders its own empty state, not the personal one.
- the global tab shows the custom-games line only when the count is non-zero.

---

## Wave 6 — say when a game will not count

**Lobby** (`src/components/home/LobbyShared.tsx`) — when the config is not
normalized, a badge next to the settings: *"Custom game — this game will not
count toward the statistics"*. The existing `resetGeneralSettings` /
`resetInitialCards` buttons are right there, so the way back is obvious.

**Online lobby only.** `AdvancedOptionsPanel` is shared with `LocalLobby.tsx`,
and local games never record stats regardless of config — the badge there
would be a false statement about a distinction that doesn't exist. Gate on
`isOnline` (or render the badge from `OnlineLobby.tsx` instead of inside the
shared panel).

**End screen** (`src/components/EndScreen.tsx`) — for a custom game:

- suppress the new-personal-record celebration entirely (`hasNewRecord` and the
  five `new*` flags). They diff against `preGameStats`; left alone they would
  celebrate a "record" set on a stacked deck.
- a one-line note: *"Custom game — counted under Custom in your statistics."*

### Tests
- `LobbyShared.test.tsx` — badge appears for a changed winning score and for a
  changed deck; absent for a changed turn timer / kick timer / random order /
  enforced dice mode; absent for the default config; absent in a local lobby
  even with a custom config.
- `EndScreen.test.tsx` — no record badges in a custom game even when the numbers
  would beat `preGameStats`; the notice renders; a normalized game is unchanged
  (existing record tests must still pass).

---

## Open risks

- **The host is still authoritative.** Kickoff freeze + sticky downgrade close
  every config-timing trick, but a determined host running a patched client can
  still stage an entire fake finished game — the same limitation
  [`socketStatsHandlers.ts`](server/socketStatsHandlers.ts) already documents.
  Out of scope here.
- **Old clients against the new server** degrade gracefully: a stats fetch
  without `?mode=` reads the normalized row, submissions never carried the mode
  anyway (the server decides), and the payload `isDefaultGame` they still send
  is simply overridden.
- **The migration touches live data.** `stats.db` in a real deployment gets a
  table swap. The migration is transactional and `down` stays a no-op (repo
  convention: never drop for data safety), but a backup before the release is
  worth a line in the README/release notes.
- **`mostPlayersInGame` and friends in the global row** still contain values from
  pre-feature custom games. Accepted, per the "existing history counts as
  normalized" decision.
