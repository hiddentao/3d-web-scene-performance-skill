# Startup: time to first render

How to get a scene on screen without freezing the page around it.


#### Where the milliseconds go

Measure this before you optimise anything. The order usually surprises people.

| Phase | Typical cost | Who pays |
| --- | --- | --- |
| HTML, CSS, first paint | 0.5-2 s on a throttled connection | network |
| Framework bundle and hydration | 0.3-2 s | network, then main thread |
| Renderer bundle download | 1-3 s | network |
| Backend init, device request | 50-300 ms | main thread or worker |
| Procedural generation | seconds | CPU |
| Texture painting | hundreds of ms each | CPU |
| Shader and pipeline assembly | often the largest single item | CPU |
| GPU uploads, first compile | hundreds of ms | GPU |

Two findings from the hezo.ai scene apply to other scenes too:

- The biggest early win had nothing to do with the renderer. The page shipped all
  twelve translation catalogs before the scene bundle could start. Shipping only
  the active one took the page bundle from 283 KB to 30 KB compressed. The
  renderer's download then finished in about 1.5 s instead of 7.2 s.
- The second biggest win was to stop rebuilding geometry that an earlier build
  stage had already published (put on screen).

Profile the whole page first, not only the renderer.

#### Get the renderer off the main thread

Transfer a fresh canvas to a worker, and do generation, compilation, uploads
and rendering there. The main thread keeps scroll, input, hydration and the DOM.

```
offscreen = canvas.transferControlToOffscreen()
worker.postMessage({ type: "init", canvas: offscreen, width, height, tier }, [offscreen])
```

Rules:

- **Never probe the canvas context before you transfer it.** Once you get a
  context, the canvas cannot be transferred. The failure comes late and is hard
  to understand.
- **The transfer is one way.** If worker startup fails, you cannot use that canvas
  again. Remove it from the DOM. Then make exactly one fallback attempt, on a
  fresh canvas, on the main thread.
- **Choose the device row on the page thread** and send it with `init`. The device
  row is the row of settings for this type of device, from the device settings
  table. A worker has no `matchMedia` and no `screen`. See
  [device tiers](device-tiers.md#device-tiers-lod-and-cost-curves).
- **Keep a main-thread path** for browsers without `OffscreenCanvas` or `Worker`.
  It can use the same builder code. You cannot move or retain that scene later.
- **Render the HTML and start its own animation loop before the scene
  initialises.** The page should be interactive while the worker is still
  downloading.

##### Worker messages

| Direction | Message | Notes |
| --- | --- | --- |
| page -> worker | `init` | canvas, size, device row |
| page -> worker | `update` | camera state, one outstanding at a time |
| page -> worker | `pointer` | carries `sentAt`; the worker drops it if it is stale |
| page -> worker | `visibility`, `resetTiming`, `resize`, `dispose` | |
| worker -> page | `progress` | stage name, and whether the stage has been drawn |
| worker -> page | `frame` | acknowledges an `update` and releases the next one |
| worker -> page | `ready`, `error`, `disposed` | |

To retire a worker, post `dispose`. Wait a limited time (about 1.2 s) for the
`disposed` reply. Then terminate the worker, whether or not the reply came.

#### One download, started early

##### Bundle the worker as one file

If the bundler splits the worker bundle into chunks, the worker must load them
one after another, and each request blocks it. Make the bundler emit one
self-contained file:

- Set the worker entry to disable async chunks.
- Exclude the worker chunk from every split-chunks cache group *and* from the
  top-level chunks filter.
- Then check the emitted bundle. Do not trust the configuration alone.

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

##### Start the download before hydration

Do not make the request wait for the framework. Put a small script in the
document head that constructs the worker at once. Hydration then adopts that
worker (takes it over) instead of constructing a new one.

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

The warm-worker setup must get four things right:

1. **Read the hashed filename from the build manifest at render time.** Never
   hard-code a hash. Fail the build if the manifest does not contain exactly one
   matching asset. That build failure is useful.
2. **Check the gate before you warm the worker.** Warming means constructing the
   worker early so its download starts. If the page has refused this device a
   scene (see [persistence](persistence.md#persistence-caching-retention-and-survival)),
   the head script must return before it constructs anything. A device that is
   refused a scene should not spend a megabyte of a metered connection.
3. **Release an unclaimed worker** on four signals: `pagehide`, a worker error, a
   timeout, and your framework's client-side route change. The first three cover
   plain documents. In a single-page app, a navigation away from the scene's route
   fires none of them. Without the fourth signal, every such navigation leaks a
   worker for the life of the tab:

   ```
   // the hook's name differs per framework; the requirement does not
   onRouteChange(({ from, to }) => {
     if (from.path !== to.path) releaseWarmWorker()
   })
   ```
4. **Adopt the warm worker. Do not construct a second one.** Add a test that
   asserts exactly one worker is ever constructed on the happy path.

#### The cooperative scheduler

A cooperative build does its work in small pieces. Between pieces it yields: it
gives control back to the browser so the page can paint and handle input.

##### Yield across real task boundaries

A `Promise.resolve()` loop is a microtask loop. However often it "yields", the
browser cannot paint or deliver input.

`setTimeout(0)` is a task. But once the nesting level is above 5, the HTML spec
clamps a nested timer to 4 ms, and a cooperative build is nothing but nested
timers. The measured cost per yield is a little above the clamp once you count
dispatch overhead. So a build that yields a few hundred times wastes most of a
second of idle time on every load.

Use a message-channel round trip. It is an ordinary task with no clamp:

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

Where `scheduler.yield()` exists, use it. Keep the message channel as the
fallback.

##### The slice budget

A checkpoint is a call in the build code where the scheduler may yield. A slice
is the work done between two yields, and its budget is how long it may run.
Put many checkpoints in the build (inside loops, between objects), and let the
scheduler decide which ones yield:

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

While the slice is still inside its budget, a checkpoint costs one subtraction.
That is why it is safe to write `if (i % 64 === 0) await checkpoint("...")`
everywhere, including tight loops.

**Forced and published checkpoints never skip.** The loading UI tracks some
stages (its milestones). Each of those stages must use a forced or a published
checkpoint. Otherwise a fast machine skips the stage without a sign, and the
progress indicator stalls. Enforce this with a check:

```
for (milestone of LOADING_MILESTONES) {
  call = findInSource(`checkpoint("${milestone}"` , `publish("${milestone}"`)
  assert(call.includes("force: true") || call.includes("publish: true"))
}
```

##### Yield during a sort

A native sort over a large array holds the thread until it finishes. Sort short
runs, then merge them in bounded pieces and yield between pieces. The result has
the same order.

```
function* sortItems(items, compare) {
  for (start = 0; start < items.length; start += 256) {
    writeBack(items.slice(start, start + 256).sort(compare), start)
    yield
  }
  ...bottom-up merge, yielding every ~2048 comparisons...
}
```

#### Publish the scene in stages

To publish a stage is to compile it, draw it and wait until the GPU has finished
that frame. Order the stages by what the reader looks at first. Each stage must
look complete and consistent on its own.

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

`NEAR_SCENE_MILESTONE` has its own name for a reason. Once it has published,
everything in front of the reader exists. The loading UI can show the canvas at
that point and let the distant stages finish in view. See
[the loading contract](loading-ui.md#the-loading-contract).

##### Publishing takes four steps, in order

```
onPublish(stage):
  prepareBuffers()                                  # any backend-specific fixups
  placeCamera(currentState)
  await renderer.compileAsync(scene, camera)        # so the next frame is not the stall
  renderOneFrame({ ...currentState, delta: 0 })     # the only draw while still building
  await renderer.waitForGPU()                       # distinguish submitted from visible
  markPublished(stage)
```

Compile, then render, then wait. If you report progress when the frame is
submitted instead of when the GPU completes it, the indicator runs ahead of the
picture.

##### Interleaving concurrent builders

Sometimes two builders must take turns. For example, the ground surface comes
before the structures on it, and the structures come before the scatter placed
against them. Use two-phase latches (gates) for this instead of one sequential
build. A builder stops at a gate, and the orchestrator (the code that runs both
builders) opens it:

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

At each gate crossing, both builders are in a known state. That makes it safe to
publish there and to name the point as a milestone.

#### Reusing what earlier stages published

##### The general rules, for any engine

A build split into phases can share work across the phases when all four of
these are true:

1. **Identity is stable.** When a later phase still needs a constructed object,
   it must be the *same* object, not an equal one. Your engine's identity (an
   object reference, a handle, a buffer id) must not change.
2. **Membership is recorded, not recomputed.** Each phase knows which items it has
   already revealed, so a later phase builds only the new items. A `published`
   set per batch is enough.
3. **Selections only grow.** A selection is the set of items a phase reveals.
   Phases reveal the nearest items first, so a later phase never
   withdraws an earlier selection. So when the selection is unchanged, you can
   safely reuse the object.
4. **The swap is atomic.** Nothing may yield between removing the old object and
   adding the new one. A frame rendered in the middle of the swap shows neither
   object.

Your engine may rebuild a pipeline or reupload a buffer when you touch a certain
property. Find out which property (question 6 in
[the six engine questions](../SKILL.md#six-questions-to-ask-of-any-engine)), and
do not touch it on the reuse path. This one check usually decides whether reuse
saves work or silently rebuilds everything anyway.

A common mistake in progressive loading is to rebuild all accumulated batches at
every stage. With five stages, the first stage's geometry is built five times and
uploaded five times.

Instead, record what each stage has already revealed, and give a later stage only
the new pieces:

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

Keep these two properties, and test them:

- **No `await` inside the swap.** If a yield happens during the swap, a published
  frame shows the scene with the old mesh removed and the new one not yet added.
- **Stages publish nearest first, so a selection is never withdrawn.** This is
  why "same selection means reuse the object" is safe.

To test it, run the whole build twice: once normally, and once with reuse forced
off. Assert that the final geometry, draw order and per-instance data are
identical. Then assert that nothing touched a reused mesh's GPU resources again.

In the hezo.ai scene, this cut repeated buffer allocation by 42-44% with exact
scene parity. The number comes from counting allocations during the build, not
from timing, so it is a count and not a wall-clock saving.

#### Generators: one body, two drivers

During startup, procedural painting and generation must be interruptible. In a
test, they must run synchronously. Write the body once as a generator, and give
it two drivers (loops that run the generator):

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

This gives two more benefits. The yielded string is a readable label that the
loading UI can show. And `finally { steps.return() }` gives you cleanup on
cancellation with no extra code. A hand-written loop over an index does not give
you that.

#### Cancellation and disposal

Use one `AbortController` for the whole build. Everything below depends on it.

- **Check the signal at every checkpoint**, and reject any pending yield when the
  signal fires. A cancelled build must not continue for another two seconds.
- **Ignore late callbacks.** Guard every `then` on a GPU promise with a generation
  counter and a disposed flag.
- **Dispose every partial owner exactly once.** An owner is anything you must
  dispose, such as a geometry, a material or a texture. A build aborted at stage
  three owns geometry, materials and textures that are not attached to the scene
  graph. Collect owners as you create them.
  Do not find them by traversing the scene at the end: that misses unpublished
  work and node-only textures.

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

Test cancellation at every publish label. Assert that every owner created and
every owner retained is disposed exactly once, and that the scene ends with zero
children. This test catches more leaks than a profiler does.

#### Keeping the connection clear

- Turn off speculative route prefetching on the page that carries the scene. Also
  turn it off on any connection that the browser reports as constrained. If the
  framework prefetches the rest of the site while the scene downloads, it competes
  with itself for the connection.
- Load only the data the current page needs. See the translation-catalog finding
  at the top of this file.
- Add a `preconnect` for each third-party origin the page contacts during startup,
  so that a cold handshake does not use up part of the startup budget.
- Do not start workers on pages that do not have a scene.

---
