# The frame budget

How to hold 60 fps, measure the frame rate correctly, and spend the frame budget
(the time each frame can take) where it shows.


#### What to measure

`requestAnimationFrame` fires at the display rate, even when the GPU has not
finished any work. On a modern async backend, the driver queues work and returns
at once. A counter based on RAF can then report 60 fps on a device that draws 22
frames a second while its latency builds up.

Track two rates and adapt to the lower one:

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

The exponential moving average of GPU latency matters as much as the rate. A
device can complete 60 frames a second while each frame takes 40 ms from
submission to completion. That is a queue. Users feel it as input lag long before
the frame counter changes.

If your engine has no completion promise, approximate one with a GPU timestamp
query or with the resolution of a fence. Do not fall back to counting callbacks.

##### Summed pass timings are not frame times

GPU timestamp APIs often report a total for each pass over a time window. That
total divided by the frame count is not a frame time, so do not compare it with
16.7 ms. In the hezo.ai scene, an early reading of a "22 ms GPU frame" was the sum
of the pass totals. The real latency from submission to completion was about 8 ms.

#### Backpressure

Apply both of these limits.

**Frames in flight.** Do not submit a frame while two frames are still unfinished.

```
if (inFlight >= 2) return          // skip this frame's submission entirely
```

The code above that check still runs. The camera is placed every frame, because
DOM overlays and picking need current matrices. Only the lighting update and the
submission are skipped.

**Messages in flight.** When the renderer runs in a worker, allow one outstanding
update message. Merge newer state over older state. Add the time delta of each
skipped update to the next update instead of dropping it, or every animation clock
in the scene runs slow under load:

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

**Reject stale input.** Pointer events carry a timestamp. The worker drops any
event older than about 350 ms. A backed-up queue must not act on where the finger
was half a second ago.

#### The adaptive ladder

The adaptive ladder is a fixed sequence of quality steps. When the frame rate is
too low, the renderer moves down one step per sampling window. When the rate
recovers, it moves back up. Keep the authored scene intact: the steps change only
buffer resolution and sample counts, in a fixed order.

**Derive the thresholds from the display, not from 60.** Many phones, tablets and
monitors run at 90, 120 or 144 Hz. A hard-coded 58 compares such a device with the
wrong target: it can run comfortably above 58 and still be nowhere near its own
target. Measure the refresh rate once and scale the thresholds:

```
# measure: the shortest stable interval RAF delivers over ~20 idle frames
refreshHz = round(1000 / medianFrameInterval)        # 60, 90, 120, ...
DOWN      = refreshHz * 0.967                        # 58 at 60 Hz
UP        = refreshHz * 0.975                        # 58.5 at 60 Hz
```

Both thresholds sit just below the target, not on either side of it. A display
cannot report more than its own refresh rate, so there is no headroom to measure
above the target, only below it.

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

`setQuality(level)` reads its values from the device row (the settings for this
type of device in the device settings table). It does not check the device type
again:

```
setQuality(level):
  ao.resolutionScale   = [0.5, 0.4, 0.33][level]
  ao.samples           = tier.ao[level]
  reflection.scale     = tier.reflection[level]
```

The ladder lowers resolution before effect quality. It lowers resolution twice,
first to 1x and then to 0.85x, before the second effect step. The order follows
what a reader notices. A slightly softer frame still looks fine. A frame without
contact shading looks flat.

Also clamp the upper end:

```
maxRatio = clamp(devicePixelRatio, tier.minPixelRatio, tier.maxPixelRatio)
```

Only a desktop row should supersample above the device's own pixel ratio.
`minPixelRatio: 1.5` on the full (desktop) row keeps fine edges sharp on a 1x
display. On a phone at ratio 3, the same setting would cost far too much.

#### Hysteresis constants

| Constant | Value used | Why |
| --- | --- | --- |
| Sampling window | 1800 ms, min 10 frames | Short enough to react. Long enough that one hitch does not count as a trend |
| Downgrade threshold | `rate < refreshHz * 0.967` (58 at 60 Hz) | Just under the target, so a healthy device never triggers it |
| Upgrade threshold | `rate >= refreshHz * 0.975` (58.5 at 60 Hz) | A display cannot report above its own refresh rate, so both thresholds sit below the target |
| GPU latency gate on recovery | `< 24 ms` | A device can reach the rate while frames queue up. Do not add detail back while there is a queue |
| Recovery cooldown | 20 s after any downgrade | Stops a borderline device from switching quality every two windows |
| Sustained good windows | 6 (about 11 s) | One good window can come from a camera pointing at the sky |
| Settle after any change | 2.5 s | The change itself costs a frame or two. Do not measure those frames |
| Startup grace | 5 s, re-armed when the build finishes | Never adapt to hitches during loading |

The constants follow one rule: **drop fast, recover slowly**. Readers accept a
slightly softer frame. They do not accept a scene that switches between two
quality levels every ten seconds.

#### What must never be resized live

**Shadow map dimensions.** On a WebGPU backend, reallocating the shadow attachment
while rendering made the canvas stay black. There was no console error, and frame
counts were normal. Set the size once from the device row and do not change it.
Render-target scale for AO, for reflections and for the canvas itself passed the
same stress test. Only the shadow attachment failed.

Treat any live resize of a depth attachment that is bound across passes as
suspect. Test it on purpose: force the ladder up and down under load, and watch
for a frame that never recovers.

**Anything that changes a pipeline.** At runtime, swapping a material, toggling a
define or changing a vertex layout causes a compile. Compiles run on a thread you
care about.

#### Renderer construction flags

A few flags set once, when you construct the renderer, matter more than a lot of
per-frame tuning.

```
renderer = new Renderer({
  canvas,
  antialias: true,
  alpha: false,                        // an opaque canvas skips a compositing blend
  powerPreference: "high-performance", // see below
})
```

**`powerPreference: "high-performance"`** is the flag people often miss. On a
laptop with an integrated and a discrete GPU, the default hint can select the
integrated GPU. That GPU may be several times slower for the same scene. The cost
is battery use. Request it when the scene is the page's subject. Do not request
it for a small decorative widget. Some engines expose this flag on their own
constructor. With raw WebGPU, it is part of the adapter request.

**`alpha: false`** suits a canvas that does not need page content composited
through it. An opaque surface lets the compositor skip a blend over the whole
canvas area every frame.

### Pass costs

Count scene traversals (each full render of the scene's objects in a frame) before
you count triangles.

| Configuration | Scene traversals per frame |
| --- | --- |
| Colour only, no post | 1 |
| Plus shadow map | 2 |
| Plus planar reflection | 3 |
| Plus post chain | 3, then full-screen resolves through its own targets |
| Plus AO with a depth-normal prepass | 4 |

On a scene with four traversals, removing one traversal saves more than a 30%
triangle cut. For that reason the phone row in
[device tiers](device-tiers.md#device-tiers-lod-and-cost-curves) turns off four
things at once instead of halving geometry.

Cheap savings of this kind:

- Hide a reflection's surface when it leaves the frustum.
- Cast shadows from far fewer objects than you draw. Set an explicit cap on the
  shadow casters. Do not let the set of casters follow the set of visible objects.
- **Anti-alias procedural detail analytically instead of supersampling it.** Fine
  procedural patterns, such as anything built from noise or summed waves, shimmer
  when their wavelength drops below a pixel. The usual fix is to raise the
  resolution or add a post AA pass. Both cost a whole frame's fill. It is far
  cheaper to fade the detail out in the shader as it approaches pixel size. Use
  the derivative of the pattern's own argument:

  ```
  // fwidth(angle) is roughly how much `angle` changes across one pixel
  contribution = sin(angle) * amplitude / (1 + pow(fwidth(angle), 2))
  ```

  Each octave fades out exactly where it would start to alias. The cost is two
  derivative instructions. Apply it to each octave, not to the sum.

- Fade contact shading out with distance. Tiny AO contacts at long range cost fill
  and look wrong, because they stamp fine geometry onto the translucent geometry
  behind it:

  ```
  contactWeight = (1 - smoothstep(65, 140, -viewZ)) * 0.32
  colour = colour * mix(1, occlusion, contactWeight)
  ```

#### Pipeline build cost

In the hezo.ai scene, shader assembly in JavaScript was the largest startup cost.
It cost more than geometry generation and more than texture painting.

The cause, in Three r180 and engines that behave like it: every instanced mesh's
uuid is part of the render cache key. So each instanced mesh assembles its own node
shaders in every pass (main, shadow, depth-normal, preview). Plain meshes that
share a material and attribute layout share one build.

So group placements by geometry and material:

```
place(geometry, material, transform):
  key = `${geometry.id}:${material.id}`
  batch = batches.get(key) ?? create(key, {
    instanced: geometry.vertexCount > MERGED_DETAIL_VERTEX_LIMIT      // 256 worked well
  })
  batch.transforms.push(transform)
  batch.tints.push(perPieceVariation())
```

The scene is built in stages. A stage is one part of the scene, and it publishes
(joins the visible scene) when it is complete. At publish time, split each batch:

- **Baked**: under the vertex limit and static. Transform every instance's
  positions and normals by its matrix and flatten them into one buffer per
  material. Write the per-piece tint into a `color` vertex attribute, and enable
  `vertexColors` on the material. One shader build then covers thousands of
  pieces, and each piece still looks different.
- **Instanced**: over the vertex limit, or moving independently.

Thousands of repeated 14-vertex pieces become one plain mesh. A few heavy,
detailed props and the moving parts stay instanced. The CPU cost is the
flattening at publish time. It is bounded, it yields to other work, and it happens
once.

Before you split instanced batches by zone, stage or variant, check whether a
shared plain mesh or fewer batches would draw the same thing.

##### Precompile before you show

Compile the pipelines a stage needs before the frame that uses them, so that no
frame stalls on a compile:

```
await renderer.compileAsync(scene, camera)
renderOneFrame()
await renderer.waitForGPU()
```

##### Keep the light count stable

Adding a light during the build invalidates the shader variants of every material
that reads lighting. At the start, create all the lights the finished scene will
have, at zero intensity. Raise each light when its stage publishes.

#### Per-frame allocation

- Do not create objects in the frame loop. Preallocate vectors, matrices,
  quaternions and colours at build time, and reuse them.
- Do not scan all instances. If you need per-instance state each frame, keep it in
  a typed array and update only the indices that changed.
- Do not recompute bounding volumes each frame. See "culling that survives
  GPU-side deformation" in [device tiers](device-tiers.md#device-tiers-lod-and-cost-curves).
- Sort once, not every frame. If startup really needs a sort, yield during it (see
  [startup](startup.md#startup-time-to-first-render)).
- **Look for an algebraic shortcut before paying for a general operation.** A
  vertex stage that moves a world-space vector into an instance's local space
  seems to need the instance's inverse matrix. That means computing and uploading
  one inverse per instance, or inverting per vertex. But an instance transform
  built only from translation, rotation and scale has orthogonal basis columns. So
  the inverse of its linear part is three projections:

  ```
  x = instanceMatrix[0].xyz; y = instanceMatrix[1].xyz; z = instanceMatrix[2].xyz
  local = vec3(dot(offset, x) / max(dot(x, x), 1e-12),
               dot(offset, y) / max(dot(y, y), 1e-12),
               dot(offset, z) / max(dot(z, z), 1e-12))
  ```

  That is nine multiplies instead of a matrix inverse, with no extra per-instance
  upload. Keep the guard on the divisor. Without it, an axis scaled to zero
  produces a NaN that spreads through the whole vertex.

- Put expensive per-frame branches behind a single uniform test in the shader. An
  idle feature then costs one comparison instead of a chain of world-space
  transforms:

  ```
  If(activeCount.greaterThan(0), () => { ...the whole displacement field... })
  ```

#### Visibility and timing reset

Pause on either of two separate signals. They mean different things:

- `document.visibilitychange`: the tab is in the background.
- An `IntersectionObserver` on the scene container: the reader scrolled past the
  scene.

```
sync = () => (document.hidden || !onScreen) ? pause() : resume()
```

On pause, cancel the pending animation frame synchronously. A hidden tab can hold
a scheduled callback and never call it. A stale handle then makes `resume()`
believe a frame is already queued.

On resume:

1. Reset the delta clock baseline (`previous = now()`). Otherwise the first frame
   after a ten-minute pause passes a ten-minute delta to the physics.
2. Reset the sampling counters and increment a generation number. A completion
   callback that resolves after the pause then cannot corrupt the new statistics.
3. Reset transient interaction state (active deformations, hover cooldowns) and
   the integration remainder of any physics. Keep positions and angles, so an
   object that was mid-swing resumes its swing instead of snapping upright.

Never fast-forward the animation clock to make up for time in the background.

#### Theme and state transitions

Bake both end states, and interpolate one scalar between them.

- Compute anything expensive (volumetric bakes, radiance probes, per-variant
  textures) once for each end state at build time. In the hezo.ai scene, that was
  8 raymarched textures in total for the life of the scene, at its chosen bake
  resolution.
- Each frame, the transition is colour lerps, transform lerps and a shader
  mix, all driven by one eased value. A day/night toggle then has no measurable
  cost, and it reverses smoothly partway through.
- Mix transparent art in premultiplied space. Otherwise edges get a dark outline
  halfway through the transition:

  ```
  alpha = mix(a.a, b.a, t)
  rgb   = mix(a.rgb * a.a, b.rgb * b.a, t) / max(alpha, epsilon)
  ```

- If the two states differ in layout as well as colour, warp the blend with a term
  that is zero at both ends (`t * (1 - t)` shaping). That keeps the endpoints
  exact.

---
