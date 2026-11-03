---
name: sipges-adr
description: "Use when a SIPGES decision changes architecture, stack, hosting, security posture or a cross-context rule and needs an Architecture Decision Record in docs/adr, or an existing ADR must be superseded or amended."
---

# Write an Architecture Decision Record

Format (`docs/adr/README.md`): Michael Nygard ADR, one decision per file. Superseded ADRs stay and link
forward. Use `cognitive-doc-design` for the prose.

## Steps

1. **Is it an ADR?** Yes for a choice that is hard to reverse or that other work must follow (stack,
   hosting, tenancy, identity, data format, an engine's model). No for a bug fix, a refactor inside one
   context or a task plan (those go in `odd/tasks/`).
2. **Number and file.** Next free number: `ls docs/adr | sort | tail -2`. File
   `docs/adr/NNNN-<kebab-title>.md`. When parallel branches may each add one, check open PRs
   (`gh pr list --search "docs/adr in:path"`) before taking the number.
3. **Sections, in order:**
   - `# NNNN — <Title>`
   - `## Status`: `Accepted (YYYY-MM-DD)` or `Proposed`; `Supersedes [NNNN](…)` / `Amends [NNNN](…)`
     with what changes.
   - `## Context`: the owner's words verbatim in «…» when they set the direction; measured facts with
     their source and the date read (`docs/…`, a URL, `odd/tasks/<feature>.md` L-entries). Facts shape
     how, not whether, when the owner already decided.
   - `## Decision`: numbered, testable statements.
   - `## Consequences`: what gets easier, harder, and what must now happen (tasks, gates).
   - `## Alternatives considered`: each with the reason it lost.
4. **Index and links.** Add the row to the table in `docs/adr/README.md`; change the status of a
   superseded or amended ADR there and in its own `## Status`, linking forward. Link the ADR from the
   code or docs that implement it (`ADR NNNN §n`).
5. **External facts are current.** Read the vendor docs the decision depends on in the same week and
   cite them with the date; never rely on remembered limits or prices.

## Checks

`pnpm exec prettier --check docs/adr/<file> docs/adr/README.md` and the links resolve (relative paths).
Commit alone as `docs(adr): <decision in imperative>`, or with the code that applies it.

Evidence of the flow: ADR 0028 (#84), 0029 (#115), 0030 (#130), 0031 (#161), 0032 (#202).

Reference: [Codex skills](https://developers.openai.com/codex/skills/).
