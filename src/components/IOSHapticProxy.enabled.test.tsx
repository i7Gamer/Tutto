import { render } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import IOSHapticProxy from './IOSHapticProxy';
import { triggerIOSSwitchHaptic, setIOSSwitchHapticElement } from '../utils/iosSwitchHaptic';

// The kill-switch (IOS_SWITCH_HAPTIC_ENABLED, iosSwitchHaptic.ts) keeps
// supportsIOSSwitchHaptic() false everywhere today, so the component's real
// wiring — the hidden switch+label pair and the register/unregister effect —
// is unreachable through the real module. This file mocks ONLY the support
// probe to the enabled answer; registration and triggering stay the real
// implementations, so these tests exercise the plumbing that comes back to
// life the day the flag is flipped. IOSHapticProxy.test.tsx keeps the real
// probe and pins today's disabled behavior — which is why this lives in its
// own file: a module mock is file-wide, and there it would test the mock
// instead of the flag.
vi.mock('../utils/iosSwitchHaptic', async (importOriginal) => {
  const real = await importOriginal<typeof import('../utils/iosSwitchHaptic')>();
  return { ...real, supportsIOSSwitchHaptic: () => true };
});

describe('IOSHapticProxy (support probe mocked on)', () => {
  afterEach(() => {
    setIOSSwitchHapticElement(null);
  });

  it('renders the hidden switch input with its label wired by id', () => {
    const { container } = render(<IOSHapticProxy />);

    const input = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
    const label = container.querySelector('label') as HTMLLabelElement;
    expect(input).not.toBeNull();
    expect(label).not.toBeNull();
    // The `switch` attribute is what makes WebKit treat it as the native
    // switch control the haptic quirk is attached to.
    expect(input).toHaveAttribute('switch');
    // Hidden plumbing must stay out of the accessibility tree and tab order.
    expect(input).toHaveAttribute('aria-hidden', 'true');
    expect(input).toHaveAttribute('tabindex', '-1');
    expect(input.style.display).toBe('none');
    expect(label.htmlFor).toBe(input.id);
  });

  it('registers the label on mount and unregisters it on unmount', () => {
    const { container, unmount } = render(<IOSHapticProxy />);
    const label = container.querySelector('label') as HTMLLabelElement;
    const clicked = vi.fn();
    label.addEventListener('click', clicked);

    // The trigger must go through the LABEL — WebKit fires the haptic only
    // for the label→input forwarding path, never a direct input .click().
    triggerIOSSwitchHaptic();
    expect(clicked).toHaveBeenCalledTimes(1);

    unmount();
    triggerIOSSwitchHaptic();
    // Still one: the unmount cleanup must unregister, or the trigger would
    // click a detached element forever after.
    expect(clicked).toHaveBeenCalledTimes(1);
  });
});
