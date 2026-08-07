import { describe, it, expect, vi, afterEach } from 'vitest';
import { supportsNativeShare, TOUCH_FIRST_POINTER_QUERY } from './shareSupport';

// setupTests installs a matchMedia stub that answers `matches: false` to
// everything; these tests swap in their own and put that one back after.
const stubMatchMedia = window.matchMedia;

const stagePointer = (coarse: boolean) => {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: coarse && query === TOUCH_FIRST_POINTER_QUERY,
    media: query,
  })) as unknown as typeof window.matchMedia;
};

const stageShareApi = () => Object.assign(navigator, { share: vi.fn() });

afterEach(() => {
  window.matchMedia = stubMatchMedia;
  delete (navigator as { share?: unknown }).share;
});

describe('supportsNativeShare', () => {
  it('is true on a touch-first device whose browser has the API', () => {
    stageShareApi();
    stagePointer(true);

    expect(supportsNativeShare()).toBe(true);
  });

  it('is false where the browser has no share API at all', () => {
    stagePointer(true);

    expect(supportsNativeShare()).toBe(false);
  });

  it('is false on a mouse-driven desktop even though the API is there', () => {
    // Chrome on Windows has navigator.share and hands off to the OS dialog,
    // which regularly comes up as "Try that again. We couldn't show you all the
    // ways you could share." — an error popup in place of a share sheet.
    stageShareApi();
    stagePointer(false);

    expect(supportsNativeShare()).toBe(false);
  });

  it('is false rather than throwing where matchMedia is missing', () => {
    // It is called during render, so a throw here would be a blank lobby.
    stageShareApi();
    window.matchMedia = undefined as unknown as typeof window.matchMedia;

    expect(supportsNativeShare()).toBe(false);
  });
});
