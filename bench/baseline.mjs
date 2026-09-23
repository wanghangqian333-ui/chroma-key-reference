/*
 * Baseline comparison — two naive keyers vs this keyer, on the same fixtures.
 *
 *   node bench/baseline.mjs
 *
 * Why this exists: "we beat nothing" is not an evaluation. The two baselines are
 * deliberately simple, dependency-free, and described in the paper, so anyone can
 * reimplement them from the prose alone.
 *
 *   baseline A  rgb-euclid   background when Euclidean RGB distance to the key < t
 *   baseline B  green-dom    background when g - max(r, b) > t   (no colour science)
 *
 * Fairness: each baseline gets an *oracle* threshold, swept over its full range and
 * reported at its own best IoU. That is the most generous reading of each baseline;
 * if it still loses, the gap is not a tuning artefact. Our keyer is reported both at
 * its shipped default (tolerance 25) and at its own best tolerance.
 *
 * Nothing here is copied from anywhere; every number is computed from
 * bench/fixtures.mjs and src/keyer.mjs.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeParams, keyPixels, rgbToHex } from '../src/keyer.mjs';
import { fixtures } from './fixtures.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, '..', 'data');
mkdirSync(DATA, { recursive: true });

const f6 = (x) => (Number.isFinite(x) ? x.toFixed(6) : 'n/a');
const ratio = (a, b) => (b === 0 ? NaN : a / b);

/** Same convention as bench/run.mjs: a pixel is "keyed" when alpha == 0. */
function iou(alpha, truth) {
  let tp = 0, fp = 0, fn = 0;
  for (let p = 0, i = 0; p < truth.length; p++, i += 4) {
    const saidBackground = alpha[i + 3] === 0;
    const isBackground = truth[p] === 0;
    if (saidBackground && isBackground) tp++;
    else if (saidBackground && !isBackground) fp++;
    else if (!saidBackground && isBackground) fn++;
  }
  return { iou: ratio(tp, tp + fp + fn), tp, fp, fn };
}

/** Baseline A: Euclidean RGB distance to the key colour. */
function alphaRgbEuclid(rgba, key, t) {
  const a = new Uint8ClampedArray(rgba.length);
  const [kr, kg, kb] = key;
  for (let i = 0; i < rgba.length; i += 4) {
    const dr = rgba[i] - kr, dg = rgba[i + 1] - kg, db = rgba[i + 2] - kb;
    const d = Math.sqrt(dr * dr + dg * dg + db * db);
    a[i + 3] = d < t ? 0 : 255;
  }
  return a;
}

/** Baseline B: green dominance — no colour space, no distance norm. */
function alphaGreenDom(rgba, t) {
  const a = new Uint8ClampedArray(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    const excess = rgba[i + 1] - Math.max(rgba[i], rgba[i + 2]);
    a[i + 3] = excess > t ? 0 : 255;
  }
  return a;
}

function ours(rgba, key, tolerance) {
  const out = new Uint8ClampedArray(rgba.length);
  keyPixels(rgba, out, makeParams(key, tolerance, 0, 0));
  return out;
}

function bestBySweep(fn, lo, hi, step) {
  let best = { iou: -1, t: null };
  for (let t = lo; t <= hi; t += step) {
    const r = fn(t);
    if (Number.isFinite(r.iou) && r.iou > best.iou) best = { iou: r.iou, t };
  }
  return best;
}

const rows = [
  ['fixture', 'key_hex', 'method', 'threshold', 'setting', 'tp', 'fp', 'fn', 'iou'].join(','),
];

const summary = [];
for (const fx of fixtures()) {
  const key = fx.keyRgb;
  const hex = rgbToHex(...key);

  const aDefault = ours(fx.rgba, key, 25);
  const sDefault = iou(aDefault, fx.truth);

  const oursBest = bestBySweep(
    (t) => iou(ours(fx.rgba, key, t), fx.truth), 0, 100, 5);
  const rgbBest = bestBySweep(
    (t) => iou(alphaRgbEuclid(fx.rgba, key, t), fx.truth), 0, 255, 1);
  const domBest = bestBySweep(
    (t) => iou(alphaGreenDom(fx.rgba, t), fx.truth), 0, 255, 1);

  const push = (method, t, setting, s) => rows.push([
    fx.name, hex, method, t === null ? 'n/a' : t, setting,
    s.tp, s.fp, s.fn, f6(s.iou),
  ].join(','));

  push('ours-cbcr', 25, 'shipped default', sDefault);
  push('ours-cbcr', oursBest.t, 'best tolerance', { iou: oursBest.iou, tp: '', fp: '', fn: '' });
  push('baseline-rgb-euclid', rgbBest.t, 'oracle threshold', { iou: rgbBest.iou, tp: '', fp: '', fn: '' });
  push('baseline-green-dom', domBest.t, 'oracle threshold', { iou: domBest.iou, tp: '', fp: '', fn: '' });

  summary.push({
    fixture: fx.name,
    ours_default: f6(sDefault.iou),
    ours_best: f6(oursBest.iou),
    rgb_euclid_best: f6(rgbBest.iou),
    green_dom_best: f6(domBest.iou),
  });
}

writeFileSync(join(DATA, 'baseline-comparison.csv'), rows.join('\n') + '\n');

const mean = (k) => f6(summary.reduce((n, r) => n + parseFloat(r[k]), 0) / summary.length);
console.log('\n=== baseline comparison (IoU, higher is better) ===');
console.log(['fixture'.padEnd(22), 'ours@25', 'ours*', 'rgb*', 'green*'].join('  '));
for (const r of summary) {
  console.log([r.fixture.padEnd(22), r.ours_default.padStart(7),
    r.ours_best.padStart(7), r.rgb_euclid_best.padStart(7),
    r.green_dom_best.padStart(7)].join('  '));
}
console.log(['MEAN'.padEnd(22), mean('ours_default').padStart(7),
  mean('ours_best').padStart(7), mean('rgb_euclid_best').padStart(7),
  mean('green_dom_best').padStart(7)].join('  '));
console.log('\n(* = oracle/best threshold for that method; ours@25 = shipped default)');
console.log('wrote data/baseline-comparison.csv');
