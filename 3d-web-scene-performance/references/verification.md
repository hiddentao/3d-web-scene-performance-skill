# Verification

How to measure, what to test without a GPU, and the browser limits that will bite.


#### Measuring honestly

**Every number carries its conditions.** A frame rate without a viewport, a device
pixel ratio, a CPU throttle setting and a scene position is not a measurement. Write
them down beside the number, every time:

```
118 fps, 1920x1071, DPR 1.5, no CPU throttle, mid-scene camera, desktop (M-series)
```

**Isolate the subject.** Two copies of a scene rendering at once - a preview
harness and the real page - halve the frame rate and tell you nothing. Check what
is actually running before recording anything.

**One machine is one data point.** The reference scene reached 120 fps on a
high-end laptop and had never been measured on a physical phone. Say which it was.

#### The startup measurement protocol

1. Production build, served as production serves it. A development build measures
   the development server.
2. Chrome DevTools, **Network throttling with a real preset** (Slow 4G), cache
   disabled. A server-side per-response delay is not the same network model: it
   gets the latency wrong and the bandwidth sharing completely wrong.
3. Record CPU throttle explicitly, even when it is 1x.
4. Capture, from navigation start:
   - first contentful paint,
   - when the renderer bundle's request starts and finishes,
   - first complete 3D slice on screen,
   - each build milestone,
   - full readiness,
   - request count and total bytes,
   - **main-thread long tasks** (over 50 ms) with their attribution,
   - input responsiveness during the build: click a control, record the delay.
5. Repeat cold and warm. A warm visit exercises the generation cache, which is a
   different code path.
6. Compare against the same protocol, not against yesterday's memory.

A worked before/after in this format is in [Budget arithmetic](../SKILL.md#budget-arithmetic).

##### Prove input responsiveness, do not assume it

"No long tasks" and "the UI is responsive" are different claims. Interact with a
real control during the build and record the response time. In the reference
implementation, measured in Chrome on a desktop machine under the Slow 4G preset
with no CPU throttle, two page controls responded in 4-7 ms while distant geometry
was still generating. Before the renderer moved off the main thread, the same page
under the same conditions showed main-thread stalls up to 744 ms.

#### What a frame counter cannot tell you

| Question | Instrument |
| --- | --- |
| Is the GPU keeping up? | Completion latency, not frame count. See [The frame budget](frame-budget.md#the-frame-budget) |
| Is the final image correct? | Screenshots, in both themes, after a resize |
| Did a shader fail? | The console, in the production build, on every backend |
| How much work per frame? | Draw calls and triangles from the renderer's own counters |
| Is the scene leaking? | Repeated navigation in and out, watching memory |
| Does the degraded tier work? | Force it and look. It is never exercised on your machine |

**Raw-source shader tests cannot prove production rendering works.** Confirm a
visible final frame in a real browser, with clean shader and pipeline logs, after
a resize, in both themes, at phone width.

**Stress the quality ladder deliberately.** Force the renderer slow, watch it step
down through every tier, then let it recover and watch it step back up. That test
found a persistent black frame on shadow-map resize that normal use never
triggered - the frame count and console were both clean while the canvas was
black.

#### Tests that need no GPU

More of a 3D scene is testable off-GPU than people expect. These patterns each
caught a real regression.

##### Structural comparison of a node graph

A shader graph built with a node API is assembled on the CPU. Only rendering needs
hardware. Walk it and compare a signature:

```
signature(node) {
  out = []
  walk(node, n => out.push(n.constructor.name + (n.op ? ":" + n.op : "")))
  return out.join(" ")
}

assert(signature(buildComposedForm()) === signature(buildOriginalExpression()))
```

**Write the control test first.** Build the *same* form twice and assert the
signatures match. Without that, a green run proves nothing.

```
assert(signature(build()) === signature(build()))     // the control
```

This matters because the obvious primitive does not work: a cache key that carries
per-instance identity yields a different value for the same expression built
twice, and therefore reports every pair of graphs as different. Check what your
engine's key actually contains before trusting it.

Keep the graph in a module that takes no renderer. That is what makes it reachable
from a test at all.

##### Compile shader sources against the real backend builder

Instantiate the engine's node builder for each backend and compile. No canvas, no
device:

```
for (backend of ["webgpu", "webgl"]) {
  code = compileWithRealNodeBuilder(myNode, backend)
  assert(!code.includes("textureDimensions(depth, "))   // the illegal overload
  assert(count(code, "textureLoad") === 9)
}
```

This reproduced a real WebGPU failure: the engine generated a
`textureDimensions(t, level)` call for a multisampled depth texture, which WGSL
forbids. It also proved the WebGL path was byte-for-byte unchanged by the fix.

##### Tier ladder monotonicity

See [Device tiers, LOD and cost curves](device-tiers.md#device-tiers-lod-and-cost-curves). Cheap, and it catches the commonest tier bug.

##### Milestone reachability by source scan

Scan the builder sources for the call that reports each milestone and assert it is
forced or published. See [Startup: time to first render](startup.md#startup-time-to-first-render).

##### Build-output audit

Parse the emitted bundle and assert its shape - one asset, no dynamic imports, no
`importScripts`, not duplicated into a page bundle. **Parse it, do not text-match**:
shader source contains strings that look like anything you grep for.

##### Cache exactness

`structuredClone` the record and deep-compare. Assert every field is a number or a
typed array. Assert record strides. See [Persistence: caching, retention and survival](persistence.md#persistence-caching-retention-and-survival).

##### Geometry parity across an optimisation

Run the build twice - once with the optimisation, once with it forced off - and
compare final geometry, draw order and per-instance data. Then assert the reused
objects' GPU resources were never touched again. This is how a geometry-reuse
optimisation is proved safe.

##### Cancellation at every stage

Abort at each publish label in turn. Assert everything created and everything
retained is disposed exactly once and the scene ends with zero children.

##### Population sweeps

Generation is usually pure arithmetic. Run it under a plain JS runtime and count
the output before choosing a knob value. Seconds, not minutes.

#### Testing after the build transforms your code

A shader that compiles from source can fail in production because the bundler
transformed the class that built it.

Two real failures from the reference scene, both invisible to source-level tests:

- **Loose class transforms break native subclassing.** A bundler compiling
  `class MyNode extends Node` in loose mode produced a constructor that the
  engine's native base class rejected. The fix was to construct the base type
  directly and attach behaviour, rather than subclass it.
- **Parameter destructuring in a shader function** was transformed into a form the
  node system read differently, silently changing what the shader computed. Named
  layout inputs had to use object destructuring, not array or index access.

So: **run the file through the real production build pipeline inside the test.**

```
config = loadRealBabelConfig()                   // the project's own preset and browserslist
compiled = transform(read("myShaderNode.js"), config)
assert(evaluate(compiled).buildsWithoutThrowing())

// and prove the test can fail: compile a deliberately broken sibling the same way
assert(throws(() => evaluate(transform(read("brokenSubclassVariant.js"), config))))
```

That last line is the part people skip. A test that cannot fail is not a test.

#### Browser and platform limits

| Limit | Value | Consequence |
| --- | --- | --- |
| Nested `setTimeout` clamp | Exactly 4 ms once nesting exceeds 5 levels (HTML spec) | Chained `setTimeout(0)` yields cost most of a second over a build. Use a message channel or `scheduler.yield()` |
| WebGL2 uniform block size | 16 KiB guaranteed; engines often assume 64 KiB | An instanced mesh with a few hundred to ~1000 instances can exceed what the device allows. Pad the instance buffer past the engine's threshold to force its instanced-attribute path |
| `navigator.deviceMemory` | Chromium-only, and clamped to 8 on Chrome for Android | Useless for telling a phone from a desktop. Only useful for spotting a genuinely low-memory desktop |
| `navigator.hardwareConcurrency` | Commonly 8 on both | Same |
| `navigator.connection` | Chromium-only (not Safari, not Firefox) | A slow-connection shortcut must be a shortcut, never the only mechanism |
| `localStorage` | Throws in some private modes | Wrap every access |
| IndexedDB | Can be blocked, full, or never open | Time-box the open; treat a null cache as normal |
| `transferControlToOffscreen` | One way; fails if a context was already obtained | Never probe the context first. Keep a fresh canvas for the one fallback attempt |
| `devicePixelRatio` | Commonly 3 on phones | Clamp per device row. A phone at ratio 3 draws nine times the pixels of ratio 1 |
| Mobile tab memory | A few hundred MB before the OS kills the tab | Kills run no callback and send no event. See the crash sentinel in [Persistence: caching, retention and survival](persistence.md#persistence-caching-retention-and-survival) |
| bfcache disqualifiers | `no-store` on the document; historically an `unload` listener, which Chrome is removing as it deprecates `unload` - verify current status | Use `pagehide`; use `max-age=0, must-revalidate` |
| WebGPU device loss | Can happen at any time | Handle `onDeviceLost` and fall back rather than freezing |
| Shadow attachment resize | Produced persistent black frames on a WebGPU backend | Fix shadow map dimensions after initialisation |
| iOS / mobile WebKit iframe sizing | Sizes a frame to its content and ignores inner scrolling; desktop Safari differs | If the scene is framed, set `width: 1px; min-width: 100%` and scroll the wrapper |
| `@media (scripting: enabled)` | Matches only when scripts run | The correct gate for any rule that hides content while loading |

#### Keep the checks running, and verify your own sources

Three failure modes that have nothing to do with rendering, and each one silently
invalidates the work above.

**An unautomated check rots.** Every audit in this section is worth writing and
worthless unrun. The project these examples come from has a careful renderer test
suite, a bundle audit and a cache-exactness test - and no CI job, no pre-push
hook and no required status check runs any of them. Its commit hook verifies that
a human *typed a sentence claiming* they ran the checks. Wire each check into
something that executes it at the moment you write it, or you are maintaining
documentation, not verification.

**A remote-tracking ref is a snapshot, not the remote.** `origin/main` in a
long-lived clone is whatever was last fetched. Any claim about what is deployed
comes from `git ls-remote` or the forge's API. This is not hypothetical: during
the audit that produced this section, a stale `origin/main` led to a confident,
wrong statement that a shipped feature was unmerged.

**A delegated finding is a claim until you reproduce it.** If you fan work out to
other agents or colleagues, spot-check the specifics before you act on them. In
the audit behind this document, one reviewer of five produced a quotation that
did not exist in the file it was attributed to, and another asserted a branch
state that a single command disproved. Both reports were otherwise accurate,
which is exactly what makes the habit necessary - the useful ones and the wrong
ones arrive in the same format.
