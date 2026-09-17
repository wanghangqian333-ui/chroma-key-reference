import { test } from 'node:test';
import assert from 'node:assert/strict';

import { crc32, zipStore, zipBlob } from './zip-store.mjs';

const enc = new TextEncoder();
const FIXED = new Date(2026, 0, 2, 3, 4, 5);

/* ------------------------------------------------------------------ crc32 */

test('crc32 matches the published IEEE 802.3 test vectors', () => {
  // Vectors cross-checked against zlib.crc32 and the CRC-32 catalogue
  // (reveng catalogue entry CRC-32/ISO-HDLC).
  assert.equal(crc32(enc.encode('')), 0x00000000);
  assert.equal(crc32(enc.encode('a')), 0xE8B7BE43);
  assert.equal(crc32(enc.encode('123456789')), 0xCBF43926);
  assert.equal(crc32(enc.encode('The quick brown fox jumps over the lazy dog')), 0x414FA339);
  assert.equal(crc32(enc.encode('green screen')), 0xC439E883);
});

test('crc32 returns an unsigned 32-bit integer', () => {
  const v = crc32(new Uint8Array([0, 1, 2, 3, 250, 251, 252, 253, 254, 255]));
  assert.ok(Number.isInteger(v));
  assert.ok(v >= 0 && v <= 0xFFFFFFFF);
});

test('crc32 is order sensitive', () => {
  assert.notEqual(crc32(enc.encode('ab')), crc32(enc.encode('ba')));
});

/* --------------------------------------------------------------- zipStore */

test('an empty entry list still produces a valid empty archive', () => {
  const zip = zipStore([], { date: FIXED });
  assert.equal(zip.length, 22);                       // just the EOCD record
  assert.equal(new DataView(zip.buffer).getUint32(0, true), 0x06054b50);
  assert.equal(new DataView(zip.buffer).getUint16(8, true), 0);
  assert.equal(new DataView(zip.buffer).getUint16(10, true), 0);
});

test('the archive is byte-identical for a fixed timestamp', () => {
  const entries = [
    { name: 'a.txt', data: enc.encode('alpha') },
    { name: 'b.txt', data: enc.encode('beta') },
  ];
  const one = zipStore(entries, { date: FIXED });
  const two = zipStore(entries, { date: FIXED });
  assert.deepEqual(one, two);
});

test('names, sizes and CRCs survive a round trip through the central directory', () => {
  const files = [
    { name: 'frame-0001.png', data: new Uint8Array([137, 80, 78, 71, 0, 0, 0, 0]) },
    { name: 'frame-0002.png', data: new Uint8Array(300).fill(7) },
    { name: 'notes/readme.txt', data: enc.encode('nested path, stored not deflated') },
  ];
  const zip = zipStore(files, { date: FIXED });
  const found = readZip(zip);

  assert.equal(found.length, files.length);
  for (let i = 0; i < files.length; i++) {
    assert.equal(found[i].name, files[i].name);
    assert.equal(found[i].method, 0);                 // stored
    assert.equal(found[i].data.length, files[i].data.length);
    assert.deepEqual(found[i].data, files[i].data);
    assert.equal(found[i].crc, crc32(files[i].data));
    assert.equal(found[i].crcOk, true);
  }
});

test('the two signatures and the end-of-central-directory offsets line up', () => {
  const zip = zipStore([
    { name: 'x.bin', data: new Uint8Array([1, 2, 3]) },
    { name: 'y.bin', data: new Uint8Array([4, 5]) },
  ], { date: FIXED });
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);

  assert.equal(dv.getUint32(0, true), 0x04034b50);    // first local header

  const eocdAt = zip.length - 22;
  assert.equal(dv.getUint32(eocdAt, true), 0x06054b50);
  assert.equal(dv.getUint16(eocdAt + 8, true), 2);    // entries on this disk
  assert.equal(dv.getUint16(eocdAt + 10, true), 2);   // entries total

  const cdSize = dv.getUint32(eocdAt + 12, true);
  const cdOffset = dv.getUint32(eocdAt + 16, true);
  assert.equal(dv.getUint32(cdOffset, true), 0x02014b50);
  assert.equal(cdOffset + cdSize, eocdAt);
});

test('a name with non-ASCII characters is written as UTF-8 and flagged as such', () => {
  const zip = zipStore([{ name: '帧-01.png', data: new Uint8Array([1]) }], { date: FIXED });
  const dv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  assert.equal(dv.getUint16(6, true) & 0x0800, 0x0800);   // UTF-8 flag set
  const [entry] = readZip(zip);
  assert.equal(entry.name, '帧-01.png');
});

test('bad input is rejected instead of producing a broken archive', () => {
  assert.throws(() => zipStore('not an array'), TypeError);
  assert.throws(() => zipStore([{ data: new Uint8Array([1]) }]), TypeError);
  assert.throws(() => zipStore([{ name: '', data: new Uint8Array([1]) }]), TypeError);
  assert.throws(() => zipStore([{ name: 'a', data: 'string' }]), TypeError);
});

test('zipBlob wraps the same bytes as a downloadable Blob', async () => {
  const entries = [{ name: 'a.txt', data: enc.encode('alpha') }];
  const blob = zipBlob(entries, { date: FIXED });
  assert.equal(blob.type, 'application/zip');
  const fromBlob = new Uint8Array(await blob.arrayBuffer());
  assert.deepEqual(fromBlob, zipStore(entries, { date: FIXED }));
});

test('ArrayBuffer and other views are accepted as entry data', () => {
  const buf = new Uint8Array([9, 8, 7]).buffer;
  const view = new DataView(buf);
  const zip = zipStore([
    { name: 'buffer.bin', data: buf },
    { name: 'view.bin', data: view },
  ], { date: FIXED });
  const found = readZip(zip);
  assert.deepEqual(found[0].data, new Uint8Array([9, 8, 7]));
  assert.deepEqual(found[1].data, new Uint8Array([9, 8, 7]));
});

/* ------------------------------------------------------------------ helper */

/**
 * A deliberately small, independent ZIP reader used only by these tests. It
 * walks the central directory rather than trusting the writer's bookkeeping,
 * and recomputes every CRC.
 */
function readZip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdAt = bytes.length - 22;
  if (dv.getUint32(eocdAt, true) !== 0x06054b50) throw new Error('no EOCD');
  const count = dv.getUint16(eocdAt + 10, true);
  let p = dv.getUint32(eocdAt + 16, true);
  const dec = new TextDecoder();
  const out = [];

  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('bad central header at ' + p);
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localAt = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));

    if (dv.getUint32(localAt, true) !== 0x04034b50) throw new Error('bad local header');
    const lNameLen = dv.getUint16(localAt + 26, true);
    const lExtraLen = dv.getUint16(localAt + 28, true);
    const dataAt = localAt + 30 + lNameLen + lExtraLen;
    const data = bytes.slice(dataAt, dataAt + size);

    out.push({ name, method, crc, data, crcOk: crc32(data) === crc });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
