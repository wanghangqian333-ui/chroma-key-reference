# How the key works

Everything below describes the code in `src/keyer.mjs`. Nothing here is
aspirational: if a sentence makes a claim about behaviour, the claim is either
a consequence of the arithmetic or a number from `data/`, and the command that
produces that number is given.

## 1. Why YCbCr and not RGB

A chroma key has to answer one question per pixel: is this pixel the backdrop,
or is it the subject? The naive answer is a distance in RGB. The problem is
that RGB mixes brightness and colour into the same three numbers, so a shadow
on the screen — the same green paint, less light on it — moves the pixel a long
way in RGB even though its *colour* has not changed.

YCbCr separates the two. Y carries brightness; Cb and Cr carry colour. A pixel
is converted with the BT.601 coefficients:

```
Y  =  0.299·R + 0.587·G + 0.114·B
Cb = -0.168736·R - 0.331264·G + 0.5·B
Cr =  0.5·R - 0.418688·G - 0.081312·B
```

and the distance to the key colour is measured **in the Cb/Cr plane only**.

`data/shadow-distance.csv` measures what that buys. For a shadow that keeps the
hue and scales the brightness down:

| backdrop brightness | RGB distance | Cb/Cr distance |
|---|---|---|
| 100% | 0.00 | 0.00 |
| 90% | 18.97 | 8.55 |
| 80% | 37.34 | 16.52 |
| 70% | 56.30 | 25.07 |
| 60% | 75.61 | 33.53 |
| 50% | 93.64 | 41.58 |

The Cb/Cr distance grows at roughly **half** the rate of the RGB distance, so
the same threshold survives about twice as deep a shadow.

It does not survive an arbitrarily deep one. The distance still grows, and at
some point it crosses the threshold. In this implementation the threshold at
the default tolerance is 29.5, which the table above crosses between 70% and
60% brightness. That is a limitation, not a footnote — see §4.

## 2. Turning a distance into an alpha

Two numbers define the band, both derived from the UI values:

```
lo = (tolerance / 100) · scale            + trim
hi = lo + feather
```

* `tolerance` (0–100) sets how far from the key colour still counts as
  backdrop. It scales onto 118 for a chroma key and 150 for a neutral one.
* `edge` (−100…100) is a single control for two opposite jobs. Positive values
  raise `hi`, which widens the band and **softens** the edge. Negative values
  raise `lo`, which narrows the band and **trims** the fringe. The two scales
  are 46 and 62 for a chroma key, 60 and 70 for a neutral one.

Alpha is then:

```
d ≤ lo          → 0        (backdrop)
lo < d < hi     → (d − lo) / (hi − lo)
d ≥ hi          → 1        (subject)
```

With `edge = 0`, `hi == lo` and the band has zero width, so alpha is only ever
0 or 255. That is the default, and it is why the tool's Edge slider has to be
moved before any feathering appears.

`data/tolerance-sweep.csv` is the band swept from 0 to 100 in steps of 5,
against six fixtures.

## 3. The neutral fallback

A white, black or grey backdrop has no chroma: those colours all sit at the
same point in the Cb/Cr plane, so a chroma key cannot tell a white wall from a
white shirt. When the key colour's Cb/Cr magnitude is below 7 the code switches
to measuring the **luminance** difference instead, and uses the wider scales
above.

This is a different algorithm wearing the same interface, and it has the
opposite failure mode: it cannot tell two things apart that have the same
brightness but different colours.

## 4. What the measurements actually say

From `data/tolerance-sweep.csv` (320×240 fixtures, tolerance stepped by 5,
`edge = 0`, `spill = 0`). IoU is computed against the fixture's ground-truth
mask: `tp / (tp + fp + fn)`, where a pixel is called backdrop when alpha came
out 0.

| fixture | best IoU | tolerance at best | first tolerance with IoU > 0.99 |
|---|---|---|---|
| `flat-green` | 1.000000 | 0 | 0 |
| `shadow-green` | 1.000000 | 40 | 40 |
| `spill-green` | 1.000000 | 0 | 0 |
| `shadow-spill-green` | 0.966269 | 40 | never |
| `flat-blue` | 1.000000 | 0 | 0 |
| `neutral-white` | 1.000000 | 0 | 0 |

Four things worth pulling out of that table:

1. **A shadowed backdrop needs a higher tolerance than the default.** At the
   default tolerance of 25, `shadow-green` scores a recall of 0.617718 — 38% of
   the backdrop is left behind. It reaches 1.000 at tolerance 40. The cost of
   going higher is visible in the next row.
2. **Raising the tolerance eats the spill rim.** On `spill-green`, precision
   falls from 1.000 at tolerance 0 to 0.885 at tolerance 80: 7,206 of the
   21,341 subject pixels are erased, because the rim is tinted with the key
   colour and a wider band treats it as backdrop. This is the trade-off the
   Tolerance slider is actually making, and it is why the fixture's rim is
   ground-truth subject rather than background.
3. **Both problems at once never gets clean.** `shadow-spill-green` peaks at
   0.966269 and never crosses 0.99. A single global distance threshold cannot
   separate a deep shadow from a spill rim, because they sit at similar
   distances from the key colour. Anything better needs a spatial method — a
   matte, a brush, or a second pass — which this core deliberately does not
   have.
4. **The neutral path collapses suddenly, not gradually.** `neutral-white`
   holds 1.000 up to tolerance 50 and then drops to 0.645560 at 60, where the
   subject itself is keyed out. Luminance distance is not a smooth proxy for
   "is this the backdrop", so the useful range is narrow.

## 5. Guessing the key colour

`autoKey()` samples a band 5% wide along all four edges (minimum 2 px), on a
grid of at most 240 steps per axis so the cost does not grow with frame size,
and takes the **median** of each channel. The median is the point: a subject
that grazes one edge of the frame is a minority of the band, so it does not
move the result, whereas a mean would be dragged toward it.

`data/auto-key-accuracy.csv` shows where that holds and where it does not:

| fixture | expected | detected | max channel delta |
|---|---|---|---|
| `flat-green` | `#00b140` | `#00b140` | 0 |
| `shadow-green` | `#00b140` | `#00a23b` | 15 |
| `spill-green` | `#00b140` | `#00b140` | 0 |
| `shadow-spill-green` | `#00b140` | `#009d39` | 20 |
| `flat-blue` | `#0047bb` | `#0047bb` | 0 |
| `neutral-white` | `#f2f2f2` | `#f2f2f2` | 0 |

The median shrugs off an intruding subject, as designed. What it cannot shrug
off is a **shadow that reaches the edge of the frame**, because then the shadow
is part of the band and the median lands between the lit and shadowed values —
off by up to 20 levels here. On a real shoot, light the screen evenly or key
from a frame where the shadow does not touch the border.

`autoKey()` returns `null` when the band holds fewer than 8 samples, which
happens only on absurdly small frames. Callers must handle that.

## 6. Spill suppression

Green light bounces off the screen onto hair, shoulders and light clothing.
After alpha is decided, subject pixels are checked for a cast and the key
channel is pulled down toward the higher of the other two:

```
family 'g':  if (G > max(R, B))  G -= (G − max(R, B)) · spill
family 'b':  if (B > max(R, G))  B -= (B − max(R, G)) · spill
family 'r':  if (R > max(G, B))  R -= (R − max(G, B)) · spill
```

`spill` is the slider scaled to 0…1. Three properties follow from the shape of
that expression, and all three are asserted in `src/keyer.test.mjs`:

* Only one channel ever moves, and only **downward**.
* A subject with no cast is left exactly as it was — if the key channel is not
  the highest, the condition is false and nothing happens. A skin tone where
  green is already the lowest channel is untouched.
* The channel is clamped to `max(other two)`, so spill removal can never
  overshoot past the cast and tint the subject with a complementary colour.

## 7. Reproducing all of it

```sh
node --test src/keyer.test.mjs    # 19 assertions, no dependencies
node bench/run.mjs                # rewrites everything in data/
```

The fixtures in `bench/fixtures.mjs` are generated from a seeded PRNG
(`mulberry32`), so the CSVs are byte-identical on every machine. Diffing them
after a change to `src/keyer.mjs` is the intended workflow.
