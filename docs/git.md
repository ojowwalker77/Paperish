# Designs in your repo

Every file is a `.paperish` file in the project's `design/` folder, e.g. `design/checkout.paperish`:
- **Every edit saves into it.** It's JSON written deterministically: nodes in tree order, one style per line, no timestamps. A git diff shows exactly which layers and properties changed.
- **Images and font files** are copied into `design/assets/`, named by content hash. Commit them with the file.
- **The linked codebase** is stored as a relative path, so a teammate who opens the file from their own clone gets the same components.
- **Outside changes reload the file**, e.g. `git checkout`, `pull`, `stash`, or a teammate's edit. If the file on disk can't be read (merge conflicts), Paperish stops saving to it until it's fixed, so it never overwrites your conflict.
- **The branch picker in the status bar** shows the branch and a dot for uncommitted changes. Its menu opens **Changes**: the file's commits, plus your uncommitted work, each rendered as a visual diff per artboard (side by side, swipe, or heatmap) with a content-match score.
- **Deleting a file** moves it to the system trash.

## Worktrees and branches

A repo has checkouts: the main one and any git worktrees, which is where agents mostly work. Each checkout has its own `design/` folder, so an agent's edits land in its worktree, on its branch.
- **The branch picker** switches between checkouts, and also shows branches that have no worktree as committed (read-only).
- **A project opens on the checkout an agent last worked in**, else the one with the newest design. When an agent edits a checkout you're not looking at, an "Agent in `<branch>`" pill takes you there.
- **Agents reach their own checkout.** The `.mcp.json` entry sends `X-Paperish-Dir: ${PWD}`, so a Claude Code session started inside a worktree targets that worktree. Worktrees made inside a session (`claude --worktree`, subagents) share the parent's MCP connection, so Paperish can't tell them apart from the header. For those, agents `open_file` the `.paperish` path under their working directory and pass its `fileId` (or `cwd` to `list_files`/`create_file`), as the tool descriptions and guide tell them. A call that names no file and no directory in a repo with several checkouts fails and asks for one, rather than guess and edit another agent's worktree.

For agents, `compare_revision` summarizes what changed since a revision ("HEAD", "main"), and `visual_diff` takes `reference.revision` for a single node.

## Design diffs from the command line

`paperish diff` renders every `.paperish` file a branch changed, headless, and compares each artboard with the base branch, using the same engine as **Changes**:

```sh
paperish diff --base main --out paperish-diff
```

- **`--base`** is the branch or revision to compare with (default `main`); files are compared from where the branch forked off it.
- **`--head`** is the revision to compare (default: the working tree, including new untracked files).
- **`--out`** gets `summary.md` (a short report per artboard: what changed, the content-match score, before | after | heatmap images), `diff.json` and the JPEG images.
- **`--url`** prefixes the image links in `summary.md`, for when the images are hosted somewhere else.

It runs on a scratch data folder and its own port, so it works next to a running Paperish. On Linux without a display, run it under `xvfb-run`. From a clone of Paperish: `npx vite build && NODE_ENV=production npx electron . diff …`.
