import { useEffect, useId, useRef } from 'react';
import { setIOSSwitchHapticElement, supportsIOSSwitchHaptic } from '../utils/iosSwitchHaptic';

// `switch` isn't a known HTML attribute to React's own type definitions yet —
// spread it in rather than pass it as a named prop so TypeScript doesn't
// reject it.
const switchAttr = { switch: '' };

// Mounted once at the App level (like ReactionOverlay/HelpPopup). Renders no
// visible UI — a hidden native switch input plus its associated <label>,
// which soundEffects.ts triggers via the label (not the input — see
// iosSwitchHaptic.ts for why) to produce a haptic tap on iOS, where
// navigator.vibrate doesn't exist. display:none is fine here — unlike a
// direct .click() on the input, the label-forwarding path WebKit hooks the
// haptic to doesn't need the control to be visibly rendered.
export default function IOSHapticProxy() {
  const id = useId();
  const labelRef = useRef<HTMLLabelElement>(null);

  useEffect(() => {
    // Guarded here too (not just the render's early return below) — otherwise
    // this runs unconditionally on every mount, including on platforms where
    // the <label> below is never rendered, always registering a null ref.
    if (!supportsIOSSwitchHaptic()) return;
    setIOSSwitchHapticElement(labelRef.current);
    return () => setIOSSwitchHapticElement(null);
  }, []);

  if (!supportsIOSSwitchHaptic()) return null;

  return (
    <>
      <input {...switchAttr} type="checkbox" id={id} aria-hidden="true" tabIndex={-1} style={{ display: 'none' }} />
      <label ref={labelRef} htmlFor={id} aria-hidden="true" style={{ display: 'none' }} />
    </>
  );
}
