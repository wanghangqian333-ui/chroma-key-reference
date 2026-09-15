/*
 * Regenerate the CSVs in data/.
 *
 *   node bench/run.mjs
 *
 * Every number written by this script is produced here, from the deterministic
 * fixtures in bench/fixtures.mjs and the keyer in src/keyer.mjs. Nothing is
 * copied from anywhere else, so the CSV can be regenerated and diffed.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeParams, keyPixels, autoKey, rgbToHex, chromaU, chromaV, luma } from '../src/keyer.mjs';
import { fixtures, GREEN, BLUE, WHITE } from './fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, '..', 'data');
mkdirSync(DATA, { recursive: true });

/* ---------------------------------------------------------------------------
 * Scoring
 * ------------------------------------------------------------------------- */

/**
 * A keyed pixel is "background" when alpha came out 0, "subject" otherwise.
 * Ground truth comes from the fixture, not from the keyer.
 */
function score(src, truth) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (let p = 0, i = 0; p < truth.length; p++, i += 4) {
    const saidBackground = src[i + 3] === 0;
    const isBackground = truth[p] === 0;
    if (saidBackground && isBackground) tp++;
    else if (saidBackground && !isBackground) fp++;
    else if (!saidBackground && isBackground) fn++;
    else tn++;
  }
  return { tp, fp, fn, tn };
}

const f6 = (x) => (Number.isFinite(x) ? x.toFixed(6) : 'n/a');
const ratio = (a, b) => (b === 0 ? NaN : a / b);

/* ---------------------------------------------------------------------------
 * 1. Tolerance sweep — the main table
 * ------------------------------------------------------------------------- */

const TOL_STEP = 5;
const rows = [
  ['fixture', 'key_hex', 'width', 'height', 'tolerance', 'edge', 'spill',
   'backdrop_pixels', 'subject_pixels', 'tp', 'fp', 'fn',
   'precision', 'recall', 'iou'].join(','),
];

let totalRows = 0;
for (const fx of fixtures()) {
  const backdrop = fx.truth.reduce((n, v) => n + (v === 0 ? 1 : 0), 0);
  const subject = fx.truth.length - backdrop;
  const out = new Uint8ClampedArray(fx.rgba.length);

  for (let tolerance = 0; tolerance <= 100; tolerance += TOL_STEP) {
    const p = makeParams(fx.keyRgb, tolerance, 0, 0);
    keyPixels(fx.rgba, out, p);
    const { tp, fp, fn } = score(out, fx.truth);
    rows.push([
      fx.name, rgbToHex(...fx.keyRgb), fx.w, fx.h, tolerance, 0, 0,
      backdrop, subject, tp, fp, fn,
      f6(ratio(tp, tp + fp)), f6(ratio(tp, tp + fn)), f6(ratio(tp, tp + fp + fn)),
    ].join(','));
    totalRows++;
  }
}
writeFileSync(join(DATA, 'tolerance-sweep.csv'), rows.join('\n') + '\n');
console.log('data/tolerance-sweep.csv  %d rows', totalRows);

/* ---------------------------------------------------------------------------
 * 2. Edge sweep — what the fringe trim does to a spill rim
 * ------------------------------------------------------------------------- */

const EDGE_STEP = 10;
const EDGE_TOLERANCE = 25;
const edgeRows = [
  ['fixture', 'key_hex', 'tolerance', 'edge', 'spill', 'tp', 'fp', 'fn',
   'precision', 'recall', 'iou'].join(','),
];

for (const fx of fixtures().filter((f) => f.name === 'spill-green' || f.name === 'shadow-spill-green')) {
  const out = new Uint8ClampedArray(fx.rgba.length);
  for (let edge = -100; edge <= 100; edge += EDGE_STEP) {
    const p = makeParams(fx.keyRgb, EDGE_TOLERANCE, edge, 0);
    keyPixels(fx.rgba, out, p);
    const { tp, fp, fn } = score(out, fx.truth);
    edgeRows.push([
      fx.name, rgbToHex(...fx.keyRgb), EDGE_TOLERANCE, edge, 0,
      tp, fp, fn,
      f6(ratio(tp, tp + fp)), f6(ratio(tp, tp + fn)), f6(ratio(tp, tp + fp + fn)),
    ].join(','));
  }
}
writeFileSync(join(DATA, 'edge-sweep.csv'), edgeRows.join('\n') + '\n');
console.log('data/edge-sweep.csv       %d rows', edgeRows.length - 1);

/* ---------------------------------------------------------------------------
 * 3. Key presets — the maths behind a chosen key colour
 * ------------------------------------------------------------------------- */

const PRESETS = [
  ['green-screen', GREEN],
  ['blue-screen', BLUE],
  ['white-wall', WHITE],
  ['black-wall', [0, 0, 0]],
  ['grey-card', [128, 128, 128]],
  ['magenta', [177, 0, 177]],
  ['broadcast-green', [0, 255, 0]],
  ['broadcast-blue', [0, 0, 255]],
];

const REF_TOLERANCE = 25;
const presetRows = [
  ['name', 'hex', 'r', 'g', 'b', 'cb', 'cr', 'luma', 'chroma_magnitude', 'neutral',
   'dominant_channel', 'lo_at_tolerance_25', 'hi_at_tolerance_25'].join(','),
];

for (const [name, rgb] of PRESETS) {
  const cb = chromaU(...rgb);
  const cr = chromaV(...rgb);
  const p = makeParams(rgb, REF_TOLERANCE, 0, 0);
  presetRows.push([
    name, rgbToHex(...rgb), rgb[0], rgb[1], rgb[2],
    cb.toFixed(4), cr.toFixed(4), luma(...rgb).toFixed(4),
    Math.sqrt(cb * cb + cr * cr).toFixed(4),
    p.neutral, p.family, p.lo.toFixed(4), p.hi.toFixed(4),
  ].join(','));
}
writeFileSync(join(DATA, 'key-presets.csv'), presetRows.join('\n') + '\n');
console.log('data/key-presets.csv      %d rows', presetRows.length - 1);

/* ---------------------------------------------------------------------------
 * 4. Auto-key accuracy — does the border median find the real key colour?
 * ------------------------------------------------------------------------- */

const autoRows = [
  ['fixture', 'expected_hex', 'detected_hex', 'exact_match',
   'max_channel_delta'].join(','),
];

for (const fx of fixtures()) {
  const got = autoKey(fx.rgba, fx.w, fx.h);
  const delta = got ? Math.max(...got.map((v, k) => Math.abs(v - fx.keyRgb[k]))) : 'n/a';
  autoRows.push([
    fx.name, rgbToHex(...fx.keyRgb), got ? rgbToHex(...got) : 'null',
    got ? String(rgbToHex(...got) === rgbToHex(...fx.keyRgb)) : 'n/a',
    delta,
  ].join(','));
}
writeFileSync(join(DATA, 'auto-key-accuracy.csv'), autoRows.join('\n') + '\n');
console.log('data/auto-key-accuracy.csv %d rows', autoRows.length - 1);

/* ---------------------------------------------------------------------------
 * 5. Shadow drift — how far a shadow moves the pixel, in RGB and in Cb/Cr
 *
 * A shadow on the screen is the same colour at a lower brightness. Measuring
 * the distance in Cb/Cr slows the drift down; it does not stop it. This table
 * is the measurement behind that sentence, so the claim can be checked rather
 * than believed.
 * ------------------------------------------------------------------------- */

const shadowRows = [
  ['backdrop_brightness', 'rgb_hex', 'rgb_distance_from_key', 'chroma_distance_from_key',
   'alpha_at_tolerance_25', 'alpha_at_tolerance_50', 'alpha_at_tolerance_75'].join(','),
];

const ku = chromaU(...GREEN), kv = chromaV(...GREEN);
for (let f = 100; f >= 40; f -= 5) {
  const factor = f / 100;
  const c = GREEN.map((v) => Math.round(v * factor));
  const rgbDistance = Math.sqrt(
    (c[0] - GREEN[0]) ** 2 + (c[1] - GREEN[1]) ** 2 + (c[2] - GREEN[2]) ** 2);
  const chromaDistance = Math.sqrt(
    (chromaU(...c) - ku) ** 2 + (chromaV(...c) - kv) ** 2);
  const alphaAt = (tolerance) => {
    const src = Uint8ClampedArray.from([...c, 255]);
    const dst = new Uint8ClampedArray(4);
    keyPixels(src, dst, makeParams(GREEN, tolerance, 0, 0));
    return dst[3];
  };
  shadowRows.push([
    factor.toFixed(2), rgbToHex(...c),
    rgbDistance.toFixed(4), chromaDistance.toFixed(4),
    alphaAt(25), alphaAt(50), alphaAt(75),
  ].join(','));
}
writeFileSync(join(DATA, 'shadow-distance.csv'), shadowRows.join('\n') + '\n');
console.log('data/shadow-distance.csv  %d rows', shadowRows.length - 1);
