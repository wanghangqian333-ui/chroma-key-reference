/**
 * zip-store.mjs — a ZIP writer with no dependencies, for the one job a
 * browser-side exporter actually has: pack a bunch of already-compressed
 * files (PNG frames, typically) into a single archive.
 *
 * Every entry is written with compression method 0 (stored). There is no
 * deflate, no ZIP64, no encryption, no data descriptor. That is deliberate:
 * PNG is already compressed, so deflating it again costs CPU and buys
 * roughly nothing, and staying with the stored method keeps the writer
 * small enough to audit in one sitting.
 *
 * Runs in Node (>=18) and in the browser. No imports, no globals beyond
 * `TextEncoder` and, optionally, `Blob`.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

/**
 * CRC-32 (IEEE 802.3, polynomial 0xEDB88320), as required by the ZIP format.
 *
 * @param {Uint8Array} bytes
 * @returns {number} unsigned 32-bit checksum
 */
export function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(date) {
  const d = date instanceof Date ? date : new Date();
  const year = d.getFullYear();
  if (year < 1980) return { time: 0, date: 0x0021 };   // 1980-01-01, the format's floor
  const time = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF;
  const day = (((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF;
  return { time, date: day };
}

function asBytes(v, what) {
  if (v instanceof Uint8Array) return v;
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  throw new TypeError(`${what} must be a Uint8Array, TypedArray or ArrayBuffer`);
}

/**
 * Build a ZIP archive with every entry stored uncompressed.
 *
 * @param {Array<{name: string, data: Uint8Array|ArrayBuffer|TypedArray}>} entries
 * @param {{date?: Date}} [options] timestamp written into every entry
 *        (pass one fixed date to get byte-identical archives, which is what
 *        the tests do)
 * @returns {Uint8Array} the complete archive
 */
export function zipStore(entries, options = {}) {
  if (!Array.isArray(entries)) throw new TypeError('entries must be an array');
  const { time, date } = dosDateTime(options.date);
  const enc = new TextEncoder();

  const parts = [];
  const central = [];
  let offset = 0;

  for (let e = 0; e < entries.length; e++) {
    const entry = entries[e];
    if (!entry || typeof entry.name !== 'string' || entry.name === '') {
      throw new TypeError(`entries[${e}].name must be a non-empty string`);
    }
    const name = enc.encode(entry.name);
    if (name.length > 0xFFFF) throw new RangeError(`entries[${e}].name is too long`);
    const data = asBytes(entry.data, `entries[${e}].data`);
    if (data.length > 0xFFFFFFFF) throw new RangeError(`entries[${e}].data is too large`);
    const crc = crc32(data);

    // Local file header
    const lh = new Uint8Array(30 + name.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);      // local file header signature
    lv.setUint16(4, 20, true);              // version needed to extract
    lv.setUint16(6, 0x0800, true);          // general purpose flags: UTF-8 names
    lv.setUint16(8, 0, true);               // method 0 = stored
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, data.length, true);    // compressed size
    lv.setUint32(22, data.length, true);    // uncompressed size
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);              // extra field length
    lh.set(name, 30);

    // Central directory record
    const ch = new Uint8Array(46 + name.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);      // central directory signature
    cv.setUint16(4, 20, true);              // version made by
    cv.setUint16(6, 20, true);              // version needed
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(30, 0, true);              // extra field length
    cv.setUint16(32, 0, true);              // comment length
    cv.setUint16(34, 0, true);              // disk number start
    cv.setUint16(36, 0, true);              // internal attributes
    cv.setUint32(38, 0, true);              // external attributes
    cv.setUint32(42, offset, true);         // offset of local header
    ch.set(name, 46);

    parts.push(lh, data);
    central.push(ch);
    offset += lh.length + data.length;
  }

  let cdSize = 0;
  for (let i = 0; i < central.length; i++) cdSize += central[i].length;

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);        // end of central directory signature
  ev.setUint16(4, 0, true);                 // this disk
  ev.setUint16(6, 0, true);                 // disk with central directory
  ev.setUint16(8, entries.length, true);    // entries on this disk
  ev.setUint16(10, entries.length, true);   // entries total
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true);                // comment length

  const total = offset + cdSize + eocd.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const part of parts) { out.set(part, p); p += part.length; }
  for (const part of central) { out.set(part, p); p += part.length; }
  out.set(eocd, p);
  return out;
}

/**
 * Same archive, wrapped in a Blob — the form a browser download wants.
 * `Blob` is a global in Node 18+ as well, so this works in both.
 *
 * @param {Array<{name: string, data: Uint8Array}>} entries
 * @param {{date?: Date}} [options]
 * @returns {Blob}
 */
export function zipBlob(entries, options) {
  return new Blob([zipStore(entries, options)], { type: 'application/zip' });
}
