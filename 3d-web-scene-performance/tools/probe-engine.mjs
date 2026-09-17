#!/usr/bin/env node
/**
 * The seven questions, asked of the engine you actually have installed.
 *
 *   node probe-engine.mjs [adapter] [--json]
 *
 * The adapter defaults to `./adapters/three.mjs`. Compare the output before and
 * after an engine upgrade. None of these answers holds still, and an engine
 * that changes one rarely says so, because nothing breaks: the scene keeps
 * rendering and costs more, or it bends a leaf about the wrong origin.
 *
 * ## Writing an adapter
 *
 * An adapter is a module whose default export is an object with an `engine`
 * string and one method per question it can answer. Each method returns
 * `{ answer, note }`, or throws to report that this engine cannot be asked
 * that way. Leave a method out and the question prints as unanswered, which is
 * the right output for a question nobody measured.
 *
 *   export default {
 *     engine: "my-engine@1.2.3",
 *     pipelineBuildKey() { return { answer: "material only", note: "..." }; },
 *   }
 *
 * Two of the seven have no general mechanical answer, so they say so. How many
 * times a frame traverses your scene is a property of the scene. What an engine
 * batches for you is usually a documented promise that a probe cannot see. For
 * those two the harness prints the measurement to go and take.
 */
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Each question carries the method an adapter implements for it, and what to
 * do when no adapter can answer. The `fallback` is not a default answer. It is
 * the measurement to go and take by hand.
 */
export const QUESTIONS = [
  {
    id: "pipelineBuildKey",
    title: "1. What is a pipeline build keyed on?",
    fallback: "Count shader builds for N objects sharing one material, then for one object holding N instances. N against 1 means object identity is in the key.",
  },
  {
    id: "automaticBatching",
    title: "2. What does the engine batch automatically?",
    fallback: "Render one frame with the draw-call counter on, against a scene whose object count you know. Most engines batch nothing above the object.",
  },
  {
    id: "scenePasses",
    title: "3. Which passes traverse the whole scene?",
    fallback: "Instrument the engine's per-object draw entry point for one frame and count how many times each object is submitted. This is a property of your scene, not of the engine.",
  },
  {
    id: "asyncCompile",
    title: "4. Is there an asynchronous pipeline compile?",
    fallback: "Time the first frame after a stage, with and without the engine's compile call ahead of it.",
  },
  {
    id: "gpuCompletionSignal",
    title: "5. Is there a GPU completion signal?",
    fallback: "Run a deliberately heavy scene and compare the callback rate against the completion rate. If they never diverge under load, the signal is not measuring completion.",
  },
  {
    id: "objectIdentity",
    title: "6. What identity must stay stable, and does the static flag apply?",
    fallback: "Mutate one property at a time on a constructed object and watch for a recompile or a buffer reupload. Then set the engine's static flag and check whether the per-object work actually drops.",
  },
  {
    id: "vertexHookOrder",
    title: "7. When does your own vertex code run?",
    fallback: "Give one instanced object a vertex hook that adds a constant, generate its vertex shader source, and read whether the engine's own transform sits above or below your line.",
  },
];

export async function probe(adapter) {
  const results = [];
  for (const question of QUESTIONS) {
    const read = adapter?.[question.id];
    if (typeof read !== "function") {
      results.push({ ...question, answer: null, note: question.fallback });
      continue;
    }
    try {
      const { answer, note } = await read.call(adapter);
      results.push({ ...question, answer, note });
    } catch (error) {
      results.push({ ...question, answer: null, note: `${error.message}. ${question.fallback}` });
    }
  }
  return results;
}

function wrap(text, width, indent) {
  const lines = [];
  let line = "";
  for (const word of String(text).split(/\s+/)) {
    if (line && line.length + word.length + 1 > width) { lines.push(line); line = ""; }
    line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines.map((entry, i) => (i ? indent + entry : entry)).join("\n");
}

export function format(results, engine) {
  const out = [`engine: ${engine || "unknown"}`, ""];
  for (const { title, answer, note } of results) {
    out.push(title);
    out.push(`  ${wrap(answer ?? "NOT MEASURED", 76, "  ")}`);
    out.push(`  ${wrap(note, 76, "  ")}`);
    out.push("");
  }
  return out.join("\n");
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const named = args.find(arg => !arg.startsWith("--"));
  const here = dirname(fileURLToPath(import.meta.url));
  const path = named ? resolve(process.cwd(), named) : resolve(here, "adapters/three.mjs");
  let adapter;
  try {
    adapter = (await import(pathToFileURL(path).href)).default;
  } catch (error) {
    console.error(`Could not load the adapter at ${path}.\n${error.message}\n`);
    console.error("An adapter needs its engine resolvable from where you run this,");
    console.error("so run it from the project that has the engine installed.");
    process.exit(1);
  }
  const results = await probe(adapter);
  console.log(json
    ? JSON.stringify({ engine: adapter?.engine ?? null, results }, null, 2)
    : format(results, adapter?.engine));
}
