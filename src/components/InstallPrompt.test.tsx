import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import InstallPrompt from './InstallPrompt';
import { localStore } from '../utils/storage';
import {
  HAS_FINISHED_GAME_KEY, INSTALL_PROMPT_DISMISSED_KEY, INSTALL_PROMPT_FLAG_VALUE,
} from '../utils/installPrompt';

const IPHONE_SAFARI_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1';

class FakeBeforeInstallPromptEvent extends Event {
  prompt = vi.fn(() => Promise.resolve());
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
  constructor(outcome: 'accepted' | 'dismissed' = 'accepted') {
    super('beforeinstallprompt', { cancelable: true });
    this.userChoice = Promise.resolve({ outcome });
  }
}

const markFinishedGame = () => localStore.write(HAS_FINISHED_GAME_KEY, INSTALL_PROMPT_FLAG_VALUE);
const setUserAgent = (ua: string) =>
  Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true });
const originalUA = window.navigator.userAgent;

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  setUserAgent(originalUA);
});

describe('InstallPrompt', () => {
  it('renders nothing before this device has finished a game', () => {
    const { container } = render(<InstallPrompt />);

    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing on a browser with neither a native event nor iOS Safari', () => {
    markFinishedGame();

    const { container } = render(<InstallPrompt />);

    expect(container).toBeEmptyDOMElement();
  });

  it('shows the native card once Chromium offers beforeinstallprompt, and Install calls prompt()', async () => {
    markFinishedGame();
    render(<InstallPrompt />);
    const event = new FakeBeforeInstallPromptEvent('accepted');
    act(() => { window.dispatchEvent(event); });

    expect(screen.getByRole('region')).toBeInTheDocument();
    const installButton = screen.getByRole('button', { name: 'installPrompt.installButton' });

    fireEvent.click(installButton);

    expect(event.prompt).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(localStore.read(INSTALL_PROMPT_DISMISSED_KEY)).toBe(INSTALL_PROMPT_FLAG_VALUE);
    });
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });

  it('shows the iOS instructions on Mobile Safari with no native event', () => {
    markFinishedGame();
    setUserAgent(IPHONE_SAFARI_UA);

    render(<InstallPrompt />);

    expect(screen.getByRole('region')).toBeInTheDocument();
    expect(screen.getByText('installPrompt.iosBody')).toBeInTheDocument();
    // The native-only Install button never renders for the iOS variant —
    // there is no beforeinstallprompt event to call prompt() on.
    expect(screen.queryByRole('button', { name: 'installPrompt.installButton' })).not.toBeInTheDocument();
  });

  it('dismiss hides the card and writes the permanent flag', () => {
    markFinishedGame();
    setUserAgent(IPHONE_SAFARI_UA);
    render(<InstallPrompt />);
    expect(screen.getByRole('region')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'installPrompt.dismissLabel' }));

    expect(localStore.read(INSTALL_PROMPT_DISMISSED_KEY)).toBe(INSTALL_PROMPT_FLAG_VALUE);
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
  });
});
