/** @vitest-environment jsdom */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isSafeToApplyUpdate,
  applyUpdateWhenIdle,
  reloadOnceForUpdate,
  _resetSwUpdateForTests,
  type UpdateIdleState,
} from './swUpdate';

const idle: UpdateIdleState = {
  players: { length: 0 },
  currentPlayerIndex: null,
  finished: false,
  roomId: null,
  hasFormDraft: false,
  statsScreenOpen: false,
};

beforeEach(() => {
  _resetSwUpdateForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isSafeToApplyUpdate', () => {
  it('is safe on an empty home screen', () => {
    expect(isSafeToApplyUpdate(idle)).toBe(true);
  });

  it('refuses while a game is being played', () => {
    // App.tsx renders <Game/> on exactly this condition.
    expect(isSafeToApplyUpdate({ ...idle, players: { length: 3 }, currentPlayerIndex: 0 })).toBe(false);
  });

  it('refuses while the end screen is up', () => {
    // And <EndScreen/> on exactly this one — where the stats submission may
    // still be in flight.
    expect(isSafeToApplyUpdate({ ...idle, players: { length: 3 }, finished: true })).toBe(false);
  });

  it('refuses while seated in an online room, even in its lobby', () => {
    // The seat survives a reload, but it costs a reconnect round trip and a
    // visible flash to everyone at the table.
    expect(isSafeToApplyUpdate({ ...idle, roomId: 'R1' })).toBe(false);
  });

  it('is safe again once the players are gone', () => {
    // currentPlayerIndex without a roster is not a game — the same reason
    // App.tsx requires both.
    expect(isSafeToApplyUpdate({ ...idle, currentPlayerIndex: 0 })).toBe(true);
    expect(isSafeToApplyUpdate({ ...idle, finished: true })).toBe(true);
  });

  // A local roster the player is still assembling in <LocalLobby/> — nobody
  // has pressed Start Game, so App.tsx renders <Home/>, not <Game/> — is
  // exactly the state this predicate used to wave through: currentPlayerIndex
  // is null, finished is false, roomId is null. attachPersistence does save
  // the roster on every change, so a reload would not lose it, but it would
  // still cost the player the flash-free continuity of the screen they were
  // just building, the same cost an online seat pays below. So any non-empty
  // local roster counts as busy, whether or not a game is under way.
  it('refuses while a local lobby has players configured but no game started', () => {
    expect(isSafeToApplyUpdate({ ...idle, players: { length: 2 } })).toBe(false);
  });

  // The online join form's room-code/name inputs and its QR scanner all live
  // as plain component state in OnlineLobby.tsx — none of it is persisted,
  // so a reload silently drops it. hasFormDraft is OnlineLobby's own signal
  // (see uiBusyState.ts) that either is true.
  it('refuses while the online join form holds a draft or its scanner is open', () => {
    expect(isSafeToApplyUpdate({ ...idle, hasFormDraft: true })).toBe(false);
  });

  // App.tsx's `showStats` is plain component state, never persisted — a
  // reload lands back on <Home/>, not <Statistics/>, so there is no "same
  // screen" for the player to resume reading on.
  it('refuses while the Statistics screen is open', () => {
    expect(isSafeToApplyUpdate({ ...idle, statsScreenOpen: true })).toBe(false);
  });
});

describe('applyUpdateWhenIdle', () => {
  /** A minimal store: a value, a setter, and zustand-shaped subscribe. */
  const makeStore = (initial: UpdateIdleState) => {
    let state = initial;
    const listeners = new Set<() => void>();
    return {
      getState: () => state,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      set: (next: UpdateIdleState) => {
        state = next;
        [...listeners].forEach(listener => listener());
      },
      listenerCount: () => listeners.size,
    };
  };

  it('applies immediately when the app is already idle', () => {
    // An update that arrives while the player sits on the home screen produces
    // no store change to wait for.
    const store = makeStore(idle);
    const apply = vi.fn();

    applyUpdateWhenIdle({ apply, getState: store.getState, subscribe: store.subscribe });

    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('does not apply mid-game, and stops watching once it has', () => {
    const store = makeStore({ ...idle, players: { length: 2 }, currentPlayerIndex: 1 });
    const apply = vi.fn();

    applyUpdateWhenIdle({ apply, getState: store.getState, subscribe: store.subscribe });
    expect(apply).not.toHaveBeenCalled();

    // The game ends and the players leave: the first idle moment.
    store.set(idle);

    expect(apply).toHaveBeenCalledTimes(1);
    expect(store.listenerCount(), 'the subscription is released').toBe(0);
  });

  it('leaves no subscription behind when it applies on the first attempt', () => {
    const store = makeStore(idle);

    applyUpdateWhenIdle({ apply: vi.fn(), getState: store.getState, subscribe: store.subscribe });

    expect(store.listenerCount()).toBe(0);
  });

  it('applies at most once, however many store changes follow', () => {
    const store = makeStore({ ...idle, roomId: 'R1' });
    const apply = vi.fn();

    applyUpdateWhenIdle({ apply, getState: store.getState, subscribe: store.subscribe });
    store.set(idle);
    store.set({ ...idle, players: { length: 2 } });
    store.set(idle);

    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('ignores a second call once an update has been applied', () => {
    // Each call messages the worker again, and in prompt mode every waiting
    // event registers another `controlling` listener behind it — which is one
    // of the two ways the app came to reload twice.
    const store = makeStore(idle);
    const first = vi.fn();
    const second = vi.fn();

    applyUpdateWhenIdle({ apply: first, getState: store.getState, subscribe: store.subscribe });
    applyUpdateWhenIdle({ apply: second, getState: store.getState, subscribe: store.subscribe });

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it('does not start a second watch while the first is still waiting', () => {
    // onNeedRefresh fires on every `waiting` event, so this call really can
    // repeat before an idle moment arrives. A second subscription would
    // outlive the applying one, whose unsubscribe only releases its own.
    const store = makeStore({ ...idle, roomId: 'R1' });
    const apply = vi.fn();

    applyUpdateWhenIdle({ apply, getState: store.getState, subscribe: store.subscribe });
    applyUpdateWhenIdle({ apply, getState: store.getState, subscribe: store.subscribe });

    expect(store.listenerCount()).toBe(1);

    store.set(idle);

    expect(apply).toHaveBeenCalledTimes(1);
    expect(store.listenerCount(), 'and it is released when it applies').toBe(0);
  });

  it('never applies while the player stays busy', () => {
    const store = makeStore({ ...idle, players: { length: 2 }, currentPlayerIndex: 0 });
    const apply = vi.fn();

    applyUpdateWhenIdle({ apply, getState: store.getState, subscribe: store.subscribe });
    store.set({ ...idle, players: { length: 2 }, currentPlayerIndex: 1 });
    store.set({ ...idle, players: { length: 2 }, finished: true });

    // The waiting worker takes over on the next cold start instead — with no
    // client to reload at all.
    expect(apply).not.toHaveBeenCalled();
  });
});

describe('reloadOnceForUpdate', () => {
  const stubReload = () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    return reload;
  };

  /** Puts this tab in the state of having handed the worker its go-ahead. */
  const applyHere = () => applyUpdateWhenIdle({
    apply: () => {},
    getState: () => idle,
    subscribe: () => () => {},
  });

  it('reloads the page once this tab has applied the update', () => {
    const reload = stubReload();
    applyHere();

    reloadOnceForUpdate();

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not reload a tab that did not apply the update itself', () => {
    // The reported "one tab updating reloads every other tab", which the move
    // to prompt mode was supposed to end and did not. The register template
    // adds a `controlling` listener in EVERY tab that sees a worker reach
    // `waiting` — including one installed because of another tab — and workbox
    // dispatches `controlling` unconditionally with isUpdate true for any tab
    // that is not a first-ever visit. isExternal is passed and the template
    // ignores it. So a tab that never chose to update was reloaded anyway,
    // mid-game included: a visible flash plus a reconnect round trip for
    // everyone at that table.
    //
    // Not reloading is not a compromise: clients.claim hands the new worker
    // tabs still running the PREVIOUS build, and RETAINED_CACHE_GENERATIONS
    // exists precisely so their chunks keep resolving.
    const reload = stubReload();

    reloadOnceForUpdate();

    expect(reload, 'only the tab that decided to update may reload').not.toHaveBeenCalled();
  });

  it('reloads only once, however often it is called', () => {
    // The reported "sometimes it reloads twice": prompt mode adds a fresh
    // `controlling` listener every time a worker enters `waiting`, so more
    // than one can be live, each reloading a page already on its way out.
    const reload = stubReload();
    applyHere();

    reloadOnceForUpdate();
    reloadOnceForUpdate();
    reloadOnceForUpdate();

    expect(reload).toHaveBeenCalledTimes(1);
  });
});
