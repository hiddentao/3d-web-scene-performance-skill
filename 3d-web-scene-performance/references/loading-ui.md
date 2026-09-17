# The loading contract

What the reader sees before the scene arrives, and for how long.


#### Set a time limit for loading

While the page waits for the scene, it holds: it hides content and locks
scrolling. You do not control how long the scene takes to build, so a percentage
bar makes a promise you cannot keep. A fixed deadline for the hold is a promise
you can keep.

```
SCENE_ARRIVAL_MS = 5000      // counted from navigation start, not from hydration
```

Five seconds is reasonable when the scene is the page's main subject. It is too
long when the scene only decorates the page. Pick a number, explain the choice in
a comment, and weigh it against two limits that pull the other way:

- Core Web Vitals: Largest Contentful Paint counts as "good" at 2.5 s. If a
  crawler or a field-data tool would score the held element as the main content,
  a 5 s hold gives a measurably bad LCP on every first visit.
- The first-render budget in SKILL.md targets readable page content under 2 s.

A 5 s hold with scrolling locked trades a metric for a first impression. Make
that trade on purpose. Keep the ways out of the hold (repeat visits, slow
connections, arriving mid-page). Shorten the time limit if the scene is not the
reason the reader came.

Set the number from real measurements. In the hezo.ai scene, a cold first visit
reached the headline in about 4.5 s on a fast machine and connection. A repeat
visit that read the cache of generated data took about 3.4 s. Both usually
finished inside the hold there, and slower devices and networks reached the late
state (described below). The deadline is the longest a reader should wait, not a
measured load time. Measure again with real network presets before you change
it, or before you change the worker's download size or the build's cost.

#### The three states

| State | What shows | Scrolling | Class |
| --- | --- | --- | --- |
| Waiting | Navigation and the placeholder only | Locked | `.is-loading`, no late class |
| Late | The whole page, over a faint placeholder | Free | `.is-loading` + late class |
| Ready | The scene | Free | `.is-ready` |

**Waiting** applies to the first screen only. If the scene is the page's headline
image, hold the headline for a few seconds so it arrives whole. That is better
than showing it over a blank canvas that fills in.

**Late** starts at the deadline, or at once if the browser reports a slow
connection. The page appears and scrolls. Until everything in front of the reader
is built, the page sits over a large, faint copy of the placeholder. After that,
the canvas shows and the distant stages (the last parts of the build) finish in
view, because only a few seconds of work remain.

**Ready** is one transition: the placeholder dissolves as the finished scene
fades in.

##### Go straight to late on a slow connection

```
if (connection?.saveData || ["slow-2g", "2g", "3g"].includes(connection?.effectiveType)) {
  markLate()          // do not even start the timer
}
```

Do not make a reader on a metered or slow connection wait for a decorative asset.
`navigator.connection` exists only in Chromium browsers. Safari and Firefox do
not give it to page scripts. The timer is what guarantees the deadline. This check
is only a shortcut for the browsers that support it.

#### Start the timer before hydration

On a slow network, page scripts arrive late, and that is the case the deadline
exists for. A timer that starts at hydration starts too late.

Serialise a small function into the document head of the page that has the scene:

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

Inside the head script, `performance.now()` is the time since navigation start.
So `deadline - performance.now()` is the time left, however long the HTML took to
arrive.

When the scene component mounts, it claims the timer by calling
`window[slotKey]()`. From then on the component owns the deadline and calculates
the remaining time itself.

Keep this function ES5 and self-contained, because it is serialised with
`toString()` and runs before any module.

#### When to skip the hold

The hold is for the first screen. Skip it when the reader is not on the first
screen or has already seen it.

| Situation | Behaviour |
| --- | --- |
| The page mounts already scrolled (back, forward, reload mid-page) | Mark late at once. The reader's content is where they left it. |
| The scene mounts a second time in the same document (client-side navigation back) | No hold, unless the connection is constrained at that moment. |
| A retained scene is available (a finished scene kept in memory across in-site navigation) | Render as ready on the first frame. Read the retention singleton (the module-level object that keeps the scene) in the state initialiser, not in an effect, or the page flashes a loading state for one frame. |
| The device is refused a scene (it will not get one) | Mark late and off at once, before first paint. "Not coming" says more than "late". |

#### The placeholder

A spinner only says that something is happening. A placeholder that shows the
structure of the scene says what is being built and how far the build has got.
That is worth the effort when the wait is seconds rather than milliseconds.

Build it like this:

1. Draw the subject as a simple line sketch: a few grouped SVG paths for each
   part.
2. Draw one part for free at first paint, so the reader never sees an empty box.
3. Map each remaining part to one build milestone (a named stage of the build),
   in order.
4. Draw the part in progress with small moving dots along its path, so the sketch
   never looks stalled between milestones.

The progress handler draws one more part at each milestone. It also marks the
container when the near-scene stage has published, which means the stage is
built and drawn on screen.

```
SKETCH = [partA, partB, partC, partD, partE, partF]   // one group per part
FROM_PAINT = SKETCH.length - LOADING_MILESTONES.length       // = 1, drawn free

onProgress({ stage, published }) {
  i = LOADING_MILESTONES.indexOf(stage)
  if (i >= 0) showBuilt(FROM_PAINT + i + 1)                  // monotonic, never goes back
  if (published && stage === NEAR_SCENE_MILESTONE) container.dataset.nearScene = "true"
}
```

The drawing is pure CSS driven by one custom property, so the RAF loop plays no
part:

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

**Delay the placeholder.** Fade it in after a 0.4 s delay, so a fast load never
flashes it. Avoid a loading indicator that appears and disappears within 200 ms.

**Never move backwards.** `showBuilt` keeps the maximum value instead of
assigning the new one. Progress that goes down looks like a failure, even when
the cause is only a reorder.

#### Revealing the canvas

Keep the canvas hidden while the reader waits. Reveal it once, as the placeholder
dissolves into it. A canvas that is visible from the start shows the scene
assembling itself, and that looks broken.

One early reveal is useful. Once `NEAR_SCENE_MILESTONE` has published, everything
in front of the reader exists, and the remaining stages only add distance. In the
late state, show the canvas at that point and let the far scenery finish in view:

```css
html.is-late .walk[data-near-scene] canvas[data-first-frame="true"] { opacity: 1 }
```

The two attributes record different facts. `data-near-scene` means the build has
got far enough. `data-first-frame` means the GPU has presented a frame. You need
both: a reveal on `data-near-scene` alone can show an empty canvas.

#### Apply hold rules only when scripts run

Put every rule that hides content, locks scrolling or pauses an animation inside
this media query:

```css
@media (scripting: enabled) { /* ...every hold rule... */ }
```

Without it, a reader with JavaScript off gets a page stuck for good in the
server-rendered loading state, with content hidden and scrolling locked. The
media feature matches only when scripts run, so it is the right condition.

Add a `<noscript>` block that takes the scene container out of the layout and
puts the content into normal document flow. That is the same end state as the
static page without the scene in
[scroll, interaction and graceful degradation](interaction.md#scroll-interaction-and-graceful-degradation).
Share the rules between the two.

#### Entrance animations during the hold

Some pages have an entrance animation, such as a typed headline or a staged
reveal. If the hold hides it, the animation uses up its delays unseen and the
reader never sees it.

**Pause it, do not replay it.**

```css
@media (scripting: enabled) {
  .is-loading .typed-unit { animation-play-state: paused }
  html.is-late .typed-unit,
  .is-ready   .typed-unit { animation-play-state: running }
}
```

**Do not change `animation-delay` between the paused and running states.** The
delay counts from the resume, so a change at that moment skips the sequence
forward and the animation seems to jump.

Also:

- Put the pause inside the scripting media query. An unconditional pause leaves a
  reader without JavaScript with an invisible headline.
- Bake per-element delays into inline custom properties at render time. Use a
  deterministic hash instead of `Math.random`, so server and client agree. A delay
  that differs between them causes a hydration mismatch. This also makes the
  animation pure CSS, so it plays with JavaScript off.

#### Accessibility

- Put `aria-hidden="true"` on the canvas. It is decoration, so everything it shows
  must also exist as text.
- The placeholder is the progress indicator:

  ```html
  <div role="progressbar" aria-label="Loading the scene"
       aria-valuemin="0" aria-valuemax="6" aria-valuenow="3"> ... </div>
  ```

  Update `aria-valuenow` from the same function that advances the drawing.
- Keep focus order sensible during the hold. Hidden content must not be
  focusable, or a keyboard user tabs into nothing.
- If a fallback list stands in for interactive canvas elements, give it a heading
  in every state where it shows. This includes on focus, when a keyboard user
  reaches it before the scene is ready.
- Never lock scrolling without a deadline that releases it.

#### Reduced motion

Under `prefers-reduced-motion: reduce`:

- Remove the placeholder's fade, stagger and moving dots. Keep the step at each
  milestone. It is a data model, not an animation.
- Remove the transitions between loading states. The states still change, but
  instantly.
- Show any entrance animation in its finished state.
- Keep the deadline and the state machine unchanged. Reduced motion changes
  motion only, not timing.

#### Anti-patterns

| Do not | Because |
| --- | --- |
| Show a percentage based on elapsed time | It is false, and it stalls at 90% |
| Hide content until the scene arrives, with no deadline | You do not control how long the build takes |
| Reveal the canvas before the first presented frame | The reader sees an empty box or a half-built scene |
| Let progress go backwards | It looks like a failure |
| Lock scrolling outside the scripting media query | Readers without JavaScript get a broken page |
| Replay an entrance animation after the hold | It has already played unseen. Pause it instead |
| Report progress when frames are submitted to the GPU | The indicator runs ahead of what is on screen |
| Use a spinner for a five-second wait | It tells the reader nothing for five seconds |

---
