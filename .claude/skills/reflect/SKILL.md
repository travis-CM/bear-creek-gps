---
name: reflect
description: End-of-session review. Lists what went wrong or took too long and proposes the smallest skill or CLAUDE.md edit that would have prevented it, then waits for Travis's OK.
---

# Reflect

Run at the end of every working session.

1. List what went wrong or took too long this session. For each one, give the evidence: the command, error, failed check or back-and-forth that shows it.
2. For each item, propose the smallest edit to a skill (`.claude/skills/`), an agent (`.claude/agents/`) or `CLAUDE.md` that would have prevented it. Show it as a before/after of the exact lines.
3. Skip items that were one-offs and wouldn't happen again.
4. Wait for Travis's OK. Apply only the edits he approves, exactly as approved.
5. Update `docs/progress.md` (dated log line), and add any new decisions to `docs/decisions.md` and gotchas to `docs/known-issues.md`.
