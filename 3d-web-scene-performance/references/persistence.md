# Persistence: caching, retention and survival

How to make the second visit fast, make back navigation instant, and stop a
crash from repeating on the next load.


#### Three different lifetimes

People often confuse these three, but each one solves a different problem.

| Mechanism | Survives | Costs | Solves |
| --- | --- | --- | --- |
| Generation cache (IndexedDB) | Reloads, new tabs, days | Disk, and a serialisation round trip | Recomputing the same arithmetic |
| Scene retention (in memory) | In-site navigation within one document | Hundreds of MB to a GB of worker and GPU memory | Rebuilding on return |
| Back/forward cache (the browser's) | Cross-site back navigation | Nothing, if the page stays eligible | Everything, instantly |

Use all three. They do not overlap.

#### Caching generated data

##### What may be stored

**Numbers and typed arrays only.** Do not store engine objects, GPU handles or
DOM nodes. A cached value must come back identical after a `structuredClone`
round trip.

```
assert(Object.values(record).every(v => typeof v === "number" || ArrayBuffer.isView(v)))
assert(deepEqual(record, structuredClone(record)))
```

**Do not cache anything whose round trip is not exact.** Canvas-painted textures
are the trap. Pixels read back from a 2D canvas are not guaranteed to be byte
identical across engines and versions, especially partially transparent pixels.
A cache that returns a nearly identical texture is worse than no cache, because
the difference stays invisible until one day it shows.

Good candidates: generated vertex positions and indices, placement records,
heightmaps and noise fields computed in plain arithmetic.

##### A cache hit must build exactly what a miss builds

One rule makes a cache safe: hits and misses must build meshes and textures
through the same code after the cache lookup.

```
async function cached(key, generate) {
  const value = cache?.get(key) ?? await generate()   // short-circuits generate on a hit
  cache?.put(key, value)                              // put() ignores keys already present
  return value
}
```

A hit and a miss then differ only in whether `generate` ran. Everything
downstream gets the same input, so it behaves the same by construction.

##### Key by the content hash of the generating code

The cache must invalidate when the code that fills it changes. Take the hash
from the bundler's output file name:

```
version = /scene-worker-([0-9a-f]{8,})\.js$/.exec(scriptPath)?.[1]
if (!version) return null            // dev build, or a main-thread path: do not cache
key     = `${version}|${localKey}`
```

This has two useful effects. A development build has no hash, so it is never
cached and you never debug a stale cache. A main-thread fallback has no worker
script, so it is never cached either.

Put every parameter that changes the output into the local key:

```
`surface:${index}:${quality}:${radial}x${levels}:s${spacing}`
```

A device row (the settings for one class of device) that changes a generation
parameter then gets its own entries and never reads another row's.

##### Delete older builds' entries on write

After a deploy, every old entry only wastes the user's storage quota.

```
flush():
  for ([key, value] of pending) { await writeOne(key, value); await yieldTask() }
  cursor over all keys:
    if (!key.startsWith(currentVersionPrefix)) delete(key)
```

Yield between writes so the sweep does not cost frames. The sweep needs to run
only when something was written. After a deploy, the first visit always writes.

##### Write after the scene is ready

```
onReady()
cache?.flush()        // fire and forget; never awaited by the build
```

Saving what this visit generated must not slow this visit down. Only the next
visit benefits from it.

##### Treat storage as best-effort

In real use, every storage path fails somewhere: private browsing, disabled
storage, a full quota, a blocked upgrade, a database that never opens.

```
open():
  race(indexedDB.open(...), timeout(1500))     // a blocked open must not hang the build
  catch => return null                         // and then close the connection if it arrives late
flush():
  catch => pending.clear()                     // drop it; the scene generates as usual
```

Call the cache as `cache?.` at every call site. A missing cache is a normal state,
not an error.

#### Retaining a finished scene across navigation

When the reader leaves the page with the scene and comes back, the scene should
not rebuild. Pause the scene, detach its canvas, and keep it in a module-level
singleton.

```
createRetention({ timeoutMs }) {
  let kept = null
  const take    = () => { if (!kept) return null; clearTimeout(kept.timer)
                          const e = kept; kept = null; return e }
  const release = () => take()?.scene.dispose()
  return {
    get holding() { return Boolean(kept?.scene.movable) },
    keep(scene, handlers) { release(); kept = { scene, handlers, timer: setTimeout(release, timeoutMs()) } },
    take, release,
  }
}
```

On unmount:

```
if (ready && !failed && renderer.movable) retention.keep(renderer, handlers)
else { buildAbort.abort(); dispose(renderer) }
```

On mount:

```
const kept = retention.take()
if (kept?.scene.attach(container)) { renderer = kept.scene; showReady() }
else { kept?.scene.dispose(); startBuilding() }
```

`attach` moves the same canvas element to a new parent in the DOM and resizes
it. It does not touch the worker, the geometry or the GPU resources.

##### How long to keep it

**Base the retention time on the device class, not the viewport.** At desktop
quality, a kept scene holds about a gigabyte of worker and GPU memory. Only the
full build (the highest-quality device row) should assume a machine with memory
to spare.

```
RETAINED_MS             = 30 * 60 * 1000     // full build only
CONSTRAINED_RETAINED_MS =  3 * 60 * 1000     // everything else

retentionMs() {
  roomy = sceneTier(...) === "full"
  return (!roomy || (deviceMemory <= 4)) ? CONSTRAINED_RETAINED_MS : RETAINED_MS
}
```

A width test lets a tablet, the device the light build exists for, keep its
scene for half an hour, because a tablet reports 820 or 1180 whichever way up it
is held. Reuse the answer the tier (the device class `sceneTier` picks) already
gave, and the two answers cannot drift apart. `deviceMemory` stays only to catch
a low-memory desktop, which the tier cannot see.

##### What can and cannot be retained

- **A worker-hosted scene can move.** Its canvas is an element in the DOM, and
  the rendering happens in the worker.
- **A main-thread fallback cannot.** Expose this as a property (`movable`), and
  dispose the fallback like an unfinished build.
- **An unfinished build cannot.** Abort it and dispose it.

```
get movable() { return ready && !disposed && !mainThreadScene && Boolean(canvas) }
```

##### Rebinding callbacks

A retained scene lives longer than the component that created it. Its error and
progress callbacks must not close over that dead component. Route them through a
mutable handler record, and overwrite the record on each mount:

```
// created once, with the scene
onError: (e) => handlers.onError(e)
// on every mount
handlers.onError = fail
```

#### The back/forward cache

On a back navigation from another site, the browser can restore the whole
document, including the canvas and the worker, at no cost. Keep the page
eligible:

- **Use `pagehide`, not `unload`.** In the past, an `unload` listener made a page
  ineligible for bfcache outright. Chrome has been removing that restriction as
  it deprecates `unload`. Firefox and Safari still treat it as a blocker. Check
  the current status before you rely on either behaviour. The advice is the same
  in both cases: `pagehide` fires in every engine, and `unload` is unreliable on
  mobile whether or not bfcache is involved.
- **Do not send `no-store`** on the document. `no-store` disables bfcache
  outright. `max-age=0, must-revalidate` is fine.
- Where you have the choice, avoid open connections that the browser refuses to
  freeze.

Put everything that must run when the reader leaves in a `pagehide` handler,
for example releasing an unclaimed worker or clearing the crash sentinel (see
the next section).

#### The crash sentinel

An out-of-memory kill destroys the tab. No error is thrown, no callback runs and
no analytics event is sent. The only way to see it is to notice, on the next
load, that the last load started a build and never completed it or exited
cleanly. The crash sentinel is the storage record that shows this: the page
writes it as a build starts and deletes it when the build is ready or the page
exits.

```
markAttempt()  -> storage[KEY] = { at: Date.now() }     // as the build starts
clearAttempt() -> delete storage[KEY]                   // on ready, and on pagehide
```

Then, before first paint on the next load, run the gate that decides whether the
scene may load:

```
function gateScene(offClass, lateClass, slotKey, storageKey, blockMs) {
  var reason = ""
  try {
    var raw = localStorage.getItem(storageKey)
    var attempt = raw ? JSON.parse(raw) : null, now = Date.now()
    if (attempt && !attempt.blockedAt) {                       // found a death
      localStorage.setItem(storageKey, JSON.stringify({ at: attempt.at, blockedAt: now }))
      reason = "crashed"
    } else if (attempt && now - attempt.blockedAt < blockMs) reason = "crashed"
    else if (attempt) localStorage.removeItem(storageKey)      // the block expired
  } catch (e) { /* storage disabled: the scene simply builds */ }
  if (!reason) return
  window[slotKey] = reason
  document.documentElement.classList.add(offClass, lateClass)
}
```

Copy these properties:

- **It runs in the document head, before first paint, and before the worker
  warm-up.** A device that the gate blocks must not spend a megabyte of a metered
  connection on a worker it will never use.
- **It adds the "late" class too.** "The scene is not coming" is a stronger
  statement than "the scene is late". It stops the loading hold (the loading
  screen that waits for the scene) from starting at all.
- **It is time-limited.** One month is a reasonable block. A force-quit of the
  whole browser fires no `pagehide` and looks the same as a crash, so a permanent
  block would punish a normal action.
- **Every storage access is wrapped.** `localStorage` throws in some private
  modes.
- **It is the only thing that turns the scene off.** The gate reads no device
  signal at all. It refuses a device only because the scene crashed there, never
  because of what the device is.

Known false positive: a second tab that opens while another tab is still building
(a window of a few seconds) reads that tab's record as a crash. This costs one
device one block, and the block expires. Accept it, and document it.

Report the fallback. Report success too, with the same once-per-document guard.
Otherwise you have a numerator with no denominator, and you cannot tell 2% from
40%.

#### Tracking what to dispose

A build that never finished owns resources that are not in the scene graph. A
traversal of the graph at the end misses them.

- **Collect owners as you create them.** Keep a set per builder, plus a set for
  node-only textures that are never assigned to a material.
- **Dispose each exactly once.** Give each builder a `dispose` hook on its root.
  Run those hooks before the generic sweep, so the sweep does not dispose
  anything twice.
- **Do not dispose the renderer if its initialisation failed.** Some backends
  start initialisation again from `dispose()`. On a half-initialised renderer,
  that throws an error which hides the original failure.
- **Guard every asynchronous callback** with a disposed flag and a generation
  counter. A GPU promise that resolves after teardown must do nothing.
- **Test cancellation at every stage boundary** (the point between two build
  stages). Assert that everything created and everything retained is disposed
  exactly once, and that the scene ends empty.

---
