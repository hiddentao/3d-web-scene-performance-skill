# Startup: time to first render

Getting a scene on screen without freezing the page that carries it.


#### Where the milliseconds go

Measure this before optimising anything. The order is usually a surprise.

| Phase | Typical cost | Who pays |
| --- | --- | --- |
| HTML, CSS, first paint | 0.5 - 2 s on a throttled connection | network |
| Framework bundle and hydration | 0.3 - 2 s | network, then main thread |
| Renderer bundle download | 1 - 3 s | network |
| Backend init, device request | 50 - 300 ms | main thread or worker |
| Procedural generation | seconds | CPU |
| Texture painting | hundreds of ms each | CPU |
| Shader and pipeline assembly | **often the largest single item** | CPU |
| GPU uploads, first compile | hundreds of ms | GPU |

Two findings from the reference scene that generalise:

- The biggest early win had nothing to do with the renderer. The page shipped all
  twelve translation catalogs before the scene bundle could start. Shipping only
  the active one took the page bundle from 283 KB to 30 KB compressed and moved
  the renderer's download from 7.2 s to about 1.5 s.
- The second biggest was not rebuilding geometry that an earlier build stage had
  already published.

Profile the page, not the renderer, first.

#### Get the renderer off the main thread

Transfer a fresh canvas to a worker and do generation, compilation, uploads and
rendering there. The main thread keeps scroll, input, hydration and the DOM.

```
offscreen = canvas.transferControlToOffscreen()
worker.postMessage({ type: "init", canvas: offscreen, width, height, tier }, [offscreen])
```

Rules that cost real debugging time to learn:

- **Never probe the canvas context before transferring it.** Getting a context
  makes the canvas ineligible for transfer, and the failure is late and confusing.
- **The transfer is one way.** If worker startup fails, the canvas is spent.
  Remove it from the DOM and make exactly one fallback attempt on a **fresh**
  canvas, on the main thread.
- **Decide the device row on the page thread** and send it with `init`. A worker
  has no `matchMedia` and no `screen`. See [Device tiers, LOD and cost curves](device-tiers.md#device-tiers-lod-and-cost-curves).
- **Keep a main-thread path** for browsers without `OffscreenCanvas` or `Worker`.
  It can be the same builder code; it just cannot be moved or retained later.
- **Render the HTML and start its own animation loop before the scene
  initialises.** The page should be interactive while the worker is still
  downloading.

##### Message contract

| Direction | Message | Notes |
| --- | --- | --- |
| page -> worker | `init` | canvas, size, device row |
| page -> worker | `update` | camera state, one outstanding at a time |
| page -> worker | `pointer` | carries `sentAt`; dropped by the worker if stale |
| page -> worker | `visibility`, `resetTiming`, `resize`, `dispose` | |
| worker -> page | `progress` | stage name, and whether it has been drawn |
| worker -> page | `frame` | acknowledges an `update`, releases the next one |
| worker -> page | `ready`, `error`, `disposed` | |

When retiring a worker, post `dispose`, wait a bounded time (about 1.2 s) for the
`disposed` acknowledgement, then terminate regardless.

#### One download, started early

##### One asset

A worker bundle split into chunks becomes serial blocking requests inside the
worker. Force the bundler to emit one self-contained file:

- Set the worker entry to disable async chunks.
- Exclude the worker chunk from every split-chunks cache group *and* from the
  top-level chunks filter.
- Then verify against the emitted bundle rather than trusting configuration.

```
# audit the real output
stats   = read("public/webpack.stats.json")
assets  = stats.assetsByChunkName["scene-worker"].filter(endsWith(".js"))
assert(assets.length === 1)

ast = parse(read(assets[0]))                       # parse, do not text-match:
walk(ast, node => {                                # shader source contains strings
  assert(node.type !== "ImportExpression")
  assert(!(node.type === "CallExpression" && node.callee.name === "importScripts"))
})
assert(noOtherChunkIncludes(assets[0]))            # and it must not leak into a page bundle
```

##### Started before hydration

The request should not wait for the framework. Emit a small script in the document
head that constructs the worker immediately, and have hydration adopt it.

```
// in <head>, on the page that needs it, serialised from a real function
function warmSceneWorker(url, slotKey, offSlotKey) {
  if (window[offSlotKey]) return                   // this device is gated: spend nothing
  if (window[slotKey] || typeof Worker !== "function") return
  var worker; try { worker = new Worker(url) } catch (e) { return }
  var timer, slot = {
    take: function () { var w = worker; detach(); worker = null; return w },
    dispose: function () { if (worker) { detach(); worker.terminate(); worker = null } }
  }
  function detach() { clearTimeout(timer); removeEventListener("pagehide", slot.dispose)
                      if (window[slotKey] === slot) delete window[slotKey] }
  window[slotKey] = slot
  worker.onerror = slot.dispose
  addEventListener("pagehide", slot.dispose)
  timer = setTimeout(slot.dispose, 120000)         // nobody claimed it: let it go
}
```

Then:

```
worker = takeWarmSceneWorker() ?? new Worker(url, { type: "module" })
```

Four things this must get right:

1. **Read the hashed filename from the build manifest at render time.** Never
   hard-code a hash. Fail the build if the manifest does not contain exactly one
   matching asset - that failure is worth having.
2. **Gate before warming.** If this device is refused a scene (see
   [Persistence: caching, retention and survival](persistence.md#persistence-caching-retention-and-survival)), the head script must return before constructing anything.
   A gated device should not spend a megabyte of a metered connection.
3. **Release an unclaimed worker** on four signals, not three: `pagehide`, a
   worker error, a timeout, **and your framework's client-side route change**.
   The first three cover the plain-document cases. In a single-page app,
   navigating away from the scene's route fires none of them, so without the
   fourth every navigation leaks a worker for the life of the tab:

   ```
   // the hook's name differs per framework; the requirement does not
   onRouteChange(({ from, to }) => {
     if (from.path !== to.path) releaseWarmWorker()
   })
   ```
4. **Adopt, do not duplicate.** Assert in a test that exactly one worker is ever
   constructed on the happy path.

Also add a `preconnect` for any third-party origin the page will contact during
this window, so a cold handshake does not land inside the budget.

#### The cooperative scheduler

##### Yield across real task boundaries

A `Promise.resolve()` loop is a microtask loop. It never lets the browser paint or
deliver input, no matter how many times it "yields".

`setTimeout(0)` is a task, but the HTML spec clamps a nested timer to **4 ms**
once the nesting level exceeds 5, and a cooperative build is nothing but nested
timers. Measured cost per yield runs a little above the clamp once dispatch
overhead is counted. Either way, a build that yields a few hundred times burns
most of a second of pure idle time on every load.

Use a message-channel round trip, which is an ordinary task with no clamp:

```
channel = new MessageChannel()
channel.port1.onmessage = () => queue.shift()()

postTask(run) {
  if (typeof MessageChannel !== "function") { setTimeout(run, 0); return }   // fallback
  queue.push(run)
  channel.port2.postMessage(null)
}

yieldTask(signal) {
  throwIfAborted(signal)
  return new Promise((resolve, reject) => {
    onAbort(signal, reject)
    postTask(resolve)
  })
}
```

`scheduler.yield()` is a better primitive where it exists; keep the message
channel as the fallback.

##### The slice budget

Scatter checkpoints liberally through the build - inside loops, between objects -
and let the scheduler decide which ones actually yield:

```
createScheduler({ budgetMs = 6, onProgress, onPublish, signal }) {
  sliceStart = now()
  return {
    async checkpoint(stage, { force = false, publish = false } = {}) {
      throwIfAborted(signal)
      if (!force && !publish && now() - sliceStart < budgetMs) return   // cheap no-op
      onProgress?.({ stage })
      await yieldTask(signal)
      if (publish) {
        await onPublish?.(stage)
        onProgress?.({ stage, published: true })
        await yieldTask(signal)        // let the submitted frame reach the screen
      }
      sliceStart = now()
    }
  }
}
```

A checkpoint inside a tight loop costs one subtraction when the slice is young.
That is what makes it safe to write `if (i % 64 === 0) await checkpoint("...")`
everywhere.

**Forced and published checkpoints never skip.** Any stage the loading UI depends
on must be one of those two, or a fast machine will silently skip it and the
progress indicator will stall. Enforce that mechanically:

```
for (milestone of LOADING_MILESTONES) {
  call = findInSource(`checkpoint("${milestone}"` , `publish("${milestone}"`)
  assert(call.includes("force: true") || call.includes("publish: true"))
}
```

##### Yield through a sort too

A native sort over a large array monopolises the thread. Sort short runs, then
merge in bounded pieces, yielding between them. The result has the same ordering.

```
function* sortItems(items, compare) {
  for (start = 0; start < items.length; start += 256) {
    writeBack(items.slice(start, start + 256).sort(compare), start)
    yield
  }
  ...bottom-up merge, yielding every ~2048 comparisons...
}
```

#### Progressive publication

Order the stages by what the reader looks at first, and make each one a complete,
coherent slice.

```
LOADING_MILESTONES = [
  "renderer:ready",         // nothing drawn yet, but the API is live
  "floor",                  // the ground under the camera
  "entrance:complete",      // the structure directly ahead
  "near-detail",            // everything in front of the reader
  "distant",                // the far scenery
]
NEAR_SCENE_MILESTONE = "near-detail"
```

`NEAR_SCENE_MILESTONE` earns its own name: once it has published, everything in
front of the reader exists. The loading UI can reveal the canvas there and let the
distant stages finish in view. See [The loading contract](loading-ui.md#the-loading-contract).

##### Publishing is four steps, in order

```
onPublish(stage):
  prepareBuffers()                                  # any backend-specific fixups
  placeCamera(currentState)
  await renderer.compileAsync(scene, camera)        # so the next frame is not the stall
  renderOneFrame({ ...currentState, delta: 0 })     # the only draw while still building
  await renderer.waitForGPU()                       # distinguish submitted from visible
  markPublished(stage)
```

Compile, then render, then wait. Reporting progress on submission rather than on
completion makes the indicator run ahead of the picture.

##### Interleaving concurrent builders

If two builders must interleave - a ground surface before the structures on it,
before the scatter that sits against those - use two-phase latches rather than one
sequential build:

```
gate = { arrived: false, released: false }
pause()          # builder: mark arrived, then block until released
waitForArrival() # orchestrator: resume once the builder reaches this point
release()        # orchestrator: let the builder continue
```

```
environment runs to "floor"           -> pauses
orchestrator sees arrival             -> starts architecture
architecture runs to "entrance"       -> pauses
orchestrator releases the floor gate  -> surface builder adds near detail
...
```

Each gate crossing is a point where both builders are in a known state, which is
exactly what makes it safe to publish and to name as a milestone.

#### Reusing what earlier stages published

##### The contract, stated without an engine

Before the implementation below, the general form. A build split into phases
shares work across them when all four hold:

1. **Identity is stable.** A constructed object that a later phase still needs is
   the *same* object, not an equal one. Whatever your engine uses for identity -
   an object reference, a handle, a buffer id - must not change.
2. **Membership is recorded, not recomputed.** Each phase knows which items it has
   already revealed, so a later phase builds only what is new. A `published` set
   per batch is enough.
3. **Selections only grow.** Phases reveal nearest first, so an earlier phase's
   selection is never withdrawn. That is what makes "the selection is unchanged,
   so reuse the object" a sound inference rather than a guess.
4. **The swap is atomic.** Between removing the old object and adding the new
   one, nothing may yield. A frame rendered mid-swap shows neither.

If your engine rebuilds a pipeline or reuploads a buffer when a property is
touched, find out which property - question 6 in
[Six questions to ask of any engine](../SKILL.md#six-questions-to-ask-of-any-engine) - and
leave it alone on the reuse path. That single check is usually the difference
between a reuse optimisation that works and one that quietly rebuilds everything
anyway.

Rebuilding accumulated batches at every stage is the classic progressive-loading
mistake: five stages means the first stage's geometry is built five times and
uploaded five times.

Track what each stage has already revealed, and give a later stage only the new
pieces:

```
publish(label, threshold, final):
  for (batch of batches) {
    fresh = indices(batch).filter(i =>
      !batch.published.has(i) && (final || batch.position[i].z >= threshold))
    ...build meshes for `fresh` only...
  }

  # merged surfaces: if the selection is unchanged, keep the existing mesh object
  if (sameSelection(previous, selected)) reuse(existingMesh)
  else                                   build(mergeGeometries(selected))

  # --- no await from here to the end of the swap ---
  removeReplaced(); addNew(); reorderChildren()
  fresh.forEach(i => batch.published.add(i))
  # --- swap complete: a preview frame can only ever see one ordered stage ---

  await checkpoint(label, { publish: true })
```

Two properties to preserve, and to test:

- **No `await` inside the swap.** If a yield lands mid-swap, a published frame
  renders a scene with the old mesh removed and the new one not yet added.
- **Stages publish nearest first, so a selection is never withdrawn.** That is
  what makes "same selection means reuse the object" sound.

Test it by running the whole build twice - once normally, once with reuse forced
off - and asserting the final geometry, draw order and per-instance data are
identical. Then assert that a reused mesh's GPU resources were never touched
again.

In the reference implementation this cut repeated buffer allocation by 42-44%
with exact scene parity - measured by counting allocations in the build, not by
timing, so it is a count rather than a wall-clock saving.

#### Generators: one body, two drivers

Procedural painting and generation want to be interruptible during startup and
synchronous in a test. Write the body once as a generator, and give it two
drivers.

```
function* paintGroundSteps() {
  for (i = 0; i < 60000; i++) {
    if (i % 512 === 0) yield "Painting ground texture"   // the yield value is the label
    drawOneBlade()
  }
  return toTexture(canvas)
}

// synchronous driver: tests, and the non-cooperative path
function finish(steps) { let r; do { r = steps.next() } while (!r.done); return r.value }

// cooperative driver: startup
async function finishAsync(steps, checkpoint) {
  try {
    for (;;) {
      const r = steps.next()
      if (r.done) return r.value
      await checkpoint(r.value)
    }
  } finally { steps.return() }          // cancellation must run the generator's cleanup
}
```

Two benefits beyond the yielding. The yielded string is a human-readable label the
loading UI can show. And `finally { steps.return() }` gives you cancellation
cleanup for free, which a hand-rolled index-based loop does not.

#### Cancellation and disposal

Everything below hangs off one `AbortController` for the whole build.

- **Check the signal at every checkpoint**, and reject any pending yield when it
  fires. A cancelled build must not continue for another two seconds.
- **Ignore late callbacks.** Guard every `then` on a GPU promise with a generation
  counter and a disposed flag.
- **Dispose every partial owner exactly once.** A build aborted at stage three
  owns geometry, materials and textures that are not attached to the scene graph.
  Collect owners as you create them - not by traversing the scene at the end, which
  misses unpublished work and node-only textures.

```
dispose():
  if (disposed || disposalRequested) return
  disposalRequested = true
  controller.abort()
  if (!initialising) cleanup()      // if init is in flight, let it finish, then clean up

cleanup():
  disposed = true
  for (root of scene.children) root.userData.disposeBuilder?.()   // builder-owned first
  collect geometries, materials, textures from the graph and from the owner sets
  dispose each exactly once
  if (rendererInitialised) renderer.dispose()                     // never on a failed init
  canvas.remove()
```

Test cancellation at **every** publish label, asserting that every owner created
and every owner retained is disposed exactly once and the scene ends with zero
children. That test found more real leaks than any profiler.

#### Keeping the connection clear

- Turn off speculative route prefetching on the page that carries the scene, and
  on any connection the browser reports as constrained. Prefetching the rest of
  the site while the scene downloads is the framework competing with itself.
- Load only the data the current page needs. See the translation-catalog finding
  at the top of this file.
- Preconnect to third-party origins the page will use during startup.
- Do not start workers on pages that do not have a scene.

---
