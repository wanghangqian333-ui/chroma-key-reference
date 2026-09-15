/*
 * Chroma key core — dependency-free, runs in Node and in the browser.
 *
 * This is the keying maths used by the green screen remover at
 * https://greenscreenremover.net, lifted out of the page so it can be reused,
 * tested and benchmarked on its own. No DOM, no canvas, no network: every
 * function here works on plain typed arrays.
 *
 * The method is deliberately small. A pixel is converted to YCbCr, the
 * distance from the key colour is measured in the Cb/Cr plane only, and that
 * distance is mapped onto an alpha ramp. Measuring in Cb/Cr is what lets a
 * shadow across the screen — the same green, only darker — key out with the
 * rest of the backdrop. A neutral key (white, black, grey) has no chroma to
 * measure, so those fall back to luminance.
 *
 * See docs/algorithm.md for the reasoning and data/tolerance-sweep.csv for
 * measured behaviour against a synthetic fixture.
 */

/* ---------------------------------------------------------------------------
 * Colour maths
 * ------------------------------------------------------------------------- */

// BT.601 luma weights and the Cb/Cr (U/V) coefficients, on 0-255 inputs.
export const KR = 0.299, KG = 0.587, KB = 0.114;
export const U_R = -0.168736, U_G = -0.331264, U_B = 0.5;
export const V_R = 0.5, V_G = -0.418688, V_B = -0.081312;

// A key colour with Cb/Cr magnitude below this has no usable chroma.
export const NEUTRAL_CHROMA = 7;

// Distance-to-alpha scaling, per key family. Tuned, not derived — see
// docs/algorithm.md for what each number does.
export const SCALE = { chroma: 118, neutral: 150 };
export const FEATHER_SCALE = { chroma: 46, neutral: 60 };
export const TRIM_SCALE = { chroma: 62, neutral: 70 };

export function chromaU(r, g, b) { return U_R * r + U_G * g + U_B * b; }
export function chromaV(r, g, b) { return V_R * r + V_G * g + V_B * b; }
export function luma(r, g, b) { return KR * r + KG * g + KB * b; }

export function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

export function hexToRgb(hex) {
  let h = String(hex).trim().replace(/^#/, '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return [0, 177, 64];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function rgbToHex(r, g, b) {
  const p = (n) => {
    const s = Math.round(clamp(n, 0, 255)).toString(16);
    return s.length < 2 ? '0' + s : s;
  };
  return '#' + p(r) + p(g) + p(b);
}

/* ---------------------------------------------------------------------------
 * Parameters
 * ------------------------------------------------------------------------- */

/**
 * Turn UI-shaped values into the numbers the pixel loop needs.
 *
 * @param {number[]} rgb       key colour, [r, g, b] on 0-255
 * @param {number}   tolerance 0-100 — how far from the key colour still counts as background
 * @param {number}   edge      -100..100 — negative trims the fringe, positive softens the edge
 * @param {number}   spill      0-100 — how hard to pull the key colour out of the subject
 */
export function makeParams(rgb, tolerance, edge, spill) {
  const [kr, kg, kb] = rgb;
  const ku = chromaU(kr, kg, kb);
  const kv = chromaV(kr, kg, kb);
  const ky = luma(kr, kg, kb);

  // A neutral key has no chroma to measure, so fall back to luminance — the
  // only thing that can separate a white wall from a white shirt.
  const neutral = Math.sqrt(ku * ku + kv * kv) < NEUTRAL_CHROMA;

  const scale = neutral ? SCALE.neutral : SCALE.chroma;
  const featherScale = neutral ? FEATHER_SCALE.neutral : FEATHER_SCALE.chroma;
  const trimScale = neutral ? TRIM_SCALE.neutral : TRIM_SCALE.chroma;

  const base = (tolerance / 100) * scale;
  let feather = 0, trim = 0;
  if (edge >= 0) feather = (edge / 100) * featherScale;
  else trim = (-edge / 100) * trimScale;

  const lo = base + trim;
  const hi = lo + feather;

  // Which channel dominates the key decides which channel spill removal pulls
  // down on the subject.
  let family = 'r';
  if (kg >= kr && kg >= kb) family = 'g';
  else if (kb >= kr && kb >= kg) family = 'b';

  return {
    ku, kv, ky, neutral,
    lo, hi,
    hard: hi - lo < 1e-6,
    spill: spill / 100,
    family,
  };
}

/* ---------------------------------------------------------------------------
 * The pixel loop
 * ------------------------------------------------------------------------- */

/**
 * Key src into dst. Both are RGBA arrays of the same length; dst may be src.
 * Background pixels come out with alpha 0, subject pixels keep their alpha.
 *
 * @param {Uint8ClampedArray|Uint8Array} src
 * @param {Uint8ClampedArray|Uint8Array} dst
 * @param {object} p  result of makeParams()
 */
export function keyPixels(src, dst, p) {
  const n = src.length;
  const { ku, kv, ky, lo, hi, hard, spill, family, neutral } = p;
  const span = hard ? 0 : (hi - lo);

  for (let i = 0; i < n; i += 4) {
    let r = src[i], g = src[i + 1], b = src[i + 2];
    const a = src[i + 3];

    let d;
    if (neutral) {
      d = luma(r, g, b) - ky;
      if (d < 0) d = -d;
    } else {
      const du = chromaU(r, g, b) - ku;
      const dv = chromaV(r, g, b) - kv;
      d = Math.sqrt(du * du + dv * dv);
    }

    let alpha;
    if (d <= lo) alpha = 0;
    else if (hard || d >= hi) alpha = 1;
    else alpha = (d - lo) / span;

    if (alpha > 0 && spill > 0) {
      if (family === 'g') {
        const mg = r > b ? r : b;
        if (g > mg) g -= (g - mg) * spill;
      } else if (family === 'b') {
        const mb = r > g ? r : g;
        if (b > mb) b -= (b - mb) * spill;
      } else {
        const mr = g > b ? g : b;
        if (r > mr) r -= (r - mr) * spill;
      }
    }

    dst[i] = r; dst[i + 1] = g; dst[i + 2] = b;
    dst[i + 3] = alpha >= 1 ? a : Math.round(alpha * a);
  }
  return dst;
}

/* ---------------------------------------------------------------------------
 * Guessing the key colour
 * ------------------------------------------------------------------------- */

/**
 * Guess the key colour from the border of the frame: the median of the outer
 * band. The median shrugs off a subject that grazes one edge of the frame.
 *
 * The band is 5% of each axis (at least 2 px) and is sampled on a grid of at
 * most 240 steps per axis, so the cost does not grow with frame size.
 *
 * @param {Uint8ClampedArray|Uint8Array} data RGBA pixels
 * @param {number} w
 * @param {number} h
 * @returns {number[]|null} [r, g, b], or null if the band held fewer than 8 samples
 */
export function autoKey(data, w, h) {
  const rs = [], gs = [], bs = [];
  const bandY = Math.max(2, Math.round(h * 0.05));
  const bandX = Math.max(2, Math.round(w * 0.05));
  const stepX = Math.max(1, Math.floor(w / 240));
  const stepY = Math.max(1, Math.floor(h / 240));

  for (let y = 0; y < h; y += stepY) {
    const edgeRow = (y < bandY) || (y >= h - bandY);
    for (let x = 0; x < w; x += stepX) {
      const edgeCol = (x < bandX) || (x >= w - bandX);
      if (!edgeRow && !edgeCol) continue;
      const i = (y * w + x) * 4;
      rs.push(data[i]); gs.push(data[i + 1]); bs.push(data[i + 2]);
    }
  }
  if (rs.length < 8) return null;

  rs.sort((a, b) => a - b);
  gs.sort((a, b) => a - b);
  bs.sort((a, b) => a - b);
  const m = Math.floor(rs.length / 2);
  return [rs[m], gs[m], bs[m]];
}
