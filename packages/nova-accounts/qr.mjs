/**
 * A QR code encoder, small enough to read in one sitting, with no dependencies.
 *
 * WHY THIS EXISTS INSTEAD OF A LIBRARY OR A QR WEB SERVICE. The thing being encoded is a
 * two-factor secret. Sending it to a third-party "make me a QR" endpoint would hand that secret
 * to somebody who has no business holding it, and pulling a package into a zero-dependency
 * account module for one function is a poor trade. So the code is drawn here, on the server,
 * as an inline SVG, and the secret never leaves the page it was rendered into.
 *
 * SCOPE. Byte mode, error-correction level M, versions 1-10 - up to 213 bytes, which is far more
 * than an `otpauth://` URI needs (about 110). Anything longer throws rather than producing a
 * code that will not scan. This is the standard ISO/IEC 18004 construction: Reed-Solomon over
 * GF(256), function patterns, zig-zag placement, and the best of the eight masks by penalty.
 */

/* ── Capacity tables, error-correction level M ───────────────────────────────────────────────
   Per version: [error-correction codewords per block, [blockCount, dataCodewordsPerBlock]...]. */
const BLOCKS_M = {
  1: [10, [1, 16]],
  2: [16, [1, 28]],
  3: [26, [1, 44]],
  4: [18, [2, 32]],
  5: [24, [2, 43]],
  6: [16, [4, 27]],
  7: [18, [4, 31]],
  8: [22, [2, 38], [2, 39]],
  9: [22, [3, 36], [2, 37]],
  10: [26, [4, 43], [1, 44]],
};

const ALIGNMENT = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
};

/** Codewords of data a version can hold (before the mode and length header). */
const dataCodewords = (version) =>
  BLOCKS_M[version].slice(1).reduce((sum, [count, size]) => sum + count * size, 0);

/* ── Reed-Solomon over GF(256), primitive polynomial 0x11D ─────────────────────────────────── */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) EXP[i] = EXP[i - 255];
}

const gfMul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

/** The generator polynomial of the given degree, high-order coefficient first (leading 1 omitted). */
function generator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], EXP[i]);
    }
    poly = next;
  }
  return poly.slice(1);
}

/** The error-correction codewords for one block of data. */
function remainder(data, degree) {
  const gen = generator(degree);
  const result = new Array(degree).fill(0);
  for (const byte of data) {
    const factor = byte ^ result.shift();
    result.push(0);
    for (let i = 0; i < degree; i += 1) result[i] ^= gfMul(gen[i], factor);
  }
  return result;
}

/* ── The message: header, data, padding, then interleaved blocks ───────────────────────────── */

function buildCodewords(bytes, version) {
  const capacityBits = dataCodewords(version) * 8;
  const bits = [];
  const push = (value, length) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };

  push(0b0100, 4); // byte mode
  push(bytes.length, version <= 9 ? 8 : 16);
  for (const byte of bytes) push(byte, 8);
  push(0, Math.min(4, capacityBits - bits.length)); // terminator
  while (bits.length % 8) bits.push(0);
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) push(pad, 8);

  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    data.push(parseInt(bits.slice(i, i + 8).join(''), 2));
  }

  const [ecLength, ...groups] = BLOCKS_M[version];
  const blocks = [];
  let at = 0;
  for (const [count, size] of groups) {
    for (let i = 0; i < count; i += 1) {
      const block = data.slice(at, at + size);
      at += size;
      blocks.push({ data: block, ec: remainder(block, ecLength) });
    }
  }

  const out = [];
  const longest = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < longest; i += 1) for (const b of blocks) if (i < b.data.length) out.push(b.data[i]);
  for (let i = 0; i < ecLength; i += 1) for (const b of blocks) out.push(b.ec[i]);
  return out;
}

/* ── The matrix ─────────────────────────────────────────────────────────────────────────────── */

/** BCH-encode `value` (already shifted into position) against `poly`, returning the remainder. */
function bch(value, poly, bitsOfData) {
  let rem = value << (poly.toString(2).length - 1);
  const top = poly.toString(2).length - 1;
  for (let i = bitsOfData + top - 1; i >= top; i -= 1) if ((rem >>> i) & 1) rem ^= poly << (i - top);
  return rem;
}

const MASKS = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (r, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function makeMatrix(version, codewords, mask) {
  const size = 17 + version * 4;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (r, c, dark) => {
    if (r < 0 || c < 0 || r >= size || c >= size) return;
    modules[r][c] = dark;
    reserved[r][c] = true;
  };

  // Finder patterns with their separators.
  for (const [r0, c0] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
    for (let dr = -1; dr <= 7; dr += 1) {
      for (let dc = -1; dc <= 7; dc += 1) {
        const inside = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        const dark =
          inside && (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
        set(r0 + dr, c0 + dc, dark);
      }
    }
  }

  // Timing patterns.
  for (let i = 8; i < size - 8; i += 1) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }

  // Alignment patterns, skipping the three that would overlap a finder.
  const centers = ALIGNMENT[version];
  for (const r of centers) {
    for (const c of centers) {
      const onFinder = (r === 6 && c === 6) || (r === 6 && c === centers.at(-1)) || (r === centers.at(-1) && c === 6);
      if (onFinder) continue;
      for (let dr = -2; dr <= 2; dr += 1) {
        for (let dc = -2; dc <= 2; dc += 1) {
          set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
        }
      }
    }
  }

  // Reserve the format and version areas now; they are written after the mask is chosen.
  for (let i = 0; i < 9; i += 1) {
    reserved[8][i] = true;
    reserved[i][8] = true;
  }
  for (let i = 0; i < 8; i += 1) {
    reserved[8][size - 1 - i] = true;
    reserved[size - 1 - i][8] = true;
  }
  set(size - 8, 8, true); // the always-dark module
  if (version >= 7) {
    for (let i = 0; i < 6; i += 1) {
      for (let j = 0; j < 3; j += 1) {
        reserved[i][size - 11 + j] = true;
        reserved[size - 11 + j][i] = true;
      }
    }
  }

  // Data, in the two-column zig-zag, bottom-right first, skipping the vertical timing column.
  const bits = [];
  for (const word of codewords) for (let i = 7; i >= 0; i -= 1) bits.push((word >>> i) & 1);
  let index = 0;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step += 1) {
      const r = upward ? size - 1 - step : step;
      for (const c of [right, right - 1]) {
        if (reserved[r][c]) continue;
        const bit = index < bits.length ? bits[index] === 1 : false; // remainder bits are zero
        index += 1;
        modules[r][c] = bit !== MASKS[mask](r, c);
      }
    }
    upward = !upward;
  }

  // Format information: level M is 00, then the mask, BCH(15,5), XOR 0x5412.
  const formatData = (0b00 << 3) | mask;
  const format = ((formatData << 10) | bch(formatData, 0x537, 5)) ^ 0x5412;
  const fbit = (i) => ((format >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i += 1) modules[i][8] = fbit(i);
  modules[7][8] = fbit(6);
  modules[8][8] = fbit(7);
  modules[8][7] = fbit(8);
  for (let i = 9; i < 15; i += 1) modules[8][14 - i] = fbit(i);
  for (let i = 0; i < 8; i += 1) modules[8][size - 1 - i] = fbit(i);
  for (let i = 8; i < 15; i += 1) modules[size - 15 + i][8] = fbit(i);
  modules[size - 8][8] = true;

  // Version information (versions 7 and up): BCH(18,6).
  if (version >= 7) {
    const info = (version << 12) | bch(version, 0x1f25, 6);
    for (let i = 0; i < 18; i += 1) {
      const dark = ((info >>> i) & 1) === 1;
      const a = Math.floor(i / 3);
      const b = (i % 3) + size - 11;
      modules[a][b] = dark;
      modules[b][a] = dark;
    }
  }

  return modules;
}

/** The standard four-rule penalty, used only to pick the most scannable of the eight masks. */
function penalty(m) {
  const n = m.length;
  let score = 0;

  const runs = (get) => {
    for (let a = 0; a < n; a += 1) {
      let run = 1;
      for (let b = 1; b < n; b += 1) {
        if (get(a, b) === get(a, b - 1)) run += 1;
        else {
          if (run >= 5) score += run - 2;
          run = 1;
        }
      }
      if (run >= 5) score += run - 2;
    }
  };
  runs((r, c) => m[r][c]);
  runs((r, c) => m[c][r]);

  for (let r = 0; r < n - 1; r += 1) {
    for (let c = 0; c < n - 1; c += 1) {
      if (m[r][c] === m[r][c + 1] && m[r][c] === m[r + 1][c] && m[r][c] === m[r + 1][c + 1]) score += 3;
    }
  }

  const finderLike = (line) => {
    const s = line.map((d) => (d ? 1 : 0)).join('');
    let found = 0;
    for (const p of ['10111010000', '00001011101']) {
      for (let i = s.indexOf(p); i !== -1; i = s.indexOf(p, i + 1)) found += 1;
    }
    return found;
  };
  for (let i = 0; i < n; i += 1) {
    score += 40 * finderLike(m[i]);
    score += 40 * finderLike(m.map((row) => row[i]));
  }

  const dark = m.flat().filter(Boolean).length;
  score += 10 * Math.floor(Math.abs((dark * 100) / (n * n) - 50) / 5);
  return score;
}

/**
 * Encode `text` and return the matrix as an array of rows of booleans (true = dark).
 * Throws if the text does not fit in version 10.
 */
export function encodeQr(text) {
  const bytes = [...new TextEncoder().encode(String(text))];
  let version = 0;
  for (let v = 1; v <= 10; v += 1) {
    const header = 4 + (v <= 9 ? 8 : 16);
    if (header + bytes.length * 8 <= dataCodewords(v) * 8) {
      version = v;
      break;
    }
  }
  if (!version) throw new Error('That is too long for the QR encoder (213 bytes at most).');

  const codewords = buildCodewords(bytes, version);
  let best = null;
  for (let mask = 0; mask < 8; mask += 1) {
    const candidate = makeMatrix(version, codewords, mask);
    const score = penalty(candidate);
    if (!best || score < best.score) best = { score, matrix: candidate };
  }
  return best.matrix;
}

/**
 * The code as an inline SVG: dark modules on a light plate with the four-module quiet zone a
 * scanner needs. The colours are fixed, not themed - a QR code is only read correctly as dark on
 * light, whatever the page around it is doing.
 */
export function qrSvg(text, { label = 'QR code', scale = 6 } = {}) {
  const matrix = encodeQr(text);
  const quiet = 4;
  const size = matrix.length + quiet * 2;
  const cells = [];
  matrix.forEach((row, r) => {
    let c = 0;
    while (c < row.length) {
      if (!row[c]) {
        c += 1;
        continue;
      }
      const start = c;
      while (c < row.length && row[c]) c += 1;
      cells.push(`M${start + quiet} ${r + quiet}h${c - start}v1h-${c - start}z`);
    }
  });
  const safe = String(label).replace(/[&<>"]/g, '');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size * scale}" height="${size * scale}" role="img" aria-label="${safe}" shape-rendering="crispEdges"><rect width="${size}" height="${size}" fill="#fff"/><path d="${cells.join('')}" fill="#000"/></svg>`;
}
