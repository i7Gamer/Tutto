import { render } from '@testing-library/react';
import { describe, it, expect, afterEach } from 'vitest';
import IOSHapticProxy from './IOSHapticProxy';
import { triggerIOSSwitchHaptic, setIOSSwitchHapticElement } from '../utils/iosSwitchHaptic';

describe('IOSHapticProxy', () => {
  afterEach(() => {
    // @ts-expect-error test-only cleanup of a jsdom-absent API
    delete HTMLInputElement.prototype.switch;
    setIOSSwitchHapticElement(null);
  });

  it('renders nothing when the iOS switch-haptic trick is unsupported', () => {
    const { container } = render(<IOSHapticProxy />);
    expect(container.firstChild).toBeNull();
  });

  it('renders a hidden switch input with an associated label, and registers the label for triggerIOSSwitchHaptic', () => {
    Object.defineProperty(HTMLInputElement.prototype, 'switch', { value: true, configurable: true });

    const { container } = render(<IOSHapticProxy />);
    const input = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    const label = container.querySelector('label') as HTMLLabelElement;
    expect(input).toBeInTheDocument();
    expect(label).toBeInTheDocument();
    // WebKit only fires the haptic for a click forwarded through the label,
    // not one called directly on the input — the two must be associated.
    expect(label.htmlFor).toBe(input.id);

    let clicked = false;
    label.addEventListener('click', () => { clicked = true; });
    triggerIOSSwitchHaptic();

    expect(clicked).toBe(true);
  });

  it('clears the registered element on unmount', () => {
    Object.defineProperty(HTMLInputElement.prototype, 'switch', { value: true, configurable: true });

    const { unmount } = render(<IOSHapticProxy />);
    unmount();

    expect(() => triggerIOSSwitchHaptic()).not.toThrow();
  });
});
