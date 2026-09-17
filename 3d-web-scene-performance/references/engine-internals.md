# Engine internals: caches, keys and ceilings

What a renderer keeps between frames and between visits, what it rebuilds
anyway, and how to find out for the engine in front of you.

#### Five caches every renderer has

A modern renderer does not rebuild the scene each frame. It keys work against a
cache and reuses the hit. Almost every engine has these five, under different
names:

| Cache | Holds | Usually keyed on |
| --- | --- | --- |
| Render object | the per-object draw state | object, material, pass, lights |
| Shader module | compiled shader text | the generated source string |
| Pipeline | the compiled GPU pipeline object | shader stages, vertex layout, targets |
| Bind group | the resource bindings for a draw | the resources and their versions |
| Geometry and texture | uploaded buffers | the source object's identity |

The keys matter more than the caches. A key that is too narrow makes two
different objects collide. A key that is too wide stops two identical objects
from sharing, and that is the failure you will actually meet, because it is
silent. Nothing breaks. The scene just takes longer to start.

Shader modules are usually keyed on the generated source, so two objects that
produce the same shader text share one compile. Pipelines are usually keyed on
those modules plus the vertex layout and render target format. Those two layers
are rarely the problem.

The render object cache is where engines get creative, and where the cost hides.

#### The cache key trap

**When a per-object identity is part of a shader or pipeline cache key, sharing a
material stops sharing the shader build.**

This is the single most expensive thing to get wrong, because the fix is
architectural and the symptom is only a slow start. An engine may append the
object's unique id to the key for objects it cannot prove are interchangeable,
and instanced or batched objects are the usual case. The result: one hundred
instanced meshes that all use the same material do one hundred shader builds, not
one.

The probe, which works on any engine:

```
# Count shader builds for N objects sharing one material.
material = makeMaterial()
before = countShaderCompiles()        # hook the engine's compile entry point
for i in 1..N: scene.add(makeInstancedMesh(geometry, material))
renderOneFrame()
after = countShaderCompiles()

assert(after - before == 1)           # if it is N, identity is in the key
```

Run it twice: once with `N` separate objects, once with one object holding `N`
instances. If the first gives `N` compiles and the second gives 1, you have found
the trap, and the fix is to reduce the number of objects rather than the number
of instances.

The cost of one build is small. The cost of the trap is the multiplier. Measure
one build, multiply by your object count, and compare against your startup
budget before you decide it does not matter.

##### What to do about it

Three options, cheapest first:

- **Carry per-object variation in instance attributes instead of in the
  material.** One material, one graph, one build, and each instance still looks
  different. This is the same move as the `color` attribute in
  [frame-budget](frame-budget.md#pipeline-build-cost).
- **Merge.** Flatten small static pieces into one plain mesh. One object, one
  build.
- **Use the engine's batching primitive** if it has one, and check its own cost
  first. See [What the GPU API cannot do](#what-the-gpu-api-cannot-do): a batched
  path on one backend can be slower than the unbatched path on another.

#### Static flags and refresh observers

An engine that decides per object whether to re-upload uniforms usually has an
escape hatch: a flag that says "this object will not change, skip the checks".
That flag usually has a precondition that is not in its documentation.

A common shape: the object's refresh check runs a list of conditions, returns
early on the first one that is true, and the static flag is read near the end.
If any earlier condition is permanently true, for example "this material is built
from shader nodes", the flag is never read. Setting it does nothing, and nothing
tells you so.

The probe:

```
# Does the static flag change anything?
baseline = countBindingUpdates(oneFrame)
for object in scene: object.static = true
withFlag = countBindingUpdates(oneFrame)

assert(withFlag < baseline)           # if equal, the flag does not apply
```

If the counts match, stop using the flag and stop reasoning as though the objects
are skipped. Two engines that both have such a flag can disagree about which
materials it covers, and the same engine can change across versions.

The same probe, run against a material with no custom shader nodes and again
against one with them, tells you the precondition.

#### When your vertex hook runs

An engine that lets you move a vertex has to decide where your code sits in its
own vertex pipeline. There are two orders, and they are both defensible:

- **Your hook first.** You are handed the geometry's own vertex, and the engine
  applies instancing, skinning and morphing to whatever you return.
- **The engine first.** Instancing and skinning are already applied, and you are
  handed the result to read and replace.

Both work. What they change is the space your displacement is written in, and
the engine does not tell you which one you are in. A sway written to bend a leaf
about its own stem, under the first order, bends it about the whole tree under
the second: the amplitude was the vertex's own height, and now it is the
instance's. The shader still compiles and the frame rate does not move, so the
rendered scene is the only place the change shows.

An engine can reorder this without breaking a single API, which is why a version
bump is a reason to re-probe it rather than to read the release notes. A project
that moves its vertex hook is usually doing it for skinning or morphing, and
will describe the change in those terms even when it moved instancing too.

The probe needs no GPU, because the answer is in the generated source:

```
# Where does the engine's own transform sit?
material.vertexHook = (vertex) => vertex + CONSTANT
object = makeInstanced(geometry, material, 4)
source = generateVertexShader(object)      # every engine can emit this

# read the order of the two assignments to the position variable
assert(source.indexOf(instanceTransform) < source.indexOf(CONSTANT))
```

Run it against the version you have and the version you are moving to, and read
the two dumps side by side.

##### Writing a displacement that survives the answer

Whichever order you are in, one of the two vertices you need is missing, so ask
for it by name rather than taking whatever the position variable holds:

- **The shape of the displacement** comes from the geometry's own vertex. Most
  engines expose it separately from the working position, precisely because the
  working position moves.
- **The result** goes back into the space the engine expects next. Under the
  second order that means applying the instance transform's linear part to your
  offset yourself, which is `transformed + M'o` for the offset `o`: the
  translation column is dropped, so the offset is rotated and scaled into the
  instance without being moved to it.

That second step needs the instance transform, and an engine that applies it for
you has no reason to expose it. Read the cost before you reach for it:
rebuilding it as a vertex attribute can mean a second copy of every matrix,
which on a batch of a few hundred thousand instances is tens of megabytes. Measure the
displacement first, and drop it where it is smaller than a pixel.

The reordering can also remove work. A displacement field defined in world space
wants the transformed vertex, not the geometry's: under the second order it is
one matrix out and its inverse back, and the code that used to rebuild the
instance transform to get there deletes.

#### Render bundles

A render bundle records a sequence of draw commands once and replays it. It saves
the cost of encoding commands. It does not save the cost of deciding what to
draw, and it does not save uniform updates.

That distinction is the whole thing. A bundle whose contents still get a full
per-object refresh each frame saves the encoder work and nothing else, which is
usually the smaller half. Before you reach for bundles, measure which half you
are paying.

Typical constraints, worth checking rather than assuming:

- Only drawable objects go in a bundle. Lights and other non-drawable types
  usually have to live outside it.
- The bundle is invalid when its structure changes. Adding or removing an object
  means recording it again.
- The render target format is part of the recording, so a bundle recorded for one
  pass may not replay into another.
- On a fallback backend the bundle may still render but save nothing.

A scene that swaps detail levels as the visitor scrolls is re-recording bundles
at every swap. Price the re-record before you count the saving.

```
# Is the bundle actually reused?
assert(recordCount == 1)              # over many frames, with nothing changing
assert(recordCount > 1)               # after one LOD swap, this should rise by 1
```

#### What no library can cache

**No JavaScript library can keep compiled pipelines between visits.** The browser
graphics API exposes no application-facing pipeline cache. Browsers keep their
own internal cache, usually on disk and usually per browser profile, and it is
invalidated when the browser updates. You cannot pre-warm it, ship it, inspect
it, or measure a hit directly.

So a first-time visitor always pays full shader compilation, in every engine.
This is a platform ceiling, not an engine choice, and it is not a reason to
prefer one library over another.

What follows for the scene:

- Compile before you show. Asynchronous pipeline compilation exists in most
  engines; use it at the end of each stage, not in the frame that needs the
  pipeline. See [Precompile before you show](frame-budget.md#precompile-before-you-show).
- Count shader builds as a startup cost, alongside geometry generation and
  texture work. They compete for the same budget.
- What you **can** cache between visits is generated data: numbers and typed
  arrays. See [persistence](persistence.md#persistence-caching-retention-and-survival).
  That rule is not a limitation of the cache you chose. It is the only thing the
  platform lets you keep.

A second visit is still faster than a first, because the browser's own cache
usually hits. Do not build a budget that depends on it.

#### What the GPU API cannot do

Some costs are not the engine's fault, and blaming the engine sends a day of work
in the wrong direction.

**There is no portable multi-draw.** The older graphics API has an extension that
submits many draws in one call. The newer one does not have an equivalent in its
portable form; where it exists it is an experimental vendor feature behind a
browser flag. So a batched draw path can legitimately be **slower** on the newer
backend than on the older one, on the same device, for the same scene. If you
measure that, you have measured the API gap, not an engine defect, and no change
of library fixes it.

**Indirect draws and compute-written draw arguments are available.** A compute
pass can write draw arguments into a buffer and the draw can read them, so
GPU-side culling is possible. This is not a reason to switch engines either;
mainstream engines expose it.

Before you attribute a backend difference to the engine, check whether the two
backends have the same feature. The probe is to find the call the fast backend
makes and ask whether the slow backend has it at all.

#### The seven questions, answered once

[SKILL.md](../SKILL.md#seven-questions-to-ask-of-any-engine) asks seven
questions of any engine. Here is what the answers tend to look like, and what
each one costs you if you assume wrongly. Re-probe them: engines change, and these are patterns,
not constants.

| Question | Common answer | Cost of assuming wrongly |
| --- | --- | --- |
| What is a pipeline build keyed on? | material and vertex layout, plus object identity for instanced and batched objects | you merge to save compiles and save none, or you split and multiply them |
| What batches automatically? | nothing above the object; instancing and batching are yours to request | you ship far more draws than you counted |
| Which passes traverse the scene? | one per shadow map, plus depth, plus each post-processing step | every triangle costs what you think it does, times the pass count |
| Is there an async compile? | usually yes, and usually not on by default | the first frame after each stage stalls |
| Is there a GPU completion signal? | usually a timestamp query or a queue promise | you measure the callback rate and believe a number that is twice the truth |
| What identity must stay stable? | the object, its material and its geometry, all three | a rebuild you did not ask for, at the worst moment |
| When does your vertex hook run? | it varies, and it moves between versions | your displacement is written in the wrong space and nothing tells you |

The two that bite hardest are the first and the sixth, and they are the same
question asked twice. An engine decides what counts as "the same object", and
everything you can reuse follows from that decision. The seventh leaves a test
suite green, because its symptom is in the rendered frame.

##### A harness for all seven

`tools/probe-engine.mjs` in this skill asks them and prints one line each. It is
engine-agnostic and reads its answers through a small adapter;
`tools/adapters/three.mjs` is a worked one, and writing a second is most of the
porting exercise this section describes. Compare its output before and after an
engine upgrade. None of these answers holds still, and an engine that changes
one rarely says so.

##### Worked example

One production scene, measured in 2025 on a then-current version of one engine,
so treat it as a shape rather than a number: shader assembly in JavaScript was
the largest single startup cost, larger than geometry generation and larger than
texture painting, because every instanced mesh built its own shaders in every
pass. Reducing the number of instanced meshes, rather than the number of
instances, was what moved it.

The engine has since made each build several times cheaper. The key still
contains the object identity. That is the pattern worth carrying: engines
optimise the constant, and leave the multiplier where it is, because removing it
changes their public behaviour.

The same scene was carried across six releases of that engine in 2026, and the
harness above is what that upgrade produced. Three answers had moved and two had
held. Of the three, one was in the migration notes.

Moved:

- The GPU completion call had been removed from the engine's public surface,
  on the argument that it was documented as a synchronisation primitive and was
  not one. It was still the right measurement for backpressure and for the
  completion rate, so the scene kept the measurement and now owns one call per
  backend. This is the one the notes carried.
- A knob had turned from a uniform into a shader constant, because the engine
  started unrolling a loop around it. Writing it now rebuilt a material, so it
  moved out of the runtime quality ladder and into the device table. Its own
  API documentation said so in one line; the migration notes did not.
- The vertex hook had moved to run after instancing. The notes described that
  change for skinned meshes and did not mention instancing. It was found by
  generating the same shader against both versions and reading the order.

Held:

- The cache key still carried object identity for instanced draws, so the
  merge-over-instance architecture stood.
- The static flag still had the same precondition, and the scene's own materials
  still failed it, so it was still a dead end rather than an unused win.

##### Report it properly

Every number in this file is a measurement of one engine at one version on one
device. So is every number you will produce. Before you report one, read
[verification](verification.md#verification), record the conditions with it, and
say which version you measured. A claim about "the engine" that came from one
revision two years ago is worse than no claim, because someone will act on it.

---
