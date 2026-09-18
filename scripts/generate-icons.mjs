/**
 * Renders the favicon and the PWA icon set from docs/brand/tutto-icon.png —
 * the brand's square master artwork (transparent background, 1254x1254).
 * It lives under docs/brand/, not public/, so the 600 KB master is neither
 * shipped in dist/ nor precached by the service worker (whose glob takes
 * every .png under it).
 *
 * Usage (sharp is not a project dependency; install it ad hoc, outside the
 * checkout if this is the production machine):
 *   npm install --no-save sharp
 *   node scripts/generate-icons.mjs
 *
 * Outputs:
 *   public/favicon.png                  browser-tab icon (index.html)
 *   public/icons/icon-192.png           192x192, purpose "any"
 *   public/icons/icon-512.png           512x512, purpose "any"
 *   public/icons/icon-512-maskable.png  512x512, purpose "maskable"
 * The three under icons/ are referenced by the manifest in vite.config.ts.
 */
import sharp from 'sharp';

const SRC = 'docs/brand/tutto-icon.png';
const OUT_DIR = 'public/icons';

// Modern tabs render 16–32px; 128 keeps hi-DPI tabs crisp at a few KB.
const FAVICON_SIZE = 128;
const ICON_SIZE_SMALL = 192;
const ICON_SIZE_LARGE = 512;

// Maskable icons get cropped to arbitrary launcher shapes — content must sit
// inside the central safe zone, so the logo is rendered at 60% of the canvas
// on a solid background (transparent corners would show the launcher's own
// fill through the mask).
const MASKABLE_SIZE = 512;
const MASKABLE_LOGO_RATIO = 0.6;
const MASKABLE_BACKGROUND = '#ffffff';

const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };

const renderSquare = (size) =>
  sharp(SRC)
    .resize(size, size, { fit: 'contain', background: TRANSPARENT })
    .png();

await renderSquare(FAVICON_SIZE).toFile('public/favicon.png');
await renderSquare(ICON_SIZE_SMALL).toFile(`${OUT_DIR}/icon-${ICON_SIZE_SMALL}.png`);
await renderSquare(ICON_SIZE_LARGE).toFile(`${OUT_DIR}/icon-${ICON_SIZE_LARGE}.png`);

const logoSize = Math.round(MASKABLE_SIZE * MASKABLE_LOGO_RATIO);
const logo = await renderSquare(logoSize).toBuffer();
await sharp({
  create: { width: MASKABLE_SIZE, height: MASKABLE_SIZE, channels: 4, background: MASKABLE_BACKGROUND },
})
  .composite([{ input: logo, gravity: 'center' }])
  .png()
  .toFile(`${OUT_DIR}/icon-${MASKABLE_SIZE}-maskable.png`);

console.log('Icons written to public/favicon.png and', OUT_DIR);
