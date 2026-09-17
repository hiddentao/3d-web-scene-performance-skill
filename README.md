# 3D Web Scene Performance

An [Agent Skill](https://agentskills.io) that teaches coding agents to build
real-time 3D scenes on web pages. The scenes hold 60 fps across phones, tablets
and desktops, show something within five seconds on a slow connection, survive
in-site navigation without rebuilding, and degrade to a readable page when the
renderer fails.

**Live demo: [hezo.ai](https://hezo.ai)**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Validate](https://github.com/hiddentao/3d-web-scene-performance-skill/actions/workflows/validate.yml/badge.svg)](https://github.com/hiddentao/3d-web-scene-performance-skill/actions/workflows/validate.yml)
[![Agent Skills](https://img.shields.io/badge/Agent%20Skills-spec%20compliant-7c3aed)](https://agentskills.io/specification)

[![Watch the walkthrough](https://i.vimeocdn.com/filter/overlay?src0=https%3A%2F%2Fi.vimeocdn.com%2Fvideo%2F2200943283-ce7d83544a9c6a1042091007b6b83fd5f12fec13fe23c28c10f104ebc3d0a447-d_1280x720&src1=http%3A%2F%2Ff.vimeocdn.com%2Fp%2Fimages%2Fcrawler_play.png)](https://vimeo.com/1226855845)

## What this is

The skill comes from the scroll-driven 3D landscape on the hezo.ai marketing
homepage, a procedural scene built with Three.js r180 and WebGPU. That scene
started as a main-thread build that froze the page. It became a worker-rendered
scene with device tiers, progressive publication, a generation cache and an
adaptive frame controller, and this skill records how it got there.

It gives an agent nine rules, the decision tables behind them, and seven
references covering device tiering, the frame budget, startup, the loading
contract, persistence, interaction and verification. The rules apply to any
engine. The worked examples show how the hezo.ai scene implements each rule, and
every number given as a measurement was measured on that scene, on stated
hardware.

## The nine rules

1. **Measure completed frames, not callbacks.** A RAF counter reports 60 fps on
 a device drawing 22.
2. **Bound work in flight.** Unbounded submission turns frame time into input
 latency and hides the overload from your own metrics.
3. **One table per build, not branches at call sites.** A single `quality`
 scalar cannot express a row that wants a third of the scatter at full
 resolution.
4. **A declined pass is a whole pass, not a smaller one.** Decline shadows,
 reflections, AO and the post chain together, or you save only a fraction of
 their cost.
5. **The page must read without the scene.** No JavaScript, a failed renderer
 and a device that died last time all land on one static path. Build that path
 first.
6. **Publish front to back, in complete slices.** Each stage renders on its own,
 with a real task boundary before the next one starts.
7. **Hold for a deadline, not for completion.** Never make content wait on work
 whose duration you do not control.
8. **Cache generated data, never engine objects.** A cache hit must replay
 exactly what generation returns.
9. **Verify after your build tools have touched the code.** A shader that
 compiles from source can still fail in production.

## Install

This skill follows the [Agent Skills specification](https://agentskills.io/specification),
so you install it the same way in every tool: copy the `3d-web-scene-performance`
directory into the folder where your tool looks for skills. Keep the directory
name as it is, because the spec requires it to match the skill's `name`.

```bash
git clone https://github.com/hiddentao/3d-web-scene-performance-skill.git
```

Then copy the skill directory to the right place:

| Tool | Project-level | User-level |
| --- | --- | --- |
| Claude Code | `.claude/skills/` | `~/.claude/skills/` |
| Codex CLI, ChatGPT desktop | `.agents/skills/` | `~/.agents/skills/` |
| Cursor | `.cursor/skills/` | `~/.cursor/skills/` |
| GitHub Copilot, VS Code | `.github/skills/` | `~/.copilot/skills/` |
| Gemini CLI, Zed | native skills support | see tool docs |

For example, for Claude Code:

```bash
mkdir -p ~/.claude/skills
cp -r 3d-web-scene-performance-skill/3d-web-scene-performance ~/.claude/skills/
```

To keep it current with `git pull`, use a symlink instead:

```bash
ln -s "$PWD/3d-web-scene-performance-skill/3d-web-scene-performance" ~/.claude/skills/
```

The paths in this section come from each tool's own documentation.

### Claude Code plugin

Run these two commands from a shell, or as slash commands in a session:

```bash
claude plugin marketplace add hiddentao/3d-web-scene-performance-skill
claude plugin install 3d-web-scene-performance@3d-web-scene-performance-skill
```

The part after `@` is the marketplace's `name` field. This repo sets it to the
repo name so the two match.

### claude.ai and the Claude desktop app

The chat apps install skills from a zip file:

1. Settings → Capabilities → enable code execution and file creation.
2. Customize → Skills → **+** → Create skill → Upload a skill.
3. Choose a zip that has the skill folder at its root.

```bash
cd 3d-web-scene-performance-skill
zip -r 3d-web-scene-performance.zip 3d-web-scene-performance/
```

The upload accepts a zip with exactly one `SKILL.md`, and the skill directory
has one. The skill is plain Markdown with no scripts or binaries, so it also
passes the text-only check that enterprise organisation uploads apply.

### Any other agent

If your tool has no skills support, it almost certainly reads
[AGENTS.md](https://agents.md). Copy [`AGENTS.md`](AGENTS.md) to your repo root.
It has the rules in short form. For the full detail, read the
[references](3d-web-scene-performance/references/) directly, or vendor the skill
directory into your repo so your agent can open them when it needs them.

Aider loads extra files through `.aider.conf.yml`, so add `read: AGENTS.md`
there. Continue loads rules from `.continue/rules/`.

## How it is laid out

`3d-web-scene-performance/SKILL.md` is a 412-line spine with the nine rules, the
decision tables and the budget arithmetic. Each of the seven files in
`references/` covers one area in full, and an agent opens only the ones a task
needs.

A skill's body loads into context every time the skill triggers, so the spec
recommends keeping it under 500 lines and loading detail on demand. The
references hold about 2,500 lines, and none of it uses context until an agent
opens it.

## Contributing

Issues and pull requests are welcome. CI runs `tools/validate.mjs`, which checks
frontmatter against the published spec, checks cross-file links, and confirms
that the skill directory holds exactly one `SKILL.md`. Run it before you open a
PR:

```bash
node tools/validate.mjs
```

## License

[MIT](LICENSE).
