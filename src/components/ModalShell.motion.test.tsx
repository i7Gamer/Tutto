import { forwardRef, type ReactNode, type HTMLAttributes } from 'react';
import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import ModalShell from './ModalShell';

// framer-motion mocked so the motion props themselves can be read off the
// DOM: with the real library the values are applied over rAF frames that jsdom
// never paints, and the point here is what the shell ASKS for, not the frames.
type MotionDivProps = HTMLAttributes<HTMLDivElement> & {
  initial?: unknown; animate?: unknown; exit?: unknown; transition?: unknown; children?: ReactNode;
};
vi.mock('framer-motion', () => ({
  AnimatePresence: ({ children }: { children?: ReactNode }) => <>{children}</>,
  motion: {
    div: forwardRef<HTMLDivElement, MotionDivProps>(function MotionDiv({ initial, animate, exit, transition, children, ...rest }, ref) {
      return (
        <div
          ref={ref}
          data-initial={JSON.stringify(initial ?? null)}
          data-animate={JSON.stringify(animate ?? null)}
          data-exit={JSON.stringify(exit ?? null)}
          {...rest}
        >
          {children}
        </div>
      );
    }),
  },
}));

const motionOf = (el: HTMLElement) => ({
  initial: JSON.parse(el.dataset.initial ?? 'null'),
  animate: JSON.parse(el.dataset.animate ?? 'null'),
  exit: JSON.parse(el.dataset.exit ?? 'null'),
});

describe('ModalShell motion', () => {
  // The leave-room, end-game and kick confirms all popped into place with no
  // transition at all: the shell only animated when a caller handed it motion
  // props, and ConfirmModal never did, while the backdrop was a plain div that
  // could not fade whatever the panel did.
  it('fades the backdrop in and out by default', () => {
    render(<ModalShell open><button>ok</button></ModalShell>);
    const backdrop = motionOf(screen.getByTestId('modal-backdrop'));
    expect(backdrop.initial).toEqual({ opacity: 0 });
    expect(backdrop.animate).toEqual({ opacity: 1 });
    expect(backdrop.exit).toEqual({ opacity: 0 });
  });

  it('gives the panel an entrance and an exit by default', () => {
    render(<ModalShell open><button>ok</button></ModalShell>);
    const panel = motionOf(screen.getByRole('dialog'));
    expect(panel.initial).toMatchObject({ opacity: 0 });
    expect(panel.animate).toMatchObject({ opacity: 1 });
    expect(panel.exit).toMatchObject({ opacity: 0 });
    // A scale change, so the card visibly settles rather than only fading.
    expect(panel.initial.scale).toBeLessThan(1);
    expect(panel.animate.scale).toBe(1);
  });

  it('lets a caller replace the panel motion, keeping the backdrop fade', () => {
    render(
      <ModalShell open motionProps={{ initial: { y: 40 }, animate: { y: 0 } }}>
        <button>ok</button>
      </ModalShell>,
    );
    const panel = motionOf(screen.getByRole('dialog'));
    expect(panel.initial).toEqual({ y: 40 });
    expect(panel.animate).toEqual({ y: 0 });
    expect(motionOf(screen.getByTestId('modal-backdrop')).exit).toEqual({ opacity: 0 });
  });
});
