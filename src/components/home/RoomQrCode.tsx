import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

// Rendered at this many device pixels per QR module, with a quiet zone of this
// many modules. The image is displayed smaller than it is generated so it stays
// sharp on a high-density phone screen, which is the screen being scanned.
const QR_CELL_SIZE_PX = 6;
const QR_QUIET_ZONE_MODULES = 2;
// Recovers from ~15% damage. Enough for a fingerprinted phone screen without
// pushing the code to a denser version than a camera can resolve.
const QR_ERROR_CORRECTION = 'M';
// 0 picks the smallest version that fits the data.
const QR_AUTO_VERSION = 0;

// Hosts that resolve to the scanning device itself. A link built from one of
// them points a guest's phone at its own machine.
const LOOPBACK_HOSTNAMES = ['localhost', '127.0.0.1', '[::1]', '::1'];

interface RoomQrCodeProps {
  /** The full invite link (see buildRoomLink) — a URL, not a room code. */
  link: string;
}

const isLoopback = (link: string): boolean => {
  try {
    return LOOPBACK_HOSTNAMES.includes(new URL(link).hostname);
  } catch {
    return false;
  }
};

/**
 * The invite link as a QR code, for the case the link was built for: two phones
 * at the same table.
 *
 * The encoder is imported lazily. It is only ever needed by a host who opened
 * this panel, so it has no business in the bundle every player downloads.
 */
export default function RoomQrCode({ link }: RoomQrCodeProps) {
  const { t } = useTranslation();
  const [imageSrc, setImageSrc] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    void import('qrcode-generator').then(({ default: qrcode }) => {
      if (cancelled) return;
      const qr = qrcode(QR_AUTO_VERSION, QR_ERROR_CORRECTION);
      qr.addData(link);
      qr.make();
      setImageSrc(qr.createDataURL(QR_CELL_SIZE_PX, QR_QUIET_ZONE_MODULES));
    }).catch((e: unknown) => {
      // A failed chunk load (offline, or a stale service worker precache) must
      // not take the lobby down — the link and the room code are both still on
      // screen right above this.
      console.error('Failed to load the QR encoder', e);
    });

    return () => { cancelled = true; };
  }, [link]);

  return (
    <div className="flex flex-col items-center gap-2 mt-3">
      {/* White regardless of theme: a QR code needs a light quiet zone, and
          inverting one is not reliably readable. */}
      <div className="bg-white p-3 rounded-xl border border-gray-200 dark:border-slate-600">
        {imageSrc
          ? (
            <img
              src={imageSrc}
              alt={t('lobby.online.qrAlt', 'QR code for this room')}
              className="w-40 h-40 sm:w-48 sm:h-48 [image-rendering:pixelated]"
            />
          )
          : <div className="w-40 h-40 sm:w-48 sm:h-48 animate-pulse bg-gray-100 rounded-lg" />}
      </div>
      {isLoopback(link) && (
        <p className="text-xs text-amber-600 dark:text-amber-400 text-center max-w-xs">
          {t(
            'lobby.online.qrLocalhostWarning',
            'This link points at this device only. Open Tutto on your network address for a code others can scan.'
          )}
        </p>
      )}
    </div>
  );
}
