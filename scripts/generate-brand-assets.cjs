/* global __dirname, process, console */
const fs = require('node:fs');
const path = require('node:path');
const { Buffer } = require('node:buffer');
const sharp = require(process.argv[2] || 'sharp');

const root = path.resolve(__dirname, '..');
const sourceRoot = path.join(root, 'assets', 'branding');
const outputRoot = path.join(root, 'assets', 'images');
const background = '#FFFFFF';
const app = fs.readFileSync(path.join(sourceRoot, 'app-icon.svg'), 'utf8');
const splash = fs.readFileSync(path.join(sourceRoot, 'splash-icon.svg'), 'utf8');
const art = app.replace(/<svg[^>]*>|<\/svg>/g, '').replace(/<rect\b[^>]*\/>/, '');
const safeArt = `<g transform="translate(512 512) scale(.78) translate(-512 -512)">${art}</g>`;
const foreground = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">${safeArt}</svg>`;
const monochrome = foreground.replace(/(fill|stroke)="#[0-9a-f]{6}"/gi, '$1="#FFFFFF"');

async function render(svg, filename, size, opaque = false) {
  let image = sharp(Buffer.from(svg)).resize(size, size);
  if (opaque) image = image.flatten({ background });
  await image.png().toFile(path.join(outputRoot, filename));
}

(async () => {
  fs.mkdirSync(outputRoot, { recursive: true });
  await render(app, 'icon.png', 1024, true);
  await render(app, 'favicon.png', 64, true);
  await render(splash, 'splash-icon.png', 1024);
  await render(foreground, 'android-icon-foreground.png', 1024);
  await render(monochrome, 'android-icon-monochrome.png', 1024);
  await sharp({ create: { width: 1024, height: 1024, channels: 3, background } }).png()
    .toFile(path.join(outputRoot, 'android-icon-background.png'));
  console.log('Generated 6 brand assets from the selected orbit SVG artwork.');
})().catch((error) => { console.error(error.message); process.exitCode = 1; });
