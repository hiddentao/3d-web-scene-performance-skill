# Device tiers, LOD and cost curves

How to choose what each device gets, and how to know what a setting costs before
you change it.


#### Keep device settings in one table

Put every decision about device class in one object. It has one row per build and
one key per knob, and the builders read it. No other code asks "is this a phone".

A knob is one setting that the scene builders read, such as a count, a resolution
or an on/off flag. A row is the full set of knob values for one device class (a
tier), and it produces one build of the scene.

```
SCENE_TIERS = {
  full:    { <every knob> },
  reduced: { <every knob> },   // narrow desktop window
  light:   { <every knob> },   // tablets
  phone:   { <every knob> },
}
```

One table prevents three failures:

**Drift.** Six `isMobile ?` branches in six builders will not stay in agreement
through six months of edits. Only one of them will name the tier. The rest become
unwritten knowledge.

**Hidden steps.** A builder that reads a single `quality` scalar as
`quality < 0.75 ? a : b` applies a step, not a multiplier. A row that asks for a
third of the detail then ships the same geometry as a row that asks for half.
Nobody notices, because the number in the config did change.

**Rows one scalar cannot express.** A real device class can need fewer scattered
instances and full surface resolution at the same time, because the surface's
silhouette breaks below a threshold while the scatter degrades gradually. One
scalar cannot express that. A table can.

To give a device class new behaviour, add a knob to the table. Never add a branch
at the call site.

##### Knobs hold real values, not named levels

`nearDetailObjects: 96` and `nearDetailObjects: 0` are easy to read and test.
`detailLevel: "medium"` is not, because each builder then decides for itself what
"medium" means.

A knob set to `null` or `false` means the pass does not exist, and the code must
treat it that way. See [Turn expensive passes fully off](#turn-expensive-passes-fully-off).

##### Ladder knobs

Some knobs need one value per runtime quality level. The frame controller (the
code that changes quality while the scene runs) can then read the row by level
index, and does not branch on device a second time:

```
ao:         [16, 8, 6],       // sample count at quality level 0 / 1 / 2
reflection: [.5, .35, .25],   // reflection target scale at each level
```

#### Choosing the row

Choose the row on the thread where the signals exist. A worker has no
`matchMedia` and no `screen`. It sees only a viewport width. A phone held sideways
reports a width of about 988 CSS pixels, so a width test gives it the full desktop
build.

Send the chosen row name to the worker in the init message. The worker passes it
on and never works it out again.

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

Use two signals. Both describe what the device is, not what it claims:

- `pointer: coarse` separates hardware that is mainly touch from hardware with a
  mouse or trackpad. It describes the hardware, and browsers report it truthfully.
- `screen.width` and `screen.height` do not change when the device rotates or the
  mobile URL bar shows or hides. Use the smaller edge.

##### Do not probe capability

- `navigator.deviceMemory` exists only in Chromium, and Chrome on Android clamps
  it to 8. A mid-range phone and a workstation report the same number.
- `navigator.hardwareConcurrency` reads 8 on both.
- A WebGL or WebGPU limits query tells you what the device supports. It tells you
  nothing about what will hold 60 fps.

The only reliable capability signal is proof that this device already failed. See
the crash sentinel in [caching and persistence](persistence.md#persistence-caching-retention-and-survival).
The crash sentinel is a storage record that shows an earlier build started and
never finished. Refuse a device the scene only because it crashed before, never
because of what it looks like.

##### Write the function so a test can call it

Give every input a default value when you destructure it. A test can then pass a
landscape phone, a portrait tablet and a narrow desktop window, with no browser at
all:

```
sceneTier({ screenWidth: 844, screenHeight: 390, coarsePointer: true })  // "phone"
sceneTier({ screenWidth: 820, screenHeight: 1180, coarsePointer: true }) // "light"
sceneTier({ width: 480, coarsePointer: false })                          // "reduced"
```

#### Screen size, pixel budget and resize

Device class and screen size are two separate decisions. Treating them as one is a
common mistake. The class decides which build to make. The size decides how many
pixels that build must fill, and that is a separate and larger lever on cost.

##### The pixel budget

Fill cost scales with `cssWidth x cssHeight x pixelRatio^2`. People often forget
the square.

| Surface | CSS size | Effective ratio | Device pixels |
| --- | --- | --- | --- |
| Phone, capped at ratio 1 | 393 x 852 | 1 | 0.33 M |
| The same phone uncapped | 393 x 852 | 3 | 3.01 M |
| Tablet, capped at ratio 1 | 820 x 1180 | 1 | 0.97 M |
| Small laptop window | 1280 x 800 | 1.5 | 2.30 M |
| Laptop, full screen | 1440 x 900 | 2 | 5.18 M |
| 4K panel, 150% OS scaling | 2560 x 1440 | 1.5 | 8.29 M |
| 4K panel, no OS scaling, supersampled | 3840 x 2160 | 1.5 | 18.66 M |

The last two rows are the same physical display. The difference is whether the OS
scales it. At 150% the browser reports 2560x1440 CSS pixels. At 100% it reports
3840x2160. Always say which one you mean. The two differ by more than a factor of
two, and a table row that does not say is easy to misread.

Two conclusions follow from this arithmetic:

- **Capping the pixel ratio is the largest single cut on a phone.** The same build
  at ratio 1 instead of ratio 3 fills nine times fewer pixels. That is why the
  phone row caps the ratio at 1, and why it can then afford geometry it could not
  afford otherwise.
- **One device row can face a three- to eightfold range of pixel counts.** A
  1280 x 800 window and the same machine maximised on a 4K panel both get the
  heaviest row. The 4K panel needs 3.6x the fill of the window if the OS scales
  it, or 8.1x if it does not and the scene supersamples. The row cannot know
  which. Only the adaptive ladder can. The adaptive ladder is the runtime
  controller that lowers quality in steps when the frame rate drops, and render
  resolution is the first thing it lowers. See
  [the adaptive ladder](frame-budget.md#the-adaptive-ladder).

If you render above the device pixel ratio for smoother edges (supersampling),
clamp the ratio tightly. The window size multiplies it, and you cannot know the
window size in advance. `minPixelRatio: 1.5` is reasonable on a 1280-wide window
and far too expensive on a maximised 4K one.

##### Decide the class once; let resolution track the window

```
mount:   tier = sceneTier(...)        // once, from screen geometry and pointer type
resize:  renderer.resize(w, h)        // every time, plus re-read layout-derived values
         // the tier is NOT re-derived
```

Do not choose the class again on resize, for three reasons:

- `screen.width` and `screen.height` do not change when the window is resized,
  when the URL bar hides, or when the device rotates. The input to the decision
  has not changed, so running it again either does nothing or causes a bug.
- Changing the row during a session means rebuilding the scene with different
  geometry densities, passes and materials. That takes seconds and visibly
  interrupts the scene, for a quality change the visitor did not ask for.
- The adaptive ladder already handles the case that matters. A window dragged onto
  a 4K panel gets more pixels. The ladder sees the frame rate drop and lowers the
  resolution, with no rebuild.

The one input that does change is `window.innerWidth`, which selects the
narrow-desktop row. Read it at mount. A visitor who resizes across that boundary
keeps the row they started with. Accept that trade: resizing across it is rare, and
a rebuild is worse than a slightly wrong row.

##### What must still react to resize

- The renderer's drawing-buffer size and the camera aspect.
- Every value that comes from layout: scroll beat positions (the scroll points
  where each section of content sits), element bounds and projected overlay
  anchors. Recompute these from a `ResizeObserver`, never per frame. See
  [reading layout on layout events](interaction.md#reading-layout-on-layout-events).
- The camera's field of view, if the composition needs a different one in
  portrait. A fixed horizontal FOV crops badly on a tall viewport.
- Anything sized in device pixels, such as offscreen target dimensions. The
  exceptions are the targets listed in
  [what must never be resized live](frame-budget.md#what-must-never-be-resized-live).

##### Cases to check

| Case | What to check |
| --- | --- |
| Phone rotated to landscape | The smaller screen edge does not change, so the row does not change. Composition and FOV must still work. |
| Tablet rotated | Same as the phone. A viewport-width test would change the row here. The screen-edge test avoids that bug. |
| Browser zoom | Changes `devicePixelRatio` and the CSS viewport together. Apply the ratio clamp to the current value, not to one captured at mount. |
| Split screen or a resized window | Layout values change. The row does not. |
| External monitor, different DPR | The ratio changes while the scene runs. Read it again on resize and clamp it again. |
| Foldable unfolding | The screen dimensions really do change. Keep the old row instead of rebuilding, and let the ladder adapt. |
| Very tall, narrow viewport | Check the composition, not the performance. Fill cost is low, but the framing breaks. |

#### Turn expensive passes fully off

A shadow map, a planar reflection, ambient occlusion and a post-processing chain
each cost a full scene traversal or a full-screen resolve. None of them is a small
extra. A scene with all of them draws its geometry three times per frame. It then
hands the result to the post chain, which resolves it through its own render
targets before anything reads it.

To decline a pass is to turn it fully off for a row. If you decline one and keep
the others, you save part of a pass and still pay every setup cost. Decline them
as a group:

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

**Declining must remove the object, not set it to zero.** If the post chain object
exists at all, it resolves the scene into its own render targets before anything
reads them. The saving is those targets and that resolve, not the two effects.

```
if (settings.ao || settings.bloom) post = new PostProcessing(renderer)
...
if (!post) renderer.render(scene, camera)
else      post.render()
```

**A declined interaction feature removes all the work under it.** When a row sets
`touch: false`, the scene should do more than ignore taps. It should skip:

- collecting pickable surfaces at build time
- the CPU copies of alpha maps that the picker samples
- the spatial index over static geometry used for occlusion
- the custom vertex stage wrapped around every deformable material, which also
  makes the compiled shaders simpler
- the API methods themselves, so the page's gesture installer detects that they
  are missing and never attaches its own logic.

The last point makes the rest safe. The page tests
`typeof api.pickInstance === "function"`, so removing the method removes the whole
feature, with no second flag to keep in sync.

**Test that the group stays together.** It is easy to turn one of these back on
while debugging and leave it on:

```
for (row of tiers) {
  declined = [row.shadowMap, row.ao, row.reflection].filter(isNullish).length
  assert(declined === 0 || declined === 3)                 // all or nothing
  assert((declined === 3) === (row.bloom === false))        // and the flags agree
}
```

#### Cost curves: know the exponent

Before you change a knob, know what it multiplies. If you get this wrong, a "20%
cut" can change nothing, or remove 90% of a feature.

| Knob shape | Curve | Example |
| --- | --- | --- |
| A count | linear | instances in a layer, detail parts per object |
| A grid resolution | quadratic | a ground or heightfield grid's columns x rows |
| A mesh resolution in two axes | quadratic | a surface's radial x vertical segments |
| A spacing between scattered placements | inverse square per surface | instances covering one surface |
| The same spacing across many surfaces | inverse square, summed over surfaces | a scatter layer covering a whole scene |
| A texture edge | quadratic in memory and fill | 512 -> 256 is a 4x cut |
| A ray-march step count | linear in a bake, per-pixel in a shader | a volumetric bake's steps |

**Spacing is the knob people misjudge.** It is a squared term, not a linear trim.
A scatter knob that divides both the row pitch and the column pitch of a placement
grid changes the population as `1 / spacing^2`. Doubling the spacing cuts the count
to a quarter, not to a half.

In the hezo.ai scene, the scatter spacing worked this way. A spacing of 1.3 gave
one surface about 92,000 instances, and 2.6 gave it about 23,000. Twice the spacing
gave a quarter of the instances, which is the mark of an inverse square. So going
from 1.3 to 1.8 is a 48% cut, not the 38% a linear reading suggests.

Take the exponent from the placement loop, not from written notes, including your
own. That scene's loop divides two axes, and its measured numbers show the square.
A fourth power would have predicted 5,750 instances at spacing 2.6, not 23,000.

**Count before you choose a value.** Procedural generation is usually plain
arithmetic with no renderer and no canvas, so it runs in a plain JS runtime:

```
# a population sweep takes seconds; a headless render takes minutes
for s in 1.0 1.3 1.8 2.6; do
  node -e "import('./generateSurface.js').then(({generateSurface}) =>
    console.log($s, generateSurface({ scatterSpacing: $s }).instanceCount))"
done
```

Also know each knob's floor: the value below which the knob stops being a quality
setting and becomes a defect. In the hezo.ai scene, a surface's angular resolution
could not fall below about 60 segments without visible saw-tooth edges on its
silhouette, because a surface-detail noise frequency was derived from that same
number. The cut went into the vertical resolution instead, which had no such floor.
Find each knob's floor before you write its lowest row.

**Phone rows are not scaled-down tablet rows.** At a pixel ratio of 1, a phone
draws about 390x844 device pixels. At that resolution, much of what a desktop row
spends its budget on is smaller than a pixel: tens of thousands of distant
billboards, small props with high triangle counts, and thousands of repeated pieces
placed one by one. Choose the cuts for the lowest row by what is still visible at
that resolution. Do not multiply every number by a constant. For each knob, ask: at
this pixel count, would a visitor see the difference at all?

#### Derived constants must follow their knob

A shader or builder can hard-code a number that is correct for one knob value. If
you change the knob, that number breaks with no error.

In one real case, a material for distant impostors (flat camera-facing cards that
stand in for far geometry) sampled a coarse mip of its own texture for large-scale
brightness. The mip level was hard-coded to 4. That was right for the 512-pixel map
that every row had, and gave a 32x32 footprint. One row then asked for 256, where
level 4 is 16x16. That is the wrong footprint, and nothing reported an error. The
fix:

```
broadLevel = max(0, round(log2(impostor.size)) - 5)   // always a 32x32 footprint
```

Before you turn a constant into a tier knob, grep for all downstream code that
assumed its old value. Then lock the relationship with a test that reads the offset
out of the source, so it cannot drift:

```
offset = /Math\.log2\(impostor\.size\)\)\s*-\s*(\d+)/.exec(source)[1]
assert(Number(offset) === 5)
```

#### Distance LOD

##### Impostors

Far geometry becomes camera-facing textured cards. Paint the card textures
procedurally at build time, with several view variants so the field does not look
like one object repeated.

```
cards = variants.map(v => paintImpostorView(v, size))   // cooperative
```

As distance grows, blend the material toward a flatter, compressed response, so
far cards do not look like cut-outs:

```
distanceBlend = smoothstep(95, 260, -viewZ)
compression   = mix(0.12, 0.48, distanceBlend)
```

##### Batch by variant and sector, not by source object

One instanced batch per source object gives thousands of pipeline builds. One batch
for the whole world gives a bounding volume that never culls.

```
key = `${spatialSector(x, z)}-${viewVariant}`
```

The batch count becomes `sectors x variants`, which is small and has a fixed upper
limit. Each sector's bounds still cull on their own when the camera turns.

##### Layer LOD

Give the nearest instances a second, cheaper card, and everything else one card.
Control this with a tier knob so lower rows never pay for it:

```
layers = (tier.impostor.layers > 1 && isNearBand(item)) ? 2 : 1
```

##### Selective structural detail

Not every object needs the expensive treatment. Name the objects that carry the
silhouette, and give only those the extra relief pass. The rest get cheap
per-vertex noise. This is LOD by importance instead of by distance, and it often
saves more.

##### Skip a pass when its subject leaves the frustum

A planar reflection is only useful while its surface is in view:

```
reflectiveSurface.visible = progress < 0.83   // behind the camera past this point
```

One line removes a whole pass for a third of the scroll.

#### Culling that survives GPU-side deformation

A vertex stage can move geometry, for example for wind, a touch response or a
swinging pendulum. The CPU-side bounds then no longer describe what is drawn, and
the renderer culls objects that are still visible.

There are two cheap fixes:

**Pad the bounds** by the maximum displacement the shader can produce:

```
mesh.boundingSphere.radius += MAX_TOUCH_DISPLACEMENT   // e.g. 1.05 world units
```

**Bound around the pivot** for anything that rotates. Centre a sphere on the fixed
attachment point, with a radius that covers the whole assembly at full deflection.
That sphere covers every possible motion with no per-frame bounds scan.

Never recompute bounds per frame over a large instance buffer. That is a full CPU
scan of data you moved to the GPU so that you would not have to scan it.

#### A worked tier table

This table comes from the hezo.ai scene, for calibration. Your knobs will differ.
The shape carries over: flags that turn whole passes off at the top, then counts,
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

Notes on the table:

- `surface.radialSegments` stays at 56 in the two lowest rows because of the floor
  described above. The cut went into `levels`.
- `cloud: null` in the two lowest rows is deliberate. The volumetric bake was the
  most expensive single step in the whole build, and the analytic sky already drew
  clouds without it.
- One row once asked for 24 ray steps from a baker that accepts 32 to 48. The baker
  threw a `RangeError`, and the caller caught it as "fall back to analytic clouds".
  So that row never baked at all, and nothing showed the failure. Validate every
  row's values against the ranges its builders accept, in a test that reads the
  limits out of the builder source.

##### Test the row order

The rows form a ladder, from the heaviest build to the lightest. Test that order:

```
for (knob of everyKnob) {
  values = TIER_ORDER.map(name => read(TIERS[name], knob))
  assert(monotonic(values))          // never increases down the ladder
}
// spacing-style knobs are inverted: assert monotonic in the other direction
```

This catches the most common tier bug: an edit to one row that makes the "light"
build heavier than the "reduced" one.

---
