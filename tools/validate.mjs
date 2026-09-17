#!/usr/bin/env node
// Checks this repo against the Agent Skills spec and its own conventions.
// Wired into CI, because the skill itself argues an unautomated check rots.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../3d-web-scene-performance");
const ORDER = ["device-tiers", "frame-budget", "startup",
               "loading-ui", "persistence", "interaction", "verification"];

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fail = [];
const check = (ok, msg) => { if (!ok) fail.push(msg); };
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9 -]/g, "").replace(/ /g, "-");

// --- frontmatter, against the published spec -------------------------------
const spine = readFileSync(`${SKILL_DIR}/SKILL.md`, "utf8");
const fm = spine.match(/^---\n([\s\S]*?)\n---\n/);
check(!!fm, "SKILL.md has no YAML frontmatter");
if (fm) {
  const name = fm[1].match(/^name:\s*(.+)$/m)?.[1]?.trim();
  const desc = fm[1].match(/^description:\s*(.+)$/m)?.[1]?.trim();
  check(!!name, "frontmatter: name missing");
  check(!!desc, "frontmatter: description missing");
  if (name) {
    check(/^[a-z0-9-]+$/.test(name), `name "${name}" must be lowercase letters, digits, hyphens`);
    check(!/^-|-$|--/.test(name), `name "${name}" cannot lead/trail or double a hyphen`);
    check(name.length <= 64, `name is ${name.length} chars, max 64`);
    check(!/anthropic|claude/i.test(name), `name "${name}" uses a reserved word`);
    check(name === basename(root) || `${name}-skill` === basename(root),
      `name "${name}" should match the skill directory it installs as`);
  }
  if (desc) {
    check(desc.length <= 1024, `description is ${desc.length} chars, max 1024`);
    check(!/[<>]/.test(desc), "description cannot contain angle brackets");
  }
}

// --- every reference exists and is reachable -------------------------------
const refs = readdirSync(`${SKILL_DIR}/references`).filter((f) => f.endsWith(".md"));
check(refs.length === ORDER.length, `references/ has ${refs.length} files, expected ${ORDER.length}`);
for (const name of ORDER) check(existsSync(`${SKILL_DIR}/references/${name}.md`), `missing references/${name}.md`);

// --- cross-file links resolve ----------------------------------------------
const files = [["SKILL.md", spine], ...refs.map((f) => [`references/${f}`, readFileSync(`${SKILL_DIR}/references/${f}`, "utf8")])];
const anchors = new Map(files.map(([f, t]) =>
  [f, new Set([...t.matchAll(/^#{1,6} (.+)$/gm)].map((m) => slug(m[1])))]));
for (const [file, text] of files) {
  for (const [, target, anchor] of text.matchAll(/\]\(((?:\.\.\/)?(?:references\/)?[a-zA-Z-]+\.md)?(#[a-z0-9-]+)?\)/g)) {
    let owner = file;
    if (target) {
      const base = basename(target);
      owner = base === "SKILL.md" ? "SKILL.md" : `references/${base}`;
      check(anchors.has(owner), `${file}: link to missing file ${target}`);
    }
    if (anchor && anchors.has(owner)) {
      check(anchors.get(owner).has(anchor.slice(1)), `${file}: dead anchor ${target ?? ""}${anchor}`);
    }
  }
  check(!/[—–]/.test(text), `${file}: contains an em or en dash`);
}

// --- exactly one SKILL.md inside the skill directory ------------------------
// The Skills API and claude.ai reject an upload containing more than one, so a
// stray SKILL.md anywhere under the skill directory breaks installation there.
const nested = [];
(function walk(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    if (e.isDirectory()) walk(`${d}/${e.name}`);
    else if (e.name === "SKILL.md") nested.push(`${d}/${e.name}`);
  }
})(SKILL_DIR);
check(nested.length === 1, `skill directory holds ${nested.length} SKILL.md files, must hold exactly 1`);

// --- the marketplace manifest matches the repo -----------------------------
const mkt = JSON.parse(readFileSync(`${root}/.claude-plugin/marketplace.json`, "utf8"));
check(mkt.name === basename(root), `marketplace name "${mkt.name}" should match the repo directory`);
check(!/^(agent-skills|anthropic-marketplace|anthropic-plugins|claude-code-marketplace|claude-code-plugins|claude-plugins-official)$/.test(mkt.name),
  `marketplace name "${mkt.name}" is reserved`);
check(Array.isArray(mkt.plugins) && mkt.plugins.length > 0, "marketplace has no plugins");

if (fail.length) {
  console.error(`FAIL (${fail.length})`);
  for (const f of fail) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("OK: frontmatter, references, links and manifest all valid");
