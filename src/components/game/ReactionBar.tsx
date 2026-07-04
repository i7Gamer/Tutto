import { motion } from 'framer-motion';
import { REACTION_EMOJIS } from '../../utils/reactions';

interface ReactionBarProps {
  sendReaction: (emoji: string) => void;
}

export default function ReactionBar({ sendReaction }: ReactionBarProps) {
  return (
    <div className="flex justify-center gap-2 md:gap-3 flex-wrap">
      {REACTION_EMOJIS.map((emoji) => (
        <motion.button
          key={emoji}
          whileHover={{ scale: 1.15 }}
          whileTap={{ scale: 0.9 }}
          className="bg-[var(--card-bg)] hover:bg-indigo-50 dark:hover:bg-indigo-900/40 border border-white/40 rounded-xl w-11 h-11 md:w-12 md:h-12 flex items-center justify-center text-2xl shadow-sm transition-colors"
          onClick={() => sendReaction(emoji)}
        >
          {emoji}
        </motion.button>
      ))}
    </div>
  );
}
