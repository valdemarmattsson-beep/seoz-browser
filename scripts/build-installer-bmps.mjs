// Generate NSIS installer BMP assets from the Orbit S logomark.
// Source of truth: brand spec (ink Orbit S on paper).
// Outputs:
//   build/installerHeader.bmp     150×57   — top of installer pages (non-Welcome/Finish)
//   build/installerSidebar.bmp    164×314  — Welcome + Finish pages
//   build/uninstallerSidebar.bmp  164×314  — uninstaller Welcome/Finish
// NSIS BMPs MUST be 24-bit BGR uncompressed. Sharp can't output BMP, so
// we render via SVG → raw RGB (sharp) → wrap in BMP header (this file).
// Run: npm run build:installer-bmps

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { writeFile, mkdir } from 'node:fs/promises'
import sharp from 'sharp'

const __dirname = dirname(fileURLToPath(import.meta.url))
const buildDir = join(__dirname, '..', 'build')

const INK = '#0A0A0A'
const PAPER = '#F6F4EF'

// Orbit S in canonical 200-unit geometry, scaled+positioned via wrapping
// SVG group. Scale = markSize / 200 puts the mark at the requested size.
function orbitGroup(markSize) {
  const scale = markSize / 200
  return `<g transform="scale(${scale})">
    <circle cx="100" cy="100" r="6" fill="${INK}"/>
    <path d="M100 40 A 60 60 0 0 1 160 100" fill="none" stroke="${INK}" stroke-width="8" stroke-linecap="round"/>
    <path d="M100 160 A 60 60 0 0 1 40 100" fill="none" stroke="${INK}" stroke-width="8" stroke-linecap="round"/>
  </g>`
}

// Header strip — small mark on the left, hairline divider running right.
// NSIS draws page text below this strip, so keep it visually quiet.
function headerSvg(width = 150, height = 57) {
  const markSize = 32
  const xPad = 14
  const y = (height - markSize) / 2
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="${width}" height="${height}" fill="${PAPER}"/>
    <g transform="translate(${xPad} ${y})">${orbitGroup(markSize)}</g>
    <line x1="${xPad + markSize + 12}" y1="${height / 2}" x2="${width - xPad}" y2="${height / 2}" stroke="${INK}" stroke-width="0.5" opacity="0.18"/>
    <line x1="0" y1="${height - 0.5}" x2="${width}" y2="${height - 0.5}" stroke="${INK}" stroke-width="1" opacity="0.08"/>
  </svg>`
}

// Sidebar — full-height panel on Welcome/Finish. NSIS draws title + body
// text to the right of this image, so we own only the left strip.
// Centered Orbit mark in the upper third, hairline accent near the bottom.
function sidebarSvg(width = 164, height = 314) {
  const markSize = 96
  const xMark = (width - markSize) / 2
  const yMark = 80
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
    <rect width="${width}" height="${height}" fill="${PAPER}"/>
    <g transform="translate(${xMark} ${yMark})">${orbitGroup(markSize)}</g>
    <line x1="40" y1="${height - 40}" x2="${width - 40}" y2="${height - 40}" stroke="${INK}" stroke-width="0.5" opacity="0.18"/>
  </svg>`
}

// Render an SVG to a raw RGB Buffer (top-down, 3 bytes/pixel).
// .flatten() composites onto paper — kills any antialias-edge alpha so the
// final BMP has no surprise transparent fringes.
async function svgToRgb(svg) {
  const { data, info } = await sharp(Buffer.from(svg))
    .flatten({ background: PAPER })
    .raw()
    .toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height }
}

// Pack a top-down RGB buffer as a 24-bit BMP (BGR, bottom-up, 4-byte
// row alignment). Hand-rolled because sharp doesn't emit BMP and pulling
// in another image lib for this one job isn't worth a devDep.
function rgbToBmp24(rgb, width, height) {
  const rowSize = width * 3
  const padding = (4 - (rowSize % 4)) % 4
  const paddedRowSize = rowSize + padding
  const pixelDataSize = paddedRowSize * height
  const fileSize = 54 + pixelDataSize

  const buf = Buffer.alloc(fileSize)
  // BITMAPFILEHEADER
  buf.write('BM', 0, 'ascii')
  buf.writeUInt32LE(fileSize, 2)
  buf.writeUInt32LE(0, 6)              // reserved
  buf.writeUInt32LE(54, 10)            // pixel data offset
  // BITMAPINFOHEADER
  buf.writeUInt32LE(40, 14)            // header size
  buf.writeInt32LE(width, 18)
  buf.writeInt32LE(height, 22)         // positive = bottom-up
  buf.writeUInt16LE(1, 26)             // planes
  buf.writeUInt16LE(24, 28)            // bit count
  buf.writeUInt32LE(0, 30)             // BI_RGB (no compression)
  buf.writeUInt32LE(pixelDataSize, 34)
  buf.writeUInt32LE(2835, 38)          // 72 DPI in pixels-per-metre
  buf.writeUInt32LE(2835, 42)
  buf.writeUInt32LE(0, 46)
  buf.writeUInt32LE(0, 50)

  for (let srcY = 0; srcY < height; srcY++) {
    const dstY = height - 1 - srcY
    const dstRowStart = 54 + dstY * paddedRowSize
    for (let x = 0; x < width; x++) {
      const srcIdx = (srcY * width + x) * 3
      const dstIdx = dstRowStart + x * 3
      buf[dstIdx]     = rgb[srcIdx + 2] // B
      buf[dstIdx + 1] = rgb[srcIdx + 1] // G
      buf[dstIdx + 2] = rgb[srcIdx]     // R
    }
    // padding bytes already zero (Buffer.alloc)
  }
  return buf
}

async function renderBmp(svgFn, width, height, outPath) {
  const svg = svgFn(width, height)
  const { data } = await svgToRgb(svg)
  const bmp = rgbToBmp24(data, width, height)
  await writeFile(outPath, bmp)
  console.log(`  ${outPath}  (${width}×${height}, ${bmp.length} B)`)
}

async function main() {
  await mkdir(buildDir, { recursive: true })
  console.log('Rendering NSIS installer BMPs...')
  await renderBmp(headerSvg,  150, 57,  join(buildDir, 'installerHeader.bmp'))
  await renderBmp(sidebarSvg, 164, 314, join(buildDir, 'installerSidebar.bmp'))
  await renderBmp(sidebarSvg, 164, 314, join(buildDir, 'uninstallerSidebar.bmp'))
  console.log('Done.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
