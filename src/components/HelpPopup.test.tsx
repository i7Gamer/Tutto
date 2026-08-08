import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import HelpPopup from './HelpPopup';
import { useGameStore } from '../store/useGameStore';
import { APP_VERSION } from '../utils/appVersion';

// Mock the dependencies
vi.mock('react-i18next', async (importOriginal) => {
  const actual = await importOriginal() as Record<string, unknown>;
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string) => key,
    }),
  };
});

// Mock scrollIntoView
window.HTMLElement.prototype.scrollIntoView = vi.fn();

describe('HelpPopup', () => {
  it('renders closed by default and opens on click', async () => {
    render(<HelpPopup />);

    // Popup content should not be in document
    expect(screen.queryByText('help.title')).not.toBeInTheDocument();

    // Click the help button
    const button = screen.getByTitle('help.buttonTitle');
    fireEvent.click(button);

    // Popup content should now be visible
    expect(screen.getByText('help.title')).toBeInTheDocument();

    // The 'general' section should be open by default
    expect(screen.getByText('help.general.intro')).toBeInTheDocument();

    // Click close
    const closeBtn = screen.getByTitle('help.close');
    fireEvent.click(closeBtn);

    // Give time for exit animation (mocked usually, but waitFor is safer)
    await waitFor(() => {
      expect(screen.queryByText('help.title')).not.toBeInTheDocument();
    });
  });

  it('can toggle sections via table of contents', async () => {
    render(<HelpPopup />);
    fireEvent.click(screen.getByTitle('help.buttonTitle'));

    // Click on FAQ in TOC
    const faqBtn = screen.getByText('help.toc.faq');
    fireEvent.click(faqBtn);

    // FAQ section content should become visible
    expect(screen.getByText('help.faq.q1')).toBeInTheDocument();
  });

  it('names the running build in the footer', () => {
    // The published image tags are `latest` and `nightly`, which do not say
    // which build is actually running. This is the only place that does.
    render(<HelpPopup />);
    fireEvent.click(screen.getByTitle('help.buttonTitle'));

    expect(screen.getByTestId('help-app-version')).toHaveTextContent(APP_VERSION);
  });

  it('documents how to get someone else into your room', () => {
    // Four ways to hand a room over and a remembered-rooms list, none of which
    // is self-explanatory from an icon button.
    render(<HelpPopup />);
    fireEvent.click(screen.getByTitle('help.buttonTitle'));

    fireEvent.click(screen.getByText('help.toc.online'));

    expect(screen.getByText('help.online.inviteLink')).toBeInTheDocument();
    expect(screen.getByText('help.online.share')).toBeInTheDocument();
    expect(screen.getByText('help.online.qr')).toBeInTheDocument();
    expect(screen.getByText('help.online.scan')).toBeInTheDocument();
    expect(screen.getByText('help.online.recentRooms')).toBeInTheDocument();
  });

  it('documents the keyboard shortcuts, which have no on-screen hint of their own', () => {
    render(<HelpPopup />);
    fireEvent.click(screen.getByTitle('help.buttonTitle'));

    fireEvent.click(screen.getByText('help.toc.shortcuts'));

    expect(screen.getByText('help.shortcuts.primary')).toBeInTheDocument();
    expect(screen.getByText('help.shortcuts.rollAgain')).toBeInTheDocument();
    expect(screen.getByText('help.shortcuts.stop')).toBeInTheDocument();
    expect(screen.getByText('help.shortcuts.selectAll')).toBeInTheDocument();
  });

  it('defaults to cards section if opened during gameplay and a card is active', async () => {
    useGameStore.setState({
      status: 'playing',
      currentCard: 'Feuerwerk',
    });

    render(<HelpPopup />);
    fireEvent.click(screen.getByTitle('help.buttonTitle'));

    // Cards section should be open (we can assert that fireworks title is rendered)
    await waitFor(() => {
      expect(screen.getByText('help.cards.fireworks')).toBeInTheDocument();
    });
  });

  it('scrolls the specific highlighted card into view, not just the section wrapper', () => {
    // Regression test: the section's own scrollIntoView only brought the
    // "Cards" section's wrapper into view — if the active card sits further
    // down that section, it could still be off-screen. The card itself must
    // be the element scrolled into view.
    useGameStore.setState({
      status: 'playing',
      currentCard: 'Feuerwerk',
    });

    const scrolledElements: Element[] = [];
    window.HTMLElement.prototype.scrollIntoView = function (this: HTMLElement) {
      scrolledElements.push(this);
    };

    vi.useFakeTimers();
    try {
      render(<HelpPopup />);
      fireEvent.click(screen.getByTitle('help.buttonTitle'));

      act(() => {
        vi.advanceTimersByTime(400); // past HELP_SECTION_OPEN_ANIMATION_MS
      });

      const highlightedCard = screen.getByText('help.cards.fireworks').closest('div');
      expect(highlightedCard).not.toBeNull();
      expect(scrolledElements).toContain(highlightedCard);
    } finally {
      vi.useRealTimers();
      window.HTMLElement.prototype.scrollIntoView = vi.fn();
    }
  });

  describe('table of contents pills', () => {
    const openWiki = () => {
      render(<HelpPopup />);
      fireEvent.click(screen.getByTitle('help.buttonTitle'));
      return screen.getAllByTestId('help-toc-pill');
    };

    it('styles every pill through the same class, so none can drift from the rest', () => {
      // The pills used to carry a copy of the same utility string each; the
      // only thing that may differ between them is the selected/unselected
      // modifier.
      const pills = openWiki();
      expect(pills.length).toBeGreaterThan(1);

      const boxes = pills.map(pill =>
        [...pill.classList].filter(name => !name.startsWith('wiki-pill-')).sort().join(' ')
      );
      expect(new Set(boxes).size).toBe(1);
      expect(boxes[0]).toContain('wiki-pill');
    });

    it('marks only the selected pill as selected', () => {
      const pills = openWiki();

      expect(pills.filter(pill => pill.classList.contains('wiki-pill-active'))).toHaveLength(1);
    });

    it('does not let the row stretch its pills', () => {
      // The real assertion is the e2e one (e2e/wiki.spec.js) — jsdom has no
      // layout. This guards the cause: a wrapping flex row stretches items to
      // their own line's height, and the "Table of Contents:" label is taller
      // than a pill, so pills sharing its line came out bigger than wrapped
      // ones.
      const [firstPill] = openWiki();

      expect(firstPill.parentElement).toHaveClass('items-center');
    });
  });

  describe('modal accessibility (COMP-ISSUE-25/26)', () => {
    it('exposes dialog role, aria-modal, and a labelled title', () => {
      render(<HelpPopup />);
      fireEvent.click(screen.getByTitle('help.buttonTitle'));

      const dialog = screen.getByRole('dialog');
      expect(dialog).toHaveAttribute('aria-modal', 'true');
      const labelledBy = dialog.getAttribute('aria-labelledby');
      expect(labelledBy).toBeTruthy();
      expect(document.getElementById(labelledBy!)).toHaveTextContent('help.title');
    });

    it('gives the close button an accessible name beyond title alone', () => {
      render(<HelpPopup />);
      fireEvent.click(screen.getByTitle('help.buttonTitle'));

      expect(screen.getByRole('button', { name: 'help.close' })).toBeInTheDocument();
    });

    it('moves focus into the dialog on open and back to the trigger on close', async () => {
      render(<HelpPopup />);
      const openButton = screen.getByTitle('help.buttonTitle');
      fireEvent.click(openButton);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'help.close' })).toHaveFocus();
      });

      fireEvent.click(screen.getByRole('button', { name: 'help.close' }));

      await waitFor(() => {
        expect(openButton).toHaveFocus();
      });
    });

    it('closes on Escape', async () => {
      render(<HelpPopup />);
      fireEvent.click(screen.getByTitle('help.buttonTitle'));
      expect(screen.getByRole('dialog')).toBeInTheDocument();

      fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

      await waitFor(() => {
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      });
    });
  });
});
