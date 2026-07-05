// Feature detection for an undocumented WebKit behavior: toggling a native
// `<input type="checkbox" switch>` control (Safari 17.4+ / iOS 17.4+) fires
// the system's native haptic tap. This is the only way to get any haptic
// feedback on iOS, since navigator.vibrate has never been implemented there.
// It's an emergent quirk of WebKit's native-control rendering, not a
// documented API — it could stop working in any future Safari release
// without notice, so every caller treats it as best-effort (see
// IOSHapticProxy.tsx for where the element itself lives).
export const supportsIOSSwitchHaptic = (): boolean =>
  typeof HTMLInputElement !== 'undefined' && 'switch' in HTMLInputElement.prototype;

let switchInputEl: HTMLInputElement | null = null;

export const setIOSSwitchHapticElement = (el: HTMLInputElement | null): void => {
  switchInputEl = el;
};

// Toggling (not just re-checking) the control's state is what produces the
// tap, and .click() both toggles it and matches how WebKit fires this for a
// real tap — a plain state mutation isn't reported to reliably trigger it.
export const triggerIOSSwitchHaptic = (): void => {
  switchInputEl?.click();
};
