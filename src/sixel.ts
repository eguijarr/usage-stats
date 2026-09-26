import { inflateSync } from 'node:zlib';

export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8Array;
}

/**
 * Decodes the 8-bit RGBA, non-interlaced PNGs in assets/icons, which is
 * all scripts/build-icons.ts writes. Other PNG flavors throw.
 */
export function decodePng(png: Uint8Array): RgbaImage {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const chunks: Uint8Array[] = [];
  let width = 0;
  let height = 0;
  let pos = 8;

  while (pos < png.length) {
    const length = view.getUint32(pos);
    const type = String.fromCharCode(...png.subarray(pos + 4, pos + 8));
    const body = png.subarray(pos + 8, pos + 8 + length);

    if (type === 'IHDR') {
      width = view.getUint32(pos + 8);
      height = view.getUint32(pos + 12);

      if (body[8] !== 8 || body[9] !== 6 || body[12] !== 0) {
        throw new Error('only 8-bit RGBA non-interlaced PNGs are supported');
      }
    } else if (type === 'IDAT') {
      chunks.push(body);
    }

    pos += 12 + length;
  }

  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * 4;
  const data = new Uint8Array(stride * height);

  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const out = data.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? data.subarray((y - 1) * stride, y * stride) : null;

    for (let i = 0; i < stride; i++) {
      const a = i >= 4 ? out[i - 4]! : 0;
      const b = prev ? prev[i]! : 0;
      const c = prev && i >= 4 ? prev[i - 4]! : 0;
      let predictor = 0;

      if (filter === 1) {
        predictor = a;
      } else if (filter === 2) {
        predictor = b;
      } else if (filter === 3) {
        predictor = (a + b) >> 1;
      } else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }

      out[i] = (line[i]! + predictor) & 255;
    }
  }

  return { width, height, data };
}

/**
 * Encodes a one-color logo as sixel at exactly width x height pixels with
 * a transparent background, so the cells around the logo keep the TUI's
 * own colors. The logo is scaled to fit the height and centered in the
 * width; a pixel is painted when at least 40% of its source area is opaque.
 */
export function encodeSixel(image: RgbaImage, width: number, height: number, color: string, bg?: string): string {
  const side = Math.min(width, height);
  const left = Math.floor((width - side) / 2);
  const top = Math.floor((height - side) / 2);
  const scale = image.width / side;
  const on: boolean[][] = [];

  for (let y = 0; y < height; y++) {
    const row: boolean[] = [];

    for (let x = 0; x < width; x++) {
      const sx = x - left;
      const sy = y - top;

      if (sx < 0 || sy < 0 || sx >= side || sy >= side) {
        row.push(false);
        continue;
      }

      let alpha = 0;
      let count = 0;

      for (let yy = Math.floor(sy * scale); yy < Math.max(Math.floor(sy * scale) + 1, Math.floor((sy + 1) * scale)); yy++) {
        for (let xx = Math.floor(sx * scale); xx < Math.max(Math.floor(sx * scale) + 1, Math.floor((sx + 1) * scale)); xx++) {
          alpha += image.data[(yy * image.width + xx) * 4 + 3] ?? 0;
          count++;
        }
      }

      row.push(alpha / count >= 0.4 * 255);
    }

    on.push(row);
  }

  const [r, g, b] = [1, 3, 5].map((i) => Math.round((Number.parseInt(color.slice(i, i + 2), 16) * 100) / 255));

  if (bg && bg.startsWith('#') && bg.length === 7) {
    const [br, bgVal, bb] = [1, 3, 5].map((i) => Math.round((Number.parseInt(bg.slice(i, i + 2), 16) * 100) / 255));
    let out = `\x1bP0;1;0q"1;1;${width};${height}#0;2;${br};${bgVal};${bb}#1;2;${r};${g};${b}`;

    for (let band = 0; band < height; band += 6) {
      out += '#0';
      for (let x = 0; x < width; x++) {
        let bits = 0;
        for (let k = 0; k < 6; k++) {
          if (band + k < height && !on[band + k]?.[x]) {
            bits |= 1 << k;
          }
        }
        out += String.fromCharCode(63 + bits);
      }
      out += '$#1';
      for (let x = 0; x < width; x++) {
        let bits = 0;
        for (let k = 0; k < 6; k++) {
          if (on[band + k]?.[x]) {
            bits |= 1 << k;
          }
        }
        out += String.fromCharCode(63 + bits);
      }
      out += '-';
    }
    return `${out}\x1b\\`;
  }

  // P2=1 keeps unpainted pixels transparent, raster attributes fix the size
  let out = `\x1bP0;1;0q"1;1;${width};${height}#1;2;${r};${g};${b}#1`;

  for (let band = 0; band < height; band += 6) {
    for (let x = 0; x < width; x++) {
      let bits = 0;

      for (let k = 0; k < 6; k++) {
        if (on[band + k]?.[x]) {
          bits |= 1 << k;
        }
      }

      out += String.fromCharCode(63 + bits);
    }

    out += '-';
  }

  return `${out}\x1b\\`;
}
