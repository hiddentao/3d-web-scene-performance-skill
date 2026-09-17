# Scroll, interaction and graceful degradation

The scene is inside a document. This is about the seam between them.


#### Scroll-driven camera

Map the container's scroll progress to a curve parameter, then ease.

```
readScroll() {
  progress = clamp(-container.getBoundingClientRect().top /
                   (container.offsetHeight - viewportHeight), 0, 1)
}
```

One bounding-rect read per frame covers a walk of any length.

##### Frame-rate-independent easing

Never `value += (target - value) * 0.1`. That converges twice as fast at 120 Hz as
at 60, so the scene feels different on different hardware.

```
k = 1 - Math.pow(0.002, delta)          // 0.002 is "fraction remaining after one second"
u += (progress - u) * k
if (Math.abs(progress - u) < 0.0003) u = progress    // snap, so it actually finishes
```

Use a second, slower constant for things that should lag - theme blends, pointer
parallax. Under reduced motion set both to 1, which is an instant snap every
frame, and force parallax targets to zero.

##### Place the camera every frame, submit less often

The camera matrices are needed by overlay projection and by picking whether or not
a frame is submitted. Place the camera above the backpressure check, and skip only
the lighting update and the submission below it. See [The frame budget](frame-budget.md#the-frame-budget).

##### Layer corrections onto the curve rather than editing the curve

```
position = curve.getPoint(u)
position.y += terrainElevation(position.z)                  // follow the ground
position.y = lerp(position.y, EYE_LEVEL, 1 - smooth(.08, .22, u))   // start at eye level
look = curve.getPoint(u + 0.03)
look.lerp(gateTarget, 1 - smooth(.06, .2, u))               // blended points of interest
    .lerp(midTarget,  smooth(.22,.42,u) * (1 - smooth(.65,.8,u)))
```

Each correction is a named smoothstep over a scroll range, which is readable and
adjustable. Editing control points to achieve the same thing moves every beat that
depends on them.

#### Authoring positions once

A scroll-driven page has two systems that need to agree about where a beat sits:
CSS positions the element, JavaScript animates against it. Encode it once.

```
WALK_BEATS = [
  { key: "hero",     wide: 0.00, phone: 0.00 },
  { key: "stations", wide: 0.30, phone: 0.22 },   // phone column only where it differs
  { key: "coach",    wide: 0.74, phone: 0.68 },
]
```

1. The table emits **both** columns as inline custom properties on the element:
   `--u-wide` and `--u-phone`. Always both, even when they are equal, so the
   switch below always resolves.
2. **CSS picks one**, in the one place the breakpoint is written down:

   ```css
   .beat { --u: var(--u-wide) }
   @media (max-width: 600px) { .beat { --u: var(--u-phone) } }
   ```

3. **JavaScript reads the resolved value back**:

   ```
   beatOf = el => Number(getComputedStyle(el).getPropertyValue("--u")) || 0
   ```

The breakpoint exists once. The panel, the figure inside it, the blur behind it
and its progress pill all move together because they all read the same property. A
position never gets hard-coded into the animation loop or duplicated in the
stylesheet.

**Do not duplicate a beat's number in the loop.** If the overlay timing needs a
beat's position, read it; a hand-copied constant will drift the first time the
table is edited.

##### Test the table, not the rendering

```
assert(strictlyIncreasing(column))          // both columns
assert(last(column) < 1)                    // the last beat has room to settle
for (adjacent pairs) assert(gap >= MIN_BREAK)   // measured against the longest translation
```

Measure the block heights in your longest language and assert against those. It is
the layout that breaks, and it breaks in the language nobody tests in.

#### Reading layout on layout events

`getComputedStyle` in a frame loop is a layout read per element per frame.

Cache every derived position, and recompute only from a `ResizeObserver` on the
elements whose size can change - the stage, the hero, every beat - plus the window
resize that observer already covers.

```
resize() {
  readBeats()               // all getComputedStyle calls live here
  renderer?.resize()
  readScroll()
}
```

The frame loop then only interpolates against cached numbers. This also handles
the cases you would otherwise forget: a font loading, a translation reflowing, a
breakpoint crossing.

#### Projecting DOM overlays onto the scene

When HTML elements must sit at 3D positions, project them with the matrices of the
**frame that was actually submitted**, not the camera's current state. Otherwise
the overlay is one frame ahead of the picture it is annotating, and under
backpressure it can be several.

```
onSubmit:
  submittedViewProjection.copy(camera.projectionMatrix).multiply(camera.matrixWorldInverse)
  submittedCameraPosition.copy(camera.position)

projectOverlays:
  use submittedViewProjection, never camera.*
```

The same applies to picking: a tap must be tested against the frame the reader was
looking at when they tapped.

#### Scroll position across in-site navigation

Three cases, three behaviours:

```
shouldUpdateScroll({ location, getSavedScrollPosition }) {
  const id = location.hash && decodeURI(location.hash.slice(1))
  if (id && document.getElementById(id)) return true        // 1. anchor: let the platform jump

  const saved = getSavedScrollPosition(location)            // 2. back/forward: restore
  const y = Array.isArray(saved) ? saved[1] : saved
  window.scrollTo({ top: y || 0, left: 0, behavior: "instant" })   // 3. new page: top
  return false
}
```

**`behavior: "instant"` is deliberate.** Pages commonly carry
`html { scroll-behavior: smooth }` for anchor jumps. If the route-change reset
inherits that, it animates exactly as the new page's DOM swaps in; navigating from
a long page to a short one has the browser clamp the animating offset to the new
scroll maximum mid-flight and cancel it, stranding the reader mid-page.

Keep `scroll-behavior: smooth` scoped to
`@media (prefers-reduced-motion: no-preference)` and never on plain `html`.

##### Seeding the camera from a restored position

When the scene mounts, read the scroll position and seed the eased camera
parameter **directly**, not from zero:

```
readScroll()
u = progress            // not 0, or the camera visibly rewinds and flies forward
```

A reader arriving through back/forward at 60% down the page should see the scene
at 60%, on the first frame.

#### Picking without a GPU readback

Reading pixels back from the GPU stalls the pipeline. Do it on the CPU instead,
against data you already generated.

**A spatial index over the pickable instances**, built cooperatively at load time:

```
buildIndex*(instances) {           // a generator: yields so the build does not block
  median-split BVH over instance bounds
  store bounds, ids and transforms in typed arrays
}

pick(ray, maxDistance) {
  nearest-first stack traversal
  for each BVH leaf candidate:
    triangle intersection
    sample the alpha map on the CPU at the hit UV     // reject transparent texels
  return nearest accepted hit
}
```

Sampling the alpha field on the CPU is what makes an alpha-cutout instance feel
solid where it is drawn and empty where the texture is transparent. Keep a copy of
the already-decoded pixels; do not re-fetch the image.

Two things make that copy cheap rather than expensive:

**Ask for a CPU-readable canvas up front.** A 2D canvas is normally backed by a
GPU surface, and the first `getImageData` on it forces a readback that stalls.
If a texture is generated in a canvas and will later be sampled on the CPU, say
so when you create the context:

```
canvas.getContext("2d", { willReadFrequently: true })
```

Pass it only for the canvases you actually read back - it gives up GPU
acceleration for drawing, so it is a loss on canvases you only upload.

**Memoise the sampler by texture identity.** Many instances usually share a few
textures, and building a sampler decodes every pixel. Key the built sampler on
the texture's identity plus whatever mode affects decoding, so N surfaces sharing
one texture pay once:

```
key = `${texture.id}:${alphaMode}`
if (!samplers.has(key)) samplers.set(key, buildSampler(texture, alphaMode))
```

**A separate index for occlusion**, over opaque geometry, so a tap cannot reach
something behind a wall:

```
blocked = groundDistance(ray, limit) < limit || occlusion.distance(ray, limit) < limit
```

Exclude anything that moves from the static occlusion index. A pendulum's
startup matrix baked into the index leaves an invisible blocker behind once the
part has moved away. Moving objects get live raycasts instead - there are few of them.

**Match the state the GPU is drawing.** If a uniform displaces instances in the
vertex stage, the picker must use the same value, or hit-testing is against
geometry the reader cannot see. Under reduced motion both are zero, which is the easy case;
the animated case is the one to get right.

Typical measured costs from the reference implementation, on one desktop machine
with a scene of roughly 100,000 pickable instances: about 0.05 ms for a full
triangle-and-alpha query and 0.01 ms for a bounds-only query. Measure your own.

#### Gesture handling

**Throttle hover.** A pointer moving across the scene generates hundreds of events
a second.

```
if (now - lastQuery < 1000 / 12) return       // at most ~12 queries a second
if (distanceMoved < 6) return                 // and only after real movement
if (buttonsDown || otherPointerActive) return
```

A stationary pointer must never schedule work, even after a previous response has
settled.

**Distinguish a tap from a scroll.** On touch, every scroll starts as a
`pointerdown` on the canvas:

```
isTap = duration <= 450 && movement <= 10
        && scrollX === downScrollX && scrollY === downScrollY
```

The scroll-offset comparison is the one that matters. Duration and movement alone
accept a slow, short drag that was really a scroll.

**Reject UI hits.** The gesture must land on the scene, not through a panel:

- the target must be inside the scene container,
- and not inside any known UI element,
- and its point must not fall inside the visible bounds of a readability overlay.

That last check is needed because text overlays often carry `pointer-events: none`
so the event reaches the canvas beneath. The event does land on the canvas; only a
bounds check protects the text.

**Feature-detect the capability, do not flag it.**

```
isEnabled: () => typeof renderer?.pickInstance === "function"
```

A device row that declines interaction removes the method, and the whole feature
switches off with no second flag to keep in sync. See [Device tiers, LOD and cost curves](device-tiers.md#device-tiers-lod-and-cost-curves).

Attach listeners `{ passive: true, capture: true }`. They are cheap even when
every handler bails out immediately.

**Watch the media query at runtime.** A reader can turn reduced motion on
mid-session. Listen for `change` and cancel any gesture in flight.

#### Bounded physics

Interactive motion must be bounded in amplitude and in cost.

```
STEP = 1 / 240                       // fixed sub-step, independent of frame rate
MAX_ELAPSED = 0.1                    // never integrate more than this after a pause

update(dt) {
  accumulator += min(dt, MAX_ELAPSED)
  while (accumulator >= STEP) { rk4(STEP); accumulator -= STEP }
}

impulse(push) {
  velocity += push
  clampEnergy(kinetic + potential, energyOf(MAX_ANGLE))    // repeated taps stay gentle
}
```

- **Bound the state itself, not just the amplitude.** Interaction events arrive
  at whatever rate the reader can produce them, so a structure that grows per
  event grows without limit, and a shader that reads it needs a matching uniform
  count - which changes the shader. Pre-allocate a small fixed pool of slots and
  evict the oldest when a new event arrives:

  ```
  SLOTS = 3                                  // as many as the shader reads
  slot = freeSlot() ?? oldestBy(s => s.order)
  ```

  Three concurrent responses is usually indistinguishable from unlimited, and the
  worst-case per-frame cost is now a constant you chose rather than a function of
  how fast someone can tap.

- A **fixed sub-step** means the motion is identical at 30, 60 and 120 fps, which
  is testable without a browser.
- An **energy clamp** means a reader hammering the object cannot wind it up.
- On resume after a pause, reset velocity and the integration remainder but **not**
  the current angle. A mid-swing object should resume, not snap upright.
- Animated instances must be marked as dynamic in the instance buffer, and their
  bounds handled per [Device tiers, LOD and cost curves](device-tiers.md#device-tiers-lod-and-cost-curves).

#### Reduced motion is a settle

Freezing is not enough. Under `prefers-reduced-motion: reduce`:

| Subsystem | Behaviour |
| --- | --- |
| Camera easing | Easing constant 1 - the camera tracks scroll exactly |
| Pointer parallax | Target forced to 0, and pointer position not even recorded |
| Scene clock | Not advanced. Wind, water, drift, flicker and sway all stop, from one place |
| Deformation state | Cleared every frame, not merely frozen - an in-flight response is cancelled |
| Physics | Reset every frame, and new impulses refused |
| Gestures | Not armed at all |
| CSS transitions | Removed |
| Entrance animations | Rendered in their settled state |

Driving every time-based effect from **one clock owned by the page** is what makes
this a single decision rather than twenty. A subsystem that reads
`performance.now()` itself will not stop.

#### The static path

The page must read without the scene. One set of rules, several ways in:

1. No JavaScript.
2. The renderer failed at runtime.
3. The device is refused a scene (crash sentinel, see [Persistence: caching, retention and survival](persistence.md#persistence-caching-retention-and-survival)).
4. The API is missing.

All of them land on the same treatment: the sticky scene stage is removed from the
layout, and every panel returns to normal document flow.

```css
.walk.is-static,                       /* set by script after a runtime failure */
html.scene-off .walk {                 /* set pre-paint by the gate script */
  height: auto; margin-top: 0;
}
.walk.is-static .stage { display: none }
.walk.is-static .beat  { position: relative; top: auto; transform: none; padding-block: 48px }
.walk.is-static .fallback-list { display: block }
```

And the same rules again, unconditionally, inside a `<noscript>` block - because
without script the state class can never be applied.

Design rules that follow:

- **A rule added for one of these paths belongs on the whole selector list**,
  including the `<noscript>` copy. They are one page, not four.
- **Anything the canvas is load-bearing for needs a canvas-free twin.** If
  floating elements are positioned by projection, ship a stacked list that carries
  the same content, and show it whenever the stage is hidden.
- **Do not print the same heading twice.** If a scroll-driven overlay names a
  section, the static twin's heading must be hidden wherever that overlay exists,
  and shown wherever it does not. Getting this backwards gives either a duplicate
  heading or an unlabelled list.
- **Check the static path in a browser.** It is the path nobody looks at, and it
  is the one a search crawler and a screen reader see.

##### Reporting

Report the fallback with its reason and the device row, once per document. Report
success the same way, so the fallback rate has a denominator. Use a module-level
flag rather than component state - a reader returning through the navigation would
otherwise report on every visit.

---
