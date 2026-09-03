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

  const stubReload = () => {
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    return reload;
  };

  it('reloads immediately when this tab is idle', () => {
    // The common case: this tab applied the update itself while idle (or the
    // controller simply changed while nothing else was going on), so the
    // idle check below passes on the very first attempt.
    const reload = stubReload();
    const store = makeStore(idle);

    reloadOnceForUpdate({ getState: store.getState, subscribe: store.subscribe });

    expect(reload).toHaveBeenCalledTimes(1);
  });

  // The bug report: a tab claimed by ANOTHER tab's update never reloaded.
  // workbox-window's `controlling` event (wired to this via onNeedReload in
  // main.tsx) fires in EVERY tab whose controller changes, including one
  // that never called apply() itself — clients.claim() affects every open
  // tab under the registration, not just the one that asked for the update.
  // The old code gated reloading on a flag only the applying tab ever set,
  // so a tab claimed this way just sat there running stale JS under a new
  // worker's control until its own next cold start. Standing down was never
  // meant to mean "never reload" — RETAINED_CACHE_GENERATIONS (src/sw.js)
  // exists so a stale tab's chunks keep resolving UNTIL it gets a chance to
  // reload without interrupting anything, not so it can skip reloading
  // forever.
  it('reloads a tab that never applied the update itself, once it is idle', () => {
    const reload = stubReload();
    const store = makeStore({ ...idle, players: { length: 2 }, currentPlayerIndex: 0 });

    reloadOnceForUpdate({ getState: store.getState, subscribe: store.subscribe });
    expect(reload, 'busy — must wait, not reload mid-game').not.toHaveBeenCalled();

    // The game ends and the players leave: the first idle moment.
    store.set(idle);

    expect(reload).toHaveBeenCalledTimes(1);
    expect(store.listenerCount(), 'the subscription is released').toBe(0);
  });

  it('reloads only once, however often it is called', () => {
    // The reported "sometimes it reloads twice": prompt mode adds a fresh
    // `controlling` listener every time a worker enters `waiting`, so more
    // than one can be live, each reloading a page already on its way out.
    const reload = stubReload();
    const store = makeStore(idle);

    reloadOnceForUpdate({ getState: store.getState, subscribe: store.subscribe });
    reloadOnceForUpdate({ getState: store.getState, subscribe: store.subscribe });
    reloadOnceForUpdate({ getState: store.getState, subscribe: store.subscribe });

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not start a second watch while the first is still waiting', () => {
    const reload = stubReload();
    const store = makeStore({ ...idle, roomId: 'R1' });

    reloadOnceForUpdate({ getState: store.getState, subscribe: store.subscribe });
    reloadOnceForUpdate({ getState: store.getState, subscribe: store.subscribe });

    expect(store.listenerCount()).toBe(1);

    store.set(idle);

    expect(reload).toHaveBeenCalledTimes(1);
    expect(store.listenerCount(), 'and it is released once it reloads').toBe(0);
  });

  // The other half of the same bug: a claimed tab's own pending
  // applyUpdateWhenIdle watch (started earlier by its own onNeedRefresh, for
  // the SAME waiting worker another tab just skip-waited) would eventually
  // fire too, telling an already-activated worker to skip waiting again — a
  // silent no-op — while permanently setting its "applied" latch. Since
  // applyUpdateWhenIdle refuses to start a second watch once that latch is
  // set, every update after the first would be a no-op for this tab forever,
  // and the header comment on reloadOnceForUpdate claimed this could not
  // happen. Once the controller has genuinely changed, that pending watch is
  // stale — there is no waiting worker left for it to message — so
  // reloadOnceForUpdate must retire it rather than let it fire later.
  it('cancels a pending apply watch so it cannot poison a later update', () => {
    const store = makeStore({ ...idle, players: { length: 2 }, currentPlayerIndex: 0 });
    const staleApply = vi.fn();

    // This tab's own onNeedRefresh, still waiting for the SAME busy player to
    // go idle when the controller changes out from under it.
    applyUpdateWhenIdle({ apply: staleApply, getState: store.getState, subscribe: store.subscribe });

    // Another tab's update claims this one before it ever went idle.
    reloadOnceForUpdate({ getState: store.getState, subscribe: store.subscribe });

    store.set(idle);
    expect(staleApply, 'the stale watch must not fire').not.toHaveBeenCalled();

    // A genuinely new update, later, must still be able to run its own watch
    // to completion — proof the earlier cancellation did not also poison
    // applyUpdateWhenIdle's own latch. No _resetSwUpdateForTests() here: that
    // would trivially "fix" a poisoned latch too and prove nothing.
    const freshApply = vi.fn();
    applyUpdateWhenIdle({ apply: freshApply, getState: () => idle, subscribe: () => () => {} });
    expect(freshApply).toHaveBeenCalledTimes(1);
  });
});
