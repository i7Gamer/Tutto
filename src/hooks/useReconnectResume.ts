import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { localStore } from '../utils/storage';
import { buildTurnKey, parseSavedDiceState, DICE_TURN_STATE_KEY } from '../utils/diceTurnState';
import type { CardType, DiceMode, DiceSnapshot, Ruleset } from '../types';

export interface UseReconnectResumeOptions {
  isOnline: boolean;
  /** Set by the store for one reconnect episode; it clears itself. */
  justReconnected: boolean;
  isMyTurn: boolean;
  /** The mode this seat actually plays in — the host's enforcement already applied. */
  effectiveDiceMode: DiceMode;
  liveTurnState: DiceSnapshot | null;
  currentCard: CardType | null;
  currentPlayerName: string | undefined;
  currentPlayerIndex: number | null;
  roomId: string | null;
  round: number;
  ruleset: Ruleset;
  addToast: (message: string) => void;
  /** Reopen the dice panel. Game passes `() => setShowDiceGame(true)`. */
  onResume: () => void;
}

/**
 * Bringing an interrupted DIGITAL dice turn back after the connection (or the
 * page) dropped out from under it. Two routes into the same outcome — the
 * cache entry restored, the panel reopened, the player told why:
 *
 *   online  — the server relayed this seat's own last live snapshot back, and
 *             it is re-stamped with the current turn key and written to the
 *             resume cache before the panel is reopened;
 *   offline — nothing was relayed, but a cache entry survived the reload, and
 *             it is trusted only if its own key matches the turn on screen.
 *
 * Both routes are one-shot per episode, which is what the two refs are for.
 */
export const useReconnectResume = ({
  isOnline,
  justReconnected,
  isMyTurn,
  effectiveDiceMode,
  liveTurnState,
  currentCard,
  currentPlayerName,
  currentPlayerIndex,
  roomId,
  round,
  ruleset,
  addToast,
  onResume,
}: UseReconnectResumeOptions): void => {
  const { t } = useTranslation();
  const reconnectHandledRef = useRef(false);
  const onlineReconnectHandledRef = useRef(false);
  // Read once, at mount: an entry written during THIS session's play is not
  // something to offer a resume for.
  const localCacheOnMountRef = useRef(!!localStore.read(DICE_TURN_STATE_KEY));

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
      // The relayed snapshot carries no turn key of its own (the server strips
      // it — see sanitizeDiceSnapshot), so re-stamping it with the CURRENT key
      // is an assertion that it belongs to the current card. A classic chain
      // can disprove that: the ~300ms snapshot debounce means a mid-chain draw
      // can land while the last pushed snapshot still describes the card
      // before it, and re-stamping that one hands its six kept dice and its
      // accumulated total to the newly drawn card — banking a chain the player
      // never played it for. The chain's own tail is the check.
      const chain = liveTurnState?.cardsThisTurn;
      const describesCurrentCard = !chain?.length || chain[chain.length - 1] === currentCard;
      if (isMyTurn && effectiveDiceMode === 'digital' && liveTurnState && describesCurrentCard) {
        const snapshotWithPlayer = {
          ...liveTurnState,
          playerName: currentPlayerName,
          turnKey: buildTurnKey(roomId, round, currentPlayerIndex, currentCard, ruleset),
        };
        localStore.write(DICE_TURN_STATE_KEY, JSON.stringify(snapshotWithPlayer));
        // Reopening the panel is one of three things that happen together
        // when a reconnect lands — the cache entry is written, the panel comes
        // back, the player is told why. There is no render-time expression of
        // that, because the other two are side effects and an effect is
        // exactly where they belong. Give onResume a stable identity: it sits
        // in this effect's dependency array.
        onResume();
        addToast(t('game.resumingDiceGame', 'Resuming your dice game...'));
      }
      return;
    }
    onlineReconnectHandledRef.current = false;

    if (!isOnline && isMyTurn && effectiveDiceMode === 'digital' && localCacheOnMountRef.current && !reconnectHandledRef.current) {
      reconnectHandledRef.current = true;
      localCacheOnMountRef.current = false;

      const raw = localStore.read(DICE_TURN_STATE_KEY);
      const parsed = parseSavedDiceState(raw);
      const expectedTurnKey = buildTurnKey(roomId, round, currentPlayerIndex, currentCard, ruleset);

      if (parsed && parsed.turnKey === expectedTurnKey) {
        onResume();
        addToast(t('game.resumingDiceGame', 'Resuming your dice game...'));
      } else {
        localStore.remove(DICE_TURN_STATE_KEY);
      }
    }
  }, [
    justReconnected, liveTurnState, isMyTurn, effectiveDiceMode, isOnline,
    currentCard, currentPlayerName, currentPlayerIndex, roomId, round, addToast, t,
    ruleset, onResume,
  ]);
};
