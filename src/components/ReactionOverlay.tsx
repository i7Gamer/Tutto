import { motion, AnimatePresence } from 'framer-motion';
import { useGameStore } from '../store/useGameStore';

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

  return (
    <AnimatePresence>
      {reactions?.map((r, i) => (
        <motion.div
          key={r.id}
          initial={{ opacity: 0, y: REACTION_SPAWN_OFFSET_PX, scale: 0.5, x: 0 }}
          animate={{
            opacity: 1,
            y: -REACTION_RISE_DISTANCE_PX,
            scale: 2,
            x: (i % REACTION_HORIZONTAL_SPREAD_COUNT) * REACTION_HORIZONTAL_SPREAD_STEP_PX - REACTION_HORIZONTAL_SPREAD_OFFSET_PX,
          }}
          exit={{ opacity: 0, y: -REACTION_EXIT_RISE_DISTANCE_PX }}
          transition={{ duration: REACTION_ANIMATION_DURATION_S }}
          className="fixed bottom-24 left-1/2 -translate-x-1/2 text-4xl pointer-events-none select-none z-[100]"
          title={r.senderName}
        >
          {r.emoji}
        </motion.div>
      ))}
    </AnimatePresence>
  );
}
