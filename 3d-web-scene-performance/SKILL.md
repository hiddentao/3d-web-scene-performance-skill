---
name: 3d-web-scene-performance
description: Build and review real-time 3D scenes on web pages. The scenes keep 60 fps on phones, tablets and desktops, show something within five seconds on a slow connection, stay loaded without a rebuild when the visitor moves to another page on the same site, and fall back to a readable page when the renderer fails. Use this skill for any canvas-rendered 3D scene in a browser (Three.js, WebGPU, WebGL, Babylon, React Three Fiber, PlayCanvas or raw shaders). Also use it when someone mentions a 3D background, a scroll-driven animation, a hero canvas, a product viewer, a procedural scene, device tiers, adaptive quality, LOD, draw calls, shader compilation, frame budget, jank, a loading screen for 3D or an OffscreenCanvas worker, or asks why their scene is slow, stutters on mobile or takes too long to appear. Read it before you write the first line of scene code, not after the first profile.
license: MIT
metadata:
  repository: https://github.com/hiddentao/3d-web-scene-performance-skill
---

# Real-time 3D on a web page

A 3D scene on a marketing page competes with the page. It shares the main thread
with layout, input and hydration, the GPU with the compositor, and the network
connection with every other asset. The visitor did not come for the scene, and
will leave if the page is slow. The rules below follow from this.

The rules apply to any engine and any subject. Under each rule, worked examples
show how the hezo.ai scene (a production Three.js r180 / WebGPU scene) implements
it. The numbers come from that scene.

## Reference files

This file holds the rules, the decision tables and the budget arithmetic. Each
reference file below covers one topic in full. Read this file first, then open
only the references the task needs.

| Reference | Open it when you are | Lines |
| --- | --- | --- |
| [device-tiers](references/device-tiers.md) | deciding what each device gets, choosing a value for a knob (one device setting), or adding distance LOD | 490 |
| [frame-budget](references/frame-budget.md) | reaching or keeping a frame rate, or counting what a frame costs | 422 |
| [engine-internals](references/engine-internals.md) | asking what your engine caches, why a shared material still rebuilds, where your own vertex code runs inside the engine's, or whether render bundles will help | 331 |
| [startup](references/startup.md) | shortening the time to first render, or moving work off the main thread | 473 |
| [loading-ui](references/loading-ui.md) | deciding what the visitor sees before the scene appears | 280 |
| [persistence](references/persistence.md) | making a second visit fast, or keeping the scene through navigation and crashes | 308 |
| [interaction](references/interaction.md) | driving the camera from scroll, picking objects, or degrading gracefully | 429 |
| [verification](references/verification.md) | about to measure something or report a number | 246 |

`tools/probe-engine.mjs` beside them asks
[the seven questions](#seven-questions-to-ask-of-any-engine) of the engine you
have installed and prints one line each, through a small adapter per engine.
Run it before and after an upgrade and diff the two outputs.

Read [verification](references/verification.md) before you report any
performance number. Most 3D performance numbers are measured wrong, and a wrong
number sends the next day's work in the wrong direction.

## The nine rules

**1. Count frames the GPU finishes.**
`requestAnimationFrame` (RAF) keeps firing at the display rate while the GPU
falls behind. A frame counter built on RAF reports 60 fps on a device that is
drawing 22 fps. Count the frames the GPU has finished, and base quality changes
on the lower of the two rates.

**2. Do not let frames pile up.**
Never submit a frame while two are still unfinished. Keep at most one camera
update in flight to an async renderer. Submitting without a limit does not make
the scene faster. It turns frame time into input latency, and it hides the
overload from your own metrics.

**3. Keep device settings in one table.**
Put every device-class decision in one table, with one row per build (the
version of the scene that one class of device gets). Each setting in a row is a
knob. An `isMobile ? a : b` check at each call site drifts over time. A single
`quality` scalar cannot express a row that wants a third of the scattered
objects but full surface resolution.

**4. Turn expensive effects fully off.**
Shadows, reflections, ambient occlusion and post-processing chains each cost a
full scene traversal plus render targets. Turning one off while keeping the
others saves only part of a pass and still pays its setup cost. Turn them off
together. Check that the code path skips the object entirely, rather than
setting it to zero.

**5. Make the page work without the 3D scene.**
A visitor may have no JavaScript, a renderer that fails, a device that crashed
on the last visit, or a browser without the API. Send all of these cases to one
static path: the page with all of its content and no canvas. Build that path
first. It is also your fallback, your SSR output and what crawlers see.

**6. Build the scene in stages.**
Order the stages by what the visitor looks at first, front to back. Each stage
must be a complete slice of the scene that renders on its own, never a
half-built mesh. When a stage is done, publish it: add it to the scene on
screen. Cross a real task boundary between stages, so input, layout and paint
can run.

**7. Set a time limit for loading.**
Decide in advance how long the visitor waits. This wait is the hold. When the
time runs out, show the page and let the scene appear behind it. Never make
content wait for work whose duration you do not control.

**8. Cache generated data, not 3D objects.**
Numbers and typed arrays survive storage. Meshes, materials, textures and GPU
handles do not. A cache hit must return exactly what generation returns, through
the same code path.

**9. Test the production build.**
A shader that compiles from source can still fail in production, because the
bundler changed the class that built it. Test the emitted bundle, not the file
you wrote.

## Build order

Implement in this order. Each step limits the next, and adding any of them later
is expensive.

1. **The static page.** Full content, no canvas. This is the SSR output.
2. **The device table.** Rows and knobs, before any builder reads a knob.
3. **The scene skeleton.** One stage, one material, on the main thread. Prove
   that the camera, the disposal path and the resize path work.
4. **The cooperative scheduler.** The build code calls a checkpoint often, and at
   each checkpoint the scheduler decides whether to yield to the browser. If you
   add the scheduler later, you must pass a `checkpoint` argument through forty
   functions.
5. **Stage publication.** Split the build into stages, front to back, and run
   them through the scheduler.
6. **The worker.** Move rendering off the main thread once the build already
   yields.
7. **The loading contract.** The rules for what the visitor sees while the scene
   loads: the deadline, the loading states and the placeholder.
8. **The frame controller.** Adaptive quality, once there is a real scene to
   measure.
9. **Persistence.** The generation cache, then keeping the scene across navigation.
10. **Interaction.** Picking, gestures and physics. Add these last, because a
    device tier that turns interaction off must be able to remove all of it.

## Porting this to another engine

Most of this skill is arithmetic and browser behaviour, which no engine changes.
A few rules depend on how one engine batches, caches and compiles. Check those
rules before you carry them to another engine, or they will mislead you.

Do not assume another engine has the same costs as the one you measured. The
rule that travels is the mechanism: **when a per-object identity is part of a
shader or pipeline cache key, sharing a material stops sharing the shader
build.** An engine that does this rebuilds the shaders for every instanced mesh
in every pass, even when they all use one material. One production Three.js
scene, measured in 2025, hit exactly that. Another engine may key on the
material alone, batch automatically, cache pipelines across meshes, or have an
explicit pipeline object that you create yourself. If you carry one engine's
result to another, you will optimise something that is already free and miss
what is not.

[engine-internals](references/engine-internals.md) covers the caches a renderer
keeps, the ones it cannot keep, and a probe for each.

### Seven questions to ask of any engine

Answer these before you optimise anything. The rest of this skill tells you what
to do with the answers.

1. **What is a pipeline build keyed on?** Material? Material plus vertex layout?
   Per-object identity? This decides whether merging objects saves compile work
   or only draw calls. See
   [the cache key trap](references/engine-internals.md#the-cache-key-trap).
2. **What does the engine batch automatically, and what must you batch?** Some
   engines merge static geometry for you. Some never do.
3. **Which passes traverse the whole scene?** For example shadows, depth
   prepass, reflections and the post-processing chain. The number of passes
   multiplies the cost of every triangle you add.
4. **Is there an asynchronous pipeline compile?** If so, use it before the frame
   that needs the pipeline. If not, the first frame after each stage will stall.
5. **Is there a signal for GPU completion?** It can be a promise, a fence or a
   timestamp query. Without one, you cannot measure frame rate accurately.
6. **What identity must stay stable for an object to be reused?** This decides
   whether you can share constructed objects across build phases, and what
   counts as "unchanged". An engine's "this object is static" flag may not apply
   to your material type, so
   [probe it](references/engine-internals.md#static-flags-and-refresh-observers)
   rather than trusting it.
7. **When does your own vertex code run?** An engine gives you a hook to move a
   vertex. It can call that hook on the geometry's own vertex and apply its own
   transforms after, or apply them first and hand you the result. This decides
   which space your displacement is written in. An engine can swap the order
   without breaking an API, so nothing fails when it does: the shader compiles
   and the object bends about the wrong origin. See
   [when your vertex hook runs](references/engine-internals.md#when-your-vertex-hook-runs).

### Measure the answers

Engine documentation describes intent. Versions change, and your bundler can
change the behaviour too. Each question has a probe (a small test) that works on
any engine:

```
# 1 + 2: what does a pipeline build cost, and when does it happen?
baseline = countShaderCompiles()                 # hook the engine's compile entry point,
buildSceneVariantA()                             # or count via a GPU debug layer
after = countShaderCompiles()
# then: build the same geometry as N separate objects vs 1 merged object,
# and compare. If the counts are equal, merging buys you draw calls only.

# 3: how many times is the scene traversed?
instrument the engine's per-object draw entry point for one frame and
count how many times each object is submitted. Passes are the multiplier.

# 4: does compiling ahead remove the stall?
time the first frame after a stage, with and without the async compile call.

# 5: does the completion signal exist and does it differ from RAF?
run a deliberately heavy scene and compare RAF rate against completion rate.
If they never diverge under load, your signal is not measuring completion.

# 6: what makes the engine rebuild?
mutate one property at a time on a constructed object and watch for a
recompile or a buffer reupload.

# 7: when does your vertex hook run?
give one object a vertex hook that adds a constant, generate the shader
source for it, and read the order of the emitted statements. The engine's
own transform is either above your line or below it.
```

A morning spent on these probes tells you more than any generic advice.

### What is engine-independent

These apply to any engine unchanged, because the browser, the network or the
hardware decides them:

- The frame budget arithmetic, and the pixel budget in
  [device-tiers](references/device-tiers.md).
- Counting the frames the GPU finishes, and not letting frames pile up.
- The device table, and choosing a row from screen geometry and pointer type.
- Every loading rule: the deadline, the three loading states and the placeholder
  rules.
- Cooperative scheduling, the timer clamp (the browser's minimum delay for
  nested timers), and yielding across task boundaries.
- Everything in [persistence](references/persistence.md): IndexedDB exactness,
  retention windows (how long to keep a finished scene after the visitor
  navigates away), the back/forward cache, and the crash sentinel (a stored
  marker that shows, on the next load, that the last build never finished).
- Scroll handling, scroll restoration, CPU picking, reduced motion and the static
  path.
- The whole browser and platform limits table in
  [verification](references/verification.md).

The engine-specific part is smaller than it looks: how you batch, how you
compile, how you signal completion, what counts as an unchanged object, and
when your own vertex code runs inside the engine's.

## What to work out for your own scene

This skill gives you a method and an architecture. Work out these four things
for your own scene.

**Your scene's values.** Every number in the worked examples comes from the
geometry, camera and subject of the hezo.ai scene. Your scene needs its own
camera paths, knob values, fade bands (the distances over which objects fade),
and resolution floor (the lowest resolution before a silhouette breaks). Use the
method here to find them. Use the numbers here as an order of magnitude, and as
a sign that the values were measured.

**Product decisions.** Whether a device class gets the scene at all is a
decision that no table makes for you. It depends on what the page is for and who
visits it. In the hezo.ai scene, the decision for phones was made, then
reversed when one release removed the scene from phones entirely, then made
again as a build sized to a phone's pixel count.

**Visual defects.** Compare rendered frames against a reference frame or a
control frame. This is how you find a distant transparent object drawn over a
nearer one, geometry that hides other geometry, or an interaction that registers
with no visible response because a transform was read one stage too late.
Checklists do not catch these defects, so look at the frames.

**Whether each rule fits your scene.** Test each rule on your own scene before
you rely on it.

## Decision tables

### What to adapt at runtime, and what to fix at build

| Knob | Adapt live? | Why |
| --- | --- | --- |
| Render resolution / pixel ratio | Yes | Cheapest knob, with the largest effect, and it changes smoothly |
| Post-effect sample counts | Yes | A uniform, so nothing is reallocated |
| Offscreen target scale (AO, reflection) | Yes | Reallocation is routine and tested |
| Shadow map dimensions | No | Resizing the attachment during rendering caused lasting black frames on WebGPU |
| Geometry density, instance counts | No | Rebuilding geometry during a scroll costs more than the frames it saves |
| Which passes exist at all | No | Decided once, from the device row |
| Material or shader structure | No | Every change is a new pipeline build |

As a rule of thumb, adapt anything that is a number in a uniform or a
render-target size. Fix anything that is a buffer, a pipeline or the shape of
the scene graph.

The first row has a limit. The ladder (the fixed order of quality steps that
adaptive quality moves through at runtime) changes resolution *only within the
range its device row allows*. A row can set that range to a single value. The
hezo.ai scene fixes its two lowest rows at exactly 1. For those devices,
resolution is no longer a live knob, and the ladder can only use its
effect-quality steps. That scene made this choice because its per-pass costs
were the real problem. It is not general advice: a recent flagship phone may
have the headroom to change resolution. Decide per row, and know which of your
rows leave the ladder nothing to change.

### Merge or instance

| The piece | Do this | Why |
| --- | --- | --- |
| Small, repeated, static (under a few hundred vertices) | Merge into one plain mesh per material. Store per-piece variation in a vertex attribute | Plain meshes sharing a material share one shader build |
| Large, repeated, static | Instance | The merged buffer would be bigger than the saving |
| Anything that moves independently | Instance, and mark its transform buffer dynamic | It needs a per-instance transform every frame |
| Thousands of far-away objects | Instance as camera-facing cards, batched by view variant and spatial sector | Limits pipeline builds and keeps frustum culling useful |

Count pipeline builds, not only draw calls. In some engines, each instanced mesh
gets its own shader-cache key, so it builds its own shader in every pass (main,
shadow, depth and post). In the hezo.ai scene, that JavaScript compile work was
the largest single startup cost.

### What may be cached

| Data | Cache? |
| --- | --- |
| Generated vertex positions, indices, placement records | Yes, as typed arrays |
| Noise fields, heightmaps computed in plain arithmetic | Yes |
| Canvas-painted textures with transparency | No. Saving and reloading the pixels does not return exactly the same values |
| Engine meshes, materials, textures | No. They do not survive serialisation |
| GPU-baked render targets | No. Regenerate them or keep them in memory |

### Which signal decides a device class

| Signal | Use it? |
| --- | --- |
| `matchMedia("(pointer: coarse)")` | Yes. It separates devices where touch is the main input |
| `screen` min edge | Yes. It does not change with orientation or the URL bar |
| `window.innerWidth` | Only for a desktop window size, never for a device class |
| `navigator.deviceMemory` | Barely. It is Chromium-only, and Chrome for Android clamps it to 8 |
| `navigator.hardwareConcurrency` | No. It reads 8 on a phone and on a workstation |
| A GPU capability probe | No. It tells you what the device can do, not what it can afford |
| Evidence that the device already crashed while building this scene | Yes. It is the only reliable capability signal |

## Budget arithmetic

### The frame

At 60 fps, a frame has 16.7 ms, and the scene cannot use all of it. Leave time
for the compositor, the page's own work and input handling. Aim for scene work
under 10 ms of CPU time and 12 ms of GPU time on the device class you target.

A scene with shadows, a planar reflection and a post-processing chain draws its
geometry three times and resolves through extra render targets. Before you
optimise triangles, count how many times per frame the scene is traversed.

### First render

Measure the budget from navigation start, not from hydration.

| Milestone | Target |
| --- | --- |
| Readable page content | under 2 s |
| Decision to hold or release the page | fixed deadline; 5 s is a reasonable choice |
| First complete 3D slice on screen | inside the hold on a fast connection |
| Everything in front of the visitor | before the visitor scrolls |
| Distant detail | may finish while in view |

These measurements come from the hezo.ai scene, with Chrome's Slow 4G preset, a
cold cache and no CPU throttle, on a fast desktop. They are a calibration point,
not a guarantee.

| Milestone | Before the startup work | After |
| --- | --- | --- |
| Readable content | 1.6 s | 1.5 s |
| Scene worker download starts | 7.2 s | ~1.5 s |
| First 3D slice | 11.1 s | 6.8 s |
| All geometry published | 32.3 s | 23.5 s |
| Page bundle, compressed | 283 KB | 30 KB |

The largest gains came from outside the renderer: shipping only the active
translation catalog, starting the worker download before hydration, and not
rebuilding geometry that an earlier stage had already published.

### The main thread

During startup, no task may run longer than 50 ms. To get there, use a slice
budget. A slice is the work done since the last yield. At each checkpoint, yield
if the current slice has run longer than about 6 ms. A checkpoint inside a tight
loop then costs almost nothing early in a slice.

## Accessibility and degradation requirements

- The canvas is decorative. Mark it `aria-hidden`. Every fact it shows must exist
  in text.
- `prefers-reduced-motion` brings the scene to rest. Pausing is not enough: clear
  transient deformation state, set physics to zero, force eased values to their
  targets, and remove motion-triggered interaction entirely.
- A loading indicator is a `progressbar` with a live value and a label.
- Put any rule that hides content during loading inside
  `@media (scripting: enabled)`. Without that query, a visitor with no JavaScript
  gets a page that hides its own content forever.
- Never lock scrolling without a deadline that unlocks it.

## Pre-ship checklist

Rendering:

- [ ] A visible final frame in a real browser, with the production build, on both
      backends if you support two.
- [ ] Clean shader and pipeline logs.
- [ ] Correct after a resize, and after a theme change.
- [ ] Phone width, in a real browser.
- [ ] Every device row forced by hand and checked by eye, including the lowest.
- [ ] The quality ladder stepped down under load and recovered, with no stuck frame.

Startup:

- [ ] A cold-cache Slow 4G run, recorded in the same format as the first-render
      measurements above.
- [ ] No main-thread task over 50 ms.
- [ ] A real control responds within single-digit milliseconds during the build.
- [ ] Exactly one renderer asset and no sub-imports that load one after another,
      checked in the emitted bundle.
- [ ] On a slow connection, the hold ends and shows the page.

Lifetime:

- [ ] The second visit reads the generation cache and is measurably faster.
- [ ] Navigate away and back: the scene reattaches without rebuilding.
- [ ] Cross-site back navigation restores the page from bfcache.
- [ ] Navigate away during the build: nothing leaks and nothing throws.
- [ ] A deploy invalidates the cache and removes the old entries.

Degradation:

- [ ] JavaScript off: all page content is readable.
- [ ] Renderer forced to fail: all page content is readable.
- [ ] Crash sentinel forced: no worker is downloaded, and all page content is
      readable.
- [ ] Reduced motion: the scene comes to rest, nothing moves, and all page content
      is still readable.
- [ ] Fallback and success are each reported once per document.

Accessibility:

- [ ] The canvas is `aria-hidden`.
- [ ] The loading indicator has a role, a label and a live value.
- [ ] Nothing hidden is focusable.
- [ ] Every fact the scene shows exists in text.

## Reviewing a scene

Ask these questions in order. Each answer changes what the next one means.

1. How is frame rate measured? If it counts RAF callbacks, do not trust any other
   number.
2. How many times per frame is the scene traversed? Count passes before
   triangles.
3. How many pipeline builds happen at startup? Count instanced batches and unique
   material-plus-attribute combinations.
4. What does the page look like with JavaScript off?
5. What happens on the second visit, and on a back navigation?
6. Where does the main thread block during startup? Record long tasks instead of
   guessing.
7. What does the phone build turn fully off? If it turns nothing fully off, it is
   a smaller desktop build, and it will not keep its frame rate.
