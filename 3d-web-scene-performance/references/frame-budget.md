# The frame budget

Holding 60 fps, measuring it honestly, and spending the budget where it shows.


#### The metric

`requestAnimationFrame` fires at display rate whether or not the GPU has finished
anything. On a modern async backend the driver queues work and returns
immediately, so a RAF-based counter reports 60 fps on a device that is drawing 22
and accumulating latency.

Track two rates and adapt on the lower:

```
onSubmit:
  submittedAt = now()
  inFlight += 1
  renderer.waitForGPU().then(() => {
    inFlight -= 1
    if (generation !== currentGeneration) return       // a reset happened while we waited
    completedFrames += 1
    latency = now() - submittedAt
    gpuLatency = gpuLatency ? gpuLatency * 0.85 + latency * 0.15 : latency
  })

everySamplingWindow:                                    # ~1800 ms, and only with >10 frames
  rafFps       = 1000 / (frameSum / frames)
  completedFps = completedFrames * 1000 / (now - sampleStart)
  rate         = min(rafFps, completedFps)              # the honest number
```

The exponential moving average on GPU latency matters as much as the rate. A
device can complete 60 frames a second while each one takes 40 ms from submission
to completion - that is a queue, and it is felt as input lag long before the frame
counter moves.

If your engine has no completion promise, approximate it with a GPU timestamp
query, or with the resolution of a fence. Do not fall back to counting callbacks.

##### Aggregated pass timings are not per-frame timings

GPU timestamp APIs often report totals per pass across a window. Dividing that by
frames is not frame time, and comparing it to 16.7 ms is meaningless. In the scene
this came from, an early "22 ms GPU frame" reading turned out to be summed pass
totals; the real submission-to-completion latency was about 8 ms.

#### Backpressure

Two bounds, both required:

**Frames in flight.** Never submit while two are unfinished.

```
if (inFlight >= 2) return          // skip this frame's submission entirely
```

Note what still runs above that line: the camera is placed every frame, because
DOM overlays and picking need current matrices. Only the lighting update and the
submission are skipped.

**Messages in flight**, when the renderer lives in a worker. Allow one outstanding
update. Coalesce newer state over older, and **accumulate the skipped time delta
rather than dropping it**, or every animation clock in the scene runs slow under
load:

```
update(state):
  skipped = pending?.delta ?? 0
  pending = state
  pending.delta = clamp(skipped + state.delta, 0, 0.05)   // cap one catch-up step
  flush()

flush():
  if (!pending || outstanding) return
  outstanding = ++seq
  post({ type: "update", seq, state: pending })
  pending = null

onFrameAck(seq):                    # worker posts this after each render
  if (seq === outstanding) outstanding = null
  flush()
```

**Reject stale input.** Pointer events carry a timestamp; the worker drops any
older than about 350 ms. A backlogged queue must not act on where the finger was
half a second ago.

#### The adaptive ladder

Keep the authored scene intact. Spend the frame budget on buffer resolution and
sample counts, in a fixed order, one step per sampling window.

**Derive the thresholds from the display, not from 60.** Many phones, tablets
and monitors run at 90, 120 or 144 Hz. Hard-coding 58 there downgrades a device
that is running perfectly, because it is comfortably above 58 and nowhere near
its own target. Measure the refresh rate once and scale:

```
# measure: the shortest stable interval RAF delivers over ~20 idle frames
refreshHz = round(1000 / medianFrameInterval)        # 60, 90, 120, ...
DOWN      = refreshHz * 0.967                        # 58 at 60 Hz
UP        = refreshHz * 0.975                        # 58.5 at 60 Hz
```

The two thresholds bracket the target asymmetrically rather than sitting either
side of a midpoint, because a display cannot report more than its own refresh
rate - there is no headroom above to measure, only below.

```
if (rate < DOWN) {
  if      (ratio > 1)          ratio -= (rate < 40 ? 0.3 : 0.15)   # big step when badly behind
  else if (quality < 1)        setQuality(1)
  else if (ratio > 0.85)       ratio = 0.85
  else if (quality < 2)        setQuality(2)
  recoveryAfter = now + 20000
  changed = true
}
else if (goodWindows >= 6) {          # recovery, exact reverse order
  if      (quality > 0)        setQuality(quality - 1)
  else if (ratio < maxRatio)   ratio += 0.1
  changed = true
}

if (changed) { renderer.setPixelRatio(ratio); goodWindows = 0; settleUntil = now + 2500 }
```

`setQuality(level)` indexes the device row rather than branching on device again:

```
setQuality(level):
  ao.resolutionScale   = [0.5, 0.4, 0.33][level]
  ao.samples           = tier.ao[level]
  reflection.scale     = tier.reflection[level]
```

Resolution is spent before effect quality, and it is spent twice - down to 1x,
then down to 0.85x - before the second effect step. That order comes from what a
reader notices: a slightly softer frame reads as fine; losing contact shading
reads as flat.

Also clamp the top:

```
maxRatio = clamp(devicePixelRatio, tier.minPixelRatio, tier.maxPixelRatio)
```

Only a desktop row should supersample above its own device ratio. `minPixelRatio:
1.5` on the full row keeps fine edges crisp on a 1x display; on a phone at ratio 3
it would be suicide.

#### Hysteresis, and why each constant exists

| Constant | Value used | Why |
| --- | --- | --- |
| Sampling window | 1800 ms, min 10 frames | Short enough to react, long enough that one hitch is not a trend |
| Downgrade threshold | `rate < refreshHz * 0.967` (58 at 60 Hz) | Just under target, so a healthy device never trips |
| Upgrade threshold | `rate >= refreshHz * 0.975` (58.5 at 60 Hz) | A display cannot report above its own refresh rate, so the pair brackets the target from below rather than symmetrically |
| GPU latency gate on recovery | `< 24 ms` | A device can hit the rate while queueing; do not restore detail into a queue |
| Recovery cooldown | 20 s after any downgrade | Stops a borderline device oscillating every two windows |
| Sustained good windows | 6 (about 11 s) | One good window is a camera pointing at the sky |
| Settle after any change | 2.5 s | The change itself costs a frame or two; do not measure that |
| Startup grace | 5 s, re-armed when the build finishes | Never adapt to load-time hitching |

The asymmetry is the point: **drop fast, recover slowly**. A reader forgives a
slightly softer frame. Nobody forgives a scene that pulses between two quality
levels every ten seconds.

#### What must never be resized live

**Shadow map dimensions.** Reallocating the shadow attachment while rendering
produced persistent black output on a WebGPU backend - no console error, normal
frame counts, a black canvas. Size it once from the device row and never touch it.
Render-target scale for AO, reflections and the canvas itself all passed the same
stress test; only the shadow attachment failed.

More generally, live-resizing anything with a depth attachment bound across
passes is a place to be suspicious. Test it deliberately by forcing the ladder up
and down under load and watching for a frame that never recovers.

**Anything that changes a pipeline.** Swapping a material, toggling a define, or
changing a vertex layout at runtime is a compile, and compiles happen on a thread
you care about.

#### Renderer construction flags

A few choices made once, at construction, outweigh a lot of per-frame tuning.

```
renderer = new Renderer({
  canvas,
  antialias: true,
  alpha: false,                        // an opaque canvas skips a compositing blend
  powerPreference: "high-performance", // see below
})
```

**`powerPreference: "high-performance"`** is the one people miss. On a laptop
with both an integrated and a discrete GPU, the default hint can land you on the
integrated one, which may be several times slower for the same scene. The cost is
battery, so it is the right request for a scene that is the page's subject and
the wrong one for a small decorative widget. Some engines expose this on their own
constructor; with raw WebGPU it is on the adapter request.

**`alpha: false`** where you do not need to composite page content through the
canvas. An opaque surface lets the compositor skip a blend over the whole canvas
area every frame.

### Pass economics

Count traversals before triangles.

| Configuration | Scene traversals per frame |
| --- | --- |
| Colour only, no post | 1 |
| Plus shadow map | 2 |
| Plus planar reflection | 3 |
| Plus post chain | 3, then full-screen resolves through its own targets |
| Plus AO with a depth-normal prepass | 4 |

A 30% triangle cut on a four-traversal scene is worth less than removing one
traversal. That is why the phone row in [Device tiers, LOD and cost curves](device-tiers.md#device-tiers-lod-and-cost-curves) declines four things at
once rather than halving geometry.

Cheap wins in this class:

- Hide a reflection's surface when it leaves the frustum.
- Cast shadows from far fewer objects than you draw. Cap the shadow-caster set
  explicitly; do not let it follow the visible set.
- **Anti-alias procedural detail analytically instead of supersampling it.** Fine
  procedural patterns - anything built from noise or summed waves - shimmer when
  their wavelength drops below a pixel, and the usual reflex is to raise the
  resolution or add a post AA pass, both of which cost a whole frame's fill. It
  is far cheaper to suppress the detail in the shader as it approaches pixel
  size, using the derivative of the pattern's own argument:

  ```
  // fwidth(angle) is roughly how much `angle` changes across one pixel
  contribution = sin(angle) * amplitude / (1 + pow(fwidth(angle), 2))
  ```

  Each octave fades itself out exactly where it would start to alias, at the cost
  of two derivative instructions. Apply it per octave, not to the sum.

- Fade contact shading out with distance rather than computing it everywhere.
  Applying tiny AO contacts at long range both costs fill and looks wrong - it
  stamps fine geometry onto translucent geometry behind it:

  ```
  contactWeight = (1 - smoothstep(65, 140, -viewZ)) * 0.32
  colour = colour * mix(1, occlusion, contactWeight)
  ```

#### Pipeline build economics

JavaScript-side shader assembly was the single largest startup cost in the scene
this skill came from - larger than geometry generation, larger than texture
painting.

The mechanism, in Three r180 and engines that behave like it: **every instanced
mesh's uuid is part of the render cache key**, so each instanced mesh assembles
its own node shaders in every pass - main, shadow, depth-normal, preview. Plain
meshes that share a material and attribute layout share one build.

So:

```
place(geometry, material, transform):
  key = `${geometry.id}:${material.id}`
  batch = batches.get(key) ?? create(key, {
    instanced: geometry.vertexCount > MERGED_DETAIL_VERTEX_LIMIT      // 256 worked well
  })
  batch.transforms.push(transform)
  batch.tints.push(perPieceVariation())
```

At publish time, split each batch:

- **Baked** - under the vertex limit and static. Flatten every instance's
  positions and normals through its matrix into one buffer per material, and
  write the per-piece tint into a `color` vertex attribute. Enable `vertexColors`
  on the material. One shader build now covers thousands of pieces, and they still
  look individually varied.
- **Instanced** - over the vertex limit, or moving independently.

Thousands of 14-vertex repeated pieces collapse into one plain mesh. A handful of
heavy detailed props and the moving parts stay instanced. The CPU cost is the
flattening at publish time, which is bounded, cooperative and happens once.

Before adding instanced batches split by zone, stage or variant, ask whether a
shared plain mesh or fewer batches would draw the same thing.

##### Precompile before you show

Compile the pipelines a stage needs *before* the frame that needs them, so no
frame is the one that stalls on a compile:

```
await renderer.compileAsync(scene, camera)
renderOneFrame()
await renderer.waitForGPU()
```

##### Keep the light count stable

Adding a light mid-build invalidates shader variants for every material that reads
lighting. Allocate the lights the finished scene will have at the start, at zero
intensity, and raise them as their stage publishes.

#### Per-frame allocation

- No object creation in the frame loop. Preallocate vectors, matrices, quaternions
  and colours at build time and reuse them.
- No full instance scans. If you need per-instance state per frame, keep it in a
  typed array and touch only the indices that changed.
- Do not recompute bounding volumes per frame. See "culling that survives GPU-side
  deformation" in [Device tiers, LOD and cost curves](device-tiers.md#device-tiers-lod-and-cost-curves).
- Sort once, not every frame. If a sort is genuinely needed during startup, yield
  through it (see [Startup: time to first render](startup.md#startup-time-to-first-render)).
- **Look for an algebraic shortcut before paying for a general operation.** A
  vertex stage that needs to move a world-space vector into an instance's local
  space appears to need that instance's inverse matrix - which means computing and
  uploading one per instance, or inverting per vertex. But an instance transform
  built only from translation, rotation and scale has orthogonal basis columns, so
  the inverse of its linear part is three projections:

  ```
  x = instanceMatrix[0].xyz; y = instanceMatrix[1].xyz; z = instanceMatrix[2].xyz
  local = vec3(dot(offset, x) / max(dot(x, x), 1e-12),
               dot(offset, y) / max(dot(y, y), 1e-12),
               dot(offset, z) / max(dot(z, z), 1e-12))
  ```

  Nine multiplies instead of a matrix inverse, and no extra per-instance upload.
  The guard on the divisor matters: a zero-scaled axis would otherwise produce a
  NaN that propagates through the whole vertex.

- Gate expensive per-frame branches behind a single uniform test in the shader, so
  an idle feature costs one comparison rather than a world-space transform chain:

  ```
  If(activeCount.greaterThan(0), () => { ...the whole displacement field... })
  ```

#### Visibility and timing reset

Pause on two independent signals, because they mean different things:

- `document.visibilitychange` - the tab is backgrounded.
- An `IntersectionObserver` on the scene container - the reader scrolled past it.

```
sync = () => (document.hidden || !onScreen) ? pause() : resume()
```

On pause, **cancel the pending animation frame synchronously**. A hidden tab can
suspend a scheduled callback without ever invoking it, and a stale handle makes
`resume()` believe a frame is already queued.

On resume:

1. Re-baseline the delta clock (`previous = now()`), so the first frame after a
   ten-minute pause does not carry a ten-minute delta into the physics.
2. Reset the sampling counters and bump a generation number, so a completion
   callback that resolves after the pause cannot contaminate fresh statistics.
3. Reset transient interaction state - active deformations, hover cooldowns - and
   the integration remainder of any physics. Keep positions and angles: a
   mid-swing object should resume, not snap upright.

Never fast-forward the animation clock to account for background time.

#### Theme and state transitions

Bake the endpoints, interpolate one scalar.

- Anything expensive - volumetric bakes, radiance probes, per-variant textures -
  is computed once for each end state at build time. In the reference scene that
  was 8 raymarched textures total for the life of the scene, at that scene's
chosen bake resolution.
- Every frame, the transition is colour lerps, transform lerps and a shader mix
  against a single eased value. A day/night toggle then costs nothing measurable
  and reverses smoothly mid-flight.
- Mix transparent art in **premultiplied** space, or edges pick up a dark outline
  halfway through:

  ```
  alpha = mix(a.a, b.a, t)
  rgb   = mix(a.rgb * a.a, b.rgb * b.a, t) / max(alpha, epsilon)
  ```

- Warp the blend so it is zero at both ends (`t * (1 - t)` shaping) if the two
  states differ in layout as well as colour. That keeps the endpoints exact.

---
