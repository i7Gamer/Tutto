import { render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import RoomQrCode from './RoomQrCode';

// The real encoder is loaded lazily, which a test should not have to await for
// the sake of asserting what got encoded.
const { encoded, addData, make, createDataURL } = vi.hoisted(() => ({
  encoded: [] as string[],
  addData: vi.fn(),
  make: vi.fn(),
  createDataURL: vi.fn(() => 'data:image/gif;base64,STUB'),
}));

vi.mock('qrcode-generator', () => ({
  default: () => ({
    addData: (text: string) => { encoded.push(text); addData(text); },
    make,
    createDataURL,
  }),
}));

beforeEach(() => {
  encoded.length = 0;
  vi.clearAllMocks();
});

describe('RoomQrCode', () => {
  it('encodes the invite link itself, not the room code', async () => {
    // The point of the QR is that a phone's own camera app can open it with
    // Tutto uninvolved — which only works if it carries a URL.
    render(<RoomQrCode link="https://tutto.example.com/?room=ROOM1" />);

    // Encoding waits on the lazily imported encoder.
    await waitFor(() => expect(encoded).toEqual(['https://tutto.example.com/?room=ROOM1']));
  });

  it('renders the generated code once the encoder has loaded', async () => {
    render(<RoomQrCode link="https://tutto.example.com/?room=ROOM1" />);

    const image = await screen.findByAltText('lobby.online.qrAlt');
    expect(image).toHaveAttribute('src', 'data:image/gif;base64,STUB');
  });

  it('re-encodes when the room changes', async () => {
    const { rerender } = render(<RoomQrCode link="https://tutto.example.com/?room=ROOM1" />);
    await screen.findByAltText('lobby.online.qrAlt');

    rerender(<RoomQrCode link="https://tutto.example.com/?room=ROOM2" />);

    await waitFor(() => expect(encoded).toContain('https://tutto.example.com/?room=ROOM2'));
  });

  it.each(['http://localhost:3001/?room=R', 'http://127.0.0.1:3001/?room=R'])(
    'warns that %s is useless to anyone else',
    async link => {
      // The link is built from the page's own URL, so a host who reached the
      // app on localhost produces a QR that resolves to the scanner's own
      // phone. Silently handing that around is the trap worth calling out.
      render(<RoomQrCode link={link} />);

      expect(await screen.findByText('lobby.online.qrLocalhostWarning')).toBeInTheDocument();
    }
  );

  it('keeps a gap under the code', async () => {
    // The paragraph the lobby puts below this panel has no top margin, so
    // without one here the code sits flush against it — cramped on a phone,
    // where the whole lobby is already stacked tight.
    const { container } = render(<RoomQrCode link="https://tutto.example.com/?room=ROOM1" />);
    await screen.findByAltText('lobby.online.qrAlt');

    expect(container.firstElementChild.className).toContain('mb-4');
  });

  it('shows no warning for an address other devices can reach', async () => {
    render(<RoomQrCode link="http://192.168.1.5:3001/?room=R" />);
    await screen.findByAltText('lobby.online.qrAlt');

    expect(screen.queryByText('lobby.online.qrLocalhostWarning')).not.toBeInTheDocument();
  });
});
