# Repository conventions

## Specs and plans live at the repo root

All design specs and implementation plans go in **root-level** folders named
`specs/` and `plans/`:

- `specs/` — design specs (the "what" and "why": requirements, design decisions).
- `plans/` — implementation plans (the "how": ordered, executable task lists).

Do **not** nest these under `docs/`, `docs/superpowers/`, or any other parent.
There is exactly one `specs/` and one `plans/` directory, both at the repository
root.

### Naming

Prefix every file with the ISO date it was created:

- Spec: `specs/YYYY-MM-DD-<slug>-design.md`
- Plan: `plans/YYYY-MM-DD-<slug>.md`

A spec and its corresponding plan share the same `YYYY-MM-DD-<slug>` stem, e.g.
`specs/2026-06-13-selectable-bookmark-import-design.md` pairs with
`plans/2026-06-13-selectable-bookmark-import.md`.

### When writing new specs/plans

Whenever you (or a skill such as `superpowers:writing-plans` /
`superpowers:brainstorming`) produce a spec or plan, write it directly into the
root `specs/` or `plans/` folder following the naming above — never into a
skill-specific or `docs/`-nested subfolder.

## Tests live at the repo root, outside the skill folder

The distributable skill is the self-contained `bookmarks-to-obsidian/` folder —
the only thing users copy and the only thing packaged into a `.skill`. To keep
that folder shippable, **dev artifacts must not live inside it**:

- The **test suite** lives in the root-level `test/` folder and imports the code
  under test from `../bookmarks-to-obsidian/scripts/src/`. Never put tests,
  fixtures, `vitest`, or other dev tooling inside `bookmarks-to-obsidian/`.
- The **skill's own `package.json`** declares **runtime dependencies only** (no
  `devDependencies`, no test scripts).
- The **root `package.json`** is the dev/test harness: it depends on `vitest` and
  packaging tools only. Tests import runtime code and vendored modules directly
  from the skill folder, keeping the skill's lockfile and committed
  `node_modules/` as the single source of truth. Do not add a `file:` dependency
  on the skill folder: root `npm install` can prune the committed vendored tree
  while cleaning that linked package. Run `npm install` then `npm test` at the
  repo root.

The skill **ships its vendored `node_modules/`**: the committed
`bookmarks-to-obsidian/node_modules/` is a runtime-only tree (`npm ci --omit=dev`
from the skill's lockfile) so the copied folder runs with **no `npm install`**.
Both distribution routes are copy-and-run — the repo's own packager
(`npm run package`) includes `node_modules/` in the `.skill` archive (the official
`skill-creator` packager strips it). The tree is pure JavaScript (nothing compiles
native code), so it is cross-platform. The root harness still stays behind.

Re-vendor after a dependency bump (keeps the committed tree correct):

```
npm run vendor                            # (cd bookmarks-to-obsidian && npm ci --omit=dev)
git add bookmarks-to-obsidian/node_modules
```

Keep `--omit=dev` **only** — not `--omit=optional`: `defuddle/node` loads
`linkedom` and `turndown` from `optionalDependencies` at runtime, so omitting
optionals would pass `--help` but break real extraction.

## Git workflow — commit directly to `main`

This is a single-maintainer repository. **Commit directly to `main` and push to
`origin/main`.** Do not create feature branches, git worktrees, or pull requests
for changes here — this deliberately overrides the default "branch first when on
the default branch" behavior.

## Git commit messages — shell syntax

This is a Windows repo with two shells available: PowerShell **and** the Bash
tool (Git Bash / POSIX sh). Each parses multi-line strings differently, and
mixing them corrupts commit messages.

- **PowerShell here-strings** use `@'` … `'@`. They are **only** valid in the
  PowerShell tool.
- **The Bash tool does not understand `@'…'@`.** It reads `@` as a literal
  character, so a PowerShell here-string passed to `git commit -m` leaks a stray
  `@` into the commit subject.

To stay shell-agnostic, write commit messages with **repeated `-m` flags** (one
per paragraph) — this works identically in both shells:

```sh
git commit -m "subject line" -m "body paragraph one" -m "body paragraph two"
```

Only use a here-string when you have matched the syntax to the tool: `@'…'@` in
the **PowerShell** tool, or a POSIX heredoc (`git commit -F - <<'EOF' … EOF`)
in the **Bash** tool.

### Prefer the PowerShell tool for git in this repo

This machine's interactive shell is PowerShell, so **run git commands through the
PowerShell tool** to match the user's environment. Reserve the Bash tool for
genuinely POSIX scripts (e.g. `*.sh` files, shebang scripts). Picking one shell
deliberately — rather than drifting between them — is what prevents the
syntax-mismatch class of bug described above.
