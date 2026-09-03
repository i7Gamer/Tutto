/**
 * Ephemeral UI state that isSafeToApplyUpdate (swUpdate.ts) needs but that
 * has no home in useGameStore: none of it is game state, none of it should
 * ever be persisted or synced to a server, and it lives only as long as the
 * component that owns it is mounted.
 *
 * A plain module-level store rather than a slice of useGameStore: adding
 * these flags there would mean excluding them from every persistence/sync
 * key list that store already enumerates by lock-step type checks
 * (STABLE_LOCAL_GAME_KEYS and the SYNCED_GAME_STATE_KEYS locks in
 * persistence.ts) — for two booleans that outlive nothing and reach no other
 * client, a second small subscribable object is less risk than editing those
 * locks. Components call the setters directly; nothing here reads the store.
 */

export interface UiBusyState {
  /** True while OnlineLobby's join form holds unsaved text, or its QR scanner is open. */
  hasFormDraft: boolean;
  /** True while the Statistics screen (App.tsx's `showStats`) is on screen. */
  statsScreenOpen: boolean;
}

const initialState: UiBusyState = { hasFormDraft: false, statsScreenOpen: false };

let state: UiBusyState = initialState;
const listeners = new Set<() => void>();

const setState = (patch: Partial<UiBusyState>): void => {
  state = { ...state, ...patch };
  // Snapshot before iterating: a listener that unsubscribes another listener
  // mid-notification must not skip or double-call anyone else in this pass.
  [...listeners].forEach((listener) => listener());
};

export const uiBusyState = {
  getState: (): UiBusyState => state,
  subscribe: (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

export const setHasFormDraft = (hasFormDraft: boolean): void => setState({ hasFormDraft });
export const setStatsScreenOpen = (statsScreenOpen: boolean): void => setState({ statsScreenOpen });

/** Test-only: restores the initial (both-false) state. */
export const _resetUiBusyStateForTests = (): void => {
  state = initialState;
};
