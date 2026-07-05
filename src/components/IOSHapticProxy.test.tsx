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

  // The feature is currently disabled (IOS_SWITCH_HAPTIC_ENABLED in
  // iosSwitchHaptic.ts), regardless of browser support, so this renders
  // nothing even on a `switch`-capable browser for now.
  it('renders nothing even when the browser supports `switch` — disabled for now', () => {
    Object.defineProperty(HTMLInputElement.prototype, 'switch', { value: true, configurable: true });

    const { container } = render(<IOSHapticProxy />);

    expect(container.firstChild).toBeNull();
  });

  it('does not throw when triggerIOSSwitchHaptic is called without ever having mounted/registered an element', () => {
    expect(() => triggerIOSSwitchHaptic()).not.toThrow();
  });
});
