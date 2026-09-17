# The loading contract

What the reader sees while the scene is not there yet, and how long they see it.


#### Hold for a deadline, not for completion

A percentage bar driven by a build whose duration you do not control is a promise
you cannot keep. A hard deadline is a promise you can.

```
SCENE_ARRIVAL_MS = 5000      // counted from navigation start, not from hydration
```

Five seconds is defensible for a scene that *is* the page's main subject, and
indefensible for one that merely decorates it. Pick a number, justify it in a
comment, and weigh it against two things that pull the other way:

- **Core Web Vitals.** Largest Contentful Paint counts "good" at 2.5 s. If the
  held element is what a crawler or a field-data tool would score as the main
  content, a 5 s hold is a measurably bad LCP on every first visit.
- **This document's own budget**, two rows up in the table above, targets
  readable content under 2 s.

Holding a scroll-locked page for 5 s is a deliberate trade of a metric for a
first impression. Make it knowingly, keep the escape hatches (repeat visits, slow
connections, arriving mid-page), and shorten the number if the scene is not the
reason the reader came.

Calibrate it against real measurements. In the reference scene a cold first visit
reached the headline in about 4.5 s on a fast machine and connection, and a repeat
visit reading the generation cache in about 3.4 s - so both usually finished inside
the hold there, and slower devices and networks reached the late state. **The
deadline is the longest a reader should wait, not a measured load time.**
Re-measure with real network presets before changing it, or before changing the
worker's download size or the build's cost.

#### The three states

| State | What shows | Scrolling | Class |
| --- | --- | --- | --- |
| **Waiting** | Navigation and the placeholder only | Locked | `.is-loading`, no late class |
| **Late** | The whole page, over a faint placeholder | Free | `.is-loading` + late class |
| **Ready** | The scene | Free | `.is-ready` |

**Waiting** belongs to the first screen. If the scene is the page's headline
image, holding the headline for a few seconds so it arrives whole is better than
showing it over a blank canvas that fills in.

**Late** is reached at the deadline, or immediately on a connection the browser
reports as slow. The page appears and scrolls. Until everything in front of the
reader has been built, it sits over an enlarged, faint version of the placeholder;
after that the canvas shows and the distant stages finish in view, because only a
few seconds of work remain.

**Ready** is one transition: the placeholder dissolves as the finished scene fades
in.

##### Immediate late on a slow connection

```
if (connection?.saveData || ["slow-2g", "2g", "3g"].includes(connection?.effectiveType)) {
  markLate()          // do not even start the timer
}
```

A reader on a metered or slow connection should never be made to wait for a
decorative asset. Note `navigator.connection` is **Chromium-only** - neither
Safari nor Firefox ships it to page scripts. The timer is what actually
guarantees the deadline; this is only a shortcut for the browsers that can take
it.

#### Binding the deadline before hydration

On a slow network, page scripts arrive late - which is exactly the case the
deadline exists for. If the timer starts at hydration it has already lost.

Serialise a small function into the document head of the page that carries the
scene:

```
function watchSceneArrival(deadline, lateClass, slotKey, slowTypes) {
  var root = document.documentElement
  var connection = navigator.connection
  function late() { root.classList.add(lateClass) }
  if (connection && (connection.saveData || slowTypes.indexOf(connection.effectiveType) >= 0)) {
    late(); return
  }
  var timer = setTimeout(late, Math.max(0, deadline - performance.now()))
  window[slotKey] = function () { clearTimeout(timer) }    // hand it to the page
}
```

`performance.now()` inside the head script is time since navigation start, so
`deadline - performance.now()` is the remaining budget however long the HTML took
to arrive.

When the scene component mounts it claims the timer (`window[slotKey]()`) and owns
the deadline from then on, re-deriving the remaining time itself.

Keep this function ES5 and self-contained. It is serialised with `toString()` and
runs before any module.

#### Exceptions that skip the hold

The hold belongs to the first screen. Skip it when the reader is not on the first
screen or has already seen it.

| Situation | Behaviour |
| --- | --- |
| Mounted already scrolled (back, forward, reload mid-page) | Mark late at once. Their content is where they left it. |
| A second mount in the same document (client-side navigation back) | No hold, unless the connection is currently constrained. |
| A retained scene is available | Render as ready on the first frame. Read the retention singleton in the state initialiser, not in an effect, or the page flashes a loading state for one frame. |
| The device is refused a scene | Mark late *and* off at once, before first paint. "Not coming" is a stronger statement than "late". |

#### The placeholder

A spinner says "something is happening". A structurally honest placeholder says
"this is what is being built, and here is how far it has got". The second is
worth the effort when the wait is seconds rather than milliseconds.

The pattern:

1. Draw the subject as a simple line sketch - a few grouped SVG paths per part.
2. Give one part away free at first paint, so the reader never sees an empty box.
3. Map the remaining parts one-to-one onto the build milestones, in order.
4. Draw the part in progress with small moving dots along its path, so the sketch
   never looks stalled between milestones.

```
SKETCH = [partA, partB, partC, partD, partE, partF]   // one group per part
FROM_PAINT = SKETCH.length - LOADING_MILESTONES.length       // = 1, drawn free

onProgress({ stage, published }) {
  i = LOADING_MILESTONES.indexOf(stage)
  if (i >= 0) showBuilt(FROM_PAINT + i + 1)                  // monotonic, never goes back
  if (published && stage === NEAR_SCENE_MILESTONE) container.dataset.nearScene = "true"
}
```

Drawing is pure CSS against one custom property, so the RAF loop is not involved:

```css
/* pathLength="1" normalises every path: one dash hides it, zero draws it */
.ink path   { stroke-dasharray: 1px 1.02px;
              stroke-dashoffset: clamp(0px, calc((var(--i) - var(--built,0)) * 1.01px), 1.01px);
              transition: stroke-dashoffset .6s ease var(--d); }   /* --d staggers by path */

/* the trace is visible only on the single part after the last completed one */
.trace path { stroke-dasharray: .1px 5px; animation: march 1.4s linear infinite;
              opacity: calc(.6 * clamp(0, var(--i) - var(--built,0), 1)
                              * clamp(0, var(--built,0) + 2 - var(--i), 1)); }
```

**Delay the placeholder's own appearance.** A 0.4 s delayed fade-in means a fast
load never flashes it. There is nothing worse than a loading indicator that
appears and disappears in 200 ms.

**Never move backwards.** `showBuilt` takes a max, not an assignment. Progress
that goes down reads as a failure even when it is a reorder.

#### Revealing the canvas

Keep the canvas hidden while the reader waits, and reveal it once - as the
placeholder dissolves into it. A canvas that is visible from the start shows the
scene assembling itself, which looks broken rather than progressive.

There is one useful early reveal. Once `NEAR_SCENE_MILESTONE` has published,
everything in front of the reader exists; the remaining stages add distance. In
the late state, show the canvas at that point and let the far scenery finish in
view:

```css
html.is-late .walk[data-near-scene] canvas[data-first-frame="true"] { opacity: 1 }
```

Two attributes, two different facts: `data-near-scene` is "the build has got far
enough", `data-first-frame` is "the GPU has actually presented something". Both
are needed - revealing on the first alone can show an empty canvas.

#### Gating every hold rule on scripting

Everything that hides content, locks scrolling or pauses an animation must sit
inside:

```css
@media (scripting: enabled) { /* ...every hold rule... */ }
```

Without that gate, a reader with JavaScript disabled gets a page permanently stuck
in the server-rendered loading state: content hidden, scroll locked, forever. The
media feature matches only when scripts actually run, so it is exactly the right
condition.

Add a `<noscript>` block that forces the scene container out of the layout and the
content into normal document flow. That is the same end state as the static path
in [Scroll, interaction and graceful degradation](interaction.md#scroll-interaction-and-graceful-degradation), and it should share its rules.

#### Entrance animations across the hold

If the page has an entrance animation - a typed headline, a staged reveal - and
the hold hides it, the animation runs out of its delays unseen and the reader gets
nothing.

**Pause it, do not replay it.**

```css
@media (scripting: enabled) {
  .is-loading .typed-unit { animation-play-state: paused }
  html.is-late .typed-unit,
  .is-ready   .typed-unit { animation-play-state: running }
}
```

One trap: **nothing may change `animation-delay` between the paused and running
states.** The delay is counted from the resume, so moving it at that moment skips
the sequence forward and the animation appears to jump.

Two related rules:

- The pause belongs inside the scripting gate. An unconditional pause leaves a
  no-JS reader with an invisible headline.
- Bake per-element delays into inline custom properties at render time, using a
  deterministic hash rather than `Math.random`, so server and client agree. A
  delay that differs between them is a hydration mismatch. This also makes the
  animation pure CSS, so it plays with JavaScript off.

#### Accessibility

- `aria-hidden="true"` on the canvas. It is decoration; everything it conveys must
  exist in text.
- The placeholder is the progress indicator:

  ```html
  <div role="progressbar" aria-label="Loading the scene"
       aria-valuemin="0" aria-valuemax="6" aria-valuenow="3"> ... </div>
  ```

  Update `aria-valuenow` from the same function that advances the drawing.
- Keep focus order sane during the hold. If content is hidden, it must not be
  focusable, or a keyboard reader tabs into nothing.
- If a fallback list stands in for interactive canvas elements, make sure it has a
  heading in every state where it is shown - including on focus, when a keyboard
  reader reaches it before the scene is ready.
- Never trap scroll without a deadline that releases it.

#### Reduced motion

Under `prefers-reduced-motion: reduce`:

- Remove the placeholder's fade, stagger and marching dots. The milestone stepping
  itself stays - it is a data model, not an animation.
- Remove the transition between loading states. The state changes happen, they
  just happen instantly.
- Settle any entrance animation to its finished state.
- Keep the deadline and the state machine unchanged. Reduced motion is about
  motion, not about timing out differently.

#### Anti-patterns

| Do not | Because |
| --- | --- |
| Show a percentage derived from elapsed time | It is a lie, and it stalls at 90% |
| Block content on the scene with no deadline | You do not control the duration |
| Reveal the canvas before the first presented frame | The reader sees an empty box or a half-built scene |
| Let progress go backwards | Reads as failure |
| Lock scroll outside a scripting gate | No-JS readers get a broken page |
| Replay an entrance animation after the hold | It has already played, invisibly; pause it instead |
| Report progress on submission | The indicator runs ahead of the picture |
| Use a spinner for a five-second wait | It carries no information for five seconds |

---
