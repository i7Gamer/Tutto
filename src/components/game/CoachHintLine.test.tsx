import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
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
  // The spy is hoisted once for the whole file, so without this every
  // negative assertion below ("never interpolated a bank") would be reading
  // the calls of the tests before it as well as its own.
  beforeEach(() => translate.mockClear());

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
    stopMeans: 'bank',
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

  // S-3: bustPercent/rollValue/threshold are null when the coach's own roll
  // was not on offer (a completed card, nothing left to roll) — the stop copy
  // must drop the risk clause instead of quoting figures for a roll that was
  // never possible.
  it('renders the no-roll stop verdict when there is no bust risk to quote', () => {
    render(<CoachHintLine hint={{
      ...baseHint, action: 'stop', bustPercent: null, rollValue: null, threshold: null,
    }} />);

    expect(screen.getByText('coach.stopNoRoll')).toBeInTheDocument();
    expect(translate).toHaveBeenCalledWith(
      'coach.stopNoRoll',
      expect.any(String),
      expect.objectContaining({ keep: '1, 5', bank: 150 }),
    );
    expect(screen.queryByText('coach.stop')).toBeNull();
  });

  // Kniffel, Plus/Minus and Feuerwerk withhold the Stop button while the card
  // is unfinished, so coachHint hands back null roll figures there: the line
  // must advise the roll on its own rather than measure it against a bank
  // nobody can take.
  it('drops the banking comparison when there is no bank to compare against', () => {
    render(<CoachHintLine hint={{ ...baseHint, rollValue: null, threshold: null }} />);

    expect(screen.getByText('coach.rollNoBank')).toBeInTheDocument();
    expect(translate).toHaveBeenCalledWith(
      'coach.rollNoBank',
      expect.any(String),
      expect.objectContaining({ keep: '1, 5', dice: 4, bust: 20 }),
    );
    expect(screen.queryByText('coach.roll')).toBeNull();
  });

  // Both figures are rounded for display, so a near-tie prints as the same
  // number twice ("worth 217 against 217") and reads like a coin flip.
  it('says rolling is worth about the same when the two figures round together', () => {
    render(<CoachHintLine hint={{ ...baseHint, rollValue: 217.4, threshold: 217.2 }} />);

    expect(screen.getByText('coach.rollTie')).toBeInTheDocument();
    expect(screen.queryByText('coach.roll')).toBeNull();
  });

  it('quotes both figures when they actually differ', () => {
    render(<CoachHintLine hint={{ ...baseHint, rollValue: 217.4, threshold: 300.2 }} />);

    expect(screen.getByText('coach.roll')).toBeInTheDocument();
    expect(translate).toHaveBeenCalledWith(
      'coach.roll',
      expect.any(String),
      expect.objectContaining({ rollValue: 217, threshold: 300 }),
    );
  });

  // A Kleeblatt's Stop button rolls the second tutto, then wins the game —
  // neither is a bank, and neither may be described with one.
  it('calls the first Kleeblatt tutto a second tutto, with no bank figure', () => {
    render(<CoachHintLine hint={{ ...baseHint, action: 'stop', stopMeans: 'secondTutto' }} />);

    expect(screen.getByText('coach.secondTutto')).toBeInTheDocument();
    expect(screen.queryByText('coach.stop')).toBeNull();
    expect(screen.queryByText('coach.stopNoRoll')).toBeNull();
    expect(translate).not.toHaveBeenCalledWith(
      expect.stringContaining('coach.'),
      expect.any(String),
      expect.objectContaining({ bank: expect.anything() }),
    );
  });

  it('calls the second Kleeblatt tutto a win, with no bank figure', () => {
    render(<CoachHintLine hint={{ ...baseHint, action: 'stop', stopMeans: 'winGame' }} />);

    expect(screen.getByText('coach.winGame')).toBeInTheDocument();
    expect(screen.queryByText('coach.stop')).toBeNull();
    expect(translate).not.toHaveBeenCalledWith(
      expect.stringContaining('coach.'),
      expect.any(String),
      expect.objectContaining({ bank: expect.anything() }),
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
