import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import DiceSummary from './DiceSummary';

describe('DiceSummary', () => {
  const baseProps = {
    summaryData: { won: true, score: 500, isTutto: false },
    bustState: false,
    bustCountdown: null,
    finishGame: vi.fn(),
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

  describe('bust countdown', () => {
    it('shows auto-continue message when busted and not won', () => {
      render(
        <DiceSummary
          {...baseProps}
          summaryData={{ won: false, score: 0, isTutto: false }}
          bustState={true}
          bustCountdown={2}
        />
      );
      expect(screen.getByText('dice.auto_continuing')).toBeInTheDocument();
    });

    it('does not show auto-continue message when bust is won (Feuerwerk)', () => {
      render(
        <DiceSummary
          {...baseProps}
          summaryData={{ won: true, score: 200, isTutto: false }}
          bustState={true}
          currentCard="Feuerwerk"
        />
      );
      expect(screen.queryByText('dice.auto_continuing')).toBeNull();
    });
  });

  describe('continue button', () => {
    it('shows Continue button when not busted', () => {
      render(<DiceSummary {...baseProps} />);
      expect(screen.getByText('dice.continue')).toBeInTheDocument();
    });

    it('shows Continue button when bustState but won (Feuerwerk scored)', () => {
      render(
        <DiceSummary
          {...baseProps}
          summaryData={{ won: true, score: 500, isTutto: false }}
          bustState={true}
          currentCard="Feuerwerk"
        />
      );
      expect(screen.getByText('dice.continue')).toBeInTheDocument();
    });

    it('does not show Continue button when busted and lost', () => {
      render(
        <DiceSummary
          {...baseProps}
          summaryData={{ won: false, score: 0, isTutto: false }}
          bustState={true}
          bustCountdown={3}
        />
      );
      expect(screen.queryByText('dice.continue')).toBeNull();
    });

    it('calls finishGame when Continue is clicked', () => {
      const finishGame = vi.fn();
      render(<DiceSummary {...baseProps} finishGame={finishGame} />);
      fireEvent.click(screen.getByText('dice.continue'));
      expect(finishGame).toHaveBeenCalledOnce();
    });
  });
});
