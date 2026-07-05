import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import HelpPopup from './HelpPopup';
import { useGameStore } from '../store/useGameStore';

// Mock the dependencies
vi.mock('react-i18next', async (importOriginal) => {
  const actual: any = await importOriginal();
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
});
