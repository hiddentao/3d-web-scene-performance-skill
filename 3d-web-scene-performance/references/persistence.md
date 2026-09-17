# Persistence: caching, retention and survival

Making the second visit fast, the back navigation instant, and a crash
non-repeating.


#### Three different lifetimes

They are often confused, and they solve different problems.

| Mechanism | Survives | Costs | Solves |
| --- | --- | --- | --- |
| Generation cache (IndexedDB) | Reloads, new tabs, days | Disk, and a serialisation round trip | Recomputing the same arithmetic |
| Scene retention (in memory) | In-site navigation within one document | Hundreds of MB to a GB of worker and GPU memory | Rebuilding on return |
| Back/forward cache (the browser's) | Cross-site back navigation | Nothing, if you do not disqualify yourself | Everything, instantly |

Use all three. They do not overlap.

#### Caching generated data

##### What may be stored

**Numbers and typed arrays only.** No engine objects, no GPU handles, no DOM.
A cached value must be something `structuredClone` round-trips exactly.

```
assert(Object.values(record).every(v => typeof v === "number" || ArrayBuffer.isView(v)))
assert(deepEqual(record, structuredClone(record)))
```

**Do not cache anything whose round trip is not exact.** Canvas-painted textures
are the trap: reading pixels back out of a 2D canvas is not guaranteed byte
identical across engines and versions, especially for partially transparent
pixels. A cache that returns *nearly* the same texture is worse than no cache,
because the difference is invisible until it is not.

Good candidates: generated vertex positions and indices, placement records,
heightmaps and noise fields computed in plain arithmetic.

##### A hit must replay exactly what a miss produces

The one invariant that makes a cache safe: hits and misses must build meshes and
textures through the **same** code below the cache boundary.

```
async function cached(key, generate) {
  const value = cache?.get(key) ?? await generate()   // short-circuits generate on a hit
  cache?.put(key, value)                              // put() ignores keys already present
  return value
}
```

Then a hit and a miss differ only in whether `generate` ran, and every downstream
consumer is identical by construction.

##### Key by the content hash of the generating code

The cache must invalidate when the code that fills it changes. Take the hash from
the bundler's own output filename:

```
version = /scene-worker-([0-9a-f]{8,})\.js$/.exec(scriptPath)?.[1]
if (!version) return null            // dev build, or a main-thread path: do not cache
key     = `${version}|${localKey}`
```

Two useful consequences: an unhashed development build is never cached, so you are
never debugging a stale cache; and a main-thread fallback with no worker script is
never cached either.

Include in the local key every parameter that changes the output:

```
`surface:${index}:${quality}:${radial}x${levels}:s${spacing}`
```

A device row that changes a generation parameter then gets its own entries rather
than reading another row's.

##### Prune older builds on write

After a deploy, every old entry is dead weight in the user's quota.

```
flush():
  for ([key, value] of pending) { await writeOne(key, value); await yieldTask() }
  cursor over all keys:
    if (!key.startsWith(currentVersionPrefix)) delete(key)
```

Yield between writes so the sweep does not cost frames. The sweep only needs to
run when something was actually written, which after a deploy is guaranteed on
the first visit.

##### Writes happen after ready

```
onReady()
cache?.flush()        // fire and forget; never awaited by the build
```

Storing what this visit generated must not slow this visit down. The beneficiary
is the next one.

##### Storage is best-effort, always

Every path fails in the wild: private browsing, disabled storage, a full quota, a
blocked upgrade, a database that never opens.

```
open():
  race(indexedDB.open(...), timeout(1500))     // a blocked open must not hang the build
  catch => return null                         // and then close the connection if it arrives late
flush():
  catch => pending.clear()                     // drop it; the scene generates as usual
```

Every cache call site is `cache?.`. A missing cache is a normal state, not an
error.

#### Retaining a finished scene across navigation

Leaving the page that carries the scene and coming back should not rebuild it.
Pause the scene, detach its canvas, and keep it in a module-level singleton.

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

`attach` is DOM reparenting of the same canvas element plus a resize. The worker,
the geometry and the GPU resources are untouched.

##### How long, and decided by what

**Key the window to the device class, not the viewport.** A kept scene holds
roughly a gigabyte of worker and GPU memory at desktop quality. Only the full
build should assume a machine with memory to spare.

```
RETAINED_MS             = 30 * 60 * 1000     // full build only
CONSTRAINED_RETAINED_MS =  3 * 60 * 1000     // everything else

retentionMs() {
  roomy = sceneTier(...) === "full"
  return (!roomy || (deviceMemory <= 4)) ? CONSTRAINED_RETAINED_MS : RETAINED_MS
}
```

Deciding this from a width is what let a tablet - the device the light build
exists for - keep its scene for half an hour, because a tablet reads 820 or 1180
whichever way up it is held. Ask the same question the tier already answered, and
the two answers cannot drift. `deviceMemory` stays only to catch a low-memory
desktop, which the tier cannot see.

##### What can and cannot be retained

- **A worker-hosted scene can move.** Its canvas is an element in the DOM; the
  rendering lives elsewhere.
- **A main-thread fallback cannot.** Expose that as a property (`movable`) and
  dispose it like an unfinished build.
- **An unfinished build cannot.** Abort and dispose.

```
get movable() { return ready && !disposed && !mainThreadScene && Boolean(canvas) }
```

##### Rebinding callbacks

A retained scene outlives the component that created it, so its error and progress
callbacks must not close over a dead component. Route them through a mutable
handler record that each mount overwrites:

```
// created once, with the scene
onError: (e) => handlers.onError(e)
// on every mount
handlers.onError = fail
```

#### The back/forward cache

A cross-site back navigation can restore the whole document - canvas, worker and
all - for free. Do not disqualify yourself:

- **Use `pagehide`, not `unload`.** An `unload` listener has historically
  disqualified a page from bfcache outright. Chrome has been removing that
  restriction as it deprecates `unload`; Firefox and Safari still treat it as a
  blocker. Verify current status before relying on either behaviour - though the
  advice does not change either way, because `pagehide` fires in every engine and
  `unload` is unreliable on mobile regardless of bfcache.
- **Do not send `no-store`** on the document. `max-age=0, must-revalidate` is
  fine; `no-store` disables bfcache outright.
- Avoid open connections the browser refuses to freeze, where you have the choice.

Everything that needs to run when the reader leaves - releasing an unclaimed
worker, clearing a crash sentinel - goes in a `pagehide` handler.

#### The crash sentinel

An out-of-memory kill destroys the tab. No error is thrown, no callback runs, no
analytics event is sent. The only way to see it is to notice, on the next load,
that the last one started a build and never reached either completion or a clean
exit.

```
markAttempt()  -> storage[KEY] = { at: Date.now() }     // as the build starts
clearAttempt() -> delete storage[KEY]                   // on ready, and on pagehide
```

Then, **before first paint on the next load**:

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

Properties worth copying:

- **It runs in the document head, before first paint, and before the worker
  warm-up.** A gated device must not spend a megabyte of a metered connection on
  a worker it will never use.
- **It adds the "late" class too.** "The scene is not coming" is a stronger
  statement than "the scene is late", and it is what stops the loading hold
  engaging at all.
- **It is time-boxed.** A month is a reasonable block. A force-quit of the whole
  browser fires no `pagehide` and looks identical to a crash, so a permanent block
  would punish a normal action.
- **Every storage access is wrapped.** `localStorage` throws in some private
  modes.
- **It is the only thing that turns the scene off.** The gate reads no device
  signal at all. A device is refused for having died, never for what it is.

Known false positive: a second tab opened during the seconds another tab is still
building reads that tab's record as a death. It costs one device one block, and it
expires. Accept it, and write it down.

Report the fallback. Report the success too, with the same once-per-document
guard, or you have a numerator with no denominator and cannot tell 2% from 40%.

#### Disposal bookkeeping

A build that never finished owns resources that are not in the scene graph.
Traversing the graph at the end will miss them.

- **Collect owners as you create them.** A set per builder, plus a set for
  node-only textures that never land on a material.
- **Dispose each exactly once.** Give each builder a `dispose` hook on its root
  and run those before the generic sweep, so the sweep does not double-dispose.
- **Do not dispose the renderer if its initialisation failed.** Some backends
  re-enter initialisation from `dispose()`, which on a half-initialised renderer
  throws an error that masks the original failure.
- **Guard every asynchronous callback** with a disposed flag and a generation
  counter. A GPU promise that resolves after teardown must do nothing.
- **Test cancellation at every stage boundary**, asserting that everything created
  and everything retained is disposed exactly once, and the scene ends empty.

---
