import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useGameStore } from '../store/useGameStore';
import confetti from 'canvas-confetti';
import { playBuzzer, playSuccess, vibrateYourTurn, vibrateTurnUrgent } from '../utils/soundEffects';
import { isTestEnv } from '../utils/env';
import { computeRankedPlayers } from '../utils/coreGameEngine';
import { applyTuttoBonus } from '../utils/diceLogic';
import { motion } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { formatTime } from '../utils/formatTime';
import { buildTurnKey, parseSavedDiceState, DICE_TURN_STATE_KEY } from '../utils/diceTurnState';
import { hasScoreInput, isSpecialCard } from '../utils/diceTurnControls';
import { parseJsonObject } from '../utils/parseJson';
import { deviceStatsUrl, gameModeOf, isCustomGameMode } from '../utils/statsApi';
import { CARD_FLIP_MS, STOP_CARD_AUTO_CONTINUE_MS, DICE_PANEL_ENTRANCE_MS } from '../utils/uiTimings';
import { useWakeLock } from '../hooks/useWakeLock';
import { useKeyboardShortcuts } from '../hooks/useKeyboardShortcuts';
import type { PreGameStats } from '../store/storeTypes';
import type { TurnSummary } from '../types';
import { KNIFFEL_SCORE, PLUS_MINUS_SCORE } from '../utils/coreGameEngine';
import { usePhysicalChain, readPhysicalChainCache } from '../hooks/usePhysicalChain';

import Scoreboard from './game/Scoreboard';
import CardDisplay from './game/CardDisplay';
import GameControls from './game/GameControls';
import ReactionBar from './game/ReactionBar';
import DiceGame from './DiceGame';
import HistoryLog from './game/HistoryLog';

// Only the fields Game actually reads (directly or via game.X below / the
// Scoreboard prop) are selected here, with shallow equality — so a store
// mutation that touches an unrelated slice (toasts, reactions, other
// players' rooms) doesn't force this component and its whole subtree to
// re-render. See HistoryLog.tsx/HelpPopup.tsx for the same narrow-selector
// pattern applied via single-field selectors instead.
const useGameSlice = () => useGameStore(useShallow(state => ({
  currentCard: state.currentCard,
  cards: state.cards,
  nextTurn: state.nextTurn,
  drawCardMidTurn: state.drawCardMidTurn,
  undo: state.undo,
  endGame: state.endGame,
  isOnline: state.isOnline,
  myName: state.myName,
  winningScore: state.winningScore,
  initialCards: state.initialCards,
  players: state.players,
  currentPlayerIndex: state.currentPlayerIndex,
  gameTimeInSeconds: state.gameTimeInSeconds,
  liveTurnState: state.liveTurnState,
  setLiveTurnState: state.setLiveTurnState,
  diceMode: state.diceMode,
  enforcedDiceMode: state.enforcedDiceMode,
  ruleset: state.ruleset,
  isHost: state.isHost,
  kickPlayer: state.kickPlayer,
  justReconnected: state.justReconnected,
  roomId: state.roomId,
  round: state.round,
  deviceId: state.deviceId,
  setPreGameStats: state.setPreGameStats,
  turnTimeRemaining: state.turnTimeRemaining,
  addToast: state.addToast,
  leaveRoom: state.leaveRoom,
  sendReaction: state.sendReaction,
  hostId: state.hostId,
  finished: state.finished,
  previousCard: state.previousCard,
  previousPlayerName: state.previousPlayerName,
  previousTurnSummary: state.previousTurnSummary,
})));

export default function Game() {
  const { t } = useTranslation();
  const game = useGameSlice();
  const {
    currentCard,
    cards,
    nextTurn,
    drawCardMidTurn,
    undo,
    endGame,
    isOnline,
    myName,
    winningScore,
    initialCards,
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
    addToast,
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
  const isClassic = game.ruleset === 'classic';
  // Classic PHYSICAL chains live in usePhysicalChain (digital chains live
  // inside DiceGame). The typed running total restores from the same cache
  // the chain does, so a reload resumes the turn mid-entry.
  const classicPhysical = isClassic && effectiveDiceMode === 'physical';
  const physicalTurnKey = buildTurnKey(roomId, round, currentPlayerIndex, currentCard, game.ruleset);
  const [scoreInput, setScoreInput] = useState(() => (classicPhysical ? readPhysicalChainCache(physicalTurnKey)?.scoreInput : null) ?? '');
  const [applyBonus, setApplyBonus] = useState(false);
  const [showDiceGame, setShowDiceGame] = useState(false);
  const {
    awaitingChoice: physicalAwaitingChoice,
    hasChain: hasPhysicalChain,
    completeCurrentCard,
    recordDraw,
    buildSummary: buildPhysicalSummary,
    clearChain,
  } = usePhysicalChain({
    enabled: classicPhysical,
    roomId, round, currentPlayerIndex, currentCard, ruleset: game.ruleset,
    scoreInput,
  });
  // An externally advanced turn (undo, the online Stop auto-continue, a
  // server timeout) never passes through the commit handlers that reset the
  // entry fields. Digits surviving into the new slot would be re-cached by
  // the chain cache's write-through under the NEW turn's key — undoing the
  // lifecycle clear one render later — so this corrects at render time (the
  // stale-modal pattern below), landing before any effect can write.
  const turnSlot = `${round}:${currentPlayerIndex}`;
  const [prevTurnSlot, setPrevTurnSlot] = useState(turnSlot);
  if (turnSlot !== prevTurnSlot) {
    setPrevTurnSlot(turnSlot);
    if (scoreInput !== '') setScoreInput('');
    if (applyBonus) setApplyBonus(false);
  }
  // Tracks whether the dice panel's own entrance animation has finished, so
  // DiceGame knows when it's safe to start rolling automatically. Reset once
  // the panel closes so the next opening waits for its own animation again.
  const [diceGamePanelReady, setDiceGamePanelReady] = useState(false);
  const confettiFiredRef = useRef(false);
  const reconnectHandledRef = useRef(false);
  const onlineReconnectHandledRef = useRef(false);
  const localCacheOnMountRef = useRef(!!localStorage.getItem(DICE_TURN_STATE_KEY));
  // Seeded with the initial value (not false) so mounting straight into an
  // already-your-turn state (fresh load, reconnect) doesn't itself count as
  // a "turn started" transition — only a later false-to-true flip does.
  const wasMyTurnRef = useRef(!!isMyTurn);

  // Both of these correct state during render rather than from an effect. An
  // effect renders the stale value first and fixes it on the next pass, and
  // for the dice panel that stale frame is a modal covering the whole screen
  // on a turn that has already moved on to somebody else.
  if (showDiceGame && !isMyTurn) setShowDiceGame(false);
  // Readiness must not outlive the panel it belongs to, or the next opening
  // starts already "ready" and auto-rolls before its entrance has played.
  if (!showDiceGame && diceGamePanelReady) setDiceGamePanelReady(false);

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
    if (!showDiceGame) return;
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
  // Snapshotted rather than depended on: the values are read for the game this
  // component mounted for, and a later change to either is not a new game.
  const atGameStartRef = useRef({ isOnline, deviceId, mode: gameModeOf({ winningScore, initialCards }, game.ruleset) });
  useEffect(() => {
    const { isOnline: onlineAtStart, deviceId: deviceAtStart, mode: modeAtStart } = atGameStartRef.current;
    // Cleared before anything else: a snapshot left over from an earlier game
    // in this session would be diffed against THIS game's numbers.
    setPreGameStats(null);
    if (!onlineAtStart || !deviceAtStart) return;
    // A custom game never celebrates a personal record (see EndScreen), which
    // is the only thing this snapshot feeds — so there is nothing to compare
    // against and no reason to spend the request. A classic game compares
    // against its OWN bucket, so the mode rides the URL.
    if (isCustomGameMode(modeAtStart)) return;
    let cancelled = false;

    void (async () => {
      try {
        const res = await fetch(deviceStatsUrl(deviceAtStart, modeAtStart));
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
  }, [setPreGameStats]);

  // justReconnected is set — and self-cleared on the next gameState event it
  // isn't itself part of — by the store; this effect only reads it to decide
  // whether to show the resume UI. onlineReconnectHandledRef still guards
  // against firing the toast/modal more than once per reconnect episode: once
  // resumed, DiceGame calls onStateChange ~300ms after mount (see its own
  // effect), which updates liveTurnState — a dependency here — and would
  // otherwise re-run this effect while justReconnected is still waiting on the
  // store's next gameState round-trip to clear it.
  //
  // The turn-key inputs below are honest dependencies, so this now also re-runs
  // on any ordinary turn or card change. Both one-shot refs make those runs
  // return immediately, and running with the current turn is the whole point:
  // the key it builds has to describe the turn actually on screen.
  useEffect(() => {
    if (isOnline && justReconnected) {
      if (onlineReconnectHandledRef.current) return;
      onlineReconnectHandledRef.current = true;
      if (isMyTurn && effectiveDiceMode === 'digital' && liveTurnState) {
        const snapshotWithPlayer = {
          ...liveTurnState,
          playerName: currentPlayer?.name,
          turnKey: buildTurnKey(roomId, round, currentPlayerIndex, currentCard, game.ruleset),
        };
        localStorage.setItem(DICE_TURN_STATE_KEY, JSON.stringify(snapshotWithPlayer));
        // The one suppression left in this file, and it is not a stale-render
        // case like the ones above: reopening the panel here is one of three
        // things that happen together when a reconnect lands — the cache entry
        // is written, the panel comes back, the player is told why. There is no
        // render-time expression of that, because the other two are side
        // effects and an effect is exactly where they belong.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setShowDiceGame(true);
        addToast(t('game.resumingDiceGame', 'Resuming your dice game...'));
      }
      return;
    }
    onlineReconnectHandledRef.current = false;

    if (!isOnline && isMyTurn && effectiveDiceMode === 'digital' && localCacheOnMountRef.current && !reconnectHandledRef.current) {
      reconnectHandledRef.current = true;
      localCacheOnMountRef.current = false;

      const raw = localStorage.getItem(DICE_TURN_STATE_KEY);
      const parsed = parseSavedDiceState(raw);
      const expectedTurnKey = buildTurnKey(roomId, round, currentPlayerIndex, currentCard, game.ruleset);

      if (parsed && parsed.turnKey === expectedTurnKey) {
        setShowDiceGame(true);
        addToast(t('game.resumingDiceGame', 'Resuming your dice game...'));
      } else {
        localStorage.removeItem(DICE_TURN_STATE_KEY);
      }
    }
  }, [
    justReconnected, liveTurnState, isMyTurn, effectiveDiceMode, isOnline,
    currentCard, currentPlayer?.name, currentPlayerIndex, roomId, round, addToast, t,
    game.ruleset,
  ]);

  useEffect(() => {
    let soundTimeout: ReturnType<typeof setTimeout> | undefined;
    let turnTimeout: ReturnType<typeof setTimeout> | undefined;

    // A Stop drawn while the dice modal is open is a classic chain forfeit
    // that DiceGame itself commits (with its own summary) — the auto-continue
    // here would race it and commit the turn a second time.
    if (currentCard === 'Stop' && !showDiceGame) {
      const commitStop = () => {
        if (isClassic && hasPhysicalChain()) {
          nextTurn(0, false, buildPhysicalSummary('stopCard', false, Math.max(0, parseInt(scoreInput, 10) || 0)));
          clearChain();
        } else {
          nextTurn(0, false);
        }
      };
      if (isTestEnv()) {
        playBuzzer();
        if (isOnline && isMyTurn) {
          turnTimeout = setTimeout(commitStop, STOP_CARD_AUTO_CONTINUE_MS);
        }
      } else {
        soundTimeout = setTimeout(() => playBuzzer(), CARD_FLIP_MS);
        if (isOnline && isMyTurn) {
          turnTimeout = setTimeout(commitStop, CARD_FLIP_MS + STOP_CARD_AUTO_CONTINUE_MS);
        }
      }
    }

    return () => {
      clearTimeout(soundTimeout);
      clearTimeout(turnTimeout);
    };
  // cards?.length is deliberate and not incidental: drawing another Stop card
  // leaves currentCard unchanged, and the deck shrinking is what tells the two
  // draws apart so the buzzer sounds again for the second one.
  }, [isOnline, isMyTurn, currentCard, cards?.length, nextTurn, showDiceGame, isClassic, hasPhysicalChain, buildPhysicalSummary, clearChain, scoreInput]);

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
    if (isClassic) {
      // The player enters the fully-computed final total (the Apply-bonus
      // helper is hidden for classic — mid-chain it would apply the wrong
      // card's arithmetic). A completed special card was already marked in
      // the chain when its Yes was answered.
      nextTurn(parsedScore, parsedScore > 0, buildPhysicalSummary(parsedScore > 0 ? 'banked' : 'null', physicalAwaitingChoice));
      clearChain();
    } else {
      nextTurn(parsedScore, parsedScore > 0);
    }
    setScoreInput('');
    setApplyBonus(false);
  }, [scoreInput, applyBonus, currentCard, nextTurn, isClassic, buildPhysicalSummary, physicalAwaitingChoice, clearChain]);

  const handleYesNo = useCallback((isSuccess: boolean) => {
    if (isClassic && currentCard && isSpecialCard(currentCard) && currentCard !== 'Kleeblatt') {
      // Kniffel/Plus_Minus under classic: a Yes does NOT commit the turn —
      // the card is completed, its fixed value is pre-filled into the score
      // input, and the player chooses to bank the total or draw the next
      // card. Only a No (the whole chain forfeited) commits here.
      if (isSuccess) {
        const isPlusMinus = currentCard === 'Plus_Minus';
        completeCurrentCard(isPlusMinus);
        setScoreInput(prev => String((parseInt(prev, 10) || 0) + (isPlusMinus ? PLUS_MINUS_SCORE : KNIFFEL_SCORE)));
        return;
      }
      nextTurn(0, false, buildPhysicalSummary('null', false, Math.max(0, parseInt(scoreInput, 10) || 0)));
      clearChain();
      setScoreInput('');
      return;
    }
    if (isClassic && currentCard === 'Kleeblatt') {
      nextTurn(0, isSuccess, buildPhysicalSummary(isSuccess ? 'banked' : 'null', isSuccess, Math.max(0, parseInt(scoreInput, 10) || 0)));
      clearChain();
      setScoreInput('');
      return;
    }
    if (isClassic && currentCard === 'Stop' && hasPhysicalChain()) {
      // The local Continue button on a mid-chain Stop — same forfeit the
      // online auto-continue commits.
      nextTurn(0, false, buildPhysicalSummary('stopCard', false, Math.max(0, parseInt(scoreInput, 10) || 0)));
      clearChain();
      setScoreInput('');
      return;
    }
    nextTurn(0, isSuccess);
  }, [nextTurn, isClassic, currentCard, completeCurrentCard, buildPhysicalSummary, clearChain, hasPhysicalChain, scoreInput]);

  // Classic physical: the player made a tutto with their real dice and
  // reveals the next card, keeping the running total in the score input.
  // A drawn Stop resolves through the Stop-card flow (auto online, the
  // Continue button locally), which commits the chain forfeit.
  const handlePhysicalDrawNextCard = useCallback(() => {
    if (!currentCard) return;
    const drawn = drawCardMidTurn();
    if (!drawn) return;
    recordDraw(drawn);
  }, [currentCard, drawCardMidTurn, recordDraw]);

  const handleDiceComplete = useCallback((score: number, isSuccess: boolean, turnSummary?: TurnSummary) => {
    setShowDiceGame(false);
    nextTurn(score, isSuccess, turnSummary);
  }, [nextTurn]);

  const currentCardHasInput = hasScoreInput(currentCard);
  const currentCardHasYesNo = isSpecialCard(currentCard);
  const isStopCard = currentCard === 'Stop';

  // Keyboard shortcuts: Space/Enter triggers whatever GameControls' primary
  // button is for the current turn state. There's no dice-roll modal dismiss
  // shortcut — once opened it auto-rolls immediately and can't be backed out
  // of. The roll/stop/select keys inside that modal live in DiceGame; the
  // guards both rely on (typing, open modals, held keys) are in the hook.
  const primaryAction = () => {
    if (isStopCard) {
      // A Stop showing while the dice modal is up is a classic mid-chain
      // forfeit that DiceGame commits itself, with the chain summary — the
      // same reason the Stop auto-continue effect above skips it. Committing
      // here too would advance the turn a second time (and without the
      // summary), handing the next player a forfeited turn.
      if (!showDiceGame) handleYesNo(false);
    } else if (effectiveDiceMode === 'digital') {
      // Digital mode always shows "Roll Dice" for any non-Stop card — it
      // doesn't distinguish input/yes-no cards the way physical mode does.
      if (!showDiceGame) setShowDiceGame(true);
    } else if (physicalAwaitingChoice) {
      // The bank-or-draw choice after a special card's Yes: banking the
      // entered total is the primary action, same as the button order.
      handleNextTurn();
    } else if (currentCardHasYesNo) {
      handleYesNo(true);
    } else if (currentCardHasInput) {
      handleNextTurn();
    }
  };

  useKeyboardShortcuts({
    space: isMyTurn ? primaryAction : undefined,
    enter: isMyTurn ? primaryAction : undefined,
  });

  // A turn exists to undo at all... (a classic chain that ended on a drawn
  // Stop card committed real changes and stays undoable — only the bare
  // modernized Stop, where nothing happened, is not)
  const hasUndoableTurn = !game.finished && !!game.previousCard
    && (game.previousCard !== 'Stop' || !!game.previousTurnSummary)
    && game.currentPlayerIndex !== null && !!game.previousPlayerName;
  // ...and this client is allowed to act on it (offline, or online as the
  // active player/host).
  const canActOnUndo = !isOnline || isMyTurn || isHost;
  const canUndo = hasUndoableTurn && canActOnUndo;

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
            ruleset={game.ruleset}
            setShowDiceGame={setShowDiceGame}
            scoreInput={scoreInput}
            setScoreInput={setScoreInput}
            applyBonus={applyBonus}
            setApplyBonus={setApplyBonus}
            handleNextTurn={handleNextTurn}
            handleYesNo={handleYesNo}
            onDrawNextCard={classicPhysical ? handlePhysicalDrawNextCard : undefined}
            awaitingChainChoice={physicalAwaitingChoice}
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
                    key={p.id ?? p.name}
                    className={`flex items-center px-4 py-3 border-b border-gray-50 dark:border-slate-700/50 last:border-0 transition-colors ${isCurrent ? 'bg-indigo-100 dark:bg-indigo-900/30' : 'hover:bg-white/50 dark:hover:bg-slate-800/50'}`}
                  >
                    <div className="w-12 font-medium text-gray-600 dark:text-gray-300">{p.position}.</div>
                    <div className="flex-1 font-bold flex items-center flex-wrap gap-2" style={{ color: p.color || 'var(--text-color, #1f2937)' }}>
                      <span>{p.name}</span>
                      {isOnline && game.hostId === p.socketId && (
                        <span title={t('game.host', 'Host')} className="text-lg leading-none">
                          <span aria-hidden="true">👑</span>
                          <span className="sr-only">{t('game.host', 'Host')}</span>
                        </span>
                      )}
                      {(() => {
                        // The streak matching the rules this room plays by.
                        const streak = isClassic ? p.winStreakClassic : p.winStreak;
                        return streak !== undefined && streak >= 3 && (
                          <span title={t('game.winStreakTitle', 'On a 🔥 {{streak}}-game win streak!', { streak })} className="text-amber-500 text-[10px] sm:text-xs font-bold bg-amber-50 dark:bg-amber-900/20 px-2 py-0.5 rounded-full border border-amber-100 dark:border-amber-900/50 flex items-center gap-0.5 whitespace-nowrap">
                            <span aria-hidden="true">🔥 {streak}</span>
                            <span className="sr-only">{t('game.winStreakTitle', 'On a 🔥 {{streak}}-game win streak!', { streak })}</span>
                          </span>
                        );
                      })()}
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
              <span className="mx-1">·</span>
              {t('game.rulesetBadge', {
                defaultValue: '{{value}} rules',
                value: game.ruleset === 'classic'
                  ? t('lobby.rulesetClassic', 'Classic')
                  : t('lobby.rulesetModernized', 'Modernized'),
              })}
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
              turnKey={buildTurnKey(roomId, round, currentPlayerIndex, currentCard, game.ruleset)}
              onComplete={handleDiceComplete}
              onStateChange={effectiveDiceMode === 'digital' ? setLiveTurnState : undefined}
              panelReady={diceGamePanelReady}
              ruleset={game.ruleset}
              onDrawCard={game.drawCardMidTurn}
            />
          </motion.div>
        </div>
      )}
    </div>
  );
}
