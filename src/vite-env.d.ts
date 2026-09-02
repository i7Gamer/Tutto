/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />


// package.json's version, substituted by the `define` in vite.config.ts.
// Read through src/utils/appVersion.ts rather than directly.
declare const __APP_VERSION__: string;

interface Window {
  webkitAudioContext?: typeof AudioContext;
}
