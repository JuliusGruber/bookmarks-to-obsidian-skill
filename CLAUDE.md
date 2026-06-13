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
