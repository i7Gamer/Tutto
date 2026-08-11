import { readFileSync } from 'node:fs';
import { render } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import CardFace from './CardFace';

const ALL_CARD_TYPES = [
  'Kniffel', 'Plus_Minus', 'x2',
  '200', '300', '400', '500', '600',
  'Feuerwerk', 'Kleeblatt', 'Stop',
];

describe('CardFace', () => {
  describe('unknown card type', () => {
    it('renders nothing for an unrecognised card type', () => {
      const { container } = render(<CardFace cardType="InvalidCard" />);
      expect(container.firstChild).toBeNull();
    });

    it('renders nothing when cardType is undefined', () => {
      const { container } = render(<CardFace />);
      expect(container.firstChild).toBeNull();
    });
  });

  describe('wrapper class per card type', () => {
    it.each(ALL_CARD_TYPES)(
      '%s → .tutto-card.c-%s',
      (cardType) => {
        const { container } = render(<CardFace cardType={cardType} />);
        expect(container.querySelector(`.tutto-card.c-${cardType}`)).toBeInTheDocument();
      }
    );
  });

  describe('structural elements present on every card', () => {
    it.each(ALL_CARD_TYPES)('%s has an .overlay layer', (cardType) => {
      const { container } = render(<CardFace cardType={cardType} />);
      expect(container.querySelector('.overlay')).toBeInTheDocument();
    });

    it.each(ALL_CARD_TYPES)('%s has the circular .inr frame', (cardType) => {
      const { container } = render(<CardFace cardType={cardType} />);
      expect(container.querySelector('.inr')).toBeInTheDocument();
    });

    it.each(ALL_CARD_TYPES)('%s has a .hdr header', (cardType) => {
      const { container } = render(<CardFace cardType={cardType} />);
      expect(container.querySelector('.hdr')).toBeInTheDocument();
    });
  });

  describe('card header values', () => {
    it('Kniffel shows "2000"', () => {
      const { container } = render(<CardFace cardType="Kniffel" />);
      expect(container.querySelector('.val').textContent).toBe('2000');
    });

    it('Plus_Minus shows "1000"', () => {
      const { container } = render(<CardFace cardType="Plus_Minus" />);
      expect(container.querySelector('.val').textContent).toBe('1000');
    });

    it('x2 shows "×2"', () => {
      const { container } = render(<CardFace cardType="x2" />);
      expect(container.querySelector('.val').textContent).toBe('×2');
    });

    it.each(['200', '300', '400', '500', '600'])(
      '%s bonus card shows value and "Bonus" label',
      (value) => {
        const { container } = render(<CardFace cardType={value} />);
        expect(container.querySelector('.val').textContent).toBe(value);
        expect(container.querySelector('.b-txt').textContent).toBe('Bonus');
      }
    );
  });

  describe('Stop card', () => {
    it('has a .ring element', () => {
      const { container } = render(<CardFace cardType="Stop" />);
      expect(container.querySelector('.ring')).toBeInTheDocument();
    });

    it('has a .cross element', () => {
      const { container } = render(<CardFace cardType="Stop" />);
      expect(container.querySelector('.cross')).toBeInTheDocument();
    });

    it('shows a die inside the ring', () => {
      const { container } = render(<CardFace cardType="Stop" />);
      expect(container.querySelector('.die-face')).toBeInTheDocument();
    });
  });

  describe('Feuerwerk card', () => {
    it('renders star elements', () => {
      const { container } = render(<CardFace cardType="Feuerwerk" />);
      expect(container.querySelectorAll('.star').length).toBeGreaterThan(0);
    });

    it('renders coloured dot (dc) elements for the constellation trail', () => {
      const { container } = render(<CardFace cardType="Feuerwerk" />);
      expect(container.querySelectorAll('.dc').length).toBeGreaterThan(0);
    });
  });

  describe('Kleeblatt card', () => {
    it('renders four main clover leaf petals (.il-1 through .il-4)', () => {
      const { container } = render(<CardFace cardType="Kleeblatt" />);
      expect(container.querySelector('.il-1')).toBeInTheDocument();
      expect(container.querySelector('.il-2')).toBeInTheDocument();
      expect(container.querySelector('.il-3')).toBeInTheDocument();
      expect(container.querySelector('.il-4')).toBeInTheDocument();
    });

    it('renders a stem (.stm)', () => {
      const { container } = render(<CardFace cardType="Kleeblatt" />);
      expect(container.querySelector('.stm')).toBeInTheDocument();
    });
  });

  describe('Kniffel card', () => {
    it('renders 6 dice in the stacked layout', () => {
      const { container } = render(<CardFace cardType="Kniffel" />);
      expect(container.querySelectorAll('.stk .die-face').length).toBe(6);
    });
  });

  describe('x2 and bonus cards — dice grid', () => {
    it('x2 has 6 dice in the .grd layout', () => {
      const { container } = render(<CardFace cardType="x2" />);
      expect(container.querySelectorAll('.grd .die-face').length).toBe(6);
    });

    it.each(['200', '300', '400', '500', '600'])(
      '%s has 6 dice in the .grd layout',
      (value) => {
        const { container } = render(<CardFace cardType={value} />);
        expect(container.querySelectorAll('.grd .die-face').length).toBe(6);
      }
    );
  });

  describe('dice dot counts (verifies DICE_PATTERNS)', () => {
    it('Kniffel stacked dice 1–6 have 21 total dots', () => {
      const { container } = render(<CardFace cardType="Kniffel" />);
      // dice 1+2+3+4+5+6 = 21 dots
      expect(container.querySelectorAll('.stk .die-face i').length).toBe(21);
    });

    it('x2 grid dice 6–1 have 21 total dots', () => {
      const { container } = render(<CardFace cardType="x2" />);
      // dice 6+5+4+3+2+1 = 21 dots
      expect(container.querySelectorAll('.grd .die-face i').length).toBe(21);
    });

    it('Stop die face value 5 has exactly 5 dots', () => {
      const { container } = render(<CardFace cardType="Stop" />);
      expect(container.querySelectorAll('.die-face i').length).toBe(5);
    });

    it('each bonus card grid has 21 total dots (6+5+4+3+2+1)', () => {
      ['200', '300', '400', '500', '600'].forEach((value) => {
        const { container } = render(<CardFace cardType={value} />);
        expect(container.querySelectorAll('.grd .die-face i').length).toBe(21);
      });
    });
  });

  describe('Plus_Minus card', () => {
    it('renders the blue cross bar (.b-grad)', () => {
      const { container } = render(<CardFace cardType="Plus_Minus" />);
      expect(container.querySelector('.b-grad')).toBeInTheDocument();
    });

    it('renders the red minus bar (.r-grad)', () => {
      const { container } = render(<CardFace cardType="Plus_Minus" />);
      expect(container.querySelector('.r-grad')).toBeInTheDocument();
    });

    it('has bicolour corner gems (.crn-pm-l and .crn-pm-r)', () => {
      const { container } = render(<CardFace cardType="Plus_Minus" />);
      expect(container.querySelector('.crn-pm-l')).toBeInTheDocument();
      expect(container.querySelector('.crn-pm-r')).toBeInTheDocument();
    });
  });

  // These cards are drawn entirely by card.css — not one Tailwind utility among
  // them. That makes the class names load-bearing in a way a codemod cannot see:
  // the Tailwind v4 upgrade renamed `.ring` (the Stop card's red circle) to
  // `.ring-3`, taking it for the v3 `ring` utility, and left the stylesheet
  // alone. Every test above still passed — including the one that renamed its
  // own selector to match. They ask whether an element is there, and it was,
  // just unstyled. This asks the question none of them can.
  describe('every rendered class is defined in card.css', () => {
    // Root-relative: vitest runs from the project root, and under its transform
    // `import.meta.url` is not a file: URL, so it cannot resolve a sibling.
    const stylesheet = readFileSync('src/components/game/cards/card.css', 'utf8');
    const defined = new Set(
      [...stylesheet.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map(match => match[1])
    );

    it.each(ALL_CARD_TYPES)('%s', (cardType) => {
      const { container } = render(<CardFace cardType={cardType} />);
      const rendered = [...container.querySelectorAll('[class]')]
        .flatMap(element => element.className.split(/\s+/))
        .filter(Boolean);

      expect(rendered.length).toBeGreaterThan(0);
      expect([...new Set(rendered)].filter(cls => !defined.has(cls))).toEqual([]);
    });
  });
});
