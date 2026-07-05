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

  it('renders a hidden switch input and registers it for triggerIOSSwitchHaptic when supported', () => {
    Object.defineProperty(HTMLInputElement.prototype, 'switch', { value: true, configurable: true });

    const { container } = render(<IOSHapticProxy />);
    const input = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(input).toBeInTheDocument();

    let clicked = false;
    input.addEventListener('click', () => { clicked = true; });
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
