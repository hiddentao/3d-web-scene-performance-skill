/**
 * A worked adapter for `probe-engine.mjs`, against Three.js with its node
 * renderer (`three/webgpu` plus `three/tsl`).
 *
 * Run it from a project that has Three installed, because that is the copy you
 * want measured. Nothing here needs a GPU: shader generation, cache keys and
 * refresh observers are all CPU work the renderer does while building a scene.
 *
 * Where an answer is read out of the shipped build rather than executed, the
 * note says "source". Those are the ones that need a device to run for real,
 * and they are the ones to re-read by hand if they ever disagree with what
 * your scene is doing.
 *
 * Treat this file as a template. A second adapter is most of the work of
 * carrying this skill to another engine, and writing one tells you more about
 * that engine than any amount of reading.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

// Resolve Three from the project this is run in, not from the skill directory.
// Go through the published entry points rather than file paths: a package's
// `exports` map decides what is reachable, and Three's does not list its build
// files. The resolved entry is that build file, so it also gives the version.
const require = createRequire(pathToFileURL(join(process.cwd(), "package.json")));
const entry = require.resolve("three/webgpu");
const THREE = await import(pathToFileURL(entry).href);
const TSL = await import(pathToFileURL(require.resolve("three/tsl")).href);
const source = readFileSync(entry, "utf8");
const version = JSON.parse(readFileSync(join(dirname(dirname(entry)), "package.json"), "utf8")).version;

globalThis.ImageBitmap ??= class ImageBitmap {};

/** An uninitialized renderer, with only what shader generation reads stubbed. */
function renderer({ gl = false } = {}) {
  const instance = new THREE.WebGPURenderer({
    canvas: { addEventListener() {}, style: {} }, antialias: true, forceWebGL: gl,
  });
  instance.backend.renderer = instance;
  instance.hasFeature = () => false;
  // No device without a GPU. Supply only the limit that decides how an
  // instance matrix is bound, which shader generation reads.
  instance.backend.device = { queue: {}, limits: { maxUniformBufferBindingSize: 65536 } };
  return instance;
}

function buildShaders(instance, object) {
  const camera = new THREE.PerspectiveCamera();
  camera.coordinateSystem = instance.coordinateSystem;
  camera.updateProjectionMatrix();
  const builder = instance.backend.createNodeBuilder(object, instance);
  builder.camera = camera;
  builder.scene = new THREE.Scene();
  builder.build();
  return builder;
}

export default {
  engine: `three@${version}`,

  pipelineBuildKey() {
    const identity = /if \( object\.isInstancedMesh \|\| object\.count > 1 \) \{[\s\S]{0,240}?cacheKey \+= object\.uuid/.test(source);
    return {
      answer: identity
        ? "material, geometry and object identity for instanced draws"
        : "no per-object identity found in the render object cache key",
      note: identity
        ? "source: every instanced mesh builds its own shaders in every pass, however many of them share one material. Merge small static pieces into one plain mesh per material; instancing then saves draw calls and not builds."
        : "source: the trap this skill describes may have been closed, or the key may have moved. Confirm by counting shader builds for N instanced meshes sharing one material before you rely on it.",
    };
  },

  automaticBatching() {
    const primitives = ["InstancedMesh", "BatchedMesh"].filter(name => name in THREE);
    return {
      answer: `nothing above the object; ${primitives.join(" and ") || "no batching primitive"} to request`,
      note: "API surface, not a measurement: this engine merges nothing for you. Count the draw calls of a frame against the object count of the scene that drew it.",
    };
  },

  asyncCompile() {
    const has = typeof renderer().compileAsync === "function";
    return {
      answer: has ? "compileAsync()" : "none found",
      note: has
        ? "Call it at the end of each published stage, not in the frame that needs the pipeline."
        : "Without one, the first frame after every stage stalls while it compiles.",
    };
  },

  gpuCompletionSignal() {
    const withdrawn = /waitForGPU\(\)[^\n]*(removed|deprecated)/.test(source);
    // The primitives belong to the platform, not to the engine, so read which
    // backends it ships rather than whether its own source still calls them.
    const ships = name => name in THREE || new RegExp(`class ${name}\\b`).test(source);
    const platform = [
      ships("WebGPUBackend") && "the WebGPU queue's onSubmittedWorkDone",
      ships("WebGLBackend") && "a WebGL2 fence",
    ].filter(Boolean);
    return {
      answer: withdrawn
        ? `not on the engine's public API; ${platform.join(" and ") || "nothing"} underneath`
        : `waitForGPU(), over ${platform.join(" and ") || "an unknown mechanism"}`,
      note: withdrawn
        ? "source: the engine withdrew the call, so this one is yours to own. Keep one per backend, do not assume a global requestAnimationFrame while polling a fence (a worker has none), and publish which signal you got: a scene without one counts submissions and reports a rate that can be twice the truth."
        : "source: use it for backpressure and for the completion rate, and check it against the callback rate under load before you trust either.",
    };
  },

  objectIdentity() {
    // Does the static flag reach the refresh check, and for which materials?
    const observed = [];
    for (const [name, make] of [
      ["no custom nodes", () => new THREE.MeshStandardNodeMaterial()],
      ["a colour node", () => Object.assign(new THREE.MeshStandardNodeMaterial(), { colorNode: TSL.vec3(1, 0, 0) })],
      ["a position node", () => Object.assign(new THREE.MeshStandardNodeMaterial(), { positionNode: TSL.positionLocal })],
    ]) {
      const instance = renderer();
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), make());
      const observer = new THREE.NodeMaterialObserver(buildShaders(instance, mesh));
      observed.push(`${name}: ${observer.hasNode ? "no" : "yes"}`);
    }
    const everywhere = observed.every(entry => entry.endsWith("yes"));
    return {
      answer: observed.join(", "),
      note: everywhere
        ? "The static flag is read for every material class here, so it is worth setting on objects that really do not change."
        : "A material built from shader nodes returns early, before the flag is read, so setting it on one does nothing and nothing says so. Check which of your own materials fall on which side before you reason as though any object is skipped. Separately: any knob whose value the engine bakes into generated source is a rebuild and not a uniform. Generate a shader twice with that knob at two values and compare the text.",
    };
  },

  vertexHookOrder() {
    const MARKER = "7.0";
    const instance = renderer();
    const material = new THREE.MeshBasicNodeMaterial();
    material.positionNode = TSL.positionLocal.add(TSL.vec3(0, 7, 0));
    const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), material, 4);
    const shader = buildShaders(instance, mesh).vertexShader;
    const instancing = shader.search(/positionLocal\s*=\s*\(?\s*\w*(Buffer|Matrix)\w*(\.value)?\[\s*instanceIndex/);
    const hook = shader.indexOf(MARKER);
    if (instancing < 0 || hook < 0) throw new Error("Could not find both assignments in the generated vertex shader");
    return {
      answer: instancing < hook
        ? "the engine transforms first; your hook is handed the instanced vertex"
        : "your hook runs first; the engine transforms what you return",
      note: instancing < hook
        ? "Write the shape of a displacement from the geometry's own vertex (`positionGeometry`), and carry the offset back through the instance transform's linear part yourself. Reading the working position here takes the instance's size for the vertex's own."
        : "The working position is the geometry's own vertex, so a displacement written against it is already in the right space. Re-run this after any engine upgrade: moving this order breaks nothing and fails silently.",
    };
  },
};
