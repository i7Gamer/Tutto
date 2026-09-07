/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />


// package.json's version, substituted by the `define` in vite.config.ts.
// Read through src/utils/appVersion.ts rather than directly.
declare const __APP_VERSION__: string;

interface Window {
  webkitAudioContext?: typeof AudioContext;
}

interface Navigator {
  // iOS Safari only, never standardized: true once the page is running from
  // its home-screen icon. See src/utils/installPrompt.ts's isStandalone.
  standalone?: boolean;
}
