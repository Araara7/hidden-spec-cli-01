# hidden-spec-cli-01

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Araara7/hidden-spec-cli-01/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Araara7/hidden-spec-cli-01/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one command-line tool that applies AI-written edits in four formats — unified
diffs (often with wrong line numbers), SEARCH/REPLACE blocks, V4A patches and JSON
text-editor tool calls — to a tree of files, to the specification in the kit's SPEC.md.
It finds the lines an edit names even when the model drifted their whitespace or
indentation (three matching tiers, with re-indentation at the loosest tier), and it
changes every file or none: a failed edit is reported and nothing is written.

## Run it

```sh
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

Node 22 and its standard library alone; nothing is installed before the program runs.
PATCH is the path of the patch file, relative to the working directory (the root of
the tree); when it is absent or `-`, the patch is read from standard input.
`--format` is `auto` (the default, which detects the format), `unified`,
`search-replace`, `v4a` or `json`. `--check` does everything but write, and
`--strict` matches lines exactly (tier 0 only).

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
