/**
 * The shared MockAudioContext (src/setupTests.tsx) used to have no close(), so
 * turning sound off anywhere in a component test threw inside an async
 * function nobody awaits — an unhandled rejection, attributed to whichever
 * test happened to be running rather than the one that caused it.
 *
 * This is the smallest thing that reproduces it: the real store action, the
 * shared mock, no local override.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { useGameStore } from '../store/useGameStore';
import { playTone } from './soundEffects';

describe('turning sound off against the shared AudioContext mock', () => {
  afterEach(() => {
    useGameStore.setState({ audioEnabled: true });
    vi.restoreAllMocks();
  });

  it('closes the context without an unhandled rejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      // A context has to exist before there is anything to close.
      await playTone(440, 'sine', 0.1);

      useGameStore.getState().setAudioEnabled(false);
      // Let the void-ed close() promise settle either way.
      await new Promise(resolve => setTimeout(resolve, 0));

      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
