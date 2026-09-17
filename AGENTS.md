# 3D web scene performance

Rules for building fast real-time 3D scenes on web pages. They come from the
scroll-driven 3D scene on the hezo.ai homepage.

This file is for agents without Agent Skills support. If your tool supports
skills, install the `3d-web-scene-performance/` directory instead. It has the full
detail in seven reference files, and the agent reads each one only when a task
needs it.

## The rules

**1. Count frames the GPU finishes.** `requestAnimationFrame` keeps firing at the
display rate when the GPU falls behind. A counter based on it can report 60 fps
while the device draws only 22. Count the frames the GPU has finished, and adapt
quality to the lower of the two rates.

**2. Do not let frames pile up.** Do not send a new frame while two are still
unfinished. Keep at most one camera update waiting on an async renderer. If work
piles up, frame time turns into input lag, and your own metrics do not show it.

**3. Keep device settings in one table.** Put every per-device decision in one
table, with one row for each build. Separate checks at each call site drift
apart. One quality number cannot describe a device that needs a third of the
scattered objects but full surface resolution.

**4. Turn expensive effects fully off.** Shadows, reflections, ambient occlusion
and post-processing each draw the whole scene again and need extra render
targets. Turn them off together. Skip them in the code; setting them to zero
still costs time.

**5. Make the page work without the 3D scene.** No JavaScript, a failed renderer,
a device that crashed last time and a browser without the API all go to one
static page. That page has all the same content. Build it first. It is also your
server-rendered output and what search crawlers see.

**6. Build the scene in stages.** Build first what the visitor looks at first.
Each stage must render and look complete on its own. Give the browser a real
break between stages so it can handle input, layout and paint.

**7. Set a time limit for loading.** Decide in advance how long the visitor
waits. After that, show the page and let the scene appear behind it. Do not make
content wait on work when you cannot control how long it takes.

**8. Cache generated data, not 3D objects.** Numbers and typed arrays can be
stored and loaded again. Meshes, materials and GPU handles cannot. Data from the
cache must give exactly what generation gives, through the same code path.

**9. Test the production build.** A shader that compiles from source can still
fail in production, because the bundler changed the class that built it. Test
the bundled output.

## Before you report a performance number

Record the conditions with every number: viewport size, device pixel ratio, CPU
throttle, and where in the scene you measured. Use the browser's network presets
instead of adding delays to single responses. Measure one copy of the scene at a
time, because two copies rendering at once make the numbers useless.

## What to work out for your own scene

Measure the values for your own scene, such as camera paths and quality settings.
Decide product questions yourself, such as which devices get the scene. Look at
rendered frames to find visual defects, and test each rule on your own scene.
