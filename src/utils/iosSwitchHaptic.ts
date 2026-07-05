// Feature detection for an undocumented WebKit behavior: clicking a <label>
// associated with a native `<input type="checkbox" switch>` control (Safari
// 17.4+ / iOS 17.4+, patched again in iOS 26.5 — see below) fires the
// system's Taptic Engine. This is the only way to get any haptic feedback on
// iOS, since navigator.vibrate has never been implemented there.
//
// Critically, the click has to go through the <label> — WebKit does NOT fire
// the haptic for a .click() called directly on the <input> itself, only for
// the label→input forwarding path a real label click goes through (see
// IOSHapticProxy.tsx for the paired input+label it clicks).
//
// This is an emergent quirk of WebKit's implementation, not a documented API,
// and Apple has already narrowed it once: it worked from iOS 17.4 up to
// 26.4 and was patched out in 26.5 (the `switch` attribute/rendering itself
// still exists — only the haptic side-effect was removed). There's no way to
// feature-detect "will this actually produce a haptic" from JS; every caller
// must already treat this as best-effort and degrade silently.
//
// Disabled for now: with the haptic side-effect gone on iOS 26.5+ and no way
// to tell which devices still have it, a "Vibration On/Off" toggle that
// silently does nothing for an unknown fraction of iOS users is worse than
// not showing it. Flip this to `true` to re-enable — the rest of the
// implementation (IOSHapticProxy, the soundEffects.ts fallbacks) is left
// completely in place and untouched.
const IOS_SWITCH_HAPTIC_ENABLED = false;

export const supportsIOSSwitchHaptic = (): boolean =>
  IOS_SWITCH_HAPTIC_ENABLED &&
  typeof HTMLInputElement !== 'undefined' && 'switch' in HTMLInputElement.prototype;

let switchLabelEl: HTMLLabelElement | null = null;

export const setIOSSwitchHapticElement = (el: HTMLLabelElement | null): void => {
  switchLabelEl = el;
};

export const triggerIOSSwitchHaptic = (): void => {
  switchLabelEl?.click();
};
