import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import RollAnnouncer from './RollAnnouncer';

// The shared setup mock (src/setupTests.tsx) hands t(key, values) back as
// the bare key — good enough here since this component only renders what it
// is given, never composes its own text (useRollAnnouncement.ts does that).

describe('RollAnnouncer', () => {
  it('renders a polite, visually hidden live region', () => {
    render(<RollAnnouncer announcement={null} seq={0} />);
    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region.className).toMatch(/\bsr-only\b/);
  });

  it('renders nothing inside the region when there is no announcement yet', () => {
    render(<RollAnnouncer announcement={null} seq={0} />);
    expect(screen.getByRole('status')).toHaveTextContent('');
  });

  it('renders the translated sentence for the given key and values', () => {
    render(<RollAnnouncer announcement={{ key: 'dice.announce.rollLanded', values: { count: 3 } }} seq={1} />);
    expect(screen.getByRole('status')).toHaveTextContent('dice.announce.rollLanded');
  });

  // The precedent (ReactionOverlay.tsx) does not solve "the same sentence
  // twice in a row is not re-spoken" — a live region only announces on a
  // DOM mutation, and setting identical text is not one. Keying the content
  // node on a counter that increments per announcement forces React to tear
  // down and remount that node even when the text is byte-for-byte the same.
  it('remounts the announced content on every seq change, even with identical text', () => {
    const announcement = { key: 'dice.announce.rollLanded', values: { count: 3 } };
    const { rerender } = render(<RollAnnouncer announcement={announcement} seq={1} />);
    const firstNode = screen.getByText('dice.announce.rollLanded');

    rerender(<RollAnnouncer announcement={announcement} seq={2} />);
    const secondNode = screen.getByText('dice.announce.rollLanded');

    expect(secondNode).not.toBe(firstNode);
  });
});
