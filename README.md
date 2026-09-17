# 3D Web Scene Performance

An [Agent Skill](https://agentskills.io) that teaches coding agents to build fast
3D scenes for web pages. The scenes run at 60 fps on phones, tablets and
desktops, show something within five seconds on a slow connection, stay loaded
when visitors move between pages, and fall back to a normal page if the 3D
renderer fails.

**Live demo: [hezo.ai](https://hezo.ai)**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Validate](https://github.com/hiddentao/3d-web-scene-performance-skill/actions/workflows/validate.yml/badge.svg)](https://github.com/hiddentao/3d-web-scene-performance-skill/actions/workflows/validate.yml)
[![Agent Skills](https://img.shields.io/badge/Agent%20Skills-spec%20compliant-7c3aed)](https://agentskills.io/specification)

[![Watch the walkthrough](https://i.vimeocdn.com/filter/overlay?src0=https%3A%2F%2Fi.vimeocdn.com%2Fvideo%2F2200943283-ce7d83544a9c6a1042091007b6b83fd5f12fec13fe23c28c10f104ebc3d0a447-d_1280x720&src1=http%3A%2F%2Ff.vimeocdn.com%2Fp%2Fimages%2Fcrawler_play.png)](https://vimeo.com/1226855845)

## What this is

The skill comes from the 3D landscape on the hezo.ai homepage. The landscape is
generated in code, moves as you scroll, and uses Three.js r180 and WebGPU.

The first version built the scene on the main thread and froze the page. The
final version renders in a web worker, picks settings for each type of device,
builds the scene in stages, caches generated data between visits, and lowers
quality when the frame rate drops. This skill explains how to build a scene that
way.

It gives an agent nine rules and seven reference files. The references cover
device settings, frame timing, startup speed, loading screens, caching and page
navigation, user input, and measuring performance. The rules work with any 3D
engine. The examples and measured numbers come from the hezo.ai scene.

## The nine rules

1. **Count frames the GPU finishes.** The browser's animation callback keeps
 firing when the GPU falls behind. A counter based on it can show 60 fps while
 the screen updates only 22 times a second.
2. **Do not let frames pile up.** Do not send a new frame while two are still
 unfinished. A backlog makes the scene lag behind scrolling and taps, and your
 frame counter will not show it.
3. **Keep device settings in one table.** Give each type of device one row of
 settings. Separate `isMobile` checks across the code drift apart, and one
 quality slider cannot say "fewer objects but full sharpness".
4. **Turn expensive effects fully off.** Shadows, reflections, ambient occlusion
 and post-processing each redraw the whole scene. Turn them off together, and
 skip them in the code instead of setting them to zero.
5. **Make the page work without the 3D scene.** If JavaScript is off, the
 renderer fails or the device crashed on the last visit, show a static page
 with the same content. Build that page first.
6. **Build the scene in stages.** Start with what the visitor sees first. Each
 stage should look complete, and the browser needs a pause between stages to
 handle input.
7. **Set a time limit for loading.** Decide how long the visitor waits. After
 that, show the page and let the scene appear behind it when it is ready.
8. **Cache generated data, not 3D objects.** Numbers and arrays can be saved and
 reloaded. Meshes, materials and GPU resources cannot. Data from the cache must
 give the same result as generating it again.
9. **Test the production build.** Bundlers change your code, so a shader that
 works in development can break in production.

## Install

This skill follows the [Agent Skills specification](https://agentskills.io/specification),
so you install it the same way in every tool: copy the `3d-web-scene-performance`
directory into the folder where your tool looks for skills. Do not rename the
directory. The spec requires it to match the skill's name.

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

To get updates with `git pull`, use a symlink instead:

```bash
ln -s "$PWD/3d-web-scene-performance-skill/3d-web-scene-performance" ~/.claude/skills/
```

The paths in this section come from each tool's documentation.

### Claude Code plugin

Run these two commands in a shell, or as slash commands in a session:

```bash
claude plugin marketplace add hiddentao/3d-web-scene-performance-skill
claude plugin install 3d-web-scene-performance@3d-web-scene-performance-skill
```

### claude.ai and the Claude desktop app

The chat apps install skills from a zip file:

1. Settings → Capabilities → enable code execution and file creation.
2. Customize → Skills → **+** → Create skill → Upload a skill.
3. Choose a zip that has the skill folder at its root.

```bash
cd 3d-web-scene-performance-skill
zip -r 3d-web-scene-performance.zip 3d-web-scene-performance/
```

The zip must contain exactly one `SKILL.md`. The skill is plain Markdown, so
enterprise organisations can upload it too.

### Any other agent

Most tools without skills support read [AGENTS.md](https://agents.md). Copy
[`AGENTS.md`](AGENTS.md) to your repo root. It has a short version of the rules.
For the full detail, copy the skill directory into your repo so your agent can
open the [references](3d-web-scene-performance/references/) when it needs them.

For Aider, add `read: AGENTS.md` to `.aider.conf.yml`. Continue reads rules from
`.continue/rules/`.

## How it is laid out

`3d-web-scene-performance/SKILL.md` holds the nine rules, the decision tables and
the frame time calculations in 412 lines. The seven files in `references/` each
cover one topic in depth.

An agent reads `SKILL.md` every time it uses the skill, so the spec asks for it
to stay under 500 lines. The references add about 2,500 lines, and the agent
reads each one only when a task needs it.

## Contributing

Issues and pull requests are welcome. Run the validator before you open a PR.
It checks the skill's frontmatter, the links between files, and that there is
exactly one `SKILL.md`. CI runs it too.

```bash
node tools/validate.mjs
```

## License

[MIT](LICENSE).
