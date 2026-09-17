# Contributing

Issues and pull requests are welcome.

Everything in this repository is prose an agent reads and acts on, so the
writing is the product. Two checks stand between a change and a merge, and only
one of them is automated.

## Write it through the humanizer skill

Put new or reworded text through the `humanizer` skill before you commit it.
That covers the rules in `SKILL.md`, the reference sections, the README, this
file, commit messages and pull request descriptions. If your tool cannot run
the skill, work from Wikipedia's
["Signs of AI writing"](https://en.wikipedia.org/wiki/Wikipedia:Signs_of_AI_writing),
which is what it is based on.

It catches what the validator cannot see:

- A point staged rather than stated, usually as a contrast against something
  nobody claimed.
- A list padded out to three items because three sounds finished.
- A claim inflated past what was measured, or a ranking nothing in the text
  supports.
- A closing line that repeats the paragraph above it.

A reference that reads like a sales page is a reference an agent will summarise
back at you instead of following.

## Run the validator

```bash
node tools/validate.mjs
```

It checks the skill's frontmatter against the Agent Skills spec, that every
reference file exists and is reachable, that the links and anchors between
files resolve, the ban on em and en dashes, that the marketplace manifest
matches the repository, and that there is exactly one `SKILL.md`. CI runs it on
every pull request.

## Numbers

Every number in this skill is a measurement of one engine, at one version, on
one device, and it says so. If you add one, record those conditions with it and
say how you measured. A number without them is worse than no number, because
someone will act on it.
[verification](3d-web-scene-performance/references/verification.md) is the rule
this repository holds itself to as well.

## Adding to the probe harness

`3d-web-scene-performance/tools/probe-engine.mjs` asks the seven engine
questions through one adapter per engine. A second adapter is a good thing to
add: it is most of the work of porting the skill, and it shows you where the
skill has assumed one engine's behaviour.

An adapter answers what it can measure and leaves out what it cannot. A
question with no method prints `NOT MEASURED` and the measurement to go and
take by hand, which is the right output for a question nobody asked the engine.
