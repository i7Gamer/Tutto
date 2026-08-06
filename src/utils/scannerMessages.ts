// The strings RoomQrScanner can put on screen, kept out of the component the
// way recentRooms.ts is: a component module may only export components
// (react-refresh/only-export-components), and the key list below has to be
// importable by a test.

import type { ScannerStatus } from '../hooks/useQrScanner';

export interface ScannerMessage {
  key: string;
  fallback: string;
}

/**
 * What to tell the player for each state the camera can be in. Every one of
 * these is actionable — grant the permission, use a different device, reach the
 * app over https — so none of them collapses into "something went wrong".
 */
export const STATUS_MESSAGES: Record<ScannerStatus, ScannerMessage | null> = {
  idle: null,
  starting: { key: 'lobby.online.scanStarting', fallback: 'Starting the camera…' },
  scanning: { key: 'lobby.online.scanHint', fallback: 'Point at the QR code on the other device' },
  insecure: {
    key: 'lobby.online.scanInsecure',
    fallback: 'Scanning needs a secure connection. Open Tutto over https, or type the room code in instead.',
  },
  unsupported: {
    key: 'lobby.online.scanUnsupported',
    fallback: 'This browser cannot use the camera. Type the room code in instead.',
  },
  denied: {
    key: 'lobby.online.scanDenied',
    fallback: 'Camera access was refused. Allow it in your browser settings, or type the room code in instead.',
  },
  'no-camera': {
    key: 'lobby.online.scanNoCamera',
    fallback: 'No camera found on this device. Type the room code in instead.',
  },
  error: {
    key: 'lobby.online.scanError',
    fallback: 'The camera could not be started. Type the room code in instead.',
  },
};

/** Why a decoded code did not become a room. */
export const REJECTION_MESSAGES: Record<'foreign-origin' | 'not-an-invite', ScannerMessage> = {
  'foreign-origin': {
    key: 'lobby.online.scanForeignOrigin',
    fallback: 'That invite is for a different Tutto server.',
  },
  'not-an-invite': {
    key: 'lobby.online.scanNotAnInvite',
    fallback: 'That is not a Tutto invite.',
  },
};

/**
 * Every translation key the scanner can ask for.
 *
 * These are looked up from the tables above rather than written out at each
 * call site, and locales/translations.test.ts only sees keys written out — so
 * scannerMessages.test.ts checks these against both locales instead.
 */
export const SCANNER_MESSAGE_KEYS: string[] = [
  ...Object.values(STATUS_MESSAGES).filter((message): message is ScannerMessage => message !== null),
  ...Object.values(REJECTION_MESSAGES),
].map(message => message.key);
