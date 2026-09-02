import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PropsWithChildren, HTMLAttributes } from 'react';
import DiceSummary from './DiceSummary';
import { AUTO_CONTINUE_SECONDS } from '../../utils/uiTimings';
import type { CardType } from '../../types';

// The shrinking progress bar's transition.duration used to collapse to 0
// under isTestEnv — now it is unconditionally AUTO_CONTINUE_SECONDS. Real
// framer-motion consumes `transition` internally rather than exposing it as
// a DOM attribute, so this surfaces it as one for the assertion below.
vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, transition, initial, animate, className, ...rest }: PropsWithChildren<HTMLAttributes<HTMLDivElement> & {
      transition?: { duration?: number; ease?: string };
      initial?: unknown;
      animate?: unknown;
    }>) => (
      <div
        className={className}
        data-transition-duration={transition?.duration}
        {...rest}
      >
        {children}
      </div>
    ),
  },
}));

describe('DiceSummary', () => {
  const baseProps = {
    summaryData: { won: true, score: 500, isTutto: false },
    continueCountdown: null,
    finishGame: vi.fn(),
    currentCard: '200' as CardType,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('outcome heading', () => {
    it('shows "dice.success" when won', () => {
      render(<DiceSummary {...baseProps} />);
      expect(screen.getByText('dice.success')).toBeInTheDocument();
    });

    it('shows "dice.bust" when not won', () => {
      render(<DiceSummary {...baseProps} summaryData={{ won: false, score: 0, isTutto: false }} />);
      expect(screen.getByText('dice.bust')).toBeInTheDocument();
    });
  });

  describe('Tutto banner', () => {
    it('shows "dice.tutto" when isTutto is true', () => {
      render(<DiceSummary {...baseProps} summaryData={{ won: true, score: 500, isTutto: true }} />);
      expect(screen.getByText('dice.tutto')).toBeInTheDocument();
    });

    it('does not show "dice.tutto" when isTutto is false', () => {
      render(<DiceSummary {...baseProps} />);
      expect(screen.queryByText('dice.tutto')).toBeNull();
    });
  });

  describe('points display', () => {
    it('shows score when won and score > 0 on a regular card', () => {
      render(<DiceSummary {...baseProps} summaryData={{ won: true, score: 350, isTutto: false }} currentCard="300" />);
      expect(screen.getByText('350')).toBeInTheDocument();
    });

    it('shows score when Feuerwerk busted after scoring', () => {
      render(<DiceSummary {...baseProps} summaryData={{ won: true, score: 450, isTutto: false }} currentCard="Feuerwerk" />);
      expect(screen.getByText('450')).toBeInTheDocument();
    });

    it('does not show score for Kniffel (special card)', () => {
      render(<DiceSummary {...baseProps} summaryData={{ won: true, score: 0, isTutto: true }} currentCard="Kniffel" />);
      expect(screen.queryByText('0')).toBeNull();
    });

    it('does not show score for Plus_Minus (special card)', () => {
      render(<DiceSummary {...baseProps} summaryData={{ won: true, score: 0, isTutto: true }} currentCard="Plus_Minus" />);
      expect(screen.queryByText('0')).toBeNull();
    });

    it('does not show score for Kleeblatt (special card)', () => {
      render(<DiceSummary {...baseProps} summaryData={{ won: true, score: 1500, isTutto: true }} currentCard="Kleeblatt" />);
      expect(screen.queryByText('1500')).toBeNull();
    });

    it('does not show score when score is 0 on a regular card', () => {
      render(<DiceSummary {...baseProps} summaryData={{ won: false, score: 0, isTutto: false }} />);
      expect(screen.queryByText('0')).toBeNull();
    });
  });

  // A win and a bust both auto-continue via the same countdown, with a button to skip it.
  describe('auto-continue countdown', () => {
    it('shows the auto-continue message on a win (Tutto/stop)', () => {
      render(
        <DiceSummary
          {...baseProps}
          summaryData={{ won: true, score: 500, isTutto: false }}
          continueCountdown={3}
        />
      );
      expect(screen.getByText('dice.auto_continuing')).toBeInTheDocument();
    });

    it('shows the auto-continue message on a bust', () => {
      render(
        <DiceSummary
          {...baseProps}
          summaryData={{ won: false, score: 0, isTutto: false }}
          continueCountdown={2}
        />
      );
      expect(screen.getByText('dice.auto_continuing')).toBeInTheDocument();
    });

    it('shows the auto-continue message when Feuerwerk busts after scoring (won)', () => {
      render(
        <DiceSummary
          {...baseProps}
          summaryData={{ won: true, score: 200, isTutto: false }}
          currentCard="Feuerwerk"
          continueCountdown={1}
        />
      );
      expect(screen.getByText('dice.auto_continuing')).toBeInTheDocument();
    });

    it('renders a skip button on both a win and a bust', () => {
      const { rerender } = render(
        <DiceSummary {...baseProps} summaryData={{ won: true, score: 500, isTutto: false }} />
      );
      expect(screen.getByText('dice.continue')).toBeInTheDocument();

      rerender(<DiceSummary {...baseProps} summaryData={{ won: false, score: 0, isTutto: false }} />);
      expect(screen.getByText('dice.continue')).toBeInTheDocument();
    });

    it('calls finishGame when the skip button is clicked', () => {
      const finishGame = vi.fn();
      render(<DiceSummary {...baseProps} finishGame={finishGame} />);
      fireEvent.click(screen.getByText('dice.continue'));
      expect(finishGame).toHaveBeenCalledOnce();
    });

    it('shrinks the progress bar over the real AUTO_CONTINUE_SECONDS, not instantly', () => {
      // There used to be an isTestEnv() branch collapsing this to a 0s
      // transition; the real timed path is now the only one.
      render(<DiceSummary {...baseProps} continueCountdown={3} />);
      const bar = document.querySelector('[data-transition-duration]');
      expect(bar).not.toBeNull();
      expect(bar).toHaveAttribute('data-transition-duration', String(AUTO_CONTINUE_SECONDS));
    });
  });

  // Drawing another card is decided in the dice panel's button row, on the
  // roll that completes the tutto — by the time this summary is on screen the
  // turn is banked, whatever the chain could still have done. All this panel
  // owes the player is naming the total it banked.
  describe('a banked classic chain total', () => {
    const chainBank = {
      ...baseProps,
      summaryData: { won: true, score: 2500, isTutto: true },
      currentCard: 'Kniffel' as CardType,
      banksChainTotal: true,
    };

    it('still shows the banked points for a special card', () => {
      render(<DiceSummary {...chainBank} />);
      expect(screen.getByText('2500')).toBeInTheDocument();
    });

    it('still labels the button as banking that total', () => {
      render(<DiceSummary {...chainBank} />);
      expect(screen.getByText('dice.bank_points')).toBeInTheDocument();
      expect(screen.queryByText('dice.continue')).toBeNull();
    });

    it('offers no draw button and runs the countdown, the turn being decided', () => {
      render(<DiceSummary {...chainBank} continueCountdown={2} />);
      expect(screen.queryByTestId('draw-next-card')).toBeNull();
      expect(screen.getByText('dice.auto_continuing')).toBeInTheDocument();
    });

    it('leaves a modernized summary saying "continue"', () => {
      render(<DiceSummary {...chainBank} banksChainTotal={false} />);
      expect(screen.getByText('dice.continue')).toBeInTheDocument();
      expect(screen.queryByText('dice.bank_points')).toBeNull();
    });
  });

  // The summary replaces the dice table, so every button that could have had
  // focus — a die, Roll, Stop & Score — unmounts at that moment and focus falls
  // to <body>. ModalShell's Tab trap is a handler ON THE PANEL, so from body it
  // never sees a key: Tab then walked the page behind the backdrop, which is
  // the escape 62c1f1b closed in the other direction. Continue is also what the
  // panel's Space/Enter shortcut already does, so nothing new can be triggered
  // by taking focus here.
  describe('focus', () => {
    it('takes focus onto Continue, so the dialog keeps the keyboard', () => {
      render(<DiceSummary {...baseProps} />);

      expect(screen.getByTestId('dice-summary-continue')).toHaveFocus();
      expect(document.activeElement).not.toBe(document.body);
    });

    it('does the same for a bust, which is the same dead end', () => {
      render(<DiceSummary {...baseProps} summaryData={{ won: false, score: 0, isTutto: false }} />);

      expect(screen.getByTestId('dice-summary-continue')).toHaveFocus();
    });
  });
});
