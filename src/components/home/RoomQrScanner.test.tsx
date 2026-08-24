import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import RoomQrScanner from './RoomQrScanner';
import type { ScannerStatus } from '../../hooks/useQrScanner';

// The hook drives a real camera and is covered on its own; here it is a dial
// for the two things this component is responsible for — turning a status into
// something a player can act on, and turning decoded text into a room or a
// reason why not.
const scanner = vi.hoisted(() => ({
  status: 'scanning' as ScannerStatus,
  decode: (() => {}) as (text: string) => void,
}));

vi.mock('../../hooks/useQrScanner', () => ({
  useQrScanner: ({ onDecode }: { onDecode: (text: string) => void }) => {
    scanner.decode = onDecode;
    return { videoRef: { current: null }, status: scanner.status };
  },
}));

const scan = (text: string) => act(() => { scanner.decode(text); });

const renderScanner = (onRoomScanned = vi.fn()) => {
  render(<RoomQrScanner onRoomScanned={onRoomScanned} onClose={vi.fn()} />);
  return onRoomScanned;
};

beforeEach(() => {
  scanner.status = 'scanning';
  window.history.replaceState({}, '', '/');
});

describe('RoomQrScanner', () => {
  it.each([
    ['insecure', 'lobby.online.scanInsecure'],
    ['unsupported', 'lobby.online.scanUnsupported'],
    ['denied', 'lobby.online.scanDenied'],
    ['no-camera', 'lobby.online.scanNoCamera'],
    ['error', 'lobby.online.scanError'],
    ['starting', 'lobby.online.scanStarting'],
    ['scanning', 'lobby.online.scanHint'],
  ] as [ScannerStatus, string][])('says what is happening while %s', (status, message) => {
    scanner.status = status;

    renderScanner();

    expect(screen.getByText(message)).toBeInTheDocument();
  });

  it('reports the room from an invite for this server', () => {
    const onRoomScanned = renderScanner();

    scan(`${window.location.origin}/?room=ROOM1`);

    expect(onRoomScanned).toHaveBeenCalledWith('ROOM1');
  });

  it('refuses an invite pointing at a different server, and says so', () => {
    // Never navigates to a scanned URL, and never lifts a room code out of
    // one — that would join a same-named room on the wrong server.
    const onRoomScanned = renderScanner();

    scan('https://somewhere.else.example/?room=ROOM1');

    expect(onRoomScanned).not.toHaveBeenCalled();
    expect(screen.getByText('lobby.online.scanForeignOrigin')).toBeInTheDocument();
  });

  it('says so when the code is not an invite at all', () => {
    const onRoomScanned = renderScanner();

    scan('WIFI:S=coffee;;');

    expect(onRoomScanned).not.toHaveBeenCalled();
    expect(screen.getByText('lobby.online.scanNotAnInvite')).toBeInTheDocument();
  });

  // Both async channels rendered into plain <p>s. The insecure/unsupported
  // messages are computed at mount, so those were only a discoverability nit;
  // the genuinely silent transitions are starting → denied/no-camera/error
  // once getUserMedia settles (the video just disappears) and the rejection
  // the decode loop sets. Focus is on the scan toggle at that moment, outside
  // this subtree, and the join form's live region watches a different value.
  describe('announcing what the camera is doing', () => {
    it('reports the status through a polite live region', () => {
      scanner.status = 'starting';

      renderScanner();

      const region = screen.getByRole('status');
      expect(region).toHaveAttribute('aria-live', 'polite');
      expect(region).toHaveTextContent('lobby.online.scanStarting');
    });

    it('keeps the region mounted so a LATER failure is announced', () => {
      // A region announced into existence alongside its own content is not
      // reliably read out — it has to be there before the text changes.
      const { rerender } = render(<RoomQrScanner onRoomScanned={vi.fn()} onClose={vi.fn()} />);
      const before = screen.getByRole('status');

      scanner.status = 'denied';
      rerender(<RoomQrScanner onRoomScanned={vi.fn()} onClose={vi.fn()} />);

      expect(screen.getByRole('status')).toBe(before);
      expect(screen.getByRole('status')).toHaveTextContent('lobby.online.scanDenied');
    });

    it('announces a rejected code through the same region', () => {
      renderScanner();

      scan('WIFI:S=coffee;;');

      expect(screen.getByRole('status')).toHaveTextContent('lobby.online.scanNotAnInvite');
    });
  });

  it('clears a rejection once a good code is scanned', () => {
    const onRoomScanned = renderScanner();

    scan('WIFI:S=coffee;;');
    expect(screen.getByText('lobby.online.scanNotAnInvite')).toBeInTheDocument();

    scan(`${window.location.origin}/?room=ROOM1`);

    expect(screen.queryByText('lobby.online.scanNotAnInvite')).not.toBeInTheDocument();
    expect(onRoomScanned).toHaveBeenCalledWith('ROOM1');
  });
});
