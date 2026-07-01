/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />


interface Window {
  __TEST_MODE__?: boolean;
  webkitAudioContext?: typeof AudioContext;
}
