import { useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { useTranslation } from 'react-i18next';
import { useGameStore } from '../store/useGameStore';
import type { Reaction } from '../types';

// A reaction emoji spawns just below its `bottom-24` anchor and drifts
// upward while fading out. These distances must stay small relative to that
// anchor (96px from the viewport bottom) so it stays a gentle float near the
// bottom rather than reaching the top half of the screen on short viewports.
const REACTION_SPAWN_OFFSET_PX = 30;
const REACTION_RISE_DISTANCE_PX = 70;
const REACTION_EXIT_RISE_DISTANCE_PX = 110;
const REACTION_ANIMATION_DURATION_S = 2.5;
const REACTION_HORIZONTAL_SPREAD_COUNT = 5;
const REACTION_HORIZONTAL_SPREAD_STEP_PX = 40;
const REACTION_HORIZONTAL_SPREAD_OFFSET_PX = 80;

// Derived from the reaction's own id, not its position in the `reactions`
// array — that array shrinks as older reactions expire, so an index-based
// spread silently reassigns a still-visible reaction to a different
// horizontal slot (a visible jump) whenever an earlier one is removed.
const spreadSlotForReaction = (id: number): number => {
  const slot = Math.floor(id) % REACTION_HORIZONTAL_SPREAD_COUNT;
  return slot < 0 ? slot + REACTION_HORIZONTAL_SPREAD_COUNT : slot;
};

// Rendered once at the App level (like ToastMessage/HelpPopup) rather than
// inside Scoreboard's own card. That card is a framer-motion `layout` element
// — while it's mid-transition (its width changes as often as a player's name
// or the host crown/disconnected badge toggling), framer-motion drives it
// with a CSS transform, and a transform on ANY ancestor becomes the
// containing block for a nested `position: fixed` descendant. A reaction
// nested inside that card was following the card's own animated position
// instead of staying anchored to the real viewport — visually "jumping" to
// wherever the card ended up, including off the top of the screen. Mounting
// this at the top level, with no animated ancestors, keeps it truly
// viewport-fixed regardless of screen size or scroll position.
export default function ReactionOverlay() {
  const reactions = useGameStore(state => state.reactions);
  const addToast = useGameStore(state => state.addToast);
  const { t } = useTranslation();

  // Announces each reaction exactly once, through the same polite live
  // region App.tsx's toasts already use — the pointer-events-none caption
  // below is silent to a screen reader, so without this nobody using one
  // would know a reaction happened at all. Keyed by id (not array length):
  // reactions expire and are pruned independently, so a naive "new since
  // last render" diff by index would re-announce a still-visible one that
  // merely shifted position when an older reaction dropped out.
  const announcedIdsRef = useRef<Set<Reaction['id']>>(new Set());
  useEffect(() => {
    const liveIds = new Set(reactions?.map(r => r.id));
    for (const r of reactions ?? []) {
      if (announcedIdsRef.current.has(r.id)) continue;
      announcedIdsRef.current.add(r.id);
      addToast(t('game.reacted', { name: r.senderName }));
    }
    // Drops ids that have already expired, so the set does not grow for the
    // life of the session.
    for (const id of announcedIdsRef.current) {
      if (!liveIds.has(id)) announcedIdsRef.current.delete(id);
    }
  }, [reactions, addToast, t]);

  return (
    <AnimatePresence>
      {reactions?.map((r) => (
        <motion.div
          key={r.id}
          initial={{ opacity: 0, y: REACTION_SPAWN_OFFSET_PX, scale: 0.5, x: 0 }}
          animate={{
            opacity: 1,
            y: -REACTION_RISE_DISTANCE_PX,
            scale: 2,
            x: spreadSlotForReaction(r.id) * REACTION_HORIZONTAL_SPREAD_STEP_PX - REACTION_HORIZONTAL_SPREAD_OFFSET_PX,
          }}
          exit={{ opacity: 0, y: -REACTION_EXIT_RISE_DISTANCE_PX }}
          transition={{ duration: REACTION_ANIMATION_DURATION_S }}
          className="fixed bottom-24 left-1/2 -translate-x-1/2 flex flex-col items-center pointer-events-none select-none z-100"
        >
          <span className="text-4xl" title={r.senderName}>{r.emoji}</span>
          {/* Visible for as long as the emoji itself: previously the name
              existed only as this element's `title`, which nothing shows on
              a `pointer-events-none` element — nobody could ever see whose
              reaction this was. */}
          <span className="text-xs font-semibold text-gray-700 dark:text-gray-200 bg-white/80 dark:bg-slate-800/80 rounded-full px-2 py-0.5 mt-1 whitespace-nowrap">
            {r.senderName}
          </span>
        </motion.div>
      ))}
    </AnimatePresence>
  );
}
