import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import DiceSummary from './DiceSummary';

describe('DiceSummary', () => {
  const baseProps = {
    summaryData: { won: true, score: 500, isTutto: false },
    bustCountdown: null,
    currentCard: '200',
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

  // A win and a bust both auto-continue via the same countdown — no manual button.
  describe('auto-continue countdown', () => {
    it('shows the auto-continue message on a win (Tutto/stop)', () => {
      render(
        <DiceSummary
          {...baseProps}
          summaryData={{ won: true, score: 500, isTutto: false }}
          bustCountdown={3}
        />
      );
      expect(screen.getByText('dice.auto_continuing')).toBeInTheDocument();
    });

    it('shows the auto-continue message on a bust', () => {
      render(
        <DiceSummary
          {...baseProps}
          summaryData={{ won: false, score: 0, isTutto: false }}
          bustCountdown={2}
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
          bustCountdown={1}
        />
      );
      expect(screen.getByText('dice.auto_continuing')).toBeInTheDocument();
    });

    it('never renders a manual continue button', () => {
      const { rerender } = render(
        <DiceSummary {...baseProps} summaryData={{ won: true, score: 500, isTutto: false }} />
      );
      expect(screen.queryByText('dice.continue')).toBeNull();

      rerender(<DiceSummary {...baseProps} summaryData={{ won: false, score: 0, isTutto: false }} />);
      expect(screen.queryByText('dice.continue')).toBeNull();
    });
  });
});
