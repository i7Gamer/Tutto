/**
 * When a newly installed service worker is allowed to take over.
 *
 * The app used to run `registerType: 'autoUpdate'`, whose register template
 * reloads the page on every worker activation where `isUpdate || isExternal`.
 * Three things followed, all of them reported as "it reloads when it doesn't
 * need to" and "sometimes it reloads twice":
 *
 *  - `isExternal` fires for a worker THIS tab did not register, so one tab
 *    updating reloaded every other open tab and PWA window along with it,
 *    mid-game included, with no idle check at all.
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
 * first moment a reload interrupts nothing. A tab whose controller changes
 * WITHOUT it ever asking (another tab applied the update, and clients.claim()
 * takes every open tab under the registration along with it) reloads too, at
 * its own next idle moment rather than immediately — see reloadOnceForUpdate.
 * And if neither moment ever comes, the browser activates the waiting worker
 * on the next cold start, with no client to reload at all.
 */

/** The store fields that decide whether the player is in the middle of something. */
export interface UpdateIdleState {
  players: { length: number };
  currentPlayerIndex: number | null;
  finished: boolean;
  roomId: string | null;
  // Component state that has no home in the store — see uiBusyState.ts.
  // OnlineLobby's join-form inputs (room code / name) hold unsaved text, or
  // its QR scanner is open. Neither is persisted, so a reload drops it.
  hasFormDraft: boolean;
  // App.tsx's `showStats`, likewise plain component state and never
  // persisted: a reload lands back on <Home/>, not <Statistics/>, so there is
  // no "same screen" to reopen the player on.
  statsScreenOpen: boolean;
}

/**
 * Whether reloading right now would interrupt nothing.
 *
 * `seated` is deliberately not split into "playing" vs "finished" vs "still
 * in the lobby assembling a roster" the way App.tsx's own routing is (it only
 * needs currentPlayerIndex/finished to choose between <Game/>, <EndScreen/>
 * and <Home/>). A local roster the player is still building in <LocalLobby/>
 * survives a reload just as well — attachPersistence (persistence.ts) saves
 * `players` on every change — but reloading anyway still costs the same
 * flash-free continuity an in-progress or just-finished game would lose, so
 * any non-empty roster counts as busy regardless of which of those three
 * screens it is currently rendering.
 *
 * An online seat (`roomId`) survives a reload too (the session is persisted
 * and the client rejoins), but costs a reconnect round trip and a visible
 * flash to everyone at the table — busy at any point in the room, lobby
 * included, for the same reason.
 *
 * `hasFormDraft` and `statsScreenOpen` cover the two screens that hold state
 * a reload would simply drop on the floor because it was never in the store
 * to begin with — see their doc comments on UpdateIdleState above.
 */
export const isSafeToApplyUpdate = (state: UpdateIdleState): boolean => {
  const seated = state.players.length > 0;
  return !seated && state.roomId === null && !state.hasFormDraft && !state.statsScreenOpen;
};

interface IdleSubscription<S extends UpdateIdleState> {
  getState: () => S;
  /** Store subscription; returns its own unsubscribe. */
  subscribe: (listener: () => void) => () => void;
}

interface ApplyUpdateOptions<S extends UpdateIdleState> extends IdleSubscription<S> {
  /** Hands the waiting worker its SKIP_WAITING message. */
  apply: () => void;
}

// Module state, because "apply once" has to hold across every call and every
// store tick. Reset between tests through the export at the bottom, the same
// way useGameStore's timers are.
//
// This is one of TWO independent one-shot watches in this file — the other
// is reloadOnceForUpdate's below. They cannot share latches: a controller
// change this tab did not itself request can arrive before, during, or
// completely without this tab's own apply() ever running (see
// reloadOnceForUpdate's docs), so "have we told a worker to skip waiting" and
// "have we reloaded onto whatever now controls us" are genuinely different
// questions.
let updateApplied = false;
let watchingForIdle = false;
// The listener applyUpdateWhenIdle is currently waiting on, if any — held at
// module scope (rather than only in applyUpdateWhenIdle's own closure) so
// cancelPendingApply can release it from the outside. See its docs.
let pendingApplyUnsubscribe: (() => void) | null = null;

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

  const attempt = (): void => {
    if (updateApplied || !isSafeToApplyUpdate(getState())) return;
    updateApplied = true;
    watchingForIdle = false;
    pendingApplyUnsubscribe?.();
    pendingApplyUnsubscribe = null;
    apply();
  };

  pendingApplyUnsubscribe = subscribe(attempt);
  attempt();
  // Already applied on the first attempt, before `pendingApplyUnsubscribe` was
  // assigned to for the listener to read.
  if (updateApplied) {
    pendingApplyUnsubscribe?.();
    pendingApplyUnsubscribe = null;
  }
};

/**
 * Retires a still-pending applyUpdateWhenIdle watch without applying it.
 *
 * Called from reloadOnceForUpdate the moment this tab's controller changes —
 * proof that whatever worker a pending watch was saving its skipWaiting
 * message for has already taken over, requested by this tab or another one.
 * Left running, that watch would still fire at this tab's next idle moment,
 * post a skipWaiting message to a worker that is no longer waiting (a silent
 * no-op), and — this is the reported bug — permanently set `updateApplied`
 * regardless, which used to make applyUpdateWhenIdle refuse to start a
 * watch for every update after it: one stray no-op meant this tab could
 * never again ask a worker to skip waiting for the rest of the page's life.
 * A no-op cancellation (`updateApplied` already true) is left alone — that
 * update genuinely was applied by this tab, and reloadOnceForUpdate's own
 * watch is what reloads onto it.
 */
const cancelPendingApply = (): void => {
  if (updateApplied) return;
  watchingForIdle = false;
  pendingApplyUnsubscribe?.();
  pendingApplyUnsubscribe = null;
};

// The second one-shot watch — see the comment above `updateApplied`.
let reloadQueued = false;
let watchingToReload = false;
let reloading = false;
let pendingReloadUnsubscribe: (() => void) | null = null;

/**
 * Reloads onto whatever now controls this tab, at the first idle moment.
 *
 * Passed to registerSW as `onNeedReload`, replacing the template's unguarded
 * `window.location.reload()`. workbox-window's `controlling` event — what
 * this is wired to — fires in EVERY tab whose controller changes, including
 * one that never called apply() itself: `clients.claim()` (src/sw.js) hands
 * the new worker every open tab under the registration, not just the one
 * that asked for it. The comment this replaced claimed standing down in that
 * tab was the end of the story, citing RETAINED_CACHE_GENERATIONS as why a
 * stale tab's chunks keep resolving — true, but the retained generations
 * exist so that tab can keep running UNTIL its own next idle moment, not so
 * it can skip reloading forever. So this runs the exact same idle watch
 * applyUpdateWhenIdle does, driven by the controller-change event itself
 * (ground truth that a new worker is in control) rather than by whether THIS
 * tab was the one that requested it.
 *
 * `reloading` still covers the "sometimes it reloads twice" report: prompt
 * mode adds a fresh `controlling` listener every time a worker enters
 * `waiting`, so more than one can be live, each otherwise reloading a page
 * already on its way out.
 */
export const reloadOnceForUpdate = <S extends UpdateIdleState>(
  { getState, subscribe }: IdleSubscription<S>,
): void => {
  // The controller has already changed by the time this runs — any apply()
  // this tab still has queued for a worker that was merely waiting is now
  // stale (see cancelPendingApply).
  cancelPendingApply();

  if (reloadQueued || watchingToReload) return;
  watchingToReload = true;

  const attempt = (): void => {
    if (reloadQueued || !isSafeToApplyUpdate(getState())) return;
    reloadQueued = true;
    watchingToReload = false;
    pendingReloadUnsubscribe?.();
    pendingReloadUnsubscribe = null;
    if (reloading) return;
    reloading = true;
    window.location.reload();
  };

  pendingReloadUnsubscribe = subscribe(attempt);
  attempt();
  if (reloadQueued) {
    pendingReloadUnsubscribe?.();
    pendingReloadUnsubscribe = null;
  }
};

/** Test-only: clears every one-shot latch above. */
export const _resetSwUpdateForTests = (): void => {
  updateApplied = false;
  watchingForIdle = false;
  pendingApplyUnsubscribe = null;
  reloadQueued = false;
  watchingToReload = false;
  reloading = false;
  pendingReloadUnsubscribe = null;
};
