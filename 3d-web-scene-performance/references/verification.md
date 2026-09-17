# Verification

How to measure performance, what to test without a GPU, and the browser limits a
3D scene runs into.

#### Measuring

**Record the conditions with every number.** A frame rate is only a measurement
when it comes with the viewport, the device pixel ratio, the CPU throttle setting
and the camera position in the scene. Write them next to the number every time:

```
118 fps, 1920x1071, DPR 1.5, no CPU throttle, mid-scene camera, desktop (M-series)
```

**Measure one scene at a time.** If two copies of the scene render at once (for
example a preview harness and the real page), the frame rate halves and the
number tells you nothing. Check what is running before you record anything.

**One machine is one data point.** The hezo.ai scene reached 120 fps on a
high-end laptop and was never measured on a physical phone. Always say which
device a number comes from.

#### Startup measurement protocol

1. Use the production build, served the way production serves it. A development
   build measures the development server.
2. In Chrome DevTools, turn on network throttling with a real preset (Slow 4G)
   and disable the cache. A delay added to each response on the server is a
   different network model. It gets the latency wrong, and it gets bandwidth
   sharing completely wrong.
3. Record the CPU throttle setting, even when it is 1x.
4. Capture these times and values, from navigation start:
   - first contentful paint
   - when the request for the renderer bundle starts and finishes
   - the first complete 3D slice on screen (the first part of the scene that
     looks finished)
   - each build milestone (each named stage of the build)
   - full readiness
   - request count and total bytes
   - main-thread long tasks (over 50 ms), with their attribution
   - input response during the build: click a control and record the delay
5. Repeat for a cold visit and a warm visit. A warm visit reads from the
   generation cache (the stored output of scene generation), which is a
   different code path.
6. Compare against runs of the same protocol, not against numbers you remember.

[Budget arithmetic](../SKILL.md#budget-arithmetic) has a worked before-and-after
example in this format.

##### Measure input response directly

"No long tasks" and "the UI is responsive" are different claims. Use a real
control during the build and record how long it takes to respond. The hezo.ai
scene was measured in Chrome on a desktop machine, with the Slow 4G preset and no
CPU throttle. Two page controls responded in 4-7 ms while distant geometry was
still generating. Before the renderer moved off the main thread, the same page
under the same conditions had main-thread stalls of up to 744 ms.

#### What a frame counter cannot tell you

| Question | Instrument |
| --- | --- |
| Is the GPU keeping up? | Completion latency, not frame count. See [the frame budget](frame-budget.md#the-frame-budget) |
| Is the final image correct? | Screenshots in both themes, after a resize |
| Did a shader fail? | The console, in the production build, on every backend |
| How much work does each frame do? | Draw calls and triangles from the renderer's own counters |
| Is the scene leaking? | Navigate in and out many times and watch memory |
| Does the degraded tier work? | Force that tier and look at it. Your own machine never runs it |

**Shader tests on raw source do not prove that production rendering works.**
Confirm a visible final frame in a real browser, with clean shader and pipeline
logs, after a resize, in both themes and at phone width.

**Stress the quality ladder on purpose.** The quality ladder is the ordered list
of quality levels that the renderer steps through as the frame rate changes.
Force the renderer to run slowly and watch it step down through every level. Then
let it recover and watch it step back up. This test found a black frame that
stayed on screen after a shadow-map resize, which normal use never triggered. The
frame count and the console were both clean while the canvas was black.

#### Tests that need no GPU

You can test more of a 3D scene without a GPU than you might expect. Each pattern
below caught a real regression.

##### Compare the structure of a node graph

A shader graph built with a node API is assembled on the CPU. Only rendering
needs a GPU. Walk the graph and compare signatures:

```
signature(node) {
  out = []
  walk(node, n => out.push(n.constructor.name + (n.op ? ":" + n.op : "")))
  return out.join(" ")
}

assert(signature(buildComposedForm()) === signature(buildOriginalExpression()))
```

**Write the control test first.** Build the same form twice and assert that the
signatures match. Without this control, a passing test proves nothing.

```
assert(signature(build()) === signature(build()))     // the control
```

The control matters because the obvious tool can fail. A cache key that includes
per-instance identity gives a different value for the same expression built
twice, so it reports every pair of graphs as different. Check what your engine's
key contains before you rely on it.

Keep the graph in a module that does not need a renderer, so a test can reach it.

##### Compile shaders with the real backend builder

Create the engine's node builder for each backend and compile. You need no canvas
and no device:

```
for (backend of ["webgpu", "webgl"]) {
  code = compileWithRealNodeBuilder(myNode, backend)
  assert(!code.includes("textureDimensions(depth, "))   // the illegal overload
  assert(count(code, "textureLoad") === 9)
}
```

This test reproduced a real WebGPU failure. The engine generated a
`textureDimensions(t, level)` call for a multisampled depth texture, which WGSL
does not allow. The same test proved that the fix left the WebGL path
byte-for-byte unchanged.

##### Tier ladder monotonicity

The device table holds one row of settings for each class of device, and each
setting in it is a knob. Assert that every knob changes in one direction only as
you move down the tiers. See [device tiers](device-tiers.md#device-tiers-lod-and-cost-curves).
The test is cheap, and it catches the most common tier bug.

##### Check milestones by scanning the source

Scan the builder source for the call that reports each milestone. Assert that
each call is forced or published, the two kinds of checkpoint that the scheduler
never skips. See [startup](startup.md#startup-time-to-first-render).

##### Check the build output

Parse the emitted bundle and assert its shape: one asset, no dynamic imports, no
`importScripts`, and no copy of it inside a page bundle. **Parse the bundle, do
not text-match it.** Shader source contains strings that look like anything you
grep for.

##### Cache exactness

Pass the record through `structuredClone` and deep-compare the result. Assert
that every field is a number or a typed array. Assert the record strides (how
many values each item takes up in an array). See
[persistence](persistence.md#persistence-caching-retention-and-survival).

##### Same geometry with and without an optimisation

Run the build twice, once with the optimisation and once with it forced off.
Compare the final geometry, draw order and per-instance data. Then assert that
the GPU resources of reused objects were never touched again. This is how you
prove that a geometry-reuse optimisation is safe.

##### Cancellation at every stage

A publish label names a point where the build shows a finished stage on screen.
Abort the build at each publish label in turn. Assert that everything created and
everything retained is disposed exactly once, and that the scene ends with zero
children.

##### Count what generation produces

Generation is usually pure arithmetic. Run it in a plain JS runtime and count the
output before you choose a knob value. This takes seconds.

#### Test the production build

A shader that compiles from source can still fail in production, because the
bundler transformed the class that builds it.

The hezo.ai scene had two failures of this kind, and source-level tests caught
neither:

- Loose class transforms break native subclassing. A bundler compiled
  `class MyNode extends Node` in loose mode and produced a constructor that the
  engine's native base class rejected. The fix was to construct the base type
  directly and attach behaviour to it, instead of subclassing it.
- Parameter destructuring in a shader function was transformed into a form that
  the node system read differently. This silently changed what the shader
  computed. Named layout inputs had to use object destructuring, not array or
  index access.

**Run the file through the real production build pipeline inside the test.**

```
config = loadRealBabelConfig()                   // the project's own preset and browserslist
compiled = transform(read("myShaderNode.js"), config)
assert(evaluate(compiled).buildsWithoutThrowing())

// and prove the test can fail: compile a deliberately broken sibling the same way
assert(throws(() => evaluate(transform(read("brokenSubclassVariant.js"), config))))
```

Do not skip the last assertion. A test that cannot fail is not a test.

#### Browser and platform limits

| Limit | Value | Consequence |
| --- | --- | --- |
| Nested `setTimeout` clamp | Exactly 4 ms once nesting exceeds 5 levels (HTML spec) | Yielding with chained `setTimeout(0)` calls costs most of a second over a build. Use a message channel or `scheduler.yield()` |
| WebGL2 uniform block size | 16 KiB guaranteed; engines often assume 64 KiB | An instanced mesh with a few hundred to ~1000 instances can exceed what the device allows. Pad the instance buffer past the engine's threshold to force its instanced-attribute path |
| `navigator.deviceMemory` | Chromium-only, and clamped to 8 on Chrome for Android | Cannot tell a phone from a desktop. Useful only to spot a desktop with little memory |
| `navigator.hardwareConcurrency` | Commonly 8 on phones and desktops | Cannot tell a phone from a desktop either |
| `navigator.connection` | Chromium-only (not Safari, not Firefox) | Use it only as an extra shortcut for slow connections, never as the only mechanism |
| `localStorage` | Throws in some private modes | Wrap every access |
| IndexedDB | Can be blocked, full, or never open | Put a time limit on the open; treat a null cache as normal |
| `transferControlToOffscreen` | One way; fails if a context was already obtained | Never probe the context first. Keep a fresh canvas for the one fallback attempt |
| `devicePixelRatio` | Commonly 3 on phones | Clamp it in each device row. A phone at ratio 3 draws nine times the pixels of ratio 1 |
| Mobile tab memory | A few hundred MB before the OS kills the tab | A kill runs no callback and sends no event. See the crash sentinel (a stored marker that shows, on the next load, that the last build never finished) in [persistence](persistence.md#persistence-caching-retention-and-survival) |
| bfcache disqualifiers | `no-store` on the document; in the past also an `unload` listener (Chrome is removing this as it deprecates `unload`, so check the current status) | Use `pagehide`; use `max-age=0, must-revalidate` |
| WebGPU device loss | Can happen at any time | Handle `onDeviceLost` and fall back, so the scene does not freeze |
| Shadow attachment resize | Produced persistent black frames on a WebGPU backend | Keep shadow map dimensions fixed after initialisation |
| iOS / mobile WebKit iframe sizing | Sizes a frame to its content and ignores inner scrolling; desktop Safari behaves differently | If the scene is in a frame, set `width: 1px; min-width: 100%` and scroll the wrapper |
| `@media (scripting: enabled)` | Matches only when scripts run | Put any rule that hides content during loading inside this query |

#### Keep checks running and confirm the facts

**Run every check automatically.** When you write a check, wire it into something
that runs it: a CI job, a pre-push hook or a required status check. The hook or
job must run the checks itself; asking a person to confirm they ran them does not
count. A check that nothing runs stops catching regressions.

**Check the remote for what is deployed.** In a long-lived clone, `origin/main`
is whatever was last fetched, and a stale copy can make a shipped feature look
unmerged. Take any claim about what is deployed from `git ls-remote` or the
forge's API.

**Reproduce findings from other agents or colleagues before you act on them.**
Correct and incorrect findings arrive in the same format, so check the specifics
yourself. Confirm that a quotation exists in the file it is attributed to, and run
the command that shows a claimed branch state.
