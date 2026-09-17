# 3D Web Scene Performance

An [Agent Skill](https://agentskills.io) that teaches coding agents to build
real-time 3D scenes on web pages that hold 60 fps across phones, tablets and
desktops, show something within five seconds on a slow connection, survive
in-site navigation without rebuilding, and degrade to a readable page when the
renderer fails.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Validate](https://github.com/hiddentao/3d-web-scene-performance-skill/actions/workflows/validate.yml/badge.svg)](https://github.com/hiddentao/3d-web-scene-performance-skill/actions/workflows/validate.yml)
[![Agent Skills](https://img.shields.io/badge/Agent%20Skills-spec%20compliant-7c3aed)](https://agentskills.io/specification)

[![Watch the walkthrough](https://i.vimeocdn.com/filter/overlay?src0=https%3A%2F%2Fi.vimeocdn.com%2Fvideo%2F2200943283-ce7d83544a9c6a1042091007b6b83fd5f12fec13fe23c28c10f104ebc3d0a447-d_1280x720&src1=http%3A%2F%2Ff.vimeocdn.com%2Fp%2Fimages%2Fcrawler_play.png)](https://vimeo.com/1226855845)

## What this is

Most advice about 3D on the web stops at "use instancing" and "reduce draw
calls". That is not where the time goes. This skill is the written-down result of
taking one production scene from a main-thread build that froze the page to a
worker-rendered scene with device tiers, progressive publication, a generation
cache and an adaptive frame controller - and then auditing every claim in it
against the code.

It gives an agent nine rules, the decision tables behind them, and seven
references covering device tiering, the frame budget, startup, the loading
contract, persistence, interaction and verification.

**What it does not give you** is stated up front inside the skill: scene-specific
values, product judgement, and defects that only a rendered comparison finds. It
transfers method, not numbers.

## The nine rules

1. **Measure completed frames, not callbacks.** A RAF counter reports 60 fps on a
 device drawing 22.
2. **Bound work in flight.** Unbounded submission converts frame time into input
 latency and hides the overload from your own metrics.
3. **One table per build, not branches at call sites.** A single `quality` scalar
 cannot express a row that wants a third of the scatter at full resolution.
4. **A declined pass is a whole pass, not a smaller one.** Decline shadows,
 reflections, AO and the post chain together or the saving is a fraction.
5. **The page must read without the scene.** No JavaScript, a failed renderer, a
 device that died last time - one static path. Build it first.
6. **Publish front to back, in complete slices.** Each stage renderable, with a
 real task boundary between them.
7. **Hold for a deadline, not for completion.** Never gate content on work whose
 duration you do not control.
8. **Cache generated data, never engine objects.** A hit must replay exactly what
 generation returns.
9. **Verify after your build tools have touched the code.** A shader that
 compiles from source can still fail in production.

## Install

This skill follows the [Agent Skills specification](https://agentskills.io/specification),
so installing it is the same everywhere: **copy the `3d-web-scene-performance`
directory into wherever your tool looks for skills.** Keep the directory name as
it is - the spec requires it to match the skill's `name`.

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

Prefer a symlink if you want `git pull` to keep it current:

```bash
ln -s "$PWD/3d-web-scene-performance-skill/3d-web-scene-performance" ~/.claude/skills/
```

### Claude Code, as a plugin

Two commands, from a shell or as slash commands in a session:

```bash
claude plugin marketplace add hiddentao/3d-web-scene-performance-skill
claude plugin install 3d-web-scene-performance@3d-web-scene-performance-skill
```

The part after `@` is the marketplace's `name` field, which this repo sets to
match the repo name so the two agree.

### claude.ai and the Claude desktop app

The chat surfaces take a zip upload rather than a directory:

1. Settings → Capabilities → enable code execution and file creation.
2. Customize → Skills → **+** → Create skill → Upload a skill.
3. Choose a zip whose **root** is the skill folder.

```bash
cd 3d-web-scene-performance-skill
zip -r 3d-web-scene-performance.zip 3d-web-scene-performance/
```

The skill directory holds exactly one `SKILL.md`, which is what the upload
validates for - a zip with more than one is rejected.

This skill is plain markdown with no scripts or binaries, so it also passes the
text-only validation that enterprise organisation uploads apply.

### Any other agent

If your tool has no skills concept, it almost certainly reads
[AGENTS.md](https://agents.md). Copy [`AGENTS.md`](AGENTS.md) to your repo root -
it carries the rules in condensed form. For the full depth, read the
[references](3d-web-scene-performance/references/) directly, or vendor the skill
directory into your repo so your agent can open them on demand.

Two tools need their own handling: **Aider** has no skills discovery and loads a
file only via `.aider.conf.yml` (`read: AGENTS.md`); **Continue** uses
`.continue/rules/` and its AGENTS.md support was still an open issue at the time
of writing.

> **Verified how.** Every path above comes from the tool's own documentation. I
> have not personally run every tool end to end, so treat these as documented
> rather than tested. Windsurf is deliberately absent: it became Devin Desktop in
> 2026 and I could not confirm the old rules convention survived the rebrand.

## How it is laid out

`3d-web-scene-performance/SKILL.md` is a 412-line spine: the nine rules, the
decision tables, and the budget arithmetic. The seven files in `references/`
carry one area each in full, and an agent opens only what a task needs.

That split is deliberate. A skill's body loads into context every time the skill
triggers, so the spec recommends keeping it under 500 lines with the detail
loaded on demand. Around 2,500 lines of depth is available without any of it
costing context until it is wanted.

## Provenance and limits

The material comes from one production scene: a procedural Three.js r180 /
WebGPU landscape driven by scroll, shipped on a marketing homepage. Every number
presented as a measurement was measured there, on stated hardware.

That origin is also the limit. Five adversarial reviews of this material found
that its coverage of that codebase proves it was written from that codebase, not
that its rules transfer. They also caught four factual errors, including an
exponent this skill's own source repository still gets wrong. Both the rules and
their corrections are in the text, with the arithmetic shown.

Treat every rule here as a strong prior worth testing, not a result.

## Contributing

Issues and pull requests welcome. `tools/validate.mjs` runs in CI and checks frontmatter
against the published spec, cross-file links, and that the skill directory holds
exactly one `SKILL.md` - run it before opening a PR:

```bash
node tools/validate.mjs
```

## License

[MIT](LICENSE).
