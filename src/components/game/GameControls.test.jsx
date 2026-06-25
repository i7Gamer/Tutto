import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import GameControls from './GameControls';

// Mock matchMedia
window.matchMedia = window.matchMedia || function() {
  return {
    matches: false,
    addListener: function() {},
    removeListener: function() {}
  };
};

describe('GameControls Component', () => {
  it('renders "Roll Dice" for digital dice mode', () => {
    render(
      <GameControls
        currentCard="300"
        isMyTurn={true}
        diceMode="digital"
        setShowDiceGame={() => {}}
      />
    );
    
    expect(screen.getByText('game.controls.rollDice')).toBeInTheDocument();
  });

  it('renders input, score placeholder and apply bonus checkbox for physical dice mode with matching card', () => {
    render(
      <GameControls
        currentCard="300"
        isMyTurn={true}
        diceMode="physical"
        scoreInput=""
        setScoreInput={() => {}}
        applyBonus={false}
        setApplyBonus={() => {}}
        handleNextTurn={() => {}}
      />
    );
    
    expect(screen.getByPlaceholderText('game.controls.scorePlaceholder')).toBeInTheDocument();
    expect(screen.getByText('game.controls.applyBonus')).toBeInTheDocument();
    expect(screen.getByText('game.controls.nextTurn')).toBeInTheDocument();
  });

  it('renders "Did you succeed?", "Yes" and "No" for cards with Yes/No interaction', () => {
    render(
      <GameControls
        currentCard="Kniffel"
        isMyTurn={true}
        diceMode="physical"
        handleYesNo={() => {}}
      />
    );
    
    expect(screen.getByText('game.controls.didYouSucceed')).toBeInTheDocument();
    expect(screen.getByText('game.controls.yes')).toBeInTheDocument();
    expect(screen.getByText('game.controls.no')).toBeInTheDocument();
  });

  it('renders Stop controls when current card is Stop', () => {
    render(
      <GameControls
        currentCard="Stop"
        isMyTurn={true}
        handleYesNo={() => {}}
      />
    );
    
    expect(screen.getByText('game.controls.stopTurnOver')).toBeInTheDocument();
    expect(screen.getByText('game.controls.continue')).toBeInTheDocument();
  });

  it('renders waiting state when not my turn', () => {
    render(
      <GameControls
        currentCard="300"
        isMyTurn={false}
      />
    );

    expect(screen.getByText('game.controls.waiting')).toBeInTheDocument();
  });

  it('renders live dice state when not my turn with activeTurnState (online digital dice)', () => {
    const activeTurnState = {
      turnScore: 350,
      keptDice: [{ val: 1 }, { val: 5 }],
      currentRoll: [{ val: 3, selected: false }, { val: 6, selected: false }],
    };
    render(
      <GameControls
        currentCard="300"
        isMyTurn={false}
        isOnline={true}
        diceMode="digital"
        activeTurnState={activeTurnState}
        currentPlayer={{ name: 'Alice' }}
      />
    );

    expect(screen.getByText('game.controls.playerIsPlaying')).toBeInTheDocument();
    expect(screen.getByText('350')).toBeInTheDocument();
    expect(screen.getByText('game.controls.keptDice')).toBeInTheDocument();
    expect(screen.getByText('game.controls.currentRoll')).toBeInTheDocument();
    expect(screen.queryByText('game.controls.waiting')).not.toBeInTheDocument();
  });

  it('still shows spinner when online digital but activeTurnState is null (not yet rolled)', () => {
    render(
      <GameControls
        currentCard="300"
        isMyTurn={false}
        isOnline={true}
        diceMode="digital"
        activeTurnState={null}
        currentPlayer={{ name: 'Alice' }}
      />
    );

    expect(screen.getByText('game.controls.waiting')).toBeInTheDocument();
    expect(screen.queryByText('game.controls.playerIsPlaying')).not.toBeInTheDocument();
  });

  it('renders footer buttons: End Game and Undo (offline mode)', () => {
    render(
      <GameControls
        currentCard="300"
        isMyTurn={true}
        isOnline={false}
        endGame={() => {}}
        undo={() => {}}
      />
    );
    
    expect(screen.getByText('game.controls.endGame')).toBeInTheDocument();
    expect(screen.getByText('game.controls.undo')).toBeInTheDocument();
  });

  it('renders footer buttons: Leave Game and Undo (online non-host mode)', () => {
    render(
      <GameControls
        currentCard="300"
        isMyTurn={true}
        isOnline={true}
        isHost={false}
        leaveRoom={() => {}}
        undo={() => {}}
      />
    );
    
    expect(screen.getByText('game.controls.leaveGame')).toBeInTheDocument();
    expect(screen.getByText('game.controls.undo')).toBeInTheDocument();
  });

  it('calls endGame/leaveRoom appropriately with confirmations', () => {
    const mockConfirm = vi.spyOn(window, 'confirm');
    mockConfirm.mockImplementation(() => true);
    
    const mockEndGame = vi.fn();
    const mockLeaveRoom = vi.fn();

    const { rerender } = render(
      <GameControls
        currentCard="300"
        isMyTurn={true}
        isOnline={false}
        endGame={mockEndGame}
        undo={() => {}}
      />
    );
    
    fireEvent.click(screen.getByText('game.controls.endGame'));
    expect(mockConfirm).toHaveBeenCalledWith('game.controls.endGameConfirm');
    expect(mockEndGame).toHaveBeenCalled();
    
    rerender(
      <GameControls
        currentCard="300"
        isMyTurn={true}
        isOnline={true}
        isHost={false}
        leaveRoom={mockLeaveRoom}
        undo={() => {}}
      />
    );
    
    fireEvent.click(screen.getByText('game.controls.leaveGame'));
    expect(mockConfirm).toHaveBeenCalledWith('game.controls.leaveGameConfirm');
    expect(mockLeaveRoom).toHaveBeenCalled();
    
    mockConfirm.mockRestore();
  });
});
