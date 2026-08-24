/**
 * When a newly installed service worker is allowed to take over.
 *
 * The app used to run `registerType: 'autoUpdate'`, whose register template
 * reloads the page on every worker activation where `isUpdate || isExternal`.
 * Three things followed, all of them reported as "it reloads when it doesn't
 * need to" and "sometimes it reloads twice":
 *
 *  - `isExternal` fires for a worker THIS tab did not register, so one tab
 *    updating reloaded every other open tab and PWA window along with it.
 *  - `isUpdate` is true for any activation with a previous controller —
 *    including the browser's own periodic sw.js re-check, with no deploy
 *    behind it.
 *  - src/sw.js called `skipWaiting()` unconditionally in `install`, so a new
 *    worker activated the moment it installed. After the forced reload the
 *    fresh page re-registers and the browser re-fetches sw.js; if the edge
 *    briefly answers with the PREVIOUS script, that installs, skips waiting,
 *    claims, and reloads again. Nothing guarded it — no `onNeedReload` was
 *    supplied, so the template's bare `window.location.reload()` ran, and
 *    prompt mode adds a fresh `controlling` listener on every waiting event.
 *
 * So: the worker now waits, and the page decides. An update is applied at the
 * first moment a reload interrupts nothing — and if that moment never comes,
 * the browser activates the waiting worker on the next cold start, with no
 * client to reload at all. Which is what main.tsx always claimed happened.
 */

/** The store fields that decide whether the player is in the middle of something. */
export interface UpdateIdleState {
  players: { length: number };
  currentPlayerIndex: number | null;
  finished: boolean;
  roomId: string | null;
}

/**
 * Whether reloading right now would interrupt nothing.
 *
 * The first two conditions mirror App.tsx's own routing exactly — they are
 * what makes it render <Game/> and <EndScreen/> rather than <Home/>. The third
 * is this module's own: an online seat survives a reload (the session is
 * persisted and the client rejoins), but it costs a reconnect round trip and a
 * visible flash to everyone at the table, and an update is never urgent enough
 * to be worth that.
 */
export const isSafeToApplyUpdate = (state: UpdateIdleState): boolean => {
  const seated = state.players.length > 0;
  const isPlaying = state.currentPlayerIndex !== null && seated;
  const hasWinner = state.finished && seated;
  return !isPlaying && !hasWinner && state.roomId === null;
};

interface ApplyUpdateOptions<S extends UpdateIdleState> {
  /** Hands the waiting worker its SKIP_WAITING message. */
  apply: () => void;
  getState: () => S;
  /** Store subscription; returns its own unsubscribe. */
  subscribe: (listener: () => void) => () => void;
}

// Module state, because "apply once" has to hold across every call and every
// store tick. Reset between tests through the export at the bottom, the same
// way useGameStore's timers are.
let updateApplied = false;
let watchingForIdle = false;
let reloading = false;

/**
 * Applies a waiting update at the first idle moment, then stops watching.
 *
 * Tries immediately — an update that arrives while the player sits on the home
 * screen produces no store change to wait for — and otherwise watches until
 * one comes. Applying at most once is the point: each call to the plugin's
 * `updateServiceWorker` messages the worker again, and every waiting event in
 * prompt mode registers another `controlling` listener behind it.
 */
export const applyUpdateWhenIdle = <S extends UpdateIdleState>(
  { apply, getState, subscribe }: ApplyUpdateOptions<S>,
): void => {
  // Two latches, not one. `updateApplied` stops a second update being applied
  // after the first; `watchingForIdle` stops a second CALL adding a second
  // subscription while the first is still waiting for an idle moment — which
  // onNeedRefresh can do, since prompt mode fires it on every `waiting` event.
  // The leaked listener would outlive the applying one, whose unsubscribe only
  // ever releases its own.
  if (updateApplied || watchingForIdle) return;
  watchingForIdle = true;

  let unsubscribe: (() => void) | null = null;
  const attempt = (): void => {
    if (updateApplied || !isSafeToApplyUpdate(getState())) return;
    updateApplied = true;
    watchingForIdle = false;
    unsubscribe?.();
    apply();
  };

  unsubscribe = subscribe(attempt);
  attempt();
  // Already applied on the first attempt, before `unsubscribe` was assigned to
  // for the listener to read.
  if (updateApplied) unsubscribe();
};

/**
 * Reloads onto the new worker, once and only once.
 *
 * Passed to registerSW as `onNeedReload`, replacing the template's unguarded
 * `window.location.reload()`. In prompt mode the template adds a `controlling`
 * listener each time a worker enters `waiting`, so more than one can be live
 * at a time — and each would reload a page that is already on its way out.
 */
export const reloadOnceForUpdate = (): void => {
  if (reloading) return;
  reloading = true;
  window.location.reload();
};

/** Test-only: clears the two one-shot latches above. */
export const _resetSwUpdateForTests = (): void => {
  updateApplied = false;
  watchingForIdle = false;
  reloading = false;
};
