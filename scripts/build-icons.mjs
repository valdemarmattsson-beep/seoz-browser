// Regenerate SEOZ app icons from the Orbit S logomark.
// Source of truth: assets/orbit-s.svg.
// Outputs: assets/icon.png, assets/icon.ico, assets/icon.icns.
// Run: npm run build:icons

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';
import sharp from 'sharp';
import pngToIco from 'png-to-ico';
import png2icons from 'png2icons';

const __dirname = dirname(fileURLToPath(import.meta.url));
const assetsDir = join(__dirname, '..', 'assets');

const INK = '#0A0A0A';
const PAPER = '#F6F4EF';

// App-icon plate: warm paper ground with ink Orbit S — matches brand spec
// (INK on PAPER, no gradients). Squircle radius ≈ 22.4%.
// Icon variant uses heavier stroke than the brand 4% rule so the mark stays
// legible at 16–48px where thin strokes disappear. Dot r=12, stroke 18 on
// the 200-unit grid. Mark sits at 64% of the plate.
function plateSvg(size) {
  const radius = Math.round(size * 0.224);
  const markSize = Math.round(size * 0.64);
  const markOffset = Math.round((size - markSize) / 2);
  const scale = markSize / 200;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect x="0" y="0" width="${size}" height="${size}" rx="${radius}" ry="${radius}" fill="${PAPER}"/>
  <g transform="translate(${markOffset} ${markOffset}) scale(${scale})">
    <circle cx="100" cy="100" r="12" fill="${INK}"/>
    <path d="M100 40 A 60 60 0 0 1 160 100" fill="none" stroke="${INK}" stroke-width="18" stroke-linecap="round"/>
    <path d="M100 160 A 60 60 0 0 1 40 100" fill="none" stroke="${INK}" stroke-width="18" stroke-linecap="round"/>
  </g>
</svg>`;
}

async function renderPng(size) {
  const svg = plateSvg(size);
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function main() {
  await mkdir(assetsDir, { recursive: true });

  console.log('Rendering icon.png (1024×1024)...');
  const png1024 = await renderPng(1024);
  await writeFile(join(assetsDir, 'icon.png'), png1024);

  console.log('Rendering multi-res .ico (16, 24, 32, 48, 64, 128, 256)...');
  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const icoPngs = await Promise.all(icoSizes.map(renderPng));
  const ico = await pngToIco(icoPngs);
  await writeFile(join(assetsDir, 'icon.ico'), ico);

  console.log('Rendering .icns (macOS) from 1024×1024 master...');
  const icns = png2icons.createICNS(png1024, png2icons.BILINEAR, 0);
  if (!icns) throw new Error('png2icons.createICNS returned null');
  await writeFile(join(assetsDir, 'icon.icns'), icns);

  console.log('Done. Output:');
  console.log(`  ${join(assetsDir, 'icon.png')}`);
  console.log(`  ${join(assetsDir, 'icon.ico')}`);
  console.log(`  ${join(assetsDir, 'icon.icns')}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
