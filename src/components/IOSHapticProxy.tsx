import { useEffect, useRef } from 'react';
import { setIOSSwitchHapticElement, supportsIOSSwitchHaptic } from '../utils/iosSwitchHaptic';

// `switch` isn't a known HTML attribute to React's own type definitions yet —
// spread it in rather than pass it as a named prop so TypeScript doesn't
// reject it.
const switchAttr = { switch: '' };

// Mounted once at the App level (like ReactionOverlay/HelpPopup). Renders no
// visible UI — just a hidden native switch control that soundEffects.ts can
// .click() to produce a haptic tap on iOS, where navigator.vibrate doesn't
// exist. Must stay a real rendered element (not display:none) for WebKit's
// native control to exist and respond to .click() — hidden via off-screen
// positioning instead.
export default function IOSHapticProxy() {
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setIOSSwitchHapticElement(ref.current);
    return () => setIOSSwitchHapticElement(null);
  }, []);

  if (!supportsIOSSwitchHaptic()) return null;

  return (
    <input
      {...switchAttr}
      ref={ref}
      type="checkbox"
      aria-hidden="true"
      tabIndex={-1}
      style={{ position: 'fixed', left: '-9999px', top: 0, width: 1, height: 1, opacity: 0, pointerEvents: 'none' }}
    />
  );
}
