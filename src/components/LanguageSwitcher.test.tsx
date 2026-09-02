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

// The aria-labels go through t(key, defaultValue) — return the default so the
// assertions below keep checking the human-readable label.
const tMock = (_key: string, defaultValue?: string) => defaultValue ?? _key;

// The real useTranslation() return type carries a branded TFunction and a
// 30+-member i18n instance; LanguageSwitcher only ever reads t, i18n.language
// and i18n.changeLanguage. Threading a minimal stand-in through unknown once
// here, rather than fabricating (or `any`-ing away) the rest of i18next's
// surface, is what "type it as unknown at the boundary" means for a
// third-party hook whose full shape isn't the thing under test.
const mockUseTranslation = (i18n: { language: string; changeLanguage: (lng: string) => void }) => {
  vi.mocked(useTranslation).mockReturnValue({ t: tMock, i18n } as unknown as ReturnType<typeof useTranslation>);
};

describe('LanguageSwitcher', () => {
  it('renders correctly and switches language', () => {
    const changeLanguageMock = vi.fn();
    mockUseTranslation({ language: 'en', changeLanguage: changeLanguageMock });

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

  it('exposes aria-label and aria-pressed reflecting the active language (COMP-ISSUE-37)', () => {
    mockUseTranslation({ language: 'en', changeLanguage: vi.fn() });

    render(<LanguageSwitcher />);

    const enButton = screen.getByRole('button', { name: 'Switch to English' });
    const deButton = screen.getByRole('button', { name: 'Switch to German' });
    expect(enButton).toHaveAttribute('aria-pressed', 'true');
    expect(deButton).toHaveAttribute('aria-pressed', 'false');
  });
});
