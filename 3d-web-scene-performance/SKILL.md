---
name: 3d-web-scene-performance
description: Build and review real-time 3D scenes on web pages so they hold 60 fps across phones, tablets and desktops, show something within five seconds on a slow connection, survive in-site navigation without rebuilding, and degrade to a readable page when the renderer fails. Use this skill whenever the work touches a canvas-rendered 3D scene in a browser - Three.js, WebGPU, WebGL, Babylon, React Three Fiber, PlayCanvas, raw shaders - and also whenever someone mentions a 3D background, a scroll-driven animation, a hero canvas, a product viewer, a procedural scene, device tiers, adaptive quality, LOD, draw calls, shader compilation, frame budget, jank, a loading screen for 3D, an OffscreenCanvas worker, or asks why their scene is slow, stutters on mobile, or takes too long to appear. Read it before writing the first line of scene code, not after the first profile.
license: MIT
metadata:
  repository: https://github.com/hiddentao/3d-web-scene-performance-skill
---


# Real-time 3D on a web page

A 3D scene on a marketing page competes with the page. It shares one main thread
with layout, input and hydration, one GPU with the compositor, and one connection
with every other asset. The reader did not come for the scene, and will leave if
the page is slow. Everything here follows from that.

The rules below are stated so they apply to any engine and any subject. Under each
one, the worked examples show how it was implemented in a production Three.js r180
/ WebGPU scene, which is where the numbers come from.

---

## Where the detail lives

This file is the spine: the rules, the decisions, and the arithmetic. Each
reference below carries one area in full. Read the spine first, then open only
what the task needs.

| Reference | Open it when you are | Lines |
| --- | --- | --- |
| [device-tiers](references/device-tiers.md) | deciding what each device gets, sizing a knob, or adding distance LOD | 475 |
| [frame-budget](references/frame-budget.md) | hitting or holding a frame rate, or counting what a frame costs | 395 |
| [startup](references/startup.md) | shortening time to first render, or moving work off the main thread | 452 |
| [loading-ui](references/loading-ui.md) | deciding what the reader sees before the scene arrives | 273 |
| [persistence](references/persistence.md) | making a second visit fast, or surviving navigation and crashes | 296 |
| [interaction](references/interaction.md) | driving a camera from scroll, picking, or degrading gracefully | 409 |
| [verification](references/verification.md) | about to measure something, or to report a number | 239 |

Read [verification](references/verification.md) before reporting any performance
number. Most 3D performance claims are measured wrong, and a wrong measurement
sends the next day's work in the wrong direction.


## The nine rules

**1. Measure completed frames, not callbacks.**
`requestAnimationFrame` keeps firing at display rate while the GPU falls behind.
A frame counter built on RAF reports 60 fps on a device drawing 22. Count frames
the GPU has finished, and adapt on the lower of the two rates.

**2. Bound work in flight.**
Never submit a frame while two are still unfinished. Never keep more than one
camera update in flight to an async renderer. Unbounded submission does not make
the scene faster - it converts frame time into input latency, and hides the
overload from your own metrics.

**3. One table per build, not branches at call sites.**
Every device-class decision lives in one table with one row per build. A
`isMobile ? a : b` at each call site drifts, and a single `quality` scalar cannot
express a row that wants a third of the scatter but full surface resolution.

**4. A declined pass is a whole pass, not a smaller one.**
Shadows, reflections, ambient occlusion and post chains each cost a full scene
traversal plus render targets. Declining one while keeping the others buys a
fraction of a pass and still pays its setup. Decline them together, and check that
the code path skips the object entirely rather than configuring it to zero.

**5. The page must read without the scene.**
No JavaScript, a failed renderer, a device that died last time, a browser without
the API - all land on one static path that still says everything the page says.
Build that path first. It is also your fallback, your SSR output and your
crawler's view.

**6. Publish front to back, in complete slices.**
Build the scene in stages ordered by what the reader looks at first. Each stage
must be a renderable, coherent slice - not a half-built mesh. Cross a real task
boundary between stages so input, layout and paint can run.

**7. Hold for a deadline, not for completion.**
Decide in advance how long the reader waits. Past that, show the page and let the
scene arrive underneath it. Never gate content on work whose duration you do not
control.

**8. Cache generated data, never engine objects.**
Numbers and typed arrays survive storage. Meshes, materials, textures and GPU
handles do not. A cache hit must replay exactly what generation returns, through
the same code path.

**9. Verify after your build tools have touched the code.**
A shader that compiles from source can still fail in production, because the
bundler transformed the class that built it. Test the emitted bundle, not the
file you wrote.

---
## Build order

Implement in this order. Each step constrains the next, and retrofitting any of
them is expensive.

1. **The static page.** Full content, no canvas. This is the SSR output.
2. **The device table.** Rows and knobs, before any builder reads a knob.
3. **The scene skeleton.** One stage, one material, on the main thread. Prove the
   camera, the disposal path and the resize path work.
4. **The cooperative scheduler.** Retrofit this and you will be threading a
   `checkpoint` argument through forty functions.
5. **Stage publication.** Split the build front to back behind the scheduler.
6. **The worker.** Move rendering off the main thread once the build already yields.
7. **The loading contract.** Deadline, states, placeholder.
8. **The frame controller.** Adaptive quality, once there is a real scene to measure.
9. **Persistence.** Generation cache, then scene retention across navigation.
10. **Interaction.** Picking, gestures, physics - last, because a declined tier
    must be able to remove all of it.

---
## Porting this to another engine

Most of this document is arithmetic and browser behaviour, which no engine
changes. A few rules depend on how a specific engine batches, caches and
compiles - and those are the rules that will mislead you if you carry them across
unexamined.

**Do not assume another engine shares Three.js's cost model.** The worked example
here notes that in Three r180 an instanced mesh's identity is part of the render
cache key, so each one assembles its own shaders in every pass. That is a fact
about one engine at one version. Another engine may key on the material alone, may
batch automatically, may cache pipelines across meshes, or may have an explicit
pipeline object you create yourself. Applying Three's conclusion to it would send
you optimising something that is already free, while missing what is not.

### Six questions to ask of any engine

Answer these before optimising anything. The rest of this document then tells you
what to do with the answers.

1. **What is a pipeline build keyed on?** Material? Material plus vertex layout?
   Per-object identity? This decides whether merging objects saves compile work
   or only draw calls.
2. **What does the engine batch automatically, and what must you batch?** Some
   engines merge static geometry for you; some never do.
3. **Which passes traverse the whole scene?** Shadows, depth prepass, reflections,
   post chain. This is the multiplier on every triangle you add.
4. **Is there an asynchronous pipeline compile?** If so, use it before the frame
   that needs the pipeline. If not, the first frame after each stage is your stall.
5. **Is there a signal for GPU completion?** A promise, a fence, a timestamp
   query. Without one you cannot measure frame rate honestly.
6. **What identity must stay stable for an object to be reused?** This decides
   whether you can share constructed objects across build phases, and what
   counts as "unchanged".

### Answer them by measurement, not by documentation

Engine docs describe intent; versions drift; your bundler may change the picture.
Each question has a probe that works on any engine:

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
```

A morning spent on these probes is worth more than any generic advice, including
this document's.

### What is engine-independent

These carry across unchanged, because they are properties of the browser, the
network or the hardware rather than of the renderer:

- The frame budget arithmetic, and the pixel arithmetic below.
- Counting completed frames rather than callbacks, and bounding work in flight.
- The device-row table, and choosing it from screen geometry and pointer type.
- Every loading rule: the deadline, the three states, the placeholder contract.
- Cooperative scheduling, the timer clamp, and yielding across task boundaries.
- Everything in the persistence section: IndexedDB exactness, retention windows,
  the back/forward cache, the crash sentinel.
- Scroll handling, scroll restoration, CPU picking, reduced motion, the static
  path.
- The whole browser-limits table.

What is engine-specific is narrower than it looks: **how you batch, how you
compile, how you signal completion, and what counts as an unchanged object.**
## What this skill cannot give you

Read this before trusting anything above. A document like this transfers method
and architecture. It does not transfer four things, and mistaking any of them for
guidance will cost you time.

**Scene-specific values.** Every number in the worked examples came from one
scene's geometry, camera and subject. Camera paths, knob values, fade bands,
the resolution floor below which a silhouette breaks - all of it is an answer to
a question your scene asks differently. The method for finding them is
transferable; the answers are not. When a number here is useful, it is useful as
an order of magnitude and as a demonstration that someone measured.

**Product judgement.** Whether a device class gets the scene at all is a
decision, not a deduction. In the project behind these examples it was decided,
then reversed - one release removed the scene from phones entirely - then remade
as a build sized to a phone's pixel count. No table produces that call. It
depends on what the page is for and who reads it.

**Defects that only a rendered comparison finds.** A distant transparent object
drawing over a nearer one; geometry quietly hiding other geometry; an interaction
registering with no visible response because a transform was read one stage too
late. Each of those needed a frame compared against a reference or a control
frame. No checklist substitutes for looking.

**Evidence that any of this transfers.** This document was written by reading one
codebase. Its coverage of that codebase demonstrates only that it was written
from it. Treat every rule as a strong prior worth testing, not as a result.
## Decision tables

### What to adapt at runtime, and what to fix at build

| Knob | Adapt live? | Why |
| --- | --- | --- |
| Render resolution / pixel ratio | Yes | Cheapest, largest, continuous effect |
| Post-effect sample counts | Yes | A uniform, no reallocation |
| Offscreen target scale (AO, reflection) | Yes | Reallocation is routine and tested |
| Shadow map dimensions | **No** | Resizing the attachment mid-render produced persistent black frames on WebGPU |
| Geometry density, instance counts | **No** | Rebuilding geometry mid-scroll costs more than the frames it saves |
| Which passes exist at all | **No** | Decided once, from the device row |
| Material or shader structure | **No** | Every change is a new pipeline build |

Rule of thumb: adapt what is a number in a uniform or a render-target size. Fix
what is a buffer, a pipeline or a scene-graph shape.

One caveat on the first row. The ladder adapts resolution *within the range its
device row allows*, and a row may legitimately set that range to a single value -
the reference implementation pins its two lowest rows to exactly 1. Where that
happens, resolution is no longer a live knob for those devices and the ladder has
only its effect-quality steps to spend. That is a deliberate choice for a scene
whose per-pass costs were the real problem, not general advice: a recent flagship
phone may well have the headroom to move. Decide it per row, and know which of
your rows have given the ladder nothing to work with.

### Bake or instance

| The piece | Do this | Why |
| --- | --- | --- |
| Small, repeated, static (under a few hundred vertices) | Merge into one plain mesh per material; carry per-piece variation as a vertex attribute | Plain meshes sharing a material share one shader build |
| Large, repeated, static | Instance | The merged buffer would be bigger than the saving |
| Anything that moves independently | Instance, and mark its transform buffer dynamic | It needs a per-instance transform every frame |
| Thousands of far-away objects | Instance as camera-facing cards, batched by view variant and spatial sector | Caps pipeline builds while keeping frustum culling useful |

Count pipeline builds, not only draw calls. In some engines each instanced mesh
gets its own shader-cache key and so builds its own shader in every pass - main,
shadow, depth, post. That JavaScript compile work was the single largest startup
cost in the scene this skill came from.

### What may be cached

| Data | Cache? |
| --- | --- |
| Generated vertex positions, indices, placement records | Yes, as typed arrays |
| Noise fields, heightmaps computed in plain arithmetic | Yes |
| Canvas-painted textures with transparency | **No** - the pixel round trip is not exact |
| Engine meshes, materials, textures | **No** - they do not survive serialisation |
| GPU-baked render targets | **No** - regenerate or keep in memory |

### Which signal decides a device class

| Signal | Use it? |
| --- | --- |
| `matchMedia("(pointer: coarse)")` | Yes - separates touch-primary hardware |
| `screen` min edge | Yes - does not move with orientation or the URL bar |
| `window.innerWidth` | Only for a desktop window size, never for a device class |
| `navigator.deviceMemory` | Barely - Chromium-only, and clamped to 8 on Chrome for Android |
| `navigator.hardwareConcurrency` | No - reads 8 on a phone and a workstation alike |
| A GPU capability probe | No - it tells you what is possible, not what is affordable |
| Evidence the device already died building this scene | Yes - the only honest capability signal there is |

---
## Budget arithmetic

### The frame

At 60 fps you own **16.7 ms**, and you do not own all of it. Reserve for the
compositor, the page's own work and input handling. Aim for scene work under
**10 ms** CPU and **12 ms** GPU on the device class you are targeting.

A scene drawn through shadows, a planar reflection and a post chain draws its
geometry three times and resolves through extra targets. Before optimising
triangles, count how many times per frame the scene is traversed.

### First render

Budget from navigation start, not from hydration.

| Milestone | Target |
| --- | --- |
| Readable page content | under 2 s |
| Decision to hold or release the page | fixed deadline, 5 s is a defensible choice |
| First complete 3D slice on screen | inside the hold on a fast connection |
| Everything in front of the reader | before the reader scrolls |
| Distant detail | may finish in view |

Reference measurements from the scene this came from, under Chrome's Slow 4G
preset, cold cache, no CPU throttle, on a fast desktop. They are a calibration
point, not a guarantee:

| Milestone | Before the startup work | After |
| --- | --- | --- |
| Readable content | 1.6 s | 1.5 s |
| Scene worker download starts | 7.2 s | ~1.5 s |
| First 3D slice | 11.1 s | 6.8 s |
| All geometry published | 32.3 s | 23.5 s |
| Page bundle, compressed | 283 KB | 30 KB |

The largest wins were not in the renderer. They were: shipping only the active
translation catalog, starting the worker download before hydration, and not
rebuilding geometry that an earlier stage had already published.

### The main thread

No task over **50 ms** during startup. The way to get there is a slice budget:
accumulate work, and yield at the next checkpoint once the slice exceeds about
**6 ms**. Checkpoints inside tight loops then cost almost nothing when the slice
is young.

---
## Non-negotiables for accessibility and degradation

- The canvas is decorative. Mark it `aria-hidden`. Every fact it shows must exist
  in text.
- `prefers-reduced-motion` settles the scene. It is not a pause: clear transient
  deformation state, zero physics, force eased values to their targets, and drop
  motion-triggered interaction entirely.
- A loading indicator is a `progressbar` with a live value and a label.
- Any rule that hides content while waiting belongs inside
  `@media (scripting: enabled)`. Without that gate, a reader with no JavaScript
  gets a page that hides its own content forever.
- Never lock scrolling without a deadline that unlocks it.

---
## Pre-ship checklist

Rendering:

- [ ] A visible final frame in a real browser, production build, both backends if
      you support two.
- [ ] Clean shader and pipeline logs.
- [ ] Correct after a resize, and after a theme change.
- [ ] Phone width, in a real browser.
- [ ] Every device row forced by hand and looked at, including the lowest.
- [ ] The quality ladder stepped down under load and recovered, with no stuck frame.

Startup:

- [ ] Cold Slow 4G run recorded in the protocol format above.
- [ ] No main-thread task over 50 ms.
- [ ] A real control responds in single-digit milliseconds during the build.
- [ ] Exactly one renderer asset, no serial sub-imports, verified against the
      emitted bundle.
- [ ] The hold expires and releases the page on a slow connection.

Lifetime:

- [ ] Second visit reads the generation cache and is measurably faster.
- [ ] Navigate away and back: the scene reattaches without rebuilding.
- [ ] Cross-site back navigation restores the page from bfcache.
- [ ] Navigate away mid-build: nothing leaks, nothing throws.
- [ ] A deploy invalidates the cache and prunes the old entries.

Degradation:

- [ ] JavaScript off: the page reads completely.
- [ ] Renderer forced to fail: the page reads completely.
- [ ] Crash sentinel forced: no worker downloaded, page reads completely.
- [ ] Reduced motion: everything settles, nothing moves, the page still reads.
- [ ] Fallback and success both reported, once per document each.

Accessibility:

- [ ] Canvas is `aria-hidden`.
- [ ] Loading indicator has a role, a label and a live value.
- [ ] Nothing hidden is focusable.
- [ ] Every fact the scene shows exists in text.

---
## Reviewing someone else's scene

In order, because each answer changes what the next one means:

1. How is frame rate measured? If it is RAF callbacks, every other number is
   suspect.
2. How many times per frame is the scene traversed? Count passes before triangles.
3. How many pipeline builds happen at startup? Count instanced batches and unique
   material-plus-attribute combinations.
4. What does the page look like with JavaScript off?
5. What happens on the second visit, and on a back navigation?
6. Where does the main thread block during startup? Record long tasks, do not
   guess.
7. What does the phone build actually decline? If it declines nothing whole, it
   is a smaller desktop build, and it will not hold frame rate.
