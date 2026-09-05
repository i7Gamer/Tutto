import type { ReactNode } from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import Scoreboard from './Scoreboard';
import type { GameStore } from '../../store/useGameStore';
import { contrastRatio, LIGHT_SURFACE, DARK_SURFACE, NAME_CONTRAST_TARGET } from '../../utils/contrastColor';
import { makePlayer } from '../../testing/factories';

// Mock framer-motion
vi.mock('framer-motion', () => {
  return {
    motion: {
      div: ({ children, ...props }: { children?: ReactNode; [key: string]: unknown }) => {
        const cleanProps = { ...props };
        delete cleanProps.layout;
        delete cleanProps.transition;
        delete cleanProps.initial;
        delete cleanProps.animate;
        delete cleanProps.exit;
        return <div {...cleanProps}>{children}</div>;
      },
    },
    AnimatePresence: ({ children }: { children?: ReactNode }) => <>{children}</>,
  };
});

// Scoreboard only ever reads this slice of the store.
type ScoreboardGame = Pick<GameStore, 'players' | 'currentPlayerIndex' | 'isOnline' | 'myName' | 'round' | 'winningScore' | 'turnTimeRemaining' | 'hostId'>;

const makeScoreboardGame = (overrides: Partial<ScoreboardGame> = {}): ScoreboardGame => ({
  players: [],
  currentPlayerIndex: 0,
  isOnline: true,
  myName: null,
  round: 1,
  winningScore: 1000,
  turnTimeRemaining: null,
  hostId: null,
  ...overrides,
});

describe('Scoreboard Component', () => {
  it('renders translation keys correctly', () => {
    const game = makeScoreboardGame({
      players: [makePlayer({ name: 'Player 1', score: 100, socketId: 'abc' })],
      currentPlayerIndex: 0,
      isOnline: true,
      myName: 'Player 1',
      round: 1,
      winningScore: 1000,
      turnTimeRemaining: 30,
      hostId: 'abc',
    });

    render(<Scoreboard game={game} formattedTime="10:00" />);

    expect(screen.getByText('game.currentPlayer')).toBeInTheDocument();
    expect(screen.getByTitle('game.host')).toBeInTheDocument();
    expect(screen.getByText('game.you')).toBeInTheDocument();
    expect(screen.getByText('game.yourScore')).toBeInTheDocument();
    expect(screen.getByText('game.round')).toBeInTheDocument();
    expect(screen.getByText('game.turnTimer')).toBeInTheDocument();
    expect(screen.getAllByText('game.timeSeconds').length).toBe(1);
    expect(screen.getByText('game.time')).toBeInTheDocument();
  });

  // "You (Host)" told a player their own name; the tile reads "You". The
  // i18n mock returns bare keys, so the wording itself is pinned on the
  // locale files: neither language interpolates a name any more.
  it('calls the current player plain "You" on their own device, in both languages', () => {
    for (const lang of ['en', 'de']) {
      const messages = JSON.parse(readFileSync(join(__dirname, '../../locales', lang, 'translation.json'), 'utf8'));
      expect(messages['game.you'], lang).not.toMatch(/{{/);
    }
  });

  it('renders translation keys when disconnected', () => {
    const game = makeScoreboardGame({
      players: [makePlayer({ name: 'Player 2', score: 100, socketId: 'def', disconnected: true })],
      myName: 'Player 1',
    });

    render(<Scoreboard game={game} formattedTime="10:00" />);
    expect(screen.getByText('game.disconnected')).toBeInTheDocument();
  });

  it('renders regular score translation when offline', () => {
    const game = makeScoreboardGame({
      players: [makePlayer({ name: 'Player 1', score: 100 })],
      isOnline: false,
      myName: 'Player 1',
    });

    render(<Scoreboard game={game} formattedTime="10:00" />);
    expect(screen.getByText('game.score')).toBeInTheDocument();
  });

  it('does not render a win streak badge in the current player panel, even for a high winStreak', () => {
    const game = makeScoreboardGame({
      players: [makePlayer({ name: 'StreakPlayer', score: 100, socketId: 'abc', winStreak: 5 })],
      myName: 'Player 1',
    });
    render(<Scoreboard game={game} formattedTime="10:00" />);
    expect(screen.queryByText('🔥 5')).not.toBeInTheDocument();
  });

  // The name used to be painted with a plain inline `color`, which for most
  // player colours is unreadable in one theme or the other (gold is 1.40:1 on
  // the light card). It now carries a per-theme pair that index.css chooses
  // between. Which one wins is cascade, so only e2e can assert that
  // (e2e/styling.spec.ts) — this pins the half jsdom can see: the class is
  // present and both values are set and readable.
  it('paints the current player name through the per-theme contrast pair', () => {
    const game = makeScoreboardGame({
      // Gold: the palette's worst case on a light background.
      players: [makePlayer({ name: 'Goldie', score: 100, socketId: 'abc', color: '#FFD700' })],
      isOnline: false,
      myName: 'Goldie',
    });

    render(<Scoreboard game={game} formattedTime="10:00" />);

    const name = screen.getByText('Goldie').closest('.player-name') as HTMLElement;
    expect(name, 'the name must carry the class the stylesheet keys on').not.toBeNull();

    const light = name.style.getPropertyValue('--player-name-light');
    const dark = name.style.getPropertyValue('--player-name-dark');
    expect(contrastRatio(light, LIGHT_SURFACE)).toBeGreaterThanOrEqual(NAME_CONTRAST_TARGET);
    expect(contrastRatio(dark, DARK_SURFACE)).toBeGreaterThanOrEqual(NAME_CONTRAST_TARGET);
    // Gold already clears the target on the dark card, so it survives there
    // untouched — the fit only moves what it has to.
    expect(dark.toUpperCase()).toBe('#FFD700');

    // And no bare inline colour is left behind to fight the stylesheet.
    expect(name.style.color).toBe('');
  });

  // The crown-adjacent sr-only badge announcing who currently has the top
  // score — distinct from the host crown just before it, which marks who
  // runs the room, not who is winning.
  describe('leader badge', () => {
    it('shows "game.leader" when the current player has the top score', () => {
      const game = makeScoreboardGame({
        players: [
          makePlayer({ name: 'Leader', score: 500, socketId: 'a' }),
          makePlayer({ name: 'Player 1', score: 100, socketId: 'b' }),
        ],
        currentPlayerIndex: 0,
        myName: 'Leader',
      });
      render(<Scoreboard game={game} formattedTime="10:00" />);
      expect(screen.getByText('game.leader')).toBeInTheDocument();
    });

    // The leader badge used to be a SECOND 👑, indistinguishable from the host
    // crown — a host who also led showed two crowns, and a leading non-host
    // showed one crown that players read as "host". It is now a trophy, so
    // only an actual host ever shows a crown.
    it('shows a trophy (not a second crown) for a leading player who is not the host', () => {
      const game = makeScoreboardGame({
        players: [
          makePlayer({ name: 'Leader', score: 500, socketId: 'a' }),
          makePlayer({ name: 'Player 1', score: 100, socketId: 'b' }),
        ],
        currentPlayerIndex: 0,
        myName: 'Leader',
        hostId: 'b',
      });
      render(<Scoreboard game={game} formattedTime="10:00" />);
      expect(screen.getByTitle('game.leader')).toHaveTextContent('🏆');
      expect(screen.queryByTitle('game.host')).not.toBeInTheDocument();
      expect(screen.queryByText('👑')).not.toBeInTheDocument();
    });

    it('shows exactly one crown (host) and one trophy (leader) for a player who is both', () => {
      const game = makeScoreboardGame({
        players: [
          makePlayer({ name: 'HostLeader', score: 500, socketId: 'a' }),
          makePlayer({ name: 'Player 1', score: 100, socketId: 'b' }),
        ],
        currentPlayerIndex: 0,
        myName: 'HostLeader',
        hostId: 'a',
      });
      render(<Scoreboard game={game} formattedTime="10:00" />);

      const crown = screen.getByTitle('game.host');
      expect(crown).toHaveTextContent('👑');
      const trophy = screen.getByTitle('game.leader');
      expect(trophy).toHaveTextContent('🏆');
      // Exactly one of each — a second 👑 for the leader badge would fail this.
      expect(screen.getAllByText('👑')).toHaveLength(1);
      expect(screen.getAllByText('🏆')).toHaveLength(1);
    });

    it('does not show "game.leader" when the current player is behind', () => {
      const game = makeScoreboardGame({
        players: [
          makePlayer({ name: 'Trailing', score: 100, socketId: 'a' }),
          makePlayer({ name: 'Ahead', score: 500, socketId: 'b' }),
        ],
        currentPlayerIndex: 0,
        myName: 'Trailing',
      });
      render(<Scoreboard game={game} formattedTime="10:00" />);
      expect(screen.queryByText('game.leader')).not.toBeInTheDocument();
    });

    // Every player is trivially tied for the top score at the game's start —
    // nothing worth a "Leader" badge yet.
    it('does not show "game.leader" with only one player', () => {
      const game = makeScoreboardGame({
        players: [makePlayer({ name: 'Solo', score: 0, socketId: 'a' })],
        currentPlayerIndex: 0,
        myName: 'Solo',
      });
      render(<Scoreboard game={game} formattedTime="10:00" />);
      expect(screen.queryByText('game.leader')).not.toBeInTheDocument();
    });

    // getLeaders() returns every player tied for the top score, and at 0-0
    // (before anyone has scored) that is everyone — the current player would
    // otherwise show as "leading" a game that hasn't started.
    it('does not show "game.leader" when two players are tied at 0', () => {
      const game = makeScoreboardGame({
        players: [
          makePlayer({ name: 'First', score: 0, socketId: 'a' }),
          makePlayer({ name: 'Second', score: 0, socketId: 'b' }),
        ],
        currentPlayerIndex: 0,
        myName: 'First',
      });
      render(<Scoreboard game={game} formattedTime="10:00" />);
      expect(screen.queryByText('game.leader')).not.toBeInTheDocument();
    });

    it('shows "game.leader" once the current player is actually ahead, 100 to 0', () => {
      const game = makeScoreboardGame({
        players: [
          makePlayer({ name: 'Ahead', score: 100, socketId: 'a' }),
          makePlayer({ name: 'Behind', score: 0, socketId: 'b' }),
        ],
        currentPlayerIndex: 0,
        myName: 'Ahead',
      });
      render(<Scoreboard game={game} formattedTime="10:00" />);
      expect(screen.getByText('game.leader')).toBeInTheDocument();
    });
  });

  // `truncate` (overflow:hidden + white-space:nowrap + ellipsis) only does
  // anything on the element that actually holds the text. It used to sit on
  // the flex COLUMN wrapping the whole name row (crown + text), which has no
  // text node of its own — so a long name overflowed and was clipped
  // mid-word with no ellipsis, and the crown had nothing to keep it from
  // being squeezed too.
  it('truncates the name text itself, not the flex container around crown + name', () => {
    const longName = 'A'.repeat(60);
    const game = makeScoreboardGame({
      players: [makePlayer({ name: longName, score: 100, socketId: 'abc' })],
      myName: longName,
      hostId: 'abc',
    });

    render(<Scoreboard game={game} formattedTime="10:00" />);

    const container = screen.getByTitle('game.host').closest('.player-name') as HTMLElement;
    expect(container).not.toBeNull();
    expect(container.className).not.toMatch(/\btruncate\b/);

    const nameSpan = screen.getByText('game.you');
    expect(nameSpan.className).toMatch(/\btruncate\b/);
    expect(nameSpan.className).toMatch(/\bmin-w-0\b/);
  });
});
