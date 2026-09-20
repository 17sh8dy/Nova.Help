/**
 * Profile pictures: what is accepted, and how an object is named. Nothing here touches storage.
 *
 * WHY THIS IS STRICT. A profile picture is a file a stranger chose, served back from the same
 * origin that holds the account cookie. Every rule below exists so that the bytes stored are
 * demonstrably an ordinary small image and nothing else:
 *
 *   - THE TYPE COMES FROM THE BYTES. The filename, the extension and the browser's claimed
 *     content type are never consulted. `sniffImage` reads the file's own signature, so a
 *     script renamed `me.png`, an SVG (which can carry script) or an HTML page is refused no
 *     matter what it claims to be. Only PNG, JPEG and WebP are accepted.
 *   - THE STORED TYPE IS ONE OF THREE FIXED STRINGS, written by us from that sniff, so what is
 *     served back can never be a type the uploader picked.
 *   - SIZE IS BOUNDED TWICE: bytes (a small file) and dimensions (a picture nobody could
 *     mistake for a decompression bomb). Dimensions are read from the header, not by decoding.
 *   - THE OBJECT KEY IS OURS. `newAvatarKey` builds it from the account id and fresh randomness;
 *     no part of a request is ever placed in a key, so there is no path to traverse and nothing
 *     for an upload to overwrite. `isAvatarKeyFor` is the check a caller makes before deleting
 *     an object it read back from a row.
 */

export const AVATAR_LIMITS = Object.freeze({
  /** A picture is resized to a few hundred pixels in the browser; this is generous headroom. */
  maxBytes: 256 * 1024,
  minBytes: 32,
  maxDimension: 2048,
});

export const AVATAR_TYPES = Object.freeze({
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
});

const u16be = (b, o) => (b[o] << 8) | b[o + 1];
const u32be = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u16le = (b, o) => b[o] | (b[o + 1] << 8);
const u24le = (b, o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const ascii = (b, o, n) => String.fromCharCode(...b.subarray(o, o + n));

function pngSize(b) {
  // 8-byte signature, then the IHDR chunk: length(4) "IHDR"(4) width(4) height(4).
  if (b.length < 24 || ascii(b, 12, 4) !== 'IHDR') return null;
  return { width: u32be(b, 16), height: u32be(b, 20) };
}

function jpegSize(b) {
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1];
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    // Start-of-frame markers carry the size; C4 (DHT), C8 (JPG) and CC (DAC) share the range.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: u16be(b, i + 5), width: u16be(b, i + 7) };
    }
    if (marker === 0xd9 || marker === 0xda) return null; // end of image / start of scan, no frame
    i += 2 + u16be(b, i + 2);
  }
  return null;
}

function webpSize(b) {
  if (b.length < 30) return null;
  const chunk = ascii(b, 12, 4);
  if (chunk === 'VP8X') return { width: 1 + u24le(b, 24), height: 1 + u24le(b, 27) };
  if (chunk === 'VP8L') {
    if (b[20] !== 0x2f) return null;
    const bits = u32le(b, 21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8 ') {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
  }
  return null;
}

/**
 * What these bytes actually are: `{ type, contentType, width, height }`, or `null` for anything
 * that is not a well-formed PNG, JPEG or WebP header.
 */
export function sniffImage(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
  if (b.length < 16) return null;

  let type = null;
  let size = null;
  if (b[0] === 0x89 && ascii(b, 1, 3) === 'PNG' && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    type = 'png';
    size = pngSize(b);
  } else if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    type = 'jpeg';
    size = jpegSize(b);
  } else if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') {
    type = 'webp';
    size = webpSize(b);
  }
  if (!type || !size || !size.width || !size.height) return null;
  return { type, contentType: AVATAR_TYPES[type], width: size.width, height: size.height };
}

/**
 * Decide whether an upload is acceptable. `{ ok: true, image }` or `{ ok: false, error }`, the
 * error being a sentence a person can act on.
 */
export function validateAvatar(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
  if (b.length < AVATAR_LIMITS.minBytes) return { ok: false, error: 'Choose a picture to upload.' };
  if (b.length > AVATAR_LIMITS.maxBytes) {
    return { ok: false, error: `That picture is too large. Use one under ${AVATAR_LIMITS.maxBytes / 1024} KB.` };
  }
  const image = sniffImage(b);
  if (!image) return { ok: false, error: 'That is not a PNG, JPEG or WebP picture.' };
  if (image.width > AVATAR_LIMITS.maxDimension || image.height > AVATAR_LIMITS.maxDimension) {
    return { ok: false, error: `That picture is too big. Use one no larger than ${AVATAR_LIMITS.maxDimension} pixels on a side.` };
  }
  return { ok: true, image };
}

const hex = (n) =>
  [...globalThis.crypto.getRandomValues(new Uint8Array(n))].map((x) => x.toString(16).padStart(2, '0')).join('');

const KEY = /^avatars\/(NA-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4})\/[0-9a-f]{48}$/;

/** A fresh object key for this account: `avatars/<accountId>/<48 hex>`. Never from a request. */
export const newAvatarKey = (accountId) => `avatars/${accountId}/${hex(24)}`;

/** The prefix every object belonging to one account lives under. */
export const avatarPrefix = (accountId) => `avatars/${accountId}/`;

/** True only for a key this module could have made for exactly this account. */
export const isAvatarKeyFor = (accountId, key) => KEY.exec(String(key ?? ''))?.[1] === accountId;
