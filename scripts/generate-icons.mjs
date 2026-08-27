/**
 * Renders the PWA icon set from public/favicon.svg (the only vector source —
 * public/assets/logo.png is a 200x200 raster and too small to upscale).
 *
 * Usage (sharp is not a project dependency; install it ad hoc):
 *   npm install --no-save sharp
 *   node scripts/generate-icons.mjs
 *
 * Outputs, referenced by the manifest in vite.config.ts:
 *   public/assets/icon-192.png           192x192, purpose "any"
 *   public/assets/icon-512.png           512x512, purpose "any"
 *   public/assets/icon-512-maskable.png  512x512, purpose "maskable"
 */
import sharp from 'sharp';

const SRC = 'public/favicon.svg';
const OUT_DIR = 'public/assets';

// Rasterization density for the 48px-wide SVG so the largest target stays crisp.
const SVG_DENSITY = 800;

// Maskable icons get cropped to arbitrary launcher shapes — content must sit
// inside the central safe zone, so the logo is rendered at 60% of the canvas
// on a solid background (transparent corners would show the launcher's own
// fill through the mask).
const MASKABLE_SIZE = 512;
const MASKABLE_LOGO_RATIO = 0.6;
const MASKABLE_BACKGROUND = '#ffffff';

const TRANSPARENT = { r: 0, g: 0, b: 0, alpha: 0 };

const renderSquare = (size) =>
  sharp(SRC, { density: SVG_DENSITY })
    .resize(size, size, { fit: 'contain', background: TRANSPARENT })
    .png();

await renderSquare(192).toFile(`${OUT_DIR}/icon-192.png`);
await renderSquare(512).toFile(`${OUT_DIR}/icon-512.png`);

const logoSize = Math.round(MASKABLE_SIZE * MASKABLE_LOGO_RATIO);
const logo = await renderSquare(logoSize).toBuffer();
await sharp({
  create: { width: MASKABLE_SIZE, height: MASKABLE_SIZE, channels: 4, background: MASKABLE_BACKGROUND },
})
  .composite([{ input: logo, gravity: 'center' }])
  .png()
  .toFile(`${OUT_DIR}/icon-512-maskable.png`);

console.log('Icons written to', OUT_DIR);
