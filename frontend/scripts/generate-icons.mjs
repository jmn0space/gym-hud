/**
 * Deterministic PWA icon generator.
 *
 * The project deliberately carries no image dependency (see the issue-17 contract:
 * no new npm dependencies), so the PNGs in `public/icons/` are encoded here by hand
 * with Node built-ins only: 8-bit RGBA, no interlacing, one `None` filter byte per
 * scanline, zlib-deflated into a single IDAT chunk.
 *
 * Re-running this script on unchanged sources must produce byte-identical files, so
 * the app-shell version the service worker derives from them stays stable across
 * rebuilds. Everything below is pure arithmetic -- no timestamps, no randomness.
 *
 * Usage: npm run icons
 */

import { Buffer } from "node:buffer";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Matches `--color-bg`, `--color-surface` and `--color-accent` in src/styles.css. */
const BACKGROUND = [0x0b, 0x0d, 0x10];
const PLATE = [0x16, 0x1a, 0x20];
const MARK = [0xff, 0xb0, 0x20];

/**
 * Maskable icons are cropped by the launcher to an arbitrary shape, so anything
 * that must stay visible has to sit inside the centre 80% of the canvas. The mark
 * is drawn at 68% of the canvas width, leaving a 16% margin on each edge.
 */
const MASKABLE_SAFE_FRACTION = 0.8;

const OUTPUTS = [
  { file: "icon-192.png", size: 192, plate: true, markScale: 0.62 },
  { file: "icon-512.png", size: 512, plate: true, markScale: 0.62 },
  { file: "icon-maskable-512.png", size: 512, plate: false, markScale: 0.68, maskable: true },
  { file: "apple-touch-icon-180.png", size: 180, plate: true, markScale: 0.62 },
];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed), 0);
  return Buffer.concat([length, typed, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  // One filter byte (0 = None) in front of every scanline.
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const target = y * (stride + 1);
    raw[target] = 0;
    rgba.copy(raw, target + 1, y * stride, (y + 1) * stride);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type 6 = truecolour with alpha
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Signed distance to a rounded rectangle centred on (cx, cy). Negative inside. */
function roundedRectDistance(x, y, shape) {
  const dx = Math.abs(x - shape.cx) - (shape.halfWidth - shape.radius);
  const dy = Math.abs(y - shape.cy) - (shape.halfHeight - shape.radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  const inside = Math.min(Math.max(dx, dy), 0);
  return outside + inside - shape.radius;
}

/**
 * A dumbbell: a grip bar, two inner plates, two outer collars. Coordinates are in
 * "mark space", where the mark spans [-1, 1] on x; the caller scales it onto the
 * canvas. Keeping the outermost collar at |x| = 1 makes `markScale` the exact
 * fraction of the canvas the artwork occupies, which is what the maskable safe
 * zone is measured against.
 */
function dumbbellShapes(scale) {
  const parts = [
    { cx: 0, cy: 0, halfWidth: 0.6, halfHeight: 0.115, radius: 0.115 },
    { cx: -0.72, cy: 0, halfWidth: 0.115, halfHeight: 0.44, radius: 0.1 },
    { cx: 0.72, cy: 0, halfWidth: 0.115, halfHeight: 0.44, radius: 0.1 },
    { cx: -0.915, cy: 0, halfWidth: 0.085, halfHeight: 0.29, radius: 0.075 },
    { cx: 0.915, cy: 0, halfWidth: 0.085, halfHeight: 0.29, radius: 0.075 },
  ];
  return parts.map((part) => ({
    cx: part.cx * scale,
    cy: part.cy * scale,
    halfWidth: part.halfWidth * scale,
    halfHeight: part.halfHeight * scale,
    radius: part.radius * scale,
  }));
}

function coverage(x, y, shapes, featherRadius) {
  let distance = Infinity;
  for (const shape of shapes) {
    distance = Math.min(distance, roundedRectDistance(x, y, shape));
  }
  // Linear feather across one pixel so edges are anti-aliased rather than jagged.
  return Math.min(1, Math.max(0, 0.5 - distance / (2 * featherRadius)));
}

function blend(target, offset, colour, alpha) {
  for (let channel = 0; channel < 3; channel += 1) {
    target[offset + channel] = Math.round(
      target[offset + channel] * (1 - alpha) + colour[channel] * alpha,
    );
  }
}

function renderIcon({ size, plate, markScale }) {
  const rgba = Buffer.alloc(size * size * 4);
  const plateShapes = [{ cx: 0, cy: 0, halfWidth: 0.88, halfHeight: 0.88, radius: 0.3 }];
  const markShapes = dumbbellShapes(markScale);
  // One pixel expressed in the [-1, 1] coordinate space the shapes are defined in.
  const feather = 2 / size;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;
      // Opaque background across the whole canvas: maskable icons are cropped, so
      // the launcher must never see transparent corners.
      rgba[offset] = BACKGROUND[0];
      rgba[offset + 1] = BACKGROUND[1];
      rgba[offset + 2] = BACKGROUND[2];
      rgba[offset + 3] = 0xff;

      // Pixel centre mapped onto [-1, 1] in both axes.
      const px = ((x + 0.5) / size) * 2 - 1;
      const py = ((y + 0.5) / size) * 2 - 1;

      if (plate) {
        blend(rgba, offset, PLATE, coverage(px, py, plateShapes, feather));
      }
      blend(rgba, offset, MARK, coverage(px, py, markShapes, feather));
    }
  }

  return rgba;
}

/** Re-reads a written file and walks its chunks, so a broken encoder fails loudly. */
function verifyPng(bytes) {
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("Output does not start with the PNG signature");
  }

  const chunks = [];
  let width = 0;
  let height = 0;
  let offset = 8;
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("latin1");
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    const declared = bytes.readUInt32BE(offset + 8 + length);
    const actual = crc32(bytes.subarray(offset + 4, offset + 8 + length));
    if (declared !== actual) {
      throw new Error(`Chunk ${type} has a bad CRC`);
    }
    if (type === "IHDR") {
      if (length !== 13) {
        throw new Error("IHDR must be 13 bytes");
      }
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      if (body[8] !== 8 || body[9] !== 6) {
        throw new Error("Expected an 8-bit RGBA image");
      }
    }
    chunks.push(type);
    offset += 12 + length;
  }

  if (offset !== bytes.length) {
    throw new Error("Trailing bytes after the last chunk");
  }
  if (chunks[0] !== "IHDR" || chunks.at(-1) !== "IEND" || !chunks.includes("IDAT")) {
    throw new Error(`Unexpected chunk sequence: ${chunks.join(", ")}`);
  }
  return { width, height, chunks };
}

/** Asserts every non-background pixel of a maskable icon sits inside the safe zone. */
function verifyMaskableSafeZone(rgba, size) {
  const margin = ((1 - MASKABLE_SAFE_FRACTION) / 2) * size;
  const low = margin;
  const high = size - margin;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;
      const isBackground =
        rgba[offset] === BACKGROUND[0] &&
        rgba[offset + 1] === BACKGROUND[1] &&
        rgba[offset + 2] === BACKGROUND[2];
      if (isBackground) {
        continue;
      }
      if (x < low || x + 1 > high || y < low || y + 1 > high) {
        throw new Error(
          `Maskable artwork escapes the centre ${String(MASKABLE_SAFE_FRACTION * 100)}% at (${String(x)}, ${String(y)})`,
        );
      }
    }
  }
  return { safeZone: `${String(Math.round(low))}..${String(Math.round(high))}px of ${String(size)}px` };
}

function main() {
  const outputDirectory = join(dirname(dirname(fileURLToPath(import.meta.url))), "public", "icons");
  mkdirSync(outputDirectory, { recursive: true });

  for (const output of OUTPUTS) {
    const rgba = renderIcon(output);
    if (output.maskable === true) {
      const { safeZone } = verifyMaskableSafeZone(rgba, output.size);
      process.stdout.write(`${output.file}: artwork confined to ${safeZone}\n`);
    }

    const target = join(outputDirectory, output.file);
    writeFileSync(target, encodePng(output.size, output.size, rgba));

    const written = readFileSync(target);
    const { width, height, chunks } = verifyPng(written);
    if (width !== output.size || height !== output.size) {
      throw new Error(`${output.file}: expected ${String(output.size)}px, parsed ${String(width)}x${String(height)}`);
    }
    process.stdout.write(
      `${output.file}: valid PNG ${String(width)}x${String(height)}, ${String(written.length)} bytes, chunks ${chunks.join("/")}\n`,
    );
  }
}

main();
