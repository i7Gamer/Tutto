import { renderHook, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

// The decoder chunk fails to load — the exact offline / stale-service-worker
// failure RoomQrCode already anticipates for its own lazy chunk.
vi.mock('jsqr', () => { throw new Error('chunk load failed'); });

import { useQrScanner } from './useQrScanner';

describe('useQrScanner camera release', () => {
  const stopTrack = vi.fn();

  beforeEach(() => {
    stopTrack.mockClear();
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: {
        getUserMedia: vi.fn().mockResolvedValue({
          getTracks: () => [{ stop: stopTrack }],
        }),
      },
    });
  });

  it('stops the granted camera when the decoder chunk fails to load', async () => {
    const { result } = renderHook(() => useQrScanner({ enabled: true, onDecode: vi.fn() }));

    await waitFor(() => expect(result.current.status).toBe('error'));
    // The stream resolved before the import failed — unless it is captured
    // the moment the camera grants it, release() has nothing to stop and the
    // camera light stays on behind the error panel until a page reload.
    expect(stopTrack).toHaveBeenCalled();
  });
});
