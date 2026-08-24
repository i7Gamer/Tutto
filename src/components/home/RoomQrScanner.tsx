import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { X } from 'lucide-react';
import { useQrScanner } from '../../hooks/useQrScanner';
import { readScannedLink } from '../../utils/roomLink';
import {
  STATUS_MESSAGES, REJECTION_MESSAGES, type ScannerMessage,
} from '../../utils/scannerMessages';

interface RoomQrScannerProps {
  /** Called with a room code from an invite for this same deployment. */
  onRoomScanned: (roomId: string) => void;
  onClose: () => void;
}

/**
 * Reads a room out of a QR code shown on someone else's screen.
 *
 * A phone's own camera app opens an invite link without Tutto being involved at
 * all, which needs no permission and works on a plain-http LAN — this exists
 * for the player who already has Tutto open and would rather not leave it.
 */
export default function RoomQrScanner({ onRoomScanned, onClose }: RoomQrScannerProps) {
  const { t } = useTranslation();
  const [rejection, setRejection] = useState<ScannerMessage | null>(null);

  const handleDecode = useCallback((text: string) => {
    const scanned = readScannedLink(text, window.location.href);
    if (scanned.kind === 'room') {
      setRejection(null);
      onRoomScanned(scanned.roomId);
      return;
    }
    setRejection(REJECTION_MESSAGES[scanned.kind]);
  }, [onRoomScanned]);

  const { videoRef, status } = useQrScanner({ enabled: true, onDecode: handleDecode });
  const message = STATUS_MESSAGES[status];

  return (
    <div className="mt-3 flex flex-col items-center gap-2 rounded-xl border border-gray-200 dark:border-slate-700 p-3">
      <div className="flex items-center justify-between w-full">
        <span className="text-xs font-bold uppercase tracking-wider text-gray-500 dark:text-gray-400">
          {t('lobby.online.scanQr', 'Scan a QR code')}
        </span>
        <button
          onClick={onClose}
          title={t('lobby.online.scanClose', 'Close scanner')}
          aria-label={t('lobby.online.scanClose', 'Close scanner')}
          className="p-1 rounded-lg text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors"
        >
          <X size={16} />
        </button>
      </div>

      {status === 'scanning' || status === 'starting' ? (
        <video
          ref={videoRef}
          // muted + playsInline or iOS takes the stream fullscreen in its own
          // player, where there is no frame for the decoder to read.
          autoPlay
          muted
          playsInline
          className="w-full max-w-xs aspect-square object-cover rounded-lg bg-black"
        />
      ) : null}

      {/* One always-mounted live region around both, following
          CurrentRollBoard. Two of these transitions are genuinely silent
          otherwise: starting → denied/no-camera/error once getUserMedia
          settles (the video simply disappears), and the rejection the decode
          loop sets. Focus at that moment is on the scan toggle, outside this
          subtree, and the join form's live region is wired to a different
          value. A region that appears together with its content is not
          reliably announced, so it stays mounted and empty. */}
      <div role="status" aria-live="polite" className="contents">
        {message && (
          <p className="text-xs text-center text-gray-600 dark:text-gray-300 max-w-xs">
            {t(message.key, message.fallback)}
          </p>
        )}
        {rejection && (
          <p className="text-xs text-center text-amber-600 dark:text-amber-400 max-w-xs">
            {t(rejection.key, rejection.fallback)}
          </p>
        )}
      </div>
    </div>
  );
}
