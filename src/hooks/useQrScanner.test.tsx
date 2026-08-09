import { render, screen, waitFor, act, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useQrScanner, QR_DECODE_INTERVAL_MS } from './useQrScanner';

const { decoded } = vi.hoisted(() => ({ decoded: { value: null as string | null } }));

vi.mock('jsqr', () => ({
  default: () => (decoded.value === null ? null : { data: decoded.value }),
}));

// jsdom's video element reports 0x0 and never has frame data; the loop reads
// both before it bothers decoding.
const video = { width: 640, height: 480, ready: 2, canPlay: true };

Object.defineProperty(HTMLVideoElement.prototype, 'videoWidth', {
  configurable: true, get: () => video.width,
});
Object.defineProperty(HTMLVideoElement.prototype, 'videoHeight', {
  configurable: true, get: () => video.height,
});
Object.defineProperty(HTMLMediaElement.prototype, 'readyState', {
  configurable: true, get: () => video.ready,
});
HTMLMediaElement.prototype.play = vi.fn(() => video.canPlay
  ? Promise.resolve()
  // How a browser refuses to play the stream inline. Carries the same error
  // name as a refused camera permission.
  : Promise.reject(Object.assign(new Error('autoplay'), { name: 'NotAllowedError' })));

const setSecureContext = (value: boolean) => {
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value });
};

const stopTrack = vi.fn();
const grantCamera = (getUserMedia = vi.fn(() => Promise.resolve({
  getTracks: () => [{ stop: stopTrack }],
} as unknown as MediaStream))) => {
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
  return getUserMedia;
};

const refuseCamera = (name: string) => grantCamera(
  vi.fn(() => Promise.reject(Object.assign(new Error(name), { name })))
);

// Frames are driven by hand, so a test decodes exactly when it means to. The
// clock moves with them because the loop throttles on the timestamp it is
// handed — by default far enough that a frame is never the throttled one.
let frames: ((time: number) => void)[] = [];
let clock = 0;
const nextFrame = async (advanceMs = QR_DECODE_INTERVAL_MS) => {
  clock += advanceMs;
  const pending = frames;
  frames = [];
  await act(async () => { pending.forEach(fn => fn(clock)); });
};

function Harness({ enabled = true, onDecode = () => {} }: { enabled?: boolean; onDecode?: (text: string) => void }) {
  const { videoRef, status } = useQrScanner({ enabled, onDecode });
  return <video ref={videoRef} data-testid="camera" data-status={status} />;
}

const status = () => screen.getByTestId('camera').getAttribute('data-status');

beforeEach(() => {
  decoded.value = null;
  video.width = 640;
  video.height = 480;
  video.ready = 2;
  video.canPlay = true;
  frames = [];
  clock = 0;
  stopTrack.mockClear();
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(fn => {
    frames.push(fn);
    return frames.length;
  });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  setSecureContext(true);
  grantCamera();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('useQrScanner', () => {
  it('never asks for the camera on an insecure origin', async () => {
    // getUserMedia is unavailable outside a secure context, and this app is
    // explicitly playable over plain http on a LAN — so this is a normal
    // state to be in, not an error to swallow.
    setSecureContext(false);
    const getUserMedia = grantCamera();

    render(<Harness />);

    await waitFor(() => expect(status()).toBe('insecure'));
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('reports a browser with no camera API at all', async () => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });

    render(<Harness />);

    await waitFor(() => expect(status()).toBe('unsupported'));
  });

  it('stays idle until it is switched on', async () => {
    const getUserMedia = grantCamera();

    render(<Harness enabled={false} />);

    expect(status()).toBe('idle');
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('asks for the rear camera and starts scanning', async () => {
    const getUserMedia = grantCamera();

    render(<Harness />);

    await waitFor(() => expect(status()).toBe('scanning'));
    expect(getUserMedia).toHaveBeenCalledWith(
      expect.objectContaining({ video: expect.objectContaining({ facingMode: 'environment' }) })
    );
  });

  it('hands over whatever it decodes', async () => {
    const onDecode = vi.fn();
    render(<Harness onDecode={onDecode} />);
    await waitFor(() => expect(status()).toBe('scanning'));

    decoded.value = 'https://tutto.example.com/?room=ROOM1';
    await nextFrame();

    expect(onDecode).toHaveBeenCalledWith('https://tutto.example.com/?room=ROOM1');
  });

  it('does not report the same code again on every frame', async () => {
    // The camera keeps looking at it, sixty times a second. Reporting it each
    // time would re-fire the caller's handling of a code it already rejected.
    const onDecode = vi.fn();
    render(<Harness onDecode={onDecode} />);
    await waitFor(() => expect(status()).toBe('scanning'));

    decoded.value = 'https://tutto.example.com/?room=ROOM1';
    await nextFrame();
    await nextFrame();
    await nextFrame();

    expect(onDecode).toHaveBeenCalledTimes(1);
  });

  it('reports a different code once the camera is moved to one', async () => {
    const onDecode = vi.fn();
    render(<Harness onDecode={onDecode} />);
    await waitFor(() => expect(status()).toBe('scanning'));

    decoded.value = 'FIRST';
    await nextFrame();
    decoded.value = 'SECOND';
    await nextFrame();

    expect(onDecode).toHaveBeenNthCalledWith(1, 'FIRST');
    expect(onDecode).toHaveBeenNthCalledWith(2, 'SECOND');
  });

  it('decodes no more often than the interval, however fast frames arrive', async () => {
    // Reading the frame back and running jsQR over it is the expensive half of
    // this hook. At sixty frames a second it is the whole main thread of a
    // phone, for a code that is being held still in front of a camera.
    const onDecode = vi.fn();
    render(<Harness onDecode={onDecode} />);
    await waitFor(() => expect(status()).toBe('scanning'));

    decoded.value = 'FIRST';
    await nextFrame();
    decoded.value = 'SECOND';
    await nextFrame(1);

    expect(onDecode).toHaveBeenCalledTimes(1);

    await nextFrame(QR_DECODE_INTERVAL_MS);

    expect(onDecode).toHaveBeenNthCalledWith(2, 'SECOND');
  });

  it('does not wait out the interval before the first decode', async () => {
    // A player holding a code up to a just-opened scanner should not be made
    // to wait for a throttle that has nothing to throttle yet.
    const onDecode = vi.fn();
    render(<Harness onDecode={onDecode} />);
    await waitFor(() => expect(status()).toBe('scanning'));

    decoded.value = 'FIRST';
    await nextFrame(1);

    expect(onDecode).toHaveBeenCalledWith('FIRST');
  });

  it('resizes its canvas only when the frame size actually changes', async () => {
    // Assigning width resets the drawing buffer, so doing it per frame throws
    // away and reallocates the bitmap sixty times a second.
    const setWidth = vi.spyOn(HTMLCanvasElement.prototype, 'width', 'set');
    render(<Harness />);
    await waitFor(() => expect(status()).toBe('scanning'));

    await nextFrame();
    await nextFrame();
    expect(setWidth).toHaveBeenCalledTimes(1);

    video.width = 1280;
    await nextFrame();

    expect(setWidth).toHaveBeenCalledTimes(2);
  });

  it('waits for the camera to produce a frame before decoding', async () => {
    const onDecode = vi.fn();
    video.ready = 0;
    video.width = 0;
    video.height = 0;
    render(<Harness onDecode={onDecode} />);
    await waitFor(() => expect(status()).toBe('scanning'));

    decoded.value = 'https://tutto.example.com/?room=ROOM1';
    await nextFrame();

    expect(onDecode).not.toHaveBeenCalled();
  });

  it('reports a refused permission as refused, not as a failure', async () => {
    refuseCamera('NotAllowedError');

    render(<Harness />);

    await waitFor(() => expect(status()).toBe('denied'));
  });

  it('reports a device with no camera separately', async () => {
    refuseCamera('NotFoundError');

    render(<Harness />);

    await waitFor(() => expect(status()).toBe('no-camera'));
  });

  it('falls back to a generic failure for anything else', async () => {
    refuseCamera('NotReadableError');

    render(<Harness />);

    await waitFor(() => expect(status()).toBe('error'));
  });

  it('reports blocked playback as a failure rather than a refused camera', async () => {
    // The permission was granted and the camera is live by the time play() is
    // called, so a NotAllowedError from it is the autoplay policy. Reporting
    // that as 'denied' would tell a player they refused a camera whose
    // indicator light is on, and send them to a setting that is already right.
    video.canPlay = false;

    render(<Harness />);

    await waitFor(() => expect(status()).toBe('error'));
    expect(stopTrack).toHaveBeenCalled();
  });

  it('releases the camera when it is switched off', async () => {
    // Otherwise the indicator light stays on after the panel is closed, which
    // reads as the app still watching.
    const { rerender } = render(<Harness enabled />);
    await waitFor(() => expect(status()).toBe('scanning'));

    rerender(<Harness enabled={false} />);

    await waitFor(() => expect(stopTrack).toHaveBeenCalled());
    expect(status()).toBe('idle');
  });

  it('releases the camera on unmount', async () => {
    const { unmount } = render(<Harness />);
    await waitFor(() => expect(status()).toBe('scanning'));

    unmount();

    await waitFor(() => expect(stopTrack).toHaveBeenCalled());
  });

  it('releases a camera that arrived after it was already switched off', async () => {
    // getUserMedia resolves on its own schedule; a stream handed over after
    // teardown would otherwise be held open with nothing left to stop it.
    let handOverCamera!: (stream: MediaStream) => void;
    grantCamera(vi.fn(() => new Promise<MediaStream>(resolve => { handOverCamera = resolve; })));

    const { unmount } = render(<Harness />);
    await waitFor(() => expect(status()).toBe('starting'));
    unmount();

    await act(async () => {
      handOverCamera({ getTracks: () => [{ stop: stopTrack }] } as unknown as MediaStream);
    });

    expect(stopTrack).toHaveBeenCalled();
  });
});
