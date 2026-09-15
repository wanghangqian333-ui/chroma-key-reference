/*
 * Synthetic test frames with a known ground-truth mask.
 *
 * Everything here is deterministic: the same seed produces byte-identical
 * pixels on every run, on every machine. That is the point — the numbers in
 * data/tolerance-sweep.csv are only worth quoting if anyone can regenerate
 * them.
 *
 * Each fixture returns { name, w, h, rgba, keyRgb, truth, note }:
 *   rgba    Uint8ClampedArray, RGBA, w*h*4
 *   keyRgb  the key colour the fixture was built around
 *   truth   Uint8Array, w*h — 1 where the pixel belongs to the subject,
 *           0 where it belongs to the backdrop
 *   note    what the fixture is for
 */

/** mulberry32 — small, fast, deterministic. */
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp255 = (v) => (v < 0 ? 0 : (v > 255 ? 255 : Math.round(v)));

/** Darken a colour without changing its hue: scale RGB toward black. */
function shade(rgb, f) {
  return [clamp255(rgb[0] * f), clamp255(rgb[1] * f), clamp255(rgb[2] * f)];
}

/** Blend b into a by t (0..1). */
function mix(a, b, t) {
  return [
    clamp255(a[0] + (b[0] - a[0]) * t),
    clamp255(a[1] + (b[1] - a[1]) * t),
    clamp255(a[2] + (b[2] - a[2]) * t),
  ];
}

/**
 * Build one frame.
 *
 * opts:
 *   w, h        frame size (default 320x240)
 *   key         backdrop colour, [r,g,b]
 *   subject     subject colour, [r,g,b]
 *   seed        RNG seed
 *   shadow      { strength, from, to } — a soft darker band across the backdrop
 *   spill       { strength, rim } — green bounced onto the subject's rim
 *   grain       per-channel noise amplitude, in 0-255 units
 *   shape       'ellipse' | 'rect'
 */
function build(opts) {
  const w = opts.w || 320;
  const h = opts.h || 240;
  const key = opts.key;
  const subject = opts.subject;
  const rnd = rng(opts.seed || 1);
  const grain = opts.grain || 0;

  const rgba = new Uint8ClampedArray(w * h * 4);
  const truth = new Uint8Array(w * h);

  const cx = w * 0.5, cy = h * 0.5;
  const rx = w * 0.26, ry = h * 0.34;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const i = p * 4;

      // --- backdrop, optionally with a shadow band -----------------------
      let base = key;
      if (opts.shadow) {
        const s = opts.shadow;
        const t = (x / w - s.from) / (s.to - s.from);
        if (t > 0) {
          // Smooth ramp so the shadow edge is not a hard line.
          const f = 1 - s.strength * Math.min(1, t * t * (3 - 2 * t));
          base = shade(key, f);
        }
      }

      // --- subject ------------------------------------------------------
      let onSubject = false;
      if (opts.shape === 'rect') {
        onSubject = Math.abs(x - cx) < rx && Math.abs(y - cy) < ry;
      } else {
        const dx = (x - cx) / rx, dy = (y - cy) / ry;
        onSubject = dx * dx + dy * dy <= 1;
      }

      let col = base;
      if (onSubject) {
        col = subject;
        // Spill: green bounced off the screen onto the rim of the subject.
        if (opts.spill) {
          const dx = (x - cx) / rx, dy = (y - cy) / ry;
          const d = Math.sqrt(dx * dx + dy * dy);       // 0 at centre, 1 at the rim
          const rim = 1 - Math.min(1, (1 - d) / opts.spill.rim);
          if (rim > 0) col = mix(subject, key, rim * opts.spill.strength);
        }
      }

      // --- grain --------------------------------------------------------
      let r = col[0], g = col[1], b = col[2];
      if (grain) {
        r += (rnd() - 0.5) * 2 * grain;
        g += (rnd() - 0.5) * 2 * grain;
        b += (rnd() - 0.5) * 2 * grain;
      }

      rgba[i] = clamp255(r);
      rgba[i + 1] = clamp255(g);
      rgba[i + 2] = clamp255(b);
      rgba[i + 3] = 255;
      truth[p] = onSubject ? 1 : 0;
    }
  }

  return { name: opts.name, w, h, rgba, keyRgb: key, truth, note: opts.note };
}

/* ---------------------------------------------------------------------------
 * The fixtures
 * ------------------------------------------------------------------------- */

export const GREEN = [0, 177, 64];      // the default key colour of the tool
export const BLUE = [0, 71, 187];
export const WHITE = [242, 242, 242];
const SKIN = [224, 176, 144];
const GREY_PROP = [154, 154, 154];

export function fixtures() {
  return [
    build({
      name: 'flat-green',
      key: GREEN, subject: SKIN, seed: 11,
      note: 'Evenly lit green screen. The easy case: every backdrop pixel is the key colour.',
    }),
    build({
      name: 'shadow-green',
      key: GREEN, subject: SKIN, seed: 12,
      shadow: { strength: 0.55, from: 0.35, to: 0.95 },
      note: 'Green screen with a soft shadow across the right half — same hue, lower luma.',
    }),
    build({
      name: 'spill-green',
      key: GREEN, subject: SKIN, seed: 13,
      spill: { strength: 0.7, rim: 0.22 },
      note: 'Green bounced onto the subject rim. The rim is ground-truth subject, so a key that erases it scores a false positive.',
    }),
    build({
      name: 'shadow-spill-green',
      key: GREEN, subject: SKIN, seed: 14,
      shadow: { strength: 0.5, from: 0.3, to: 0.95 },
      spill: { strength: 0.7, rim: 0.22 },
      note: 'Both problems at once, plus sensor grain.',
      grain: 3,
    }),
    build({
      name: 'flat-blue',
      key: BLUE, subject: SKIN, seed: 15,
      note: 'Blue screen instead of green.',
    }),
    build({
      name: 'neutral-white',
      key: WHITE, subject: GREY_PROP, seed: 16,
      shape: 'rect',
      note: 'Neutral backdrop. No chroma to measure, so the key falls back to luminance.',
    }),
  ];
}
