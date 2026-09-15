/*
 * Tests for the keyer. Run with:  node --test src/
 *
 * These check the properties the maths is supposed to have, not memorised
 * output values: a flat green backdrop keys out completely, a subject of a
 * different hue survives, a shadow keeps keying, a neutral backdrop switches
 * to luminance, and spill removal only ever pulls the key channel down.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  makeParams, keyPixels, autoKey, hexToRgb, rgbToHex,
  chromaU, chromaV, luma,
} from './keyer.mjs';

const GREEN = [0, 177, 64];
const SKIN = [224, 176, 144];

/** One RGBA pixel through the keyer. */
function key1(rgb, params, alpha = 255) {
  const src = Uint8ClampedArray.from([rgb[0], rgb[1], rgb[2], alpha]);
  const dst = new Uint8ClampedArray(4);
  keyPixels(src, dst, params);
  return [dst[0], dst[1], dst[2], dst[3]];
}

/* ------------------------------------------------------------------------- */

test('hex parsing accepts 3- and 6-digit forms and rejects junk', () => {
  assert.deepEqual(hexToRgb('#00b140'), [0, 177, 64]);
  assert.deepEqual(hexToRgb('00b140'), [0, 177, 64]);
  assert.deepEqual(hexToRgb('#0b4'), [0, 187, 68]);
  assert.deepEqual(hexToRgb('not a colour'), [0, 177, 64], 'falls back to the default');
  assert.equal(rgbToHex(0, 177, 64), '#00b140');
  assert.equal(rgbToHex(-10, 300, 64), '#00ff40', 'clamps out-of-range channels');
});

test('BT.601 coefficients produce the documented values', () => {
  // Green #00b140 in YCbCr, computed from the coefficients in the source:
  //   Y  = 0.299*0   + 0.587*177   + 0.114*64    = 111.195
  //   Cb = -0.168736*0 - 0.331264*177 + 0.5*64   = -26.6337
  //   Cr = 0.5*0     - 0.418688*177 - 0.081312*64 = -79.3117
  const [r, g, b] = GREEN;
  assert.ok(Math.abs(luma(r, g, b) - 111.195) < 0.01, 'luma of #00b140');
  assert.ok(Math.abs(chromaU(r, g, b) - (-26.6337)) < 0.01, 'Cb of #00b140');
  assert.ok(Math.abs(chromaV(r, g, b) - (-79.3117)) < 0.01, 'Cr of #00b140');
  // A neutral colour sits on the grey axis: Cb and Cr are both ~0.
  assert.ok(Math.abs(chromaU(128, 128, 128)) < 1e-9);
  assert.ok(Math.abs(chromaV(128, 128, 128)) < 1e-9);
});

test('a saturated key is treated as chroma, a grey key as neutral', () => {
  assert.equal(makeParams(GREEN, 25, 0, 0).neutral, false);
  assert.equal(makeParams([0, 0, 255], 25, 0, 0).neutral, false);
  assert.equal(makeParams([242, 242, 242], 25, 0, 0).neutral, true);
  assert.equal(makeParams([0, 0, 0], 25, 0, 0).neutral, true);
});

test('the dominant channel decides which channel spill removal pulls down', () => {
  assert.equal(makeParams(GREEN, 25, 0, 0).family, 'g');
  assert.equal(makeParams([0, 0, 255], 25, 0, 0).family, 'b');
  assert.equal(makeParams([255, 0, 0], 25, 0, 0).family, 'r');
});

test('the exact key colour keys out to zero alpha', () => {
  const p = makeParams(GREEN, 25, 0, 0);
  assert.equal(key1(GREEN, p)[3], 0);
});

test('a pixel far from the key colour keeps full alpha', () => {
  const p = makeParams(GREEN, 25, 0, 0);
  assert.equal(key1(SKIN, p)[3], 255);
});

test('tolerance 0 keys almost nothing, tolerance 100 keys almost everything', () => {
  const tight = makeParams(GREEN, 0, 0, 0);
  const loose = makeParams(GREEN, 100, 0, 0);
  assert.equal(key1(GREEN, tight)[3], 0, 'the exact key still goes at tolerance 0');
  assert.equal(key1([40, 180, 90], tight)[3], 255, 'a near neighbour survives at tolerance 0');
  assert.equal(key1([40, 180, 90], loose)[3], 0, 'the same neighbour goes at tolerance 100');
});

test('a shadow on the screen keys out, but only down to a depth the tolerance allows', () => {
  // Measuring in Cb/Cr slows the drift down, it does not stop it. Measured
  // distances from the key colour, and what they do at the default tolerance:
  //
  //   brightness  RGB distance  Cb/Cr distance  alpha @ tolerance 25
  //   100%         0.00          0.00            0
  //    90%        18.97          8.55            0
  //    80%        37.34         16.52            0
  //    70%        56.30         25.07            0
  //    60%        75.61         33.53          255   <- lo is 29.5 here
  //    55%        85.09         37.81          255
  //
  // So the Cb/Cr distance grows at roughly half the rate of the RGB distance,
  // which is the whole reason for measuring there — but a deep enough shadow
  // still crosses the threshold and needs a higher tolerance.
  const tol25 = makeParams(GREEN, 25, 0, 0);
  const tol50 = makeParams(GREEN, 50, 0, 0);
  const at = (f) => GREEN.map((v) => Math.round(v * f));

  assert.equal(key1(at(0.8), tol25)[3], 0, 'a 20% shadow keys out at the default tolerance');
  assert.equal(key1(at(0.7), tol25)[3], 0, 'a 30% shadow still keys out at the default tolerance');
  assert.equal(key1(at(0.55), tol25)[3], 255, 'a 45% shadow does NOT key out at the default tolerance');
  assert.equal(key1(at(0.55), tol50)[3], 0, 'the same shadow keys out once the tolerance is raised');
  assert.equal(key1(at(0.4), tol50)[3], 0, 'even a 60% shadow keys out at tolerance 50');
});

test('alpha ramps across the feather band rather than switching hard', () => {
  const p = makeParams(GREEN, 50, 40, 0);          // tolerance 50 + edge +40 => a soft band
  assert.ok(p.hi - p.lo > 1, 'the feather band has width: lo=' + p.lo + ' hi=' + p.hi);
  const seen = new Set();
  for (let r = 0; r <= 255; r++) {                  // walk the red channel away from the key
    seen.add(key1([r, 177, 64], p)[3]);
  }
  const partial = [...seen].filter((a) => a > 0 && a < 255);
  assert.ok(partial.length >= 20,
    'expected a smooth ramp, saw ' + partial.length + ' distinct partial alphas');
  assert.ok(Math.min(...partial) <= 20 && Math.max(...partial) >= 235,
    'the ramp should reach near 0 and near 255');
});

test('with edge at 0 the band is hard, so alpha is only ever 0 or 255', () => {
  const p = makeParams(GREEN, 25, 0, 0);
  const seen = new Set();
  for (let r = 0; r <= 255; r++) seen.add(key1([r, 177, 64], p)[3]);
  assert.deepEqual([...seen].sort((a, b) => a - b), [0, 255]);
});

test('a neutral key measures luminance, not chroma', () => {
  const p = makeParams([242, 242, 242], 25, 0, 0);
  assert.equal(key1([242, 242, 242], p)[3], 0, 'the wall itself keys out');
  assert.equal(key1([154, 154, 154], p)[3], 255, 'a much darker grey prop survives');
  // Two colours with identical chroma but different luma must be told apart,
  // which a chroma-only key could not do.
  assert.notEqual(key1([200, 200, 200], p)[3], key1([242, 242, 242], p)[3]);
});

test('spill removal pulls the key channel down and leaves the others alone', () => {
  // A green cast means green is the highest channel — that is the condition
  // the spill stage looks for.
  const cast = [180, 214, 150];
  assert.ok(cast[1] > Math.max(cast[0], cast[2]), 'fixture really has a green cast');

  const p = makeParams(GREEN, 25, 0, 100);
  const [r, g, b, a] = key1(cast, p);
  assert.equal(a, 255, 'spill removal must not touch alpha');
  assert.equal(r, cast[0], 'red is untouched for a green key');
  assert.equal(b, cast[2], 'blue is untouched for a green key');
  assert.ok(g < cast[1], 'green comes down');
  assert.ok(g <= Math.max(r, b), 'green is clamped to the other channels');
});

test('spill removal leaves a subject alone when there is no cast to remove', () => {
  // Skin tone where green is already the lowest channel: nothing to pull down.
  assert.ok(SKIN[1] < Math.max(SKIN[0], SKIN[2]), 'fixture has no green cast');
  const p = makeParams(GREEN, 25, 0, 100);
  assert.deepEqual(key1(SKIN, p).slice(0, 3), SKIN);
});

test('spill removal only ever moves one channel, and only downward', () => {
  const p = makeParams(GREEN, 25, 0, 100);
  for (let g = 0; g <= 255; g += 5) {
    const c = [180, g, 150];
    const [r, gg, b] = key1(c, p);
    assert.equal(r, 180, 'red unchanged at g=' + g);
    assert.equal(b, 150, 'blue unchanged at g=' + g);
    assert.ok(gg <= g, 'green never rises at g=' + g);
  }
});

test('spill removal at 0 changes nothing', () => {
  const p = makeParams(GREEN, 25, 0, 0);
  assert.deepEqual(key1(SKIN, p).slice(0, 3), SKIN);
});

test('keying is in-place safe: dst may be src', () => {
  const buf = Uint8ClampedArray.from([...GREEN, 255, ...SKIN, 255]);
  const p = makeParams(GREEN, 25, 0, 0);
  keyPixels(buf, buf, p);
  assert.equal(buf[3], 0, 'first pixel keyed out');
  assert.equal(buf[7], 255, 'second pixel kept');
});

test('autoKey finds the median border colour and ignores a subject that grazes an edge', () => {
  const w = 40, h = 40;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < data.length; i += 4) {
    data[i] = GREEN[0]; data[i + 1] = GREEN[1]; data[i + 2] = GREEN[2]; data[i + 3] = 255;
  }
  // A bright prop covering the top-left quarter, touching two edges.
  for (let y = 0; y < 12; y++) {
    for (let x = 0; x < 12; x++) {
      const i = (y * w + x) * 4;
      data[i] = 255; data[i + 1] = 255; data[i + 2] = 255;
    }
  }
  assert.deepEqual(autoKey(data, w, h), GREEN, 'the median ignores the intruding prop');
});

test('autoKey returns null when the border band holds too few samples', () => {
  // A 1x1 frame has one pixel; the band needs at least 8 samples.
  assert.equal(autoKey(new Uint8ClampedArray(4), 1, 1), null);
});

test('alpha is preserved proportionally for partially transparent input', () => {
  const p = makeParams(GREEN, 50, 40, 0);
  const src = Uint8ClampedArray.from([0, 177, 64, 128]);
  const dst = new Uint8ClampedArray(4);
  keyPixels(src, dst, p);
  assert.equal(dst[3], 0, 'the key colour is fully removed whatever the source alpha');
});
