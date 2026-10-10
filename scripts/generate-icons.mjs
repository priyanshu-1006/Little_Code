import { writeFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = path.join(root, 'resources', 'app');
const check = process.argv.includes('--check');
const vectorsOnly = process.argv.includes('--vectors');
const files = new Map();
const sourceName = 'Little_code_logo.png';
const source = await readFile(path.join(root, sourceName));
const sourceHash = createHash('sha256').update(source).digest('hex');

// Decode only the user's PNG; conversion never removes its background or redraws it.
function decodePng(bytes) {
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('The supplied Little_code_logo.png is not a PNG.');
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const channels = bytes[25] === 6 ? 4 : bytes[25] === 2 ? 3 : 0;
  if (bytes[24] !== 8 || !channels || bytes[28] !== 0) throw new Error('The logo converter requires a non-interlaced 8-bit RGB/RGBA PNG.');
  const chunks = [];
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    if (offset + length + 12 > bytes.length) throw new Error('The supplied PNG is truncated.');
    if (bytes.toString('ascii', offset + 4, offset + 8) === 'IDAT') chunks.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * channels;
  if (raw.length !== (stride + 1) * height) throw new Error('The supplied PNG has an invalid image data length.');
  const pixels = Buffer.alloc(width * height * 4);
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const rowOffset = y * (stride + 1);
    const filter = raw[rowOffset];
    const row = Buffer.alloc(stride);
    if (filter > 4) throw new Error('The supplied PNG uses an invalid row filter.');
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? row[x - channels] : 0;
      const b = previous[x];
      const c = x >= channels ? previous[x - channels] : 0;
      let prediction = 0;
      if (filter === 1) prediction = a;
      else if (filter === 2) prediction = b;
      else if (filter === 3) prediction = Math.floor((a + b) / 2);
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        prediction = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      row[x] = (raw[rowOffset + 1 + x] + prediction) & 255;
    }
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      for (let channel = 0; channel < 3; channel++) pixels[offset + channel] = row[x * channels + channel];
      pixels[offset + 3] = channels === 4 ? row[x * channels + 3] : 255;
    }
    previous = row;
  }
  return { width, height, pixels };
}
const logo = decodePng(source);

// Area filtering averages premultiplied-alpha source pixels, preserving fine edges.
// Contain the entire supplied canvas in a square without cropping or recoloring.
function render(size) {
  const width = Math.max(1, Math.round(logo.width * size / Math.max(logo.width, logo.height)));
  const height = Math.max(1, Math.round(logo.height * size / Math.max(logo.width, logo.height)));
  const left = Math.floor((size - width) / 2);
  const top = Math.floor((size - height) / 2);
  const bytes = Buffer.alloc(size * size * 4);
  const ratioX = logo.width / width, ratioY = logo.height / height;
  for (let y = 0; y < height; y++) {
    const y0 = y * ratioY, y1 = (y + 1) * ratioY;
    for (let x = 0; x < width; x++) {
      const x0 = x * ratioX, x1 = (x + 1) * ratioX;
      const sums = [0, 0, 0, 0];
      for (let sy = Math.floor(y0); sy < Math.ceil(y1) && sy < logo.height; sy++) {
        const wy = Math.min(y1, sy + 1) - Math.max(y0, sy);
        for (let sx = Math.floor(x0); sx < Math.ceil(x1) && sx < logo.width; sx++) {
          const weight = wy * (Math.min(x1, sx + 1) - Math.max(x0, sx));
          const offset = (sy * logo.width + sx) * 4;
          const alpha = logo.pixels[offset + 3] * weight;
          for (let i = 0; i < 3; i++) sums[i] += logo.pixels[offset + i] * alpha;
          sums[3] += alpha;
        }
      }
      const offset = ((y + top) * size + x + left) * 4;
      for (let i = 0; i < 3; i++) bytes[offset + i] = sums[3] ? Math.round(sums[i] / sums[3]) : 0;
      bytes[offset + 3] = Math.round(sums[3] / (ratioX * ratioY));
    }
  }
  return bytes;
}

function onBackground(width, height, size, left, top, background) {
  const bytes = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    for (let channel = 0; channel < 3; channel++) bytes[i * 4 + channel] = background[channel];
    bytes[i * 4 + 3] = 255;
  }
  const resized = render(size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const targetX = x + left, targetY = y + top;
      if (targetX < 0 || targetY < 0 || targetX >= width || targetY >= height) continue;
      const sourceOffset = (y * size + x) * 4;
      const targetOffset = (targetY * width + targetX) * 4;
      const alpha = resized[sourceOffset + 3] / 255;
      for (let i = 0; i < 3; i++) bytes[targetOffset + i] = Math.round(resized[sourceOffset + i] * alpha + background[i] * (1 - alpha));
    }
  }
  return bytes;
}

function logoSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${logo.width} ${logo.height}" role="img" aria-labelledby="title"><title id="title">Little Code — supplied logo</title><image width="${logo.width}" height="${logo.height}" href="data:image/png;base64,${source.toString('base64')}"/></svg>\n`;
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, bytes) {
  const name = Buffer.from(type);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(bytes.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([name, bytes])));
  return Buffer.concat([size, name, bytes, crc]);
}
function png(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const scanlines = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) rgba.copy(scanlines, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(scanlines, { level: 9 })), pngChunk('IEND', Buffer.alloc(0))]);
}

function ico(images) {
  const header = Buffer.alloc(6 + images.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, bytes }, i) => {
    const entry = 6 + i * 16;
    header[entry] = size === 256 ? 0 : size;
    header[entry + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, entry + 4);
    header.writeUInt16LE(32, entry + 6);
    header.writeUInt32LE(bytes.length, entry + 8);
    header.writeUInt32LE(offset, entry + 12);
    offset += bytes.length;
  });
  return Buffer.concat([header, ...images.map(image => image.bytes)]);
}

function icns(images) {
  const types = { 16: 'icp4', 32: 'icp5', 64: 'icp6', 128: 'ic07', 256: 'ic08', 512: 'ic09', 1024: 'ic10' };
  const chunks = images.map(({ size, bytes }) => {
    const header = Buffer.alloc(8);
    header.write(types[size]);
    header.writeUInt32BE(bytes.length + 8, 4);
    return Buffer.concat([header, bytes]);
  });
  const header = Buffer.alloc(8);
  header.write('icns');
  header.writeUInt32BE(8 + chunks.reduce((sum, chunk) => sum + chunk.length, 0), 4);
  return Buffer.concat([header, ...chunks]);
}

function bmp(width, height, rgba) {
  const stride = Math.ceil(width * 3 / 4) * 4;
  const bytes = Buffer.alloc(54 + height * stride);
  bytes.write('BM', 0);
  bytes.writeUInt32LE(bytes.length, 2);
  bytes.writeUInt32LE(54, 10);
  bytes.writeUInt32LE(40, 14);
  bytes.writeInt32LE(width, 18);
  bytes.writeInt32LE(height, 22);
  bytes.writeUInt16LE(1, 26);
  bytes.writeUInt16LE(24, 28);
  bytes.writeUInt32LE(height * stride, 34);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const source = (y * width + x) * 4;
      const target = 54 + (height - y - 1) * stride + x * 3;
      bytes[target] = rgba[source + 2];
      bytes[target + 1] = rgba[source + 1];
      bytes[target + 2] = rgba[source];
    }
  }
  return bytes;
}

files.set('little-logo.png', source);
files.set('little-code.svg', Buffer.from(logoSvg()));
files.set('little-mark.svg', Buffer.from(logoSvg()));
if (!vectorsOnly) {
const sizes = [16, 24, 32, 48, 64, 70, 128, 150, 192, 256, 512, 1024];
const iconImages = [];
const macImages = [];
for (const size of sizes) {
  const bytes = png(size, size, render(size));
  files.set(`little-code-${size}.png`, bytes);
  if ([16, 24, 32, 48, 64, 128, 256].includes(size)) iconImages.push({ size, bytes });
  if ([16, 32, 64, 128, 256, 512, 1024].includes(size)) macImages.push({ size, bytes });
}
files.set('code.ico', ico(iconImages));
files.set('code.icns', icns(macImages));
const bg = [9, 11, 16];
for (const scale of [100, 125, 150, 175, 200, 225, 250]) {
  const ratio = scale / 100;
  const bigWidth = Math.round(164 * ratio);
  const bigHeight = Math.round(314 * ratio);
  const logoSize = Math.round(132 * ratio);
  const left = Math.floor((bigWidth - logoSize) / 2);
  const top = Math.round(72 * ratio);
  const big = onBackground(bigWidth, bigHeight, logoSize, left, top, bg);
  files.set(`inno-big-${scale}.bmp`, bmp(bigWidth, bigHeight, big));
  const smallSize = Math.round(55 * ratio);
  const small = onBackground(smallSize, smallSize, smallSize, 0, 0, [245, 247, 251]);
  files.set(`inno-small-${scale}.bmp`, bmp(smallSize, smallSize, small));
}

files.set('logo-provenance.json', Buffer.from(`${JSON.stringify({
  source: sourceName,
  sourceSha256: sourceHash,
  sourceBytes: source.length,
  sourceWidth: logo.width,
  sourceHeight: logo.height,
  sourceHasAlpha: source[25] === 6,
  userSupplied: true,
  canonicalPng: 'resources/app/little-logo.png',
  transformations: 'Format conversion and proportional area resampling only. Complete source canvas preserved; no crop, recoloring, added tile, or replacement artwork.',
}, null, 2)}\n`));
}

if (!check) await mkdir(destination, { recursive: true });
for (const [name, bytes] of files) {
  const file = path.join(destination, name);
  if (check) {
    const current = await readFile(file);
    if (!current.equals(bytes)) throw new Error(`Brand asset differs from its source: ${name}`);
  } else {
    await writeFile(file, bytes);
  }
}
console.log(`${check ? 'Verified' : 'Generated'} ${files.size} Little Code brand assets from supplied ${sourceName} (${logo.width}×${logo.height}, SHA-256 ${sourceHash}).`);
