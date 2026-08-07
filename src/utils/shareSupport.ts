/**
 * Whether a device where a link is worth handing to the OS share sheet.
 *
 * `typeof navigator.share === 'function'` on its own is not that question.
 * Chrome on Windows has the API and implements it by handing off to the Windows
 * share dialog, which regularly comes up as "Try that again. We couldn't show
 * you all the ways you could share." — an error popup instead of a sheet, with
 * nothing the player can do about it.
 *
 * A touch-first device is where the sheet is both dependable and the natural
 * way to pass a link to a messenger app. On desktop the copy button is the
 * better fit anyway: there is a keyboard to paste with, so nothing is lost by
 * leaving the share button out.
 */
export const TOUCH_FIRST_POINTER_QUERY = '(pointer: coarse)';

export const supportsNativeShare = (): boolean => {
  if (typeof navigator.share !== 'function') return false;
  // Guarded rather than assumed: this is read during render, so a browser
  // without matchMedia would be a blank lobby rather than a missing button.
  if (typeof window.matchMedia !== 'function') return false;
  return window.matchMedia(TOUCH_FIRST_POINTER_QUERY).matches;
};
