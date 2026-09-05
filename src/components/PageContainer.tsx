import type { ReactNode } from 'react';

/**
 * The outer shell of every top-level screen — Home (both lobbies), Game,
 * EndScreen and Statistics render through this so they share one width and
 * clear the fixed HUD the same way. Kept as a component rather than a copied
 * class string so the screens cannot drift apart again (PageContainer.test
 * pins each of them to it).
 *
 * max-w-4xl: at the lg: breakpoint the lobby's advanced-options grids switch
 * to 3/4 columns (LobbyShared.tsx) — at max-w-3xl those columns were too
 * narrow for their own labels ("Winning Score", "Kick Timer (s)", longer card
 * names like "Plus/Minus"), which get whitespace-nowrap + text-ellipsis and
 * were silently truncating regardless of how wide the browser window was.
 * The other screens follow the lobby so the app does not change width
 * between screens.
 *
 * pb-20: the fixed Help button (bottom-6 left-6) and the theme/language HUD
 * (bottom-4 right-4, App.tsx) sit over the bottom edge of every screen —
 * without it a screen's last row sits directly behind them.
 *
 * No flex-1: a screen is as tall as its content. Home used to fill the
 * viewport, which stretched a two-player lobby card to the full screen height.
 */
export const PAGE_CONTAINER_CLASS = 'container mx-auto max-w-4xl px-2 sm:px-4 pb-20 flex flex-col';

interface PageContainerProps {
  /** Per-screen extras: top padding, gap, alignment. Never a width or bottom padding. */
  className?: string;
  testId?: string;
  children: ReactNode;
}

export default function PageContainer({ className, testId, children }: PageContainerProps) {
  return (
    <div data-testid={testId} className={className ? `${PAGE_CONTAINER_CLASS} ${className}` : PAGE_CONTAINER_CLASS}>
      {children}
    </div>
  );
}
