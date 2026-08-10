import { useEffect, useRef, useState, type RefObject } from 'react';

/**
 * What the scanner is doing, or why it is not doing it. Every non-scanning
 * state is something a player can act on, so each is reported separately
 * rather than collapsed into a single failure.
 */
export type ScannerStatus =
  | 'idle'
  | 'starting'
  | 'scanning'
  /** Not a secure context. getUserMedia is unavailable and cannot be asked for. */
  | 'insecure'
  /** No camera API in this browser at all. */
  | 'unsupported'
  | 'denied'
  | 'no-camera'
  | 'error';

// Plenty for a QR code held up on a phone screen, and small enough that
// decoding a frame is not the thing that drops the frame rate. Requested of the
// camera rather than downscaled afterwards.
const CAPTURE_WIDTH = 640;
const CAPTURE_HEIGHT = 480;

// HTMLMediaElement.HAVE_CURRENT_DATA — there is a frame to draw.
const HAVE_CURRENT_DATA = 2;

/**
 * How long to leave between decodes.
 *
 * Reading a frame back off the canvas and running jsQR over it costs tens of
 * milliseconds on the mid-range phone this is aimed at — done every animation
 * frame it is the entire main thread, and the device gets hot holding a camera
 * on a code that is not moving. Ten looks a second still reads as instant.
 */
export const QR_DECODE_INTERVAL_MS = 100;

const statusForCameraError = (error: unknown): ScannerStatus => {
  switch ((error as Error)?.name) {
    // SecurityError is how some browsers phrase a blocked permission.
    case 'NotAllowedError':
    case 'SecurityError':
      return 'denied';
    // OverconstrainedError here means no camera matched facingMode, which for
    // a player amounts to the same thing as having none.
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'no-camera';
    default:
      return 'error';
  }
};

interface QrScannerOptions {
  enabled: boolean;
  /** Called with the raw decoded text — validating it is the caller's job. */
  onDecode: (text: string) => void;
}

interface QrScanner {
  /** Attach to a `<video autoPlay muted playsInline>`. */
  videoRef: RefObject<HTMLVideoElement | null>;
  status: ScannerStatus;
}

/**
 * Drives the camera and decodes QR codes out of its frames.
 *
 * The decoder is imported lazily alongside the permission prompt: it is only
 * needed by someone who opened the scanner, and it is the larger half of this
 * feature.
 *
 * Note the deliberate absence of `BarcodeDetector`, which would avoid the
 * decoder entirely — it is Chromium-only, so on iOS it would silently mean no
 * scanner at all.
 */
export const useQrScanner = ({ enabled, onDecode }: QrScannerOptions): QrScanner => {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [cameraStatus, setCameraStatus] = useState<ScannerStatus>('starting');

  // Whether a camera could be used at all is fixed for the life of the page, so
  // it is read once and derived into the status rather than pushed there by an
  // effect — being switched off, or being on an origin that cannot ask, are not
  // things that happen to the camera.
  const [availability] = useState<'ok' | 'insecure' | 'unsupported'>(() => {
    if (!window.isSecureContext) return 'insecure';
    if (!navigator.mediaDevices?.getUserMedia) return 'unsupported';
    return 'ok';
  });

  // Held in a ref so a caller passing an inline handler does not tear the
  // camera down and re-request permission on every render.
  const onDecodeRef = useRef(onDecode);
  useEffect(() => {
    onDecodeRef.current = onDecode;
  });

  useEffect(() => {
    if (!enabled || availability !== 'ok') return;

    let stopped = false;
    let stream: MediaStream | null = null;
    let frame: number | null = null;
    // The camera keeps looking at a code long after it is decoded; without
    // this the caller re-handles the same text sixty times a second.
    let lastDecoded: string | null = null;
    // The frame timestamp the last decode ran on, or null while none has. Taken
    // from the one requestAnimationFrame hands over rather than a clock read of
    // its own — it is the time that frame is being drawn for.
    let lastDecodedAt: number | null = null;

    const release = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      stream?.getTracks().forEach(track => track.stop());
      stream = null;
    };

    const start = async () => {
      // Also resets a previous run's outcome, so re-opening after a refused
      // permission does not show the refusal until it is refused again.
      setCameraStatus('starting');

      // Kicked off first so the chunk downloads while the permission prompt
      // is up. The no-op catch keeps its rejection from surfacing as
      // unhandled when getUserMedia fails first; the real handling is the
      // await further down.
      const modulePromise = import('jsqr');
      modulePromise.catch(() => {});

      const media = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: 'environment',
          width: { ideal: CAPTURE_WIDTH },
          height: { ideal: CAPTURE_HEIGHT },
        },
      });

      // The stream resolves on its own schedule: the panel may already be
      // closed, and a stream nobody holds a reference to keeps the camera on.
      if (stopped) {
        media.getTracks().forEach(track => track.stop());
        return;
      }
      // Held from the moment the camera grants it — if the decoder chunk
      // then fails to load (offline, stale SW precache: the failure
      // RoomQrCode anticipates for its own chunk), the catch's release()
      // must have tracks to stop, or the camera light stays on behind the
      // error panel until a page reload.
      stream = media;

      const { default: jsQR } = await modulePromise;
      if (stopped) return;

      const video = videoRef.current;
      if (!video) {
        release();
        return;
      }
      video.srcObject = media;
      // Kept away from statusForCameraError deliberately. A browser refusing to
      // play the stream inline rejects with NotAllowedError too, and the camera
      // is granted and running by now — calling that 'denied' would tell the
      // player they refused a camera whose indicator light is on, and send them
      // to a permission setting that is already correct.
      const playing = await video.play().then(() => true, () => false);
      if (stopped) return;
      if (!playing) {
        setCameraStatus('error');
        release();
        return;
      }
      setCameraStatus('scanning');

      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) {
        setCameraStatus('error');
        release();
        return;
      }

      const scanFrame = (time: number) => {
        frame = requestAnimationFrame(scanFrame);

        const width = video.videoWidth;
        const height = video.videoHeight;
        if (video.readyState < HAVE_CURRENT_DATA || !width || !height) return;
        // Counted from the last decode rather than the last frame, so the first
        // one after the camera warms up is not made to wait out an interval.
        if (lastDecodedAt !== null && time - lastDecodedAt < QR_DECODE_INTERVAL_MS) return;
        lastDecodedAt = time;

        // Assigning either of these throws the drawing buffer away and
        // allocates a new one, so it is worth not doing per frame.
        if (canvas.width !== width || canvas.height !== height) {
          canvas.width = width;
          canvas.height = height;
        }
        context.drawImage(video, 0, 0, width, height);
        const { data } = context.getImageData(0, 0, width, height);

        // dontInvert: an inverted QR is not something a phone screen produces,
        // and the extra passes cost a frame's worth of time each.
        const found = jsQR(data, width, height, { inversionAttempts: 'dontInvert' });
        if (!found?.data || found.data === lastDecoded) return;

        lastDecoded = found.data;
        onDecodeRef.current(found.data);
      };

      // Scheduled rather than called: every run is then a real frame with the
      // timestamp the throttle above measures from.
      frame = requestAnimationFrame(scanFrame);
    };

    start().catch((error: unknown) => {
      if (stopped) return;
      setCameraStatus(statusForCameraError(error));
      release();
    });

    return () => {
      stopped = true;
      release();
    };
  }, [enabled, availability]);

  const status: ScannerStatus = !enabled
    ? 'idle'
    : availability !== 'ok' ? availability : cameraStatus;

  return { videoRef, status };
};
