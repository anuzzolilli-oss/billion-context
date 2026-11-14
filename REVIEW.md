# Review guidance

Policy for automated pull request review in this repository. The aim is fewer wasted
reviews and no lost real findings: spend effort where defects are likely, and stay
quiet where they are not.

## Review depth

Choose the depth from the diff before reading anything else. "Changed lines" means
additions plus deletions.

**Light.** Use when the diff is docs-only, formatting-only, lockfile-only,
generated-files-only, or under 50 changed lines in total.
- One pass over the diff. Use 0 sub-agents.
- Do not explore the wider repository. Open a file outside the diff only to confirm
  one specific suspected defect.
- Report CRITICAL and WARNING findings only. No suggestions.
- If there is nothing to report, say "No issues found" in one line and stop.
- Light never applies to a diff that touches a high-risk path listed under
  "Repo-specific rules". Review those at the default depth or deeper, whatever their
  size.

**Everything else.** Use the default review depth and the default sub-agent tiers.
This file does not reduce them.

Sub-agents stay read-only, never post comments, and return path, line, severity,
rationale and confidence. The main reviewer verifies every finding before posting.

## Severity

- **CRITICAL**: data loss or corruption, a security hole, an exposed secret, a crash
  on a main path, or a broken public contract.
- **WARNING**: a concrete defect with a reachable failure, or changed behaviour that
  the repository's rules require a test for and that has none.
- **SUGGESTION**: at most 3 per review, and only where it prevents a likely future
  defect.

Do not report: style, naming or wording preferences; anything a linter or formatter
enforces; speculative "consider" notes; praise; restatements of the diff; problems in
unchanged code unless this change makes them reachable; anything in a skipped path.

## What a finding must contain

1. The exact file and line in the diff.
2. The failing input or state and the wrong result, in one or two sentences.
3. Why it is reachable, citing the code that shows it.
4. The smallest direction for a fix.

If no concrete failure can be named, do not post the finding. One finding per root
cause: merge duplicates and name the other locations in the same comment.

## Skip

Do not review or comment on: lockfiles; generated, vendored or minified files;
snapshots and recorded fixtures; binary files and images. Repo-specific additions are
listed below.

## Summary

Keep the summary short. No file-by-file recap. State what was reviewed, whether
the Light pass was used, and the findings by severity.

## Repo-specific rules

Source of truth for project rules: `AGENTS.md` and the references it points to under
`reference/`. Where this file and `AGENTS.md` disagree, `AGENTS.md` wins.

High-risk paths (never Light): `kernel/`, `pi-subagents/`, anything handling
compression, caching, references or signed payloads, wire or config shapes,
persistence, and identity or session binding.

Check, where the diff touches them:
- **Signed thinking stays byte-exact.** Provider thinking and thought-signature
  payloads must pass through unchanged, in client-visible output and in re-requests.
  Flag filtering, trimming, reordering or removal of empty segments. CRITICAL.
- **Kernel boundary.** Changes under `kernel/` need the approval and declaration that
  `AGENTS.md` describes. Note in the summary when a diff touches `kernel/` without it.
- **Config surface.** Flag a new, renamed or re-meaning config field or flag that is
  not documented where the config guard expects it.
- **Versions.** Root package version changes belong only to release commits. Flag a
  version bump mixed into other work.
- **Tests.** Every gate needs a positive and a negative assertion. Tests use allocated
  ports, never fixed ones, and keep their skip gates. Flag a regression test that
  would pass on the symptom without proving the mechanism.
- **Docs.** New documents belong under `docs/` with English and Chinese versions and
  both index entries. Flag a missing counterpart.

Skip: `devlog/`, `paper/`, `release-notes/`, recorded results under `benchmarks/`,
generated files under `website/`, and translated `*.zh-CN.md` files except to flag
one missing from a docs change.
