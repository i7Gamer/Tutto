// Milliseconds in one second — the single conversion factor every
// `* 1000` / `/ 1000` ms-per-second literal in the client and server timing
// code used to spell out independently. Imported by both sides (the server
// can reach into src/utils/, same as it already does for configValidation.ts).
export const MS_PER_SECOND = 1000;
