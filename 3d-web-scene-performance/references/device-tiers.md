# Device tiers, LOD and cost curves

How to decide what a given device gets, and how to know what a knob actually
costs before you turn it.


#### One table, one row per build

Put every device-class decision in one object. One row per build, one key per
knob, read by the builders. Nothing else in the codebase asks "is this a phone".

```
SCENE_TIERS = {
  full:    { <every knob> },
  reduced: { <every knob> },   // narrow desktop window
  light:   { <every knob> },   // tablets
  phone:   { <every knob> },
}
```

Three failures this prevents:

**Drift.** Six `isMobile ?` branches in six builders will not stay in agreement
through six months of edits. Only one of them will name the tier, and the rest
become folklore.

**Floors you cannot see.** A single `quality` scalar read as `quality < 0.75 ? a : b`
is a step, not a multiplier. A row asking for a third of the detail then ships the
same geometry as a row asking for half, and nobody notices because the number in
the config did change.

**Unexpressible rows.** A real device class wants fewer scattered instances *and*
full surface resolution, because the surface's silhouette breaks below a
threshold while the scatter degrades gracefully. One scalar cannot say that. A
table can.

When you need new behaviour for a device class, **add a knob to the table**. Never
add a branch at the call site.

##### Knobs should be the thing, not a level

`nearDetailObjects: 96` and `nearDetailObjects: 0` are readable and testable.
`detailLevel: "medium"` is not, because every builder then re-interprets
"medium" privately.

A knob whose value is `null` or `false` means *this pass does not exist*, and the
code must treat it that way - see [Whole-pass declines](#whole-pass-declines).

##### Ladder knobs

Some knobs need one value per runtime quality level, so the frame controller can
index the row instead of branching on device a second time:

```
ao:         [16, 8, 6],       // sample count at quality level 0 / 1 / 2
reflection: [.5, .35, .25],   // reflection target scale at each level
```

#### Choosing the row

Decide on the thread where the signals exist. A worker has no `matchMedia` and no
`screen`; it sees a viewport width and nothing else. A phone held sideways reports
roughly 988 CSS pixels wide, which a width test hands the full desktop build.

Pass the chosen row name to the worker with the init message. The worker forwards
it. It never re-derives it.

```
function sceneTier({ width, screenWidth, screenHeight, coarsePointer, blocked }) {
  if (blocked) return "off"                      // this device already died building it
  if (coarsePointer) {
    edge = min(screenWidth, screenHeight)        // stable under rotation and URL-bar chrome
    return edge < PHONE_MAX_EDGE ? "phone" : "light"
  }
  return width < PHONE_MAX_EDGE ? "reduced" : "full"
}
```

Two signals, both about what the device *is* rather than what it claims:

- `pointer: coarse` separates touch-primary hardware from mouse-and-trackpad
  hardware. It is a hardware fact, reported honestly.
- `screen.width` / `screen.height` do not change with orientation or with the
  mobile URL bar. Take the smaller edge.

##### Do not probe capability

- `navigator.deviceMemory` is Chromium-only and clamped to 8 by Chrome on
  Android. A mid-range phone and a workstation report the same number.
- `navigator.hardwareConcurrency` reads 8 on both.
- A WebGL/WebGPU limits query tells you what is *possible*. It says nothing about
  what will hold 60 fps.

The single honest capability signal is evidence that this device already failed:
see the crash sentinel in [Persistence: caching, retention and survival](persistence.md#persistence-caching-retention-and-survival). A device is refused a scene for having
died, never for what it looks like.

##### Write the function so a test can drive it

Default-destructure every input. Then a test supplies a landscape phone, a
portrait tablet and a narrow desktop window with no browser at all:

```
sceneTier({ screenWidth: 844, screenHeight: 390, coarsePointer: true })  // "phone"
sceneTier({ screenWidth: 820, screenHeight: 1180, coarsePointer: true }) // "light"
sceneTier({ width: 480, coarsePointer: false })                          // "reduced"
```

#### Screen size, pixel budget and resize

Device *class* and screen *size* are two decisions, and conflating them is a
common mistake. The class decides which build to make. The size decides how many
pixels that build has to fill, which is a separate and larger lever.

##### The pixel budget

Fill cost scales with `cssWidth x cssHeight x pixelRatio^2`. The square is the
part people forget.

| Surface | CSS size | Effective ratio | Device pixels |
| --- | --- | --- | --- |
| Phone, capped at ratio 1 | 393 x 852 | 1 | 0.33 M |
| The same phone uncapped | 393 x 852 | 3 | 3.01 M |
| Tablet, capped at ratio 1 | 820 x 1180 | 1 | 0.97 M |
| Small laptop window | 1280 x 800 | 1.5 | 2.30 M |
| Laptop, full screen | 1440 x 900 | 2 | 5.18 M |
| 4K panel, 150% OS scaling | 2560 x 1440 | 1.5 | 8.29 M |
| 4K panel, no OS scaling, supersampled | 3840 x 2160 | 1.5 | 18.66 M |

The last two rows are the same physical display. What changes is whether the OS
scales it: at 150% the browser reports 2560x1440 CSS pixels, at 100% it reports
3840x2160. Always state which you mean - the two differ by more than a factor of
two, and a table row that does not say invites the wrong reading.

Two conclusions from that arithmetic:

- **Capping the pixel ratio is the single largest cut available on a phone.** The
  same build at ratio 1 instead of ratio 3 is a ninefold reduction in fill. That
  is why the phone row caps at 1 and why it can then afford geometry it otherwise
  could not.
- **The same device row can face a three- to eightfold range of pixel counts.**
  A window at 1280 x 800 and the same machine maximised on a 4K panel both get
  the heaviest row: 3.6x the fill if the panel is OS-scaled, 8.1x if it is not
  and the scene supersamples. The row cannot know which. Only the adaptive ladder
  can, which is why render resolution is the first thing it spends. See
  [The adaptive ladder](frame-budget.md#the-adaptive-ladder).

If you supersample above the device ratio for edge quality, clamp it hard and
remember it is multiplied by an unknown window size. `minPixelRatio: 1.5` is
reasonable on a 1280-wide window and ruinous on a maximised 4K one.

##### Decide the class once; let resolution track the window

```
mount:   tier = sceneTier(...)        // once, from screen geometry and pointer type
resize:  renderer.resize(w, h)        // every time, plus re-read layout-derived values
         // the tier is NOT re-derived
```

**Why the class is not re-derived on resize:**

- `screen.width` and `screen.height` do not change when the window is resized,
  when the URL bar hides, or when the device is rotated. The input to the decision
  has not changed, so re-running it is either a no-op or a bug.
- Changing the row mid-session means rebuilding the scene: different geometry
  densities, different passes, different materials. That is seconds of work and a
  visible interruption, in exchange for a quality change the reader did not ask
  for.
- The adaptive ladder already covers the case that matters. A window dragged onto
  a 4K panel gets more pixels; the ladder sees the frame rate drop and spends
  resolution. No rebuild.

The one input that *does* move is `window.innerWidth`, used for the narrow-desktop
row. Read it at mount and accept that a reader who resizes across that boundary
keeps the row they started with. That is the right trade: it is a rare action, and
a rebuild is worse than a slightly wrong row.

##### What must still react to resize

- The renderer's drawing-buffer size and the camera aspect.
- Every layout-derived value: scroll beat positions, element bounds, projected
  overlay anchors. Recompute these from a `ResizeObserver`, never per frame. See
  [Reading layout on layout events](interaction.md#reading-layout-on-layout-events).
- The camera's field of view, if the composition needs a different one in
  portrait. A fixed horizontal FOV crops badly on a tall viewport.
- Anything sized in device pixels: offscreen target dimensions, except the ones
  [What must never be resized live](frame-budget.md#what-must-never-be-resized-live) rules out.

##### Cases worth checking explicitly

| Case | What to check |
| --- | --- |
| Phone rotated to landscape | Screen min edge is unchanged, so the row is unchanged. Composition and FOV must still work. |
| Tablet rotated | Same. A viewport-width test would flip the row here, which is the bug the screen-edge test avoids. |
| Browser zoom | Changes `devicePixelRatio` and CSS viewport together. The ratio clamp must be applied to the *current* value, not one captured at mount. |
| Split screen or a resized window | Layout values change; the row does not. |
| External monitor, different DPR | The ratio changes under you. Re-read it on resize and re-clamp. |
| Foldable unfolding | Screen dimensions genuinely change. Accept the stale row rather than rebuilding, and let the ladder adapt. |
| Very tall, narrow viewport | Check the composition, not the performance. Fill cost is low; framing is what breaks. |

#### Whole-pass declines

A shadow map, a planar reflection, ambient occlusion and a post chain are each a
**full scene traversal** or a **full-screen resolve**, not a small extra. A scene
with all of them draws its geometry three times a frame and hands the result to a
chain that resolves it through its own targets before anything reads it.

Declining one while keeping the others buys a fraction of a pass and still pays
every setup cost. Decline them as a group:

```
phone: {
  shadowMap: null,    // no second traversal from the light
  ao: null,           // no depth-normal pass
  reflection: null,   // no third traversal for a planar reflection
  bloom: false,
  skyNoise: false,    // five octaves of noise per pixel over the largest surface
  touch: false,       // see below
}
```

**Declining must remove the object, not configure it to zero.** If the post chain
object exists at all it resolves the scene into its own render targets before
anything reads them. The saving is those targets and that resolve, not the two
effects.

```
if (settings.ao || settings.bloom) post = new PostProcessing(renderer)
...
if (!post) renderer.render(scene, camera)
else      post.render()
```

**A declined interaction tier removes its whole hierarchy.** When a row sets
`touch: false`, the scene should not merely ignore taps. It should skip:

- collecting pickable surfaces at build time,
- the CPU copies of alpha maps the picker samples,
- the spatial index over static geometry used for occlusion,
- the custom vertex stage wrapped around every deformable material - that is
  *simpler compiled shaders*, not only skipped work,
- and the API methods themselves, so the page's gesture installer feature-detects
  their absence and never attaches its own logic.

That last point is the seam that makes the rest safe: the page tests
`typeof api.pickInstance === "function"`, so removing the method removes the
feature end to end with no second flag to keep in sync.

**Hold the group together with a test.** It is easy to re-enable one of these
while debugging and leave it on:

```
for (row of tiers) {
  declined = [row.shadowMap, row.ao, row.reflection].filter(isNullish).length
  assert(declined === 0 || declined === 3)                 // all or nothing
  assert((declined === 3) === (row.bloom === false))        // and the flags agree
}
```

#### Cost curves: know the exponent

Before you change a knob, know what it multiplies. Getting this wrong is how a
"20% cut" changes nothing, or removes 90% of a feature.

| Knob shape | Curve | Example |
| --- | --- | --- |
| A count | linear | instances in a layer, detail parts per object |
| A grid resolution | quadratic | a ground or heightfield grid's columns x rows |
| A mesh resolution in two axes | quadratic | a surface's radial x vertical segments |
| A **spacing** between scattered placements | **inverse square** per surface | instances covering one surface |
| The same spacing across many surfaces | inverse square, summed over surfaces | a scatter layer covering a whole scene |
| A texture edge | quadratic in memory and fill | 512 -> 256 is a 4x cut |
| A ray-march step count | linear in a bake, per-pixel in a shader | a volumetric bake's steps |

**Spacing is the one people misjudge, because it is a squared term rather than a
linear trim.** A scatter knob that divides both the row pitch and the column
pitch of a placement grid moves the population as `1 / spacing^2`. So doubling
the spacing does not halve the count, it quarters it.

Worked example from the reference implementation, whose scatter spacing did
exactly that: **1.3 gave one surface about 92,000 instances; 2.6 gave it about
23,000** - a factor of four for a factor of two in spacing, which is the
signature of the inverse square. Going from 1.3 to 1.8 is therefore a **48%**
cut, not the 38% a linear reading suggests.

Be careful reading an exponent off someone's notes, including your own. The
project this example comes from describes the same knob as a *fourth* power in
its own guidance, while its code divides only two axes and its own cited numbers
show the square. A fourth power would have predicted 5,750 instances at spacing
2.6, not 23,000. Derive the exponent from the placement loop, not from prose.

**Count before choosing a value.** Procedural generation is usually pure
arithmetic with no renderer and no canvas, so it runs under a plain JS runtime:

```
# a population sweep takes seconds; a headless render takes minutes
for s in 1.0 1.3 1.8 2.6; do
  node -e "import('./generateSurface.js').then(({generateSurface}) =>
    console.log($s, generateSurface({ scatterSpacing: $s }).instanceCount))"
done
```

Also know the floor. Below some value a knob stops being a quality setting and
becomes a defect. In the reference implementation a surface's angular resolution
could not fall below about 60 segments without its silhouette visibly serrating,
because a surface-detail noise frequency was derived from that same number. The
cut went into the vertical resolution instead, which had no such floor. Find each
knob's floor before you write its lowest row.

**Phone rows are not scaled-down tablet rows.** At a pixel ratio of 1 a phone
draws roughly 390x844 device pixels. Much of what a desktop row spends its budget
on is sub-pixel at that resolution - tens of thousands of distant billboards,
high-triangle small props, thousands of individually placed repeated pieces.
Choose the lowest row's cuts by *what survives that resolution*, not by
multiplying every number by a constant. Ask of each knob: at this pixel count,
would a reader see the difference at all?

#### Derived constants must follow their knob

When a shader or builder hard-codes a number that was correct for one knob value,
changing the knob silently breaks it.

Real example: a distant-impostor material sampled a coarse mip of its own texture
for macro luminance, at a level hard-coded to 4. That was right for the 512-pixel
map every row had, giving a 32x32 footprint. One row then asked for 256, where
level 4 is 16x16 - the wrong footprint, and nothing failed loudly. The fix:

```
broadLevel = max(0, round(log2(impostor.size)) - 5)   // always a 32x32 footprint
```

Before promoting a constant to a tier knob, grep for everything downstream that
assumed its old value. Then pin the relationship in a test that reads the offset
out of the source, so it cannot drift:

```
offset = /Math\.log2\(impostor\.size\)\)\s*-\s*(\d+)/.exec(source)[1]
assert(Number(offset) === 5)
```

#### Distance LOD

##### Impostors

Far geometry becomes camera-facing textured cards. Paint the card textures
procedurally at build time - several view variants so the field does not read as
one repeated object.

```
cards = variants.map(v => paintImpostorView(v, size))   // cooperative
```

Blend the material toward a flatter, compressed response with distance, so cards
do not read as cut-outs at range:

```
distanceBlend = smoothstep(95, 260, -viewZ)
compression   = mix(0.12, 0.48, distanceBlend)
```

##### Batch by variant and sector, not by source object

One instanced batch per source object gives thousands of pipeline builds. One
batch for the whole world gives a bounding volume that never culls.

```
key = `${spatialSector(x, z)}-${viewVariant}`
```

Batch count becomes `sectors x variants` - bounded and small - while each sector's
bounds still cull independently when the camera turns.

##### Layer LOD

Give the nearest instances a second, cheaper card and everything else one. Gate
that on a tier knob so lower rows never pay for it:

```
layers = (tier.impostor.layers > 1 && isNearBand(item)) ? 2 : 1
```

##### Selective structural detail

Not every object needs the expensive treatment. Name the ones that carry the
silhouette and give only those the extra relief pass. The rest get cheap
per-vertex noise. This is LOD by importance rather than by distance, and it is
often the larger win.

##### Skip a pass when its subject leaves the frustum

A planar reflection is only useful while its surface is in view:

```
reflectiveSurface.visible = progress < 0.83   // behind the camera past this point
```

That is a whole pass removed for a third of the scroll, for one line.

#### Culling that survives GPU-side deformation

If a vertex stage displaces geometry - wind, a touch response, a swinging
pendulum - the CPU-side bounds no longer describe what is drawn, and the renderer
culls objects that are still visible.

Two fixes, both cheap:

**Pad the bounds** by the maximum displacement the shader can produce:

```
mesh.boundingSphere.radius += MAX_TOUCH_DISPLACEMENT   // e.g. 1.05 world units
```

**Bound about the pivot** for anything that rotates. A sphere centred on the
fixed attachment point, with a radius covering the whole assembly at full
deflection, covers every possible motion without any per-frame bounds scan.

Never recompute bounds per frame over a large instance buffer. That is a full CPU
scan of data you moved to the GPU precisely to avoid scanning.

#### A worked tier table

From the production scene, for calibration. Your knobs will be different; the
*shape* is the transferable part - whole-pass flags at the top, then counts,
then resolutions.

| knob | full | reduced | light | phone |
| --- | --- | --- | --- | --- |
| `quality` (legacy scalar) | 1 | .6 | .3 | .12 |
| `minPixelRatio` | 1.5 | 1 | 1 | 1 |
| `maxPixelRatio` | 2 | 1.5 | 1 | 1 |
| `shadowMap` | 2048 | 1024 | 512 | **null** |
| `ao` ladder | [16, 8, 6] | [8, 6, 4] | [4, 3, 2] | **null** |
| `reflection` ladder | [.5, .35, .25] | [.3, .23, .18] | [.2, .16, .12] | **null** |
| `bloom` | true | true | true | **false** |
| `touch` | true | true | true | **false** |
| `skyNoise` | true | true | true | **false** |
| `surface.radialSegments` | 128 | 80 | 56 | 56 |
| `surface.levels` | 96 | 56 | 40 | 28 |
| `nearDetailObjects` | 96 | 32 | 16 | 0 |
| `partsPerObject` | 3200 | 1200 | 500 | 0 |
| `scatterSpacing` | 1 | 1.3 | 1.3 | 1.8 |
| `prop.segments` / `.subdivisions` | 6 / 17 | 5 / 17 | 5 / 17 | 3 / 8 |
| `ground.columns` x `rows` | 300 x 144 | 300 x 144 | 300 x 144 | 150 x 72 |
| `architecture` detail | 1 | .65 | .65 | .4 |
| `impostor.size` / `variants` / `layers` | 512 / 4 / 2 | 512 / 4 / 1 | 512 / 4 / 1 | 256 / 2 / 1 |
| `cloud` bake | 512x320, 48 steps | 256x160, 32 steps | **null** | **null** |

Notes worth carrying over:

- `surface.radialSegments` holds at 56 for both bottom rows because of the floor
  described above. The cut went into `levels`.
- `cloud: null` on the two lowest rows is a decision, not an omission: the
  volumetric bake was the most expensive discrete step in the whole build, and
  the analytic sky already drew clouds without it.
- One row once asked for 24 ray steps against a baker that accepts 32 to 48. It
  threw a `RangeError` the caller caught as "fall back to analytic clouds", so
  that row **never baked once** and nobody noticed for months. Validate every
  row's values against the ranges its builders accept, in a test that reads the
  limits out of the builder source.

##### Test the ladder itself

```
for (knob of everyKnob) {
  values = TIER_ORDER.map(name => read(TIERS[name], knob))
  assert(monotonic(values))          // never increases down the ladder
}
// spacing-style knobs are inverted: assert monotonic in the other direction
```

This catches the commonest tier bug: an edit to one row that makes the "light"
build heavier than the "reduced" one.

---
