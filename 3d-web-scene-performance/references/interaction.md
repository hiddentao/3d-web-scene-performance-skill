# Scroll, interaction and graceful degradation

The 3D scene sits inside an HTML document. This file covers how the two work
together.

#### Scroll-driven camera

Convert the container's scroll progress into a parameter on the camera's curve,
then ease towards it.

```
readScroll() {
  progress = clamp(-container.getBoundingClientRect().top /
                   (container.offsetHeight - viewportHeight), 0, 1)
}
```

One bounding-rect read per frame is enough, however long the walk is. The walk is
the tall container the reader scrolls through to move the camera.

##### Frame-rate-independent easing

Do not write `value += (target - value) * 0.1`. It converges twice as fast at
120 Hz as at 60 Hz, so the scene feels different on different hardware. Use this
instead:

```
k = 1 - Math.pow(0.002, delta)          // 0.002 is "fraction remaining after one second"
u += (progress - u) * k
if (Math.abs(progress - u) < 0.0003) u = progress    // snap, so it actually finishes
```

Use a second, slower constant for things that should lag, such as theme blends
and pointer parallax. Under reduced motion, set both to 1, which snaps to the
target every frame, and force parallax targets to zero.

##### Place the camera every frame, submit less often

Overlay projection and picking need the camera matrices whether or not a frame is
submitted to the GPU. Place the camera before the backpressure check (the check
that holds back a frame while the GPU is still busy). Below that check, skip only
the lighting update and the submission. See
[the frame budget](frame-budget.md#the-frame-budget).

##### Add corrections on top of the curve

```
position = curve.getPoint(u)
position.y += terrainElevation(position.z)                  // follow the ground
position.y = lerp(position.y, EYE_LEVEL, 1 - smooth(.08, .22, u))   // start at eye level
look = curve.getPoint(u + 0.03)
look.lerp(gateTarget, 1 - smooth(.06, .2, u))               // blended points of interest
    .lerp(midTarget,  smooth(.22,.42,u) * (1 - smooth(.65,.8,u)))
```

Each correction is a named smoothstep over a range of scroll progress, so it is
easy to read and adjust. If you edit the curve's control points to get the same
result, you move every beat that depends on those points. A beat is a named
moment on the walk, such as a content panel, at a fixed scroll position.

#### Write each position once

On a scroll-driven page, CSS and JavaScript must agree on where each beat sits.
CSS positions the element, and JavaScript animates against that position. Keep
each position in one table.

```
WALK_BEATS = [
  { key: "hero",     wide: 0.00, phone: 0.00 },
  { key: "stations", wide: 0.30, phone: 0.22 },   // phone column only where it differs
  { key: "coach",    wide: 0.74, phone: 0.68 },
]
```

1. The table writes both columns onto the element as inline custom properties,
   `--u-wide` and `--u-phone`. Always write both, even when they are equal, so
   the switch below always resolves.
2. CSS picks one, in the only place where the breakpoint is written:

   ```css
   .beat { --u: var(--u-wide) }
   @media (max-width: 600px) { .beat { --u: var(--u-phone) } }
   ```

3. JavaScript reads the resolved value back:

   ```
   beatOf = el => Number(getComputedStyle(el).getPropertyValue("--u")) || 0
   ```

The panel, the figure inside it, the blur behind it and its progress pill all
read the same property, so they move together. No position is hard-coded in the
animation loop or copied into the stylesheet.

**Do not copy a beat's number into the loop.** If overlay timing needs a beat's
position, read it. A copied constant goes out of date the first time someone
edits the table.

##### Test the table, not the rendering

```
assert(strictlyIncreasing(column))          // both columns
assert(last(column) < 1)                    // the last beat has room to settle
for (adjacent pairs) assert(gap >= MIN_BREAK)   // measured against the longest translation
```

Measure the block heights in your longest language and assert against those
heights. Layout is the part that breaks, and it breaks in the language nobody
checks.

#### Reading layout on layout events

Calling `getComputedStyle` in the frame loop costs one layout read per element
per frame.

Cache every derived position. Recompute only when a `ResizeObserver` fires on an
element whose size can change: the stage (the sticky element that holds the
scene), the hero and every beat. That observer also covers window resizes.

```
resize() {
  readBeats()               // all getComputedStyle calls live here
  renderer?.resize()
  readScroll()
}
```

The frame loop then only interpolates against cached numbers. This also covers
cases that are easy to forget: a font finishing loading, a translation reflowing
the text, or the window crossing a breakpoint.

#### Projecting DOM overlays onto the scene

When HTML elements must sit at 3D positions, project them with the matrices of
the frame that was actually submitted, not the camera's current state. Otherwise
the overlay runs one frame ahead of the picture it labels. Under backpressure it
can run several frames ahead.

```
onSubmit:
  submittedViewProjection.copy(camera.projectionMatrix).multiply(camera.matrixWorldInverse)
  submittedCameraPosition.copy(camera.position)

projectOverlays:
  use submittedViewProjection, never camera.*
```

Picking follows the same rule. Test a tap against the frame the reader was
looking at when they tapped.

#### Scroll position across in-site navigation

Three cases need three different behaviours:

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

**`behavior: "instant"` is deliberate.** Pages often set
`html { scroll-behavior: smooth }` for anchor jumps. If the reset on a route
change inherits that, the scroll animates at the same moment the new page's DOM
swaps in. When the reader goes from a long page to a short one, the browser
clamps the animating offset to the new scroll maximum mid-animation and cancels
it, which leaves the reader partway down the page.

Put `scroll-behavior: smooth` only inside
`@media (prefers-reduced-motion: no-preference)`, never on plain `html`.

##### Start the camera at the restored position

When the scene mounts, read the scroll position and set the eased camera
parameter to it directly. Do not start it from zero:

```
readScroll()
u = progress            // not 0, or the camera visibly rewinds and flies forward
```

A reader who returns with back or forward to a point 60% down the page should see
the scene at 60% on the first frame.

#### Picking without a GPU readback

Reading pixels back from the GPU stalls the pipeline. Pick on the CPU instead,
against data you already generated.

**Build a spatial index over the pickable instances** at load time, in small
steps that yield to the browser:

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

Because the alpha is sampled on the CPU, an alpha-cutout instance feels solid
where it is drawn and empty where its texture is transparent. Keep a copy of the
pixels you already decoded. Do not fetch the image again.

Two things keep that copy cheap:

**Ask for a CPU-readable canvas up front.** A 2D canvas is usually backed by a GPU
surface. The first `getImageData` call on it forces a readback, and the readback
stalls. If you generate a texture in a canvas and will sample it on the CPU
later, say so when you create the context:

```
canvas.getContext("2d", { willReadFrequently: true })
```

Pass this option only for canvases you actually read back. It gives up GPU
acceleration for drawing, which is a loss on canvases you only upload.

**Memoise the sampler by texture identity.** Many instances usually share a few
textures, and building a sampler decodes every pixel. Key each sampler on the
texture's identity and on any mode that affects decoding. Then N surfaces that
share one texture pay the cost once:

```
key = `${texture.id}:${alphaMode}`
if (!samplers.has(key)) samplers.set(key, buildSampler(texture, alphaMode))
```

**Keep a separate index for occlusion** over opaque geometry, so a tap cannot
reach something behind a wall:

```
blocked = groundDistance(ray, limit) < limit || occlusion.distance(ray, limit) < limit
```

Leave anything that moves out of the static occlusion index. If a pendulum's
startup matrix is baked into the index, an invisible blocker stays behind after
the pendulum moves away. Raycast moving objects live instead, since there are
few of them.

**Match the state the GPU is drawing.** If a uniform displaces instances in the
vertex stage, the picker must use the same value. Otherwise it tests hits
against geometry the reader cannot see. Under reduced motion both are zero, so
that case is easy. The animated case is the one that needs care.

Typical costs measured in the hezo.ai scene, on one desktop machine with roughly
100,000 pickable instances: about 0.05 ms for a full triangle-and-alpha query and
0.01 ms for a bounds-only query. Measure the costs in your own scene.

#### Gesture handling

**Throttle hover.** A pointer that moves across the scene fires hundreds of events
a second.

```
if (now - lastQuery < 1000 / 12) return       // at most ~12 queries a second
if (distanceMoved < 6) return                 // and only after real movement
if (buttonsDown || otherPointerActive) return
```

A stationary pointer must never schedule work, even after an earlier response has
finished.

**Tell a tap from a scroll.** On touch screens, every scroll starts as a
`pointerdown` on the canvas:

```
isTap = duration <= 450 && movement <= 10
        && scrollX === downScrollX && scrollY === downScrollY
```

The scroll-offset comparison matters most. With duration and movement alone, a
slow, short drag that was really a scroll counts as a tap.

**Reject UI hits.** The gesture must land on the scene, not pass through a panel.
Accept it only when all of these are true:

- The target is inside the scene container.
- The target is not inside any known UI element.
- The event's point is not inside the visible bounds of a readability overlay (a
  panel that keeps text readable over the scene).

The last check is needed because text overlays often set `pointer-events: none`
so that events reach the canvas below. The event does land on the canvas, so
only a bounds check protects the text.

**Feature-detect the capability instead of adding a flag.**

```
isEnabled: () => typeof renderer?.pickInstance === "function"
```

A device row (the settings for one type of device) that turns interaction off
removes this method. The whole feature then switches off, and there is no second
flag to keep in sync. See [device tiers](device-tiers.md#device-tiers-lod-and-cost-curves).

Attach listeners with `{ passive: true, capture: true }`. They stay cheap even
when every handler returns at once.

**Watch the media query at runtime.** A reader can turn reduced motion on during
a session. Listen for `change` and cancel any gesture in progress.

#### Bounded physics

Limit interactive motion in both amplitude and cost.

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

- **Bound the state itself, not only the amplitude.** Interaction events arrive
  as fast as the reader can make them. A structure that grows with each event
  grows without limit. A shader that reads it needs a matching uniform count,
  and changing that count changes the shader. Pre-allocate a small, fixed pool of
  slots and evict the oldest when a new event arrives:

  ```
  SLOTS = 3                                  // as many as the shader reads
  slot = freeSlot() ?? oldestBy(s => s.order)
  ```

  Three responses at once usually look the same as unlimited responses. The
  worst-case cost per frame becomes a constant you chose, instead of depending on
  how fast someone can tap.

- A fixed sub-step makes the motion identical at 30, 60 and 120 fps, and you can
  test that without a browser.
- An energy clamp stops a reader who taps the object again and again from winding
  it up.
- When resuming after a pause, reset the velocity and the integration remainder,
  but keep the current angle. An object paused mid-swing should resume from that
  angle, not snap upright.
- Mark animated instances as dynamic in the instance buffer, and handle their
  bounds as described in [device tiers](device-tiers.md#device-tiers-lod-and-cost-curves).

#### Reduced motion settles the scene

Under `prefers-reduced-motion: reduce`, settle the scene: put every moving part
in its final resting state. Freezing it is not enough.

| Subsystem | Behaviour |
| --- | --- |
| Camera easing | Easing constant is 1, so the camera tracks scroll exactly |
| Pointer parallax | Target forced to 0. The pointer position is not recorded at all |
| Scene clock | Not advanced. Wind, water, drift, flicker and sway all stop from this one place |
| Deformation state | Cleared every frame (not just frozen), which cancels any response in progress |
| Physics | Reset every frame. New impulses are refused |
| Gestures | Not enabled at all |
| CSS transitions | Removed |
| Entrance animations | Rendered in their final, settled state |

Drive every time-based effect from one clock that the page owns. Then reduced
motion is one decision instead of twenty. A subsystem that reads
`performance.now()` itself will not stop.

#### The static path

**Make the page work without the 3D scene.** The static path is the page shown
without the scene. These cases all lead to it:

1. No JavaScript.
2. The renderer failed at runtime.
3. The device is refused a scene by the crash sentinel, a stored marker that
   shows the scene crashed on a previous visit. See
   [persistence](persistence.md#persistence-caching-retention-and-survival).
4. The API is missing.

All of them get the same treatment. The sticky scene stage is removed from the
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

Also put the same rules inside a `<noscript>` block, where they apply
unconditionally. Without script, nothing can add the state class.

Follow these design rules:

- **Add a rule for one path to the whole selector list**, including the
  `<noscript>` copy. All the paths show one page, not four.
- **Anything that depends on the canvas needs a canvas-free twin.** If floating
  elements are positioned by projection, also ship a stacked list with the same
  content, and show it whenever the stage is hidden.
- **Do not show the same heading twice.** If a scroll-driven overlay names a
  section, hide the static twin's heading wherever that overlay exists, and show
  it wherever the overlay does not exist. If you get this backwards, you get
  either a duplicate heading or a list with no label.
- **Check the static path in a browser.** Developers rarely look at it, but search
  crawlers and screen readers see it.

##### Reporting

Report each fallback once per document, with its reason and the device row.
Report success the same way, so the fallback rate has a denominator. Use a
module-level flag instead of component state. With component state, a reader who
comes back through in-site navigation reports again on every visit.

---
