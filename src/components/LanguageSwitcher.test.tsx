import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import LanguageSwitcher from './LanguageSwitcher';
import { useTranslation } from 'react-i18next';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual('react-i18next');
  return {
    ...actual,
    useTranslation: vi.fn(),
  };
});

describe('LanguageSwitcher', () => {
  it('renders correctly and switches language', () => {
    const changeLanguageMock = vi.fn();
    useTranslation.mockReturnValue({
      i18n: {
        language: 'en',
        changeLanguage: changeLanguageMock,
      },
    });

    render(<LanguageSwitcher />);

    // Should display language options or toggle
    const deButton = screen.getByText('DE');
    expect(deButton).toBeInTheDocument();

    const enButton = screen.getByText('EN');
    expect(enButton).toBeInTheDocument();

    // Click to switch to German
    fireEvent.click(deButton);
    expect(changeLanguageMock).toHaveBeenCalledWith('de');
  });
});
