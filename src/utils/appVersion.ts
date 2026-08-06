// The version from package.json, substituted at build time by the `define` in
// vite.config.js. Importing the manifest instead would pull it into the bundle
// and drag its whole dependency list along with it.
//
// Surfaced in HelpPopup's footer so a player (or whoever deployed the Docker
// image) can say which build they are looking at — the published tags are
// `latest` and `nightly`, which do not answer that on their own.
export const APP_VERSION: string = __APP_VERSION__;
