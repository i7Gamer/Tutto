import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import CoachHintLine from './CoachHintLine';
import type { CoachHint } from '../../utils/coachHint';

// The shared setup mock (src/setupTests.tsx) renders every message as its
// bare key and drops the interpolation values — the same reasoning
// HistoryLog.test.tsx documents. `t` itself is the only place the numbers
// behind Otto's advice are observable, so this file replaces it with a spy
// that still returns the bare key (every screen.getByText below keeps
// working) but also records what it was called with.
const { translate } = vi.hoisted(() => ({
  translate: vi.fn<(key: string, fallback?: string, opts?: Record<string, unknown>) => string>(key => key),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: translate,
    i18n: { changeLanguage: () => Promise.resolve() },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

describe('CoachHintLine', () => {
  const baseHint: CoachHint = {
    action: 'roll',
    keep: [1, 5],
    diceAfter: 4,
    bank: 150,
    bustPercent: 20,
    rollValue: 217,
    threshold: 300,
    trailing: false,
    selectionDiffers: false,
  };

  it('renders nothing when there is no hint', () => {
    const { container } = render(<CoachHintLine hint={null} />);
    expect(container.firstChild).toBeNull();
  });

  it('renders the roll verdict with its numbers', () => {
    render(<CoachHintLine hint={baseHint} />);

    expect(screen.getByText('coach.roll')).toBeInTheDocument();
    expect(translate).toHaveBeenCalledWith(
      'coach.roll',
      expect.any(String),
      expect.objectContaining({ keep: '1, 5', dice: 4, bust: 20, rollValue: 217, threshold: 300 }),
    );
  });

  it('renders the stop verdict with its numbers', () => {
    render(<CoachHintLine hint={{ ...baseHint, action: 'stop' }} />);

    expect(screen.getByText('coach.stop')).toBeInTheDocument();
    expect(translate).toHaveBeenCalledWith(
      'coach.stop',
      expect.any(String),
      expect.objectContaining({ keep: '1, 5', bank: 150, bust: 20, dice: 4 }),
    );
  });

  it('renders the draw verdict with the bank at stake', () => {
    render(<CoachHintLine hint={{ ...baseHint, action: 'draw', bank: 450 }} />);

    expect(screen.getByText('coach.draw')).toBeInTheDocument();
    expect(translate).toHaveBeenCalledWith('coach.draw', expect.any(String), expect.objectContaining({ bank: 450 }));
  });

  it('prefixes the line when the player has tapped a different die than Otto would keep', () => {
    render(<CoachHintLine hint={{ ...baseHint, selectionDiffers: true }} />);
    expect(screen.getByText('coach.selectionDiffers')).toBeInTheDocument();
  });

  it('omits the selectionDiffers prefix when the player matches Otto', () => {
    render(<CoachHintLine hint={{ ...baseHint, selectionDiffers: false }} />);
    expect(screen.queryByText('coach.selectionDiffers')).toBeNull();
  });

  it('appends the trailing clause once Otto is taking on more risk', () => {
    render(<CoachHintLine hint={{ ...baseHint, trailing: true }} />);
    expect(screen.getByText('coach.trailing')).toBeInTheDocument();
  });

  it('omits the trailing clause while level with or ahead of the leader', () => {
    render(<CoachHintLine hint={{ ...baseHint, trailing: false }} />);
    expect(screen.queryByText('coach.trailing')).toBeNull();
  });
});
