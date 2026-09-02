import { render, screen } from '@testing-library/react';
import { PropsWithChildren } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import HistoryLog from './HistoryLog';
import { useGameStore } from '../../store/useGameStore';
import { PLUS_MINUS_SCORE } from '../../utils/coreGameEngine';
import type { HistoryEntry } from '../../types';

// The shared setup mock (src/setupTests.tsx) renders every message as its bare
// key and drops the interpolation values, so a deducted AMOUNT never reaches
// the DOM here. `t` itself is therefore the only place the number the player
// reads is observable — same mock behaviour (key in, key out) so every
// which-message-was-chosen assertion below is unaffected.
const { translate } = vi.hoisted(() => ({
  translate: vi.fn<(key: string, opts?: Record<string, unknown>) => string>(key => key),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: translate,
    i18n: { changeLanguage: () => Promise.resolve() },
  }),
  initReactI18next: { type: '3rdParty', init: () => {} },
}));

vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, ...props }: PropsWithChildren<Record<string, unknown>>) => {
      const cleanProps = { ...props };
      delete cleanProps.layout;
      delete cleanProps.transition;
      delete cleanProps.initial;
      delete cleanProps.animate;
      delete cleanProps.exit;
      return <div {...cleanProps}>{children}</div>;
    },
  },
  AnimatePresence: ({ children }: PropsWithChildren) => <>{children}</>,
}));

describe('HistoryLog', () => {
  beforeEach(() => {
    translate.mockClear();
  });

  it('renders empty state message when historyLog is empty', () => {
    useGameStore.setState({ historyLog: [] });
    render(<HistoryLog />);
    expect(screen.getByText('history.empty')).toBeInTheDocument();
  });

  // The columns are Round and Event, and they used to ask for them with
  // t('game.pos', 'Rnd') / t('game.player', 'Event') — keys that exist
  // (the scoreboard's "Pos"/"Player" headers), so i18next returned THOSE and
  // the fallbacks here were dead. Asserting on the keys, not the rendered
  // words, is what catches it: the mock echoes the key, so borrowing a
  // scoreboard key again fails here rather than silently mislabelling the log.
  it('heads its columns with its own round/event keys, not the scoreboard ones', () => {
    useGameStore.setState({ historyLog: [] });
    render(<HistoryLog />);

    expect(screen.getByText('history.colRound')).toBeInTheDocument();
    expect(screen.getByText('history.colEvent')).toBeInTheDocument();
    expect(translate).not.toHaveBeenCalledWith('game.pos', expect.anything());
    expect(translate).not.toHaveBeenCalledWith('game.player', expect.anything());
  });

  it('renders a skip entry correctly', () => {
    const entry: HistoryEntry = {
      id: '1-Alice-1',
      round: 1,
      playerName: 'Alice',
      card: 'Stop',
      type: 'skip',
      score: 0,
    };
    useGameStore.setState({ historyLog: [entry] });
    render(<HistoryLog />);
    
    expect(screen.queryByText('history.empty')).not.toBeInTheDocument();
    expect(screen.getByText('history.skip')).toBeInTheDocument();
  });

  it('renders a bust entry correctly', () => {
    const entry: HistoryEntry = {
      id: '1-Alice-1',
      round: 1,
      playerName: 'Alice',
      card: 'x2',
      type: 'bust',
      score: 0,
    };
    useGameStore.setState({ historyLog: [entry] });
    render(<HistoryLog />);
    
    expect(screen.getByText('history.bust')).toBeInTheDocument();
  });

  // A dedicated wording for a turn the server's clock forfeited: no dice bust
  // happened, so the log must not print "busted on X" (history.bust) or claim
  // an ordinary success worth 0 points (history.success) for it.
  it('renders a timeout entry with its own wording, not bust or success', () => {
    const entry: HistoryEntry = {
      id: '1-Alice-1',
      round: 1,
      playerName: 'Alice',
      card: '300',
      type: 'timeout',
      score: 0,
    };
    useGameStore.setState({ historyLog: [entry] });
    render(<HistoryLog />);

    expect(screen.getByText('history.timeout')).toBeInTheDocument();
    expect(screen.queryByText('history.bust')).not.toBeInTheDocument();
    expect(screen.queryByText('history.success')).not.toBeInTheDocument();
  });

  it('renders a fail entry correctly', () => {
    const entry: HistoryEntry = {
      id: '1-Alice-1',
      round: 1,
      playerName: 'Alice',
      card: 'Kniffel',
      type: 'fail',
      score: 0,
    };
    useGameStore.setState({ historyLog: [entry] });
    render(<HistoryLog />);
    
    expect(screen.getByText('history.fail')).toBeInTheDocument();
  });

  it('renders a standard success entry correctly', () => {
    const entry: HistoryEntry = {
      id: '1-Alice-1',
      round: 1,
      playerName: 'Alice',
      card: '300',
      type: 'success',
      score: 500,
    };
    useGameStore.setState({ historyLog: [entry] });
    render(<HistoryLog />);
    
    expect(screen.getByText('history.success')).toBeInTheDocument();
  });

  it('renders a Kleeblatt success entry correctly', () => {
    const entry: HistoryEntry = {
      id: '1-Alice-1',
      round: 1,
      playerName: 'Alice',
      card: 'Kleeblatt',
      type: 'success',
      score: 0,
    };
    useGameStore.setState({ historyLog: [entry] });
    render(<HistoryLog />);
    
    expect(screen.getByText('history.kleeblatt')).toBeInTheDocument();
  });

  it('renders a Plus_Minus success with deducted players correctly', () => {
    const entry: HistoryEntry = {
      id: '1-Alice-1',
      round: 1,
      playerName: 'Alice',
      card: 'Plus_Minus',
      type: 'success',
      score: 1000,
      deductedPlayers: ['Bob', 'Charlie'],
    };
    useGameStore.setState({ historyLog: [entry] });
    render(<HistoryLog />);

    expect(screen.getByText('history.plusMinusDeducted')).toBeInTheDocument();
  });

  // A multi-card turn only ever reaches the chain branch, which reported the
  // score and the cards and said nothing about the ±1000s — so a player could
  // watch 1000 vanish with no line anywhere explaining it.
  it('reports the deductions a classic chain imposed, not just its score', () => {
    const entry: HistoryEntry = {
      id: '3-Alice-1',
      round: 3,
      playerName: 'Alice',
      card: 'Plus_Minus',
      type: 'success',
      score: 2800,
      cards: ['300', 'Plus_Minus'],
      deductedPlayers: ['Bob'],
    };
    useGameStore.setState({ historyLog: [entry] });
    render(<HistoryLog />);

    expect(screen.getByText('history.chainSuccessDeducted')).toBeInTheDocument();
    expect(screen.queryByText('history.chainSuccess')).not.toBeInTheDocument();
  });

  it('leaves a chain that deducted nobody on the plain chain message', () => {
    const entry: HistoryEntry = {
      id: '4-Alice-1',
      round: 4,
      playerName: 'Alice',
      card: '300',
      type: 'success',
      score: 2800,
      cards: ['300', 'x2'],
    };
    useGameStore.setState({ historyLog: [entry] });
    render(<HistoryLog />);

    expect(screen.getByText('history.chainSuccess')).toBeInTheDocument();
    expect(screen.queryByText('history.chainSuccessDeducted')).not.toBeInTheDocument();
  });

  // A completed Kleeblatt is a binary instant win, so the engine deliberately
  // records the turn as worth 0 (see calculateNextTurn). The chain message
  // prints that score, so the game-winning turn read as "scored 0 pts".
  it('reports a chain that ended on a completed Kleeblatt as the win it is', () => {
    const entry: HistoryEntry = {
      id: '2-Alice-1',
      round: 2,
      playerName: 'Alice',
      card: '200',
      type: 'success',
      score: 0,
      cards: ['200', 'Kleeblatt'],
    };
    useGameStore.setState({ historyLog: [entry] });
    render(<HistoryLog />);

    expect(screen.getByText('history.chainKleeblatt')).toBeInTheDocument();
    expect(screen.queryByText('history.chainSuccess')).toBeNull();
  });

  it('still reports an ordinary banked chain with its score', () => {
    const entry: HistoryEntry = {
      id: '2-Alice-2',
      round: 2,
      playerName: 'Alice',
      card: '200',
      type: 'success',
      score: 1500,
      cards: ['200', 'Kniffel'],
    };
    useGameStore.setState({ historyLog: [entry] });
    render(<HistoryLog />);

    expect(screen.getByText('history.chainSuccess')).toBeInTheDocument();
  });

  it('reports a chain that BUSTED on a Kleeblatt as the loss it is', () => {
    const entry: HistoryEntry = {
      id: '2-Alice-3',
      round: 2,
      playerName: 'Alice',
      card: '200',
      type: 'bust',
      score: 0,
      cards: ['200', 'Kleeblatt'],
    };
    useGameStore.setState({ historyLog: [entry] });
    render(<HistoryLog />);

    expect(screen.getByText('history.chainBust')).toBeInTheDocument();
  });

  // What the classic 0-floor really took. The engine records it per hit
  // (historyEntry.deductedAmounts); this log is the only thing that shows it,
  // and it used to re-derive a flat PLUS_MINUS_SCORE instead — so a leader on
  // 400 was reported as having lost 1000 while his score dropped by 400.
  describe('the amount a deduction actually took', () => {
    // Bob led on this much, so the Plus/Minus could take no more than this.
    const CLAMPED_DEDUCTION = 400;

    it('prints what a clamped deduction removed, not the full Plus/Minus', () => {
      const entry: HistoryEntry = {
        id: '5-Alice-1',
        round: 5,
        playerName: 'Alice',
        card: 'Plus_Minus',
        type: 'success',
        score: PLUS_MINUS_SCORE,
        deductedPlayers: ['Bob'],
        deductedAmounts: [CLAMPED_DEDUCTION],
      };
      useGameStore.setState({ historyLog: [entry] });
      render(<HistoryLog />);

      expect(screen.getByText('history.plusMinusDeducted')).toBeInTheDocument();
      expect(translate).toHaveBeenCalledWith(
        'history.deductedEntry',
        expect.objectContaining({ name: 'Bob', amount: CLAMPED_DEDUCTION }),
      );
    });

    // The chain branch is a second, separate call site — the multi-card turn
    // is exactly where classic clamping happens most.
    it('prints a chain deduction at its clamped amount too', () => {
      const entry: HistoryEntry = {
        id: '5-Alice-2',
        round: 5,
        playerName: 'Alice',
        card: '300',
        type: 'success',
        score: 2800,
        cards: ['300', 'Plus_Minus'],
        deductedPlayers: ['Bob'],
        deductedAmounts: [CLAMPED_DEDUCTION],
      };
      useGameStore.setState({ historyLog: [entry] });
      render(<HistoryLog />);

      expect(screen.getByText('history.chainSuccessDeducted')).toBeInTheDocument();
      expect(translate).toHaveBeenCalledWith(
        'history.deductedEntry',
        expect.objectContaining({ name: 'Bob', amount: CLAMPED_DEDUCTION }),
      );
    });

    it('still prints the full Plus/Minus when the floor never bit', () => {
      const entry: HistoryEntry = {
        id: '5-Alice-3',
        round: 5,
        playerName: 'Alice',
        card: 'Plus_Minus',
        type: 'success',
        score: PLUS_MINUS_SCORE,
        deductedPlayers: ['Bob'],
        deductedAmounts: [PLUS_MINUS_SCORE],
      };
      useGameStore.setState({ historyLog: [entry] });
      render(<HistoryLog />);

      expect(translate).toHaveBeenCalledWith(
        'history.deductedEntry',
        expect.objectContaining({ name: 'Bob', amount: PLUS_MINUS_SCORE }),
      );
    });

    // A modernized turn (never clamps) and an entry relayed by a server that
    // does not carry the field both arrive without amounts — the flat
    // PLUS_MINUS_SCORE fallback is the right read for them.
    it('falls back to the full Plus/Minus for an entry carrying no amounts', () => {
      const entry: HistoryEntry = {
        id: '5-Alice-4',
        round: 5,
        playerName: 'Alice',
        card: 'Plus_Minus',
        type: 'success',
        score: PLUS_MINUS_SCORE,
        deductedPlayers: ['Bob'],
      };
      useGameStore.setState({ historyLog: [entry] });
      render(<HistoryLog />);

      expect(screen.getByText('history.plusMinusDeducted')).toBeInTheDocument();
      expect(translate).toHaveBeenCalledWith(
        'history.deductedEntry',
        expect.objectContaining({ name: 'Bob', amount: PLUS_MINUS_SCORE }),
      );
    });
  });

  // A scroller that hits its end hands the remaining gesture to the page
  // behind it (scroll chaining), so reaching the bottom of the history log scrolled
  // the app underneath. `overscroll-contain` stops the handoff; it is
  // supported on iOS Safari 16+, which is where this is worst.
  //
  // Asserted as an invariant over every scroller this component renders
  // rather than one pinned element, so a scroller added later without it
  // fails here. jsdom resolves no stylesheet, so that the utility actually
  // computes to `contain` is pinned in e2e/styling.spec.ts.
  it('contains overscroll on every scroller it renders', () => {
    render(<HistoryLog />);
    const scrollers = document.querySelectorAll('.overflow-y-auto');
    expect(scrollers.length, 'no scroller found — the selector has gone stale').toBeGreaterThan(0);
    scrollers.forEach(scroller => {
      expect(scroller.className, scroller.className).toContain('overscroll-contain');
    });
  });

});
