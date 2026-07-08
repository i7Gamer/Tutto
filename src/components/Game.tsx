import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useGameStore } from '../store/useGameStore';
import confetti from 'canvas-confetti';
import { playBuzzer, playSuccess, vibrateYourTurn, vibrateTurnUrgent } from '../utils/soundEffects';
import { isTestEnv } from '../utils/env';
import { computeRankedPlayers } from '../utils/coreGameEngine';
import { applyTuttoBonus } from '../utils/diceLogic';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { formatTime } from '../utils/formatTime';
import { buildTurnKey, parseSavedDiceState } from '../utils/diceTurnState';
import { parseJsonObject } from '../utils/parseJson';
import { CARD_FLIP_MS, STOP_CARD_AUTO_CONTINUE_MS, DICE_PANEL_ENTRANCE_MS } from '../utils/uiTimings';
import { useWakeLock } from '../hooks/useWakeLock';
import type { PreGameStats } from '../store/storeTypes';

import Scoreboard from './game/Scoreboard';
import CardDisplay from './game/CardDisplay';
import GameControls from './game/GameControls';
import ReactionBar from './game/ReactionBar';
import DiceGame from './DiceGame';
import HistoryLog from './game/HistoryLog';

export default function Game() {
  const { t } = useTranslation();
  const game = useGameStore();
  const {
    currentCard,
    cards,
    nextTurn,
    undo,
    endGame,
    isOnline,
    myName,
    winningScore,
    players,
    currentPlayerIndex,
    gameTimeInSeconds,
    liveTurnState,
    setLiveTurnState,
    diceMode,
    enforcedDiceMode,
    isHost,
    kickPlayer,
    justReconnected,
    roomId,
    round,
    deviceId,
    setPreGameStats,
    turnTimeRemaining,
  } = game;

  // Keeps the screen awake for the whole gameplay session, on every device —
  // host or client, since this component mounts identically for both.
  useWakeLock();

  const formattedTime = formatTime(gameTimeInSeconds);

  // The host may pin a single dice mode for how every player takes their OWN
  // turn, overriding each player's personal device preference (offline has no
  // host to enforce anything, so it's always the personal preference there).
  const effectiveDiceMode = isOnline && enforcedDiceMode ? enforcedDiceMode : diceMode;

  const currentPlayer = currentPlayerIndex !== null ? players[currentPlayerIndex] : null;
  const sortedPlayers = useMemo(() => computeRankedPlayers(players), [players]);

  const isMyTurn = !isOnline || (currentPlayer && currentPlayer.name === myName);
  const [scoreInput, setScoreInput] = useState('');
  const [applyBonus, setApplyBonus] = useState(false);
  const [showDiceGame, setShowDiceGame] = useState(false);
  // Tracks whether the dice panel's own entrance animation has finished, so
  // DiceGame knows when it's safe to start rolling automatically. Reset once
  // the panel closes so the next opening waits for its own animation again.
  const [diceGamePanelReady, setDiceGamePanelReady] = useState(false);
  const confettiFiredRef = useRef(false);
  const reconnectHandledRef = useRef(false);
  const onlineReconnectHandledRef = useRef(false);
  const localCacheOnMountRef = useRef(!!localStorage.getItem('tutto_dice_turn_state'));
  // Seeded with the initial value (not false) so mounting straight into an
  // already-your-turn state (fresh load, reconnect) doesn't itself count as
  // a "turn started" transition — only a later false-to-true flip does.
  const wasMyTurnRef = useRef(!!isMyTurn);

  useEffect(() => {
    if (!isMyTurn) setShowDiceGame(false); // eslint-disable-line react-hooks/set-state-in-effect
  }, [isMyTurn]);

  // Local hot-seat has no meaning for "your turn" haptics — every turn is
  // "mine" there, since one device is passed around the table.
  useEffect(() => {
    if (isOnline && isMyTurn && !wasMyTurnRef.current) {
      vibrateYourTurn();
    }
    wasMyTurnRef.current = !!isMyTurn;
  }, [isOnline, isMyTurn]);

  // Fires once per second for as long as your own turn timer reads 10s or
  // under (turnTimeRemaining ticks down once a second, so this effect
  // re-running on each new value already gives the "every second" cadence —
  // no edge-detection needed). Only for the active player's own device —
  // spectators watching someone else's countdown run low shouldn't feel
  // their phone buzz for it.
  useEffect(() => {
    if (!isOnline || !isMyTurn) return;
    if (turnTimeRemaining === null || turnTimeRemaining === undefined) return;
    if (turnTimeRemaining <= 10) vibrateTurnUrgent();
  }, [isOnline, isMyTurn, turnTimeRemaining]);

  useEffect(() => {
    if (showDiceGame) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = 'unset';
    }
    return () => {
      document.body.style.overflow = 'unset';
    };
  }, [showDiceGame]);

  useEffect(() => {
    if (!showDiceGame) {
      // Resets synchronously (not via a timer) so the very next opening can't
      // race a stale `true` from the previous session into an instant re-roll.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDiceGamePanelReady(false);
      return;
    }
    const timer = setTimeout(() => setDiceGamePanelReady(true), DICE_PANEL_ENTRANCE_MS);
    return () => clearTimeout(timer);
  }, [showDiceGame]);

  // Snapshot this device's lifetime records once, right as the game begins —
  // this component only mounts when a fresh game starts (App.tsx swaps in
  // EndScreen while finished, then remounts Game on "Play Again"), and this
  // read is guaranteed to land before this game's own endGameStats submission
  // (which only fires from nextTurn at game-over). EndScreen later diffs the
  // post-game stats against this snapshot to detect genuinely new personal
  // records, rather than merely tying an older one.
  useEffect(() => {
    if (!isOnline || !deviceId) return;
    setPreGameStats(null);
    let cancelled = false;

    void (async () => {
      try {
        const res = await fetch(`/api/stats/${deviceId}`);
        if (!res.ok) return;
        const data = await parseJsonObject<Partial<PreGameStats>>(res);
        if (cancelled || !data) return;
        setPreGameStats({
          highestTurnScore: data.highestTurnScore ?? null,
          fastestWinTurns: data.fastestWinTurns ?? null,
          fastestLossTurns: data.fastestLossTurns ?? null,
          highestFeuerwerkTurnScore: data.highestFeuerwerkTurnScore ?? null,
          highestX2TurnScore: data.highestX2TurnScore ?? null,
        });
      } catch (err) {
        console.error('Could not fetch pre-game device stats', err);
      }
    })();

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // justReconnected is set — and self-cleared on the next gameState event it
  // isn't itself part of — by the store; this effect only reads it to decide
  // whether to show the resume UI. onlineReconnectHandledRef still guards
  // against firing the toast/modal more than once per reconnect episode: once
  // resumed, DiceGame calls onStateChange ~300ms after mount (see its own
  // effect), which updates liveTurnState — a dependency here — and would
  // otherwise re-run this effect while justReconnected is still waiting on the
  // store's next gameState round-trip to clear it.
  useEffect(() => {
    if (isOnline && justReconnected) {
      if (onlineReconnectHandledRef.current) return;
      onlineReconnectHandledRef.current = true;
      if (isMyTurn && effectiveDiceMode === 'digital' && liveTurnState) {
        const snapshotWithPlayer = {
          ...liveTurnState,
          playerName: currentPlayer?.name,
          turnKey: buildTurnKey(roomId, round, currentPlayerIndex, currentCard),
        };
        localStorage.setItem('tutto_dice_turn_state', JSON.stringify(snapshotWithPlayer));
        setShowDiceGame(true); // eslint-disable-line react-hooks/set-state-in-effect
        game.addToast(t('game.resumingDiceGame', 'Resuming your dice game...'));
      }
      return;
    }
    onlineReconnectHandledRef.current = false;

    if (!isOnline && isMyTurn && effectiveDiceMode === 'digital' && localCacheOnMountRef.current && !reconnectHandledRef.current) {
      reconnectHandledRef.current = true;
      localCacheOnMountRef.current = false;

      const raw = localStorage.getItem('tutto_dice_turn_state');
      const parsed = parseSavedDiceState(raw);
      const expectedTurnKey = buildTurnKey(roomId, round, currentPlayerIndex, currentCard);

      if (parsed && parsed.turnKey === expectedTurnKey) {
        setShowDiceGame(true);
        game.addToast(t('game.resumingDiceGame', 'Resuming your dice game...'));
      } else {
        localStorage.removeItem('tutto_dice_turn_state');
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [justReconnected, liveTurnState, isMyTurn, effectiveDiceMode, isOnline]);

  useEffect(() => {
    let soundTimeout: ReturnType<typeof setTimeout> | undefined;
    let turnTimeout: ReturnType<typeof setTimeout> | undefined;

    if (currentCard === 'Stop') {
      if (isTestEnv()) {
        playBuzzer();
        if (isOnline && isMyTurn) {
          turnTimeout = setTimeout(() => nextTurn(0, false), STOP_CARD_AUTO_CONTINUE_MS);
        }
      } else {
        soundTimeout = setTimeout(() => playBuzzer(), CARD_FLIP_MS);
        if (isOnline && isMyTurn) {
          turnTimeout = setTimeout(() => nextTurn(0, false), CARD_FLIP_MS + STOP_CARD_AUTO_CONTINUE_MS);
        }
      }
    }

    return () => {
      clearTimeout(soundTimeout);
      clearTimeout(turnTimeout);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOnline, isMyTurn, currentCard, cards?.length]);

  useEffect(() => {
    confettiFiredRef.current = false;
  }, [currentCard, cards?.length]);

  useEffect(() => {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    if (currentCard === 'Feuerwerk' && !confettiFiredRef.current) {
      if (isTestEnv()) {
        confetti({ particleCount: 150, spread: 80, origin: { y: 0.6 } });
        playSuccess();
        confettiFiredRef.current = true;
      } else {
        timeout = setTimeout(() => {
          if (!confettiFiredRef.current) {
            confetti({ particleCount: 150, spread: 80, origin: { y: 0.6 } });
            playSuccess();
            confettiFiredRef.current = true;
          }
        }, CARD_FLIP_MS);
      }
    }
    return () => clearTimeout(timeout);
  }, [currentCard, cards?.length]);

  const handleNextTurn = useCallback(() => {
    let parsedScore = Math.max(0, parseInt(scoreInput, 10) || 0);
    if (applyBonus) {
      parsedScore = applyTuttoBonus(parsedScore, currentCard);
    }
    nextTurn(parsedScore, parsedScore > 0);
    setScoreInput('');
    setApplyBonus(false);
  }, [scoreInput, applyBonus, currentCard, nextTurn]);

  const handleYesNo = useCallback((isSuccess: boolean) => {
    nextTurn(0, isSuccess);
  }, [nextTurn]);

  const handleDiceComplete = useCallback((score: number, isSuccess: boolean) => {
    setShowDiceGame(false);
    nextTurn(score, isSuccess);
  }, [nextTurn]);

  const currentCardHasInput = !['Stop', 'Plus_Minus', 'Kniffel', 'Kleeblatt'].includes(currentCard ?? '');
  const currentCardHasYesNo = ['Plus_Minus', 'Kniffel', 'Kleeblatt'].includes(currentCard ?? '');
  const isStopCard = currentCard === 'Stop';

  // Keyboard shortcuts: Space/Enter triggers whatever GameControls' primary
  // button is for the current turn state. There's no dice-roll modal dismiss
  // shortcut — once opened it auto-rolls immediately and can't be backed out
  // of. Ignored while typing in an input (e.g. the physical-mode score field)
  // so it doesn't hijack normal text entry.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const tag = (document.activeElement as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      if (e.key !== ' ' && e.key !== 'Enter') return;
      if (!isMyTurn) return;
      e.preventDefault();

      if (isStopCard) {
        handleYesNo(false);
      } else if (effectiveDiceMode === 'digital') {
        // Digital mode always shows "Roll Dice" for any non-Stop card — it
        // doesn't distinguish input/yes-no cards the way physical mode does.
        if (!showDiceGame) setShowDiceGame(true);
      } else if (currentCardHasYesNo) {
        handleYesNo(true);
      } else if (currentCardHasInput) {
        handleNextTurn();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isMyTurn, isStopCard, currentCardHasYesNo, currentCardHasInput, effectiveDiceMode, showDiceGame, handleNextTurn, handleYesNo]);

  const canUndo = !game.finished && !!game.previousCard && game.previousCard !== 'Stop' && game.currentPlayerIndex !== null && !!game.previousPlayerName && (!isOnline || isMyTurn || isHost);

  return (
    <div className="container mx-auto px-2 md:px-4 pt-2 md:pt-4 pb-20 max-w-3xl flex flex-col gap-2 md:gap-4">
      <Scoreboard game={game} formattedTime={formattedTime} />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-2 md:gap-4">
        <motion.div initial={{ opacity: 0, x: -20 }} animate={{ opacity: 1, x: 0 }} className="flex flex-col h-full">
          <CardDisplay currentCard={currentCard} cards={cards} />
        </motion.div>

        <motion.div initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }} className="flex flex-col h-full">
          <GameControls
            currentCard={currentCard}
            cardsLength={cards?.length || 0}
            isMyTurn={!!isMyTurn}
            diceMode={effectiveDiceMode}
            setShowDiceGame={setShowDiceGame}
            scoreInput={scoreInput}
            setScoreInput={setScoreInput}
            applyBonus={applyBonus}
            setApplyBonus={setApplyBonus}
            handleNextTurn={handleNextTurn}
            handleYesNo={handleYesNo}
            undo={undo}
            canUndo={canUndo}
            endGame={endGame}
            isOnline={isOnline}
            isHost={isHost}
            leaveRoom={game.leaveRoom}
            activeTurnState={liveTurnState}
            currentPlayer={currentPlayer}
          />
          {/* Reactions are meaningless without other players around to see
              them, so the bar only makes sense for online games. */}
          {isOnline && (
            <div className="mt-2 md:mt-4">
              <ReactionBar sendReaction={game.sendReaction} />
            </div>
          )}
        </motion.div>

        <motion.div initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} className="md:col-span-2 bg-white dark:bg-slate-800/80 backdrop-blur border border-white/40 rounded-3xl p-4 md:p-6 shadow-xl flex flex-col">
          <h3 className="text-xl font-bold text-gray-800 dark:text-gray-100 mb-6 uppercase tracking-wider text-center">{t('game.leaderboard', 'Leaderboard')}</h3>
          <div className="flex flex-col rounded-xl border border-gray-100 dark:border-slate-700 bg-white dark:bg-slate-800/40 overflow-hidden">
            <div className="flex px-4 py-3 font-semibold text-gray-600 dark:text-gray-300 border-b border-gray-100 dark:border-slate-700 bg-black/5 dark:bg-white/5">
              <div className="w-12">{t('game.pos', 'Pos')}</div>
              <div className="flex-1">{t('game.player', 'Player')}</div>
              <div className="w-24 text-right">{t('game.score', 'Score')}</div>
            </div>
            <div className="flex flex-col">
              {sortedPlayers.map(p => {
                const isCurrent = currentPlayer && p.name === currentPlayer.name;
                return (
                  <motion.div
                    layout
                    key={p.name}
                    className={`flex items-center px-4 py-3 border-b border-gray-50 dark:border-slate-700/50 last:border-0 transition-colors ${isCurrent ? 'bg-indigo-100 dark:bg-indigo-900/30' : 'hover:bg-white/50 dark:hover:bg-slate-800/50'}`}
                  >
                    <div className="w-12 font-medium text-gray-600 dark:text-gray-300">{p.position}.</div>
                    <div className="flex-1 font-bold flex items-center flex-wrap gap-2" style={{ color: p.color || 'var(--text-color, #1f2937)' }}>
                      <span>{p.name}</span>
                      {isOnline && game.hostId === p.socketId && <span title={t('game.host', 'Host')} className="text-lg leading-none">👑</span>}
                      {p.winStreak !== undefined && p.winStreak >= 3 && (
                        <span title={t('game.winStreakTitle', 'On a 🔥 {{streak}}-game win streak!', { streak: p.winStreak })} className="text-amber-500 text-[10px] sm:text-xs font-bold bg-amber-50 dark:bg-amber-900/20 px-2 py-0.5 rounded-full border border-amber-100 dark:border-amber-900/50 flex items-center gap-0.5 whitespace-nowrap">
                          🔥 {p.winStreak}
                        </span>
                      )}
                      {p.disconnected && (
                        <>
                          <span className="text-red-500 text-[10px] sm:text-xs font-normal bg-red-50 dark:bg-red-900/20 px-2 py-0.5 rounded-full border border-red-100 dark:border-red-900/50 whitespace-nowrap">{t('game.disconnected', 'Disconnected')}</span>
                          {isOnline && isHost && (
                            <button
                              onClick={() => { if (p.socketId) kickPlayer(p.socketId); }}
                              className="text-red-600 dark:text-red-400 hover:text-white hover:bg-red-500 dark:hover:bg-red-600 px-2 py-0.5 text-[10px] sm:text-xs font-semibold rounded-full border border-red-200 dark:border-red-800 transition-colors shadow-sm ml-1"
                              title={t('game.kickPlayer', 'Kick Player')}
                            >
                              {t('game.kick', 'Kick')}
                            </button>
                          )}
                        </>
                      )}
                    </div>
                    <div className="w-24 font-bold text-gray-800 dark:text-gray-100 text-right">{p.score}</div>
                  </motion.div>
                );
              })}
            </div>
          </div>
          {winningScore > 0 && (
            <div className="mt-6 text-center text-sm text-gray-500 dark:text-gray-400 bg-black/5 dark:bg-white/5 p-3 rounded-xl border border-gray-100 dark:border-slate-700">
              {t('game.goalPrefix', 'Goal: First to reach')} <strong className="text-indigo-600">{winningScore}</strong> {t('game.goalSuffix', 'points wins!')}
            </div>
          )}
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="md:col-span-2"
        >
          <HistoryLog />
        </motion.div>
      </div>

      {showDiceGame && (
        <div data-testid="dice-game-backdrop" className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
          <motion.div
            initial={{ opacity: 0, scale: 0.9, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.9, y: 20 }}
            className="w-full max-w-4xl rounded-3xl"
          >
            <DiceGame
              currentCard={currentCard}
              turnKey={buildTurnKey(roomId, round, currentPlayerIndex, currentCard)}
              onComplete={handleDiceComplete}
              onStateChange={effectiveDiceMode === 'digital' ? setLiveTurnState : undefined}
              panelReady={diceGamePanelReady}
            />
          </motion.div>
        </div>
      )}
    </div>
  );
}
