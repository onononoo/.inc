// Renders resources/brand/icon.svg into the icon files used by the packager.
//
//   node scripts/make-icons.mjs
//
// Output (resources/icons/):
//   png/icon-<size>.png   16, 32, 48, 64, 128, 256, 512, 1024
//   icon.png              512 px copy used for Linux desktop entries and window icons
//   icon.ico              Windows icon, PNG-compressed entries for 16 to 256 px
//   icon.icns             macOS icon, PNG chunks for 16 to 1024 px (including @2x variants)
//
// Rendering uses Electron itself (already a dev dependency), so no extra tooling is needed. This
// file has two roles: run by Node it orchestrates; run by Electron (`--render`) it rasterises.
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

export const PNG_SIZES = [16, 32, 48, 64, 128, 256, 512, 1024];
/** The ICO directory stores width and height in one byte each; 256 is written as 0. */
export const ICO_SIZES = [16, 32, 48, 64, 128, 256];

/**
 * ICNS chunk types that carry PNG data, with the pixel size each expects.
 * Sizes marked "@2x" reuse the PNG of the doubled size.
 */
export const ICNS_TYPES = [
  ['icp4', 16],
  ['icp5', 32],
  ['icp6', 64],
  ['ic07', 128],
  ['ic08', 256],
  ['ic09', 512],
  ['ic10', 1024],
  ['ic11', 32],
  ['ic12', 64],
  ['ic13', 256],
  ['ic14', 512],
];

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Read width, height and colour type from a PNG's IHDR chunk. Throws on anything that is not a PNG. */
export function readPngHeader(data) {
  if (data.length < 33 || !data.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('Not a PNG file');
  }
  if (data.toString('ascii', 12, 16) !== 'IHDR') throw new Error('PNG is missing its IHDR chunk');
  return {
    width: data.readUInt32BE(16),
    height: data.readUInt32BE(20),
    bitDepth: data[24],
    colorType: data[25],
  };
}

function requireSquare(images) {
  return images.map(({ size, data }) => {
    const header = readPngHeader(data);
    if (header.width !== size || header.height !== size) {
      throw new Error(
        `Expected a ${size}x${size} PNG but got ${header.width}x${header.height} pixels`,
      );
    }
    return { size, data };
  });
}

/**
 * Build a Windows .ico container holding PNG-compressed images (supported since Windows Vista).
 * @param {{ size: number, data: Buffer }[]} images square PNGs no larger than 256 px
 */
export function encodeIco(images) {
  const list = requireSquare(images).sort((a, b) => a.size - b.size);
  if (list.length === 0) throw new Error('An icon needs at least one image');
  if (list.some((i) => i.size > 256)) throw new Error('ICO images cannot exceed 256 px');

  const headerSize = 6 + 16 * list.length;
  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(list.length, 4);

  let offset = headerSize;
  list.forEach(({ size, data }, index) => {
    const at = 6 + index * 16;
    const dimension = size === 256 ? 0 : size;
    header.writeUInt8(dimension, at);
    header.writeUInt8(dimension, at + 1);
    header.writeUInt8(0, at + 2); // palette colours: none
    header.writeUInt8(0, at + 3); // reserved
    header.writeUInt16LE(1, at + 4); // colour planes
    header.writeUInt16LE(32, at + 6); // bits per pixel
    header.writeUInt32LE(data.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...list.map((i) => i.data)]);
}

/**
 * Build a macOS .icns container from PNG chunks.
 * @param {{ size: number, data: Buffer }[]} images square PNGs; every size in ICNS_TYPES must be present
 */
export function encodeIcns(images) {
  const bySize = new Map(requireSquare(images).map((i) => [i.size, i.data]));
  const chunks = ICNS_TYPES.map(([type, size]) => {
    const data = bySize.get(size);
    if (!data) throw new Error(`ICNS type ${type} needs a ${size}x${size} image`);
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(8 + data.length, 4);
    return Buffer.concat([head, data]);
  });
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(8 + body.length, 4);
  return Buffer.concat([head, body]);
}

/** Parse an .ico produced by encodeIco (used by tests and by the post-write self check). */
export function decodeIco(data) {
  if (data.readUInt16LE(0) !== 0 || data.readUInt16LE(2) !== 1) throw new Error('Not an ICO file');
  const count = data.readUInt16LE(4);
  const entries = [];
  for (let i = 0; i < count; i++) {
    const at = 6 + i * 16;
    const length = data.readUInt32LE(at + 8);
    const offset = data.readUInt32LE(at + 12);
    entries.push({
      width: data[at] || 256,
      height: data[at + 1] || 256,
      bitsPerPixel: data.readUInt16LE(at + 6),
      image: data.subarray(offset, offset + length),
    });
  }
  return entries;
}

/** Parse an .icns produced by encodeIcns. */
export function decodeIcns(data) {
  if (data.toString('ascii', 0, 4) !== 'icns') throw new Error('Not an ICNS file');
  if (data.readUInt32BE(4) !== data.length) throw new Error('ICNS length field is wrong');
  const chunks = [];
  let at = 8;
  while (at < data.length) {
    const length = data.readUInt32BE(at + 4);
    chunks.push({
      type: data.toString('ascii', at, at + 4),
      image: data.subarray(at + 8, at + length),
    });
    at += length;
  }
  return chunks;
}

/** Runs inside Electron: rasterise the SVG at each size into PNG files with transparency. */
async function renderInElectron(svgPath, outDir) {
  const { app, BrowserWindow } = await import('electron');
  // Sizes must be exact pixels regardless of the display scale factor.
  app.commandLine.appendSwitch('force-device-scale-factor', '1');
  await app.whenReady();

  const svg = await readFile(svgPath, 'utf8');
  const dataUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
  const canvas = Math.max(...PNG_SIZES);
  const win = new BrowserWindow({
    width: canvas,
    height: canvas,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    enableLargerThanScreen: true,
    backgroundColor: '#00000000',
    webPreferences: { sandbox: true, offscreen: false },
  });

  const html = (size) =>
    `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden">` +
    `<img id="i" src="${dataUrl}" width="${size}" height="${size}" style="display:block"></body></html>`;

  for (const size of PNG_SIZES) {
    await win.loadURL(`data:text/html;base64,${Buffer.from(html(size)).toString('base64')}`);
    await win.webContents.executeJavaScript('document.getElementById("i").decode()');
    // One frame so the compositor has painted the decoded image.
    await win.webContents.executeJavaScript(
      'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))',
    );
    const image = await win.webContents.capturePage({ x: 0, y: 0, width: size, height: size });
    const png = image.toPNG();
    const header = readPngHeader(png);
    if (header.width !== size || header.height !== size) {
      throw new Error(`Rendered ${header.width}x${header.height} instead of ${size}x${size}`);
    }
    await writeFile(path.join(outDir, `icon-${size}.png`), png);
  }
  win.destroy();
  app.quit();
}

function runElectron(electronPath, args) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return new Promise((resolve, reject) => {
    execFile(
      electronPath,
      args,
      { env, timeout: 120_000, windowsHide: true },
      (error, stdout, stderr) => {
        if (error)
          reject(new Error(`Electron failed to render the icons: ${error.message}\n${stderr}`));
        else resolve(stdout);
      },
    );
  });
}

async function main() {
  const svgPath = path.join(root, 'resources', 'brand', 'icon.svg');
  const iconsDir = path.join(root, 'resources', 'icons');
  const pngDir = path.join(iconsDir, 'png');
  await mkdir(pngDir, { recursive: true });

  const electronPath = createRequire(import.meta.url)('electron');
  await runElectron(electronPath, [fileURLToPath(import.meta.url), '--render', svgPath, pngDir]);

  const images = [];
  for (const size of PNG_SIZES) {
    images.push({ size, data: await readFile(path.join(pngDir, `icon-${size}.png`)) });
  }
  const pick = (size) => images.find((i) => i.size === size).data;

  await writeFile(path.join(iconsDir, 'icon.png'), pick(512));
  await writeFile(
    path.join(iconsDir, 'icon.ico'),
    encodeIco(images.filter((i) => ICO_SIZES.includes(i.size))),
  );
  await writeFile(path.join(iconsDir, 'icon.icns'), encodeIcns(images));
  console.log(`Wrote icons to ${path.relative(root, iconsDir)}`);
}

const isEntry =
  process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isEntry) {
  const renderAt = process.argv.indexOf('--render');
  const run =
    renderAt !== -1
      ? renderInElectron(process.argv[renderAt + 1], process.argv[renderAt + 2])
      : main();
  run.catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
