# billion-context Agent Contract

Canonical, harness-neutral project instructions. Read the task-specific references below before acting; their detailed policies remain mandatory, not optional background. Preserve human-authored policies when maintaining this map.

## Purpose and workspace

- billion-context (`bili`) is a context-compression proxy between agent clients and upstream providers.
- This checkout targets **anuzzolilli-oss/billion-context**. Pushes, issues and PRs go to that fork; `upstream` stays fetch-only with a disabled push URL.
- Read [Cindy project guide](docs/cindy-project.md) and [local workflow](reference/cindy-project.md) first. Checkout builds/tests do **not** deploy the separate live proxy; deployment needs explicit approval.
- One canonical rules file: this file. Any future harness adapter must point here, not duplicate policy. No glossary is currently needed; do not create a root glossary contrary to the docs layout.

## Stack and architecture

- TypeScript strict ESM; tsup bundles the in-repo `kernel/` and `pi-subagents/`. Versions/dependency exceptions: [contract §1](reference/development-contract.md#1-project-overview); executable truth: `package.json` and component manifests.
- `src/server.ts`, `src/server/`, `src/loop/`: request preparation, lanes and wire relay.
- `kernel/`: platform-independent compression core; `pi-subagents/`: Pi delegation component.
- `src/storage/`, `src/persist.ts`, `src/session-id.ts`: persistence and identity.
- `src/agent/`: host integrations; `src/update.ts`: load-bearing self-updater.
- [Architecture hub](docs/architecture.md) and [source map](reference/architecture.md) are live. Source module or depicted-flow changes require affected pages, diagrams, hub and map updates together.

## Always-loaded invariants

KDD numbers are stable. Tier A consequences remain here; full wording and all Tier B entries are in [contract §2](reference/development-contract.md#2-architecture), with mechanism detail in the append-only [KDD ledger](reference/design-decisions.md).

- **KDD 2 — ACP tags:** XML-format message refs; in source, write tag angle brackets as `\x3c` and `\x3e` so tooling cannot strip them.
- **KDD 4 — logging:** server logs go through `src/logger.ts`, not `console.error`; CLI/pre-logger exceptions are in the contract. Mask secrets.
- **KDD 6 — single writer:** every installed copy has exactly one writer, chosen by its install source. Use the owner's sanctioned update channel; never add a competing copy/writer or modify a host-managed copy in place. Bili-owned in-place updates remain subject to the detailed ownership contract.
- **KDD 7 — reason in BOTH compression modes:** plugin mode's agent executes compression locally and carries summaries in tool calls; the proxy suppresses tool/nudge injection and does not expose kernel summaries to that agent. Plain proxy mode executes compression server-side; its carrier is `acp_summary`, re-voiced by `systemToUser` as user at its anchor, preserving the head system prefix. Mode is per-request and session-bound, sticky/upgrade-only.
- **KDD 8 — nudge:** growth cadence is flat **50000**, independent of context-window percentage. Do not reintroduce percentage gates; the existing `compress.nudgeGrowthTokens` escape hatch and kernel-owned wording remain authoritative.
- **KDD 10 — signed thinking:** Anthropic thinking/redacted-thinking and Gemini thought signatures must remain byte-exact in both client-visible output and loop re-requests. No filtering, trimming, reorder or empty-segment removal. Changes require loop-level byte-equality tests on both signed wires; prose filters apply only to text.
- **Kernel identity:** content-hash IDs and `mNNNNN` refs are never reused within a session. Do not prune/repack ref maps so a freed number can be reissued. Read the detailed kernel identity contract before touching refs.
- **Wire fidelity:** preserve tool IDs/order, protocol framing and upstream constraints. Tool-call arguments are user intent: forward byte-exact, never strip tags from executable/persisted arguments. The wire-constraint ledger only grows without owner approval.
- **Config integrity:** never silently clobber user config; reject malformed input rather than merge defaults. Availability outranks performance; fix producers, not cosmetic payload symptoms.

## Hard boundaries

- Never merge PRs, force-push `master`, manually publish npm packages, or print credentials. Human merge only, including when detailed auto-merge eligibility criteria are met.
- Never cut a release without explicit owner approval. Root package version changes belong only to isolated release commits/branches. Component version rules are separately scoped below; unresolved interpretations must be escalated, not guessed.
- No new/renamed/re-semantic config shapes without prior owner sign-off and documented existing-surface mapping. Read [config/environment discipline](reference/development-contract.md#configuration-surface-discipline-owner-gated) and [env categories](reference/env-vars.md).
- Before any `kernel/**` work, read [Kernel Boundary](reference/development-contract.md#kernel-boundary-in-repo-acp-kernel-2092): dedicated approval issue except the recorded mechanical-bug exemption, PR declaration, required source-coupled version bump, both test layers, human review always. Structural invariants and runtime dependencies remain owner-gated.
- Before `pi-subagents/**` work, read [component boundary](reference/development-contract.md#pi-subagents-boundary-in-repo-pi-lane-component-2384): source-coupled version bump, both test layers, zero-runtime-dependency contract.
- Updater changes require the owner-approved no-op validation release first. Security, identity/session binding, wire/config/persistence changes and fallback/default decisions remain human-gated.
- One issue = one scope. Screen open AND closed issues/PRs first. Finished development requires a PR referencing its issue, not just a pushed branch. Separate discovered substantive problems; fix minor nonsemantic flaws in place.
- Preserve contributor authorship: additive fixes to existing PR branches, never replace their contributions. Post-merge supplements use a new follow-up PR.

## Verification and delivery

- Before code-level bug analysis, pin the reported bili/kernel version and inspect that build/tag. For checkout diagnostics, record the exact SHA and environment.
- Build before targeted tests; use both repository test preloads. Exact commands and Windows isolation: [Cindy workflow](reference/cindy-project.md#verify-changes). Do not install globally or touch port 8787 as routine checkout validation.
- Local verification is targeted; authoritative full-suite results are remote CI on the exact pushed head. A full local diagnostic run requires explicit owner approval and never substitutes for CI.
- Read [testing](reference/testing.md) for real-client/registry gates before pipeline/updater/install work. Keep skip gates; use allocated ports, not assumed-free fixed ports.
- Every gate needs positive AND negative assertions. Deterministic regression evidence must distinguish mechanism from symptom; inspect actual logs before blaming compression or retries.
- Double-review, then execute the changed behavior. Read review comments even when their check is green. Verify current master and rerun required checks before claiming mergeable.
- Report evidence, failures, skips and remaining uncertainty honestly. No deployment claim from a checkout build. Commit/PR attribution: `Assisted-by: Cindy (https://cindy.app)`; GitHub comments require the actual model declaration specified in the detailed contract.

## Required task references

These are scoped parts of this contract. Read each matching row before implementation; do not rely on this map as a substitute for its rules.

| Task | Mandatory reference |
|---|---|
| Any development or review | [Development standards](reference/development-contract.md#3-development-standards), [contribution checklist](reference/development-contract.md#6-contributing), [correctness/review guardrails](reference/development-contract.md#7-review--auto-merge-discipline) |
| Kernel, compression, cache, refs, signed payloads | [Architecture/KDD consequences](reference/development-contract.md#2-architecture), [KDD mechanism ledger](reference/design-decisions.md), [technical notes](docs/technical-notes.md) |
| Install/update/plugin ownership | [Single-writer/update contract](reference/development-contract.md#install-lane--update-ownership-contract-1196), [release procedure](reference/release.md) |
| Session/msgid/identity, snapshot or watermark lanes | KDD 9/11/13/15/17/18 in [§2](reference/development-contract.md#2-architecture); [msgid infrastructure](docs/msgid-infrastructure.md), [identity channels](docs/identity-channels.md) |
| Compression range eligibility | KDD 12 in [§2](reference/development-contract.md#2-architecture): shared projection on the exact apply-view array |
| Solver-guarded code | KDD 14 in [§2](reference/development-contract.md#2-architecture), [verif doctrine](verif/README.md); subset guard and relevant solver regressions |
| UI notices | KDD 16 in [§2](reference/development-contract.md#2-architecture): one registry/channel, B>A>S shadowing |
| Config/env/CLI surface | [Owner-gated config rules](reference/development-contract.md#configuration-surface-discipline-owner-gated), [environment rules](reference/env-vars.md) |
| Issues, commits, PRs | [Git safety/issue rules](reference/development-contract.md#4-git-safety-rules-mandatory), [triage](reference/triage.md), [Git/PR procedure](reference/git-pr.md); fork routing above overrides upstream examples |
| Release/version/updater | [Release policy](reference/development-contract.md#5-release-workflow), [release procedure](reference/release.md); stop for owner approval |
| Documentation/context maintenance | [Layout and language rules](reference/development-contract.md#documentation-layout-owner-ruling-2026-11-08-5920), [context maintenance notes](reference/context-maintenance.md), [reference index](reference/README.md) |

## Compatibility and unresolved policy tensions

- Detailed policy text was extracted, not rescinded. [Context maintenance notes](reference/context-maintenance.md) record authority, preservation checks and unresolved wording; do not silently turn those tensions into new policy.
- New decision/protocol docs belong in `docs/`, procedures in `reference/`; keep en/zh parity and both indexes updated. No redundant harness adapters or speculative glossary.
- Legacy section links below remain redirect anchors so existing documentation continues to resolve. They delegate to the matching numbered sections in [the detailed contract](reference/development-contract.md).

<a id="1-project-overview"></a>
<a id="2-architecture"></a>
<a id="3-development-standards"></a>
<a id="4-git-safety-rules-mandatory"></a>
<a id="5-release-workflow"></a>
<a id="6-contributing"></a>
<a id="7-review--auto-merge-discipline"></a>
<a id="71-before-you-start"></a>
<a id="72-review-discipline"></a>
<a id="73-correctness-guardrails"></a>
<a id="74-auto-merge-gate-this-repo-only"></a>
<a id="75-reviewer-focus--the-重灾区-second-round-zones"></a>
<a id="kernel-boundary-in-repo-acp-kernel-2092"></a>
<a id="pi-subagents-boundary-in-repo-pi-lane-component-2384"></a>

<a id="billion-context-development-specification"></a>
<a id="tech-stack"></a>
<a id="repository-info"></a>
<a id="module-map"></a>
<a id="key-design-decisions"></a>
<a id="18--身份信道接线所有车道接进同一采集缝消费者永不直读客户端存储-5825-tier-b"></a>
<a id="install-lane--update-ownership-contract-1196"></a>
<a id="kernel-contract-message-ids-are-never-reused"></a>
<a id="build-commands"></a>
<a id="local-testing--install"></a>
<a id="e2e-regression-real-client-through-bili"></a>
<a id="gate-test-discipline--negative-assertions-3617"></a>
<a id="configuration-surface-discipline-owner-gated"></a>
<a id="environment-variable-discipline-2030"></a>
<a id="code-quality"></a>
<a id="documentation-layout-owner-ruling-2026-11-08-5920"></a>
<a id="issue--problem-tracking-mandatory"></a>
<a id="issue-分类与标签规则triage-必做"></a>
<a id="version-bumps--one-version-one-commit-one-branch"></a>
