// Renders the PWA / home-screen icons from public/icons/favicon.svg.
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';

const dir = new URL('../public/icons/', import.meta.url);
const svg = await readFile(new URL('favicon.svg', dir));

const render = (size, file) =>
  sharp(svg, { density: 384 }).resize(size, size).png().toFile(new URL(file, dir).pathname);

await render(192, 'icon-192.png');
await render(512, 'icon-512.png');
// iOS rounds corners itself and shows transparency as black: use a full-bleed square.
const square = await sharp(svg, { density: 384 })
  .resize(180, 180)
  .flatten({ background: '#0b1220' })
  .png()
  .toBuffer();
await sharp({ create: { width: 180, height: 180, channels: 4, background: '#0b1220' } })
  .composite([{ input: square }])
  .png()
  .toFile(new URL('apple-touch-icon.png', dir).pathname);
// Maskable: content inside the central 80% safe zone.
const content = await sharp(svg, { density: 384 }).resize(410, 410).png().toBuffer();
await sharp({ create: { width: 512, height: 512, channels: 4, background: '#0b1220' } })
  .composite([{ input: content, gravity: 'center' }])
  .png()
  .toFile(new URL('icon-maskable-512.png', dir).pathname);
console.log('icons written');
