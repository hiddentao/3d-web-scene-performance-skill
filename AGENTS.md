# 3D web scene performance

Guidance for building real-time 3D scenes on web pages. This file is the
fallback for agents with no Agent Skills support. If your tool does support
skills, install the `3d-web-scene-performance/` directory instead, which carries the
full text across seven references - it carries the full
text with the detail loaded only when a task needs it.

## The rules

**1. Measure completed frames, not callbacks.** `requestAnimationFrame` keeps
firing at display rate while the GPU falls behind, so a RAF counter reports
60 fps on a device drawing 22. Count frames the GPU has finished and adapt on the
lower of the two rates.

**2. Bound work in flight.** Never submit a frame while two are unfinished, and
never keep more than one camera update in flight to an async renderer. Unbounded
submission converts frame time into input latency and hides the overload from
your own metrics.

**3. One table per build, not branches at call sites.** Every device-class
decision lives in one table with one row per build. A branch at each call site
drifts, and a single `quality` scalar cannot express a row that wants a third of
the scatter at full surface resolution.

**4. A declined pass is a whole pass, not a smaller one.** Shadows, reflections,
ambient occlusion and post chains each cost a full scene traversal plus render
targets. Decline them together, and make the code skip the object entirely
rather than configuring it to zero.

**5. The page must read without the scene.** No JavaScript, a failed renderer, a
device that died last time, a browser without the API - all land on one static
path that still says everything the page says. Build that path first; it is also
your SSR output and your crawler's view.

**6. Publish front to back, in complete slices.** Order build stages by what the
reader looks at first. Each stage must be renderable and coherent, with a real
task boundary between them so input, layout and paint can run.

**7. Hold for a deadline, not for completion.** Decide in advance how long the
reader waits. Past that, show the page and let the scene arrive underneath.
Never gate content on work whose duration you do not control.

**8. Cache generated data, never engine objects.** Numbers and typed arrays
survive storage; meshes, materials and GPU handles do not. A cache hit must
replay exactly what generation returns, through the same code path.

**9. Verify after your build tools have touched the code.** A shader that
compiles from source can still fail in production because the bundler
transformed the class that built it. Test the emitted bundle.

## Before reporting a performance number

Every number carries its conditions: viewport, device pixel ratio, CPU throttle,
and where in the scene it was measured. A frame rate without them is not a
measurement. Use real network presets rather than per-response delays, and
isolate the subject - two copies of a scene rendering at once tell you nothing.

## What this cannot give you

Scene-specific values, product judgement, and defects that only a rendered
comparison finds. It transfers method, not numbers. Treat each rule as a strong
prior worth testing.
