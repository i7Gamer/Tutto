import { describe, it, expect, vi, afterEach } from 'vitest';
import { supportsIOSSwitchHaptic, setIOSSwitchHapticElement, triggerIOSSwitchHaptic } from './iosSwitchHaptic';

describe('iosSwitchHaptic', () => {
  afterEach(() => {
    // @ts-expect-error test-only cleanup of a jsdom-absent API
    delete HTMLInputElement.prototype.switch;
    setIOSSwitchHapticElement(null);
  });

  describe('supportsIOSSwitchHaptic', () => {
    it('returns false when the browser has no `switch` property on HTMLInputElement (jsdom, most browsers)', () => {
      expect(supportsIOSSwitchHaptic()).toBe(false);
    });

    it('returns true when `switch` is present (Safari 17.4+)', () => {
      Object.defineProperty(HTMLInputElement.prototype, 'switch', { value: true, configurable: true });

      expect(supportsIOSSwitchHaptic()).toBe(true);
    });
  });

  describe('triggerIOSSwitchHaptic', () => {
    it('clicks the registered label (not an input — WebKit only fires the haptic via label forwarding)', () => {
      const el = document.createElement('label');
      const clickSpy = vi.spyOn(el, 'click');
      setIOSSwitchHapticElement(el);

      triggerIOSSwitchHaptic();

      expect(clickSpy).toHaveBeenCalledTimes(1);
    });

    it('does not throw when no element has been registered', () => {
      expect(() => triggerIOSSwitchHaptic()).not.toThrow();
    });
  });
});
