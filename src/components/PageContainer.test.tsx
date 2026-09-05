import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import PageContainer, { PAGE_CONTAINER_CLASS } from './PageContainer';

const read = (file: string) => readFileSync(join(__dirname, file), 'utf8');

// Every top-level screen goes through this one shell. The Statistics page used
// to be max-w-3xl while the lobby was max-w-4xl, and the lobby stretched to the
// full viewport height (flex-1) while every other screen sized to its content —
// two drifts nobody noticed until a round was played on a wide desktop. Pinning
// the four screens to the shared component keeps them from drifting again.
const SCREENS = ['Home.tsx', 'Game.tsx', 'EndScreen.tsx', 'Statistics.tsx'];

describe('PageContainer', () => {
  it('renders its children inside the shared shell class, with a test id and extra classes', () => {
    render(
      <PageContainer testId="probe-page" className="pt-8 items-center">
        <span>content</span>
      </PageContainer>,
    );
    const page = screen.getByTestId('probe-page');
    expect(page).toHaveTextContent('content');
    for (const cls of PAGE_CONTAINER_CLASS.split(' ')) expect(page).toHaveClass(cls);
    expect(page).toHaveClass('pt-8');
    expect(page).toHaveClass('items-center');
  });

  it('renders without a test id when none is given', () => {
    const { container } = render(<PageContainer>x</PageContainer>);
    expect(container.firstElementChild).not.toHaveAttribute('data-testid');
    expect(container.firstElementChild).toHaveAttribute('class', PAGE_CONTAINER_CLASS);
  });

  it('centres at one shared width, clears the HUD, and never fills the viewport height', () => {
    const classes = PAGE_CONTAINER_CLASS.split(' ');
    expect(classes).toContain('mx-auto');
    expect(classes).toContain('max-w-4xl');
    // The fixed help button and theme/language HUD sit at the bottom edge —
    // every screen clears them with the same bottom padding.
    expect(classes).toContain('pb-20');
    expect(classes).not.toContain('flex-1');
  });

  it.each(SCREENS)('%s renders through PageContainer instead of its own container div', (file) => {
    const source = read(file);
    expect(source).toMatch(/<PageContainer\b/);
    expect(source).not.toMatch(/container mx-auto/);
  });

  it('the lobby sizes to its content instead of stretching to the viewport', () => {
    // Home.tsx had flex-1 on both its outer div and its card, which is what
    // made a two-player online lobby as tall as the screen.
    expect(read('Home.tsx')).not.toMatch(/\bflex-1\b/);
  });
});
