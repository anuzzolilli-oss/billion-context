# Cindy project: billion-context

[中文](cindy-project.zh-CN.md) · [Architecture](architecture.md) · [Working instructions](../reference/cindy-project.md)

This is Andrew's fork of the billion-context compression proxy, used by Cindy's Pi provider route. The project maintains bounded context maintenance, reliable archive retrieval and accurate history-consistency checks.

## Project identity

| Item | Value |
|---|---|
| Cindy project | `billion-context` on TheGame |
| Development checkout | `C:\Users\anuzz\Projects\billion-context` |
| Fork / `origin` | https://github.com/anuzzolilli-oss/billion-context |
| Default branch | `master` |
| Original source / `upstream` | https://github.com/ranxianglei/billion-context |
| Upstream push URL | `disabled://upstream-push-blocked` |

All pushes, issues and pull requests for this project belong in Andrew's fork unless Andrew explicitly selects a different destination. Keep the upstream push block in place.

## Development and the live service

The development checkout holds source, local dependencies and test/build outputs. Cindy tasks for this project should use that checkout. The earlier checkout inside the original conversation remains historical evidence; use the registered Projects directory for new development.

The live proxy runs from a separate release directory under `%APPDATA%\CindyGlobal\billion-context-proxy`, managed by the existing scheduled task **Cindy - billion-context proxy**. It listens on `127.0.0.1:8787`. Building or testing the checkout does not deploy a release.

As verified on 2026-11-08, live build `51a1cdbf-live` uses reviewed source `51a1cdbf4e732bfe9cedae73aec8aee53ec20599`. Its Git tree matches merged PR [#1](https://github.com/anuzzolilli-oss/billion-context/pull/1), merge commit `d6573a0881feb6102a3353e50060d07bf26099d9`. Treat these as a dated deployment snapshot; check the live manifest and deployment receipt before future operations.

The deployed configuration uses `promptPack: lean` and `nudgeGrowthTokens: 25000`. Its local runtime entry calls `startServer` with `boundedMaintenance: { timeoutMs: 15000, maxTokens: 1024 }`. Preserve that explicit runtime policy when preparing a replacement; building the standard CLI alone does not capture this deployment choice.

## Instructions for work in Cindy

1. Read [AGENTS.md](../AGENTS.md) and the relevant linked reference before editing. Preserve the kernel and Pi-subagents component boundaries.
2. Start with a clean-status check and confirm `origin` points to Andrew's fork. Keep changes scoped and reviewable on a feature branch.
3. Run targeted tests for the affected behavior during ordinary development. Full local runs require an explicit request; use the Windows partition recipe in the [workflow](../reference/cindy-project.md). Remote CI on the exact pushed head remains the merge gate.
4. Use the repository's test preloads, generated fixtures and loopback upstreams. Keep credentials out of source, logs and reports. Gated external-client/model tests need their stated prerequisites and separate authorization.
5. Deploy or restart the live proxy only when requested. Preserve settings, credentials and original archives; prepare rollback and verify the deployed manifest, forwarding, folding and retrieval.
6. Preserve human authorship and add `Assisted-by: Cindy (https://cindy.app)` to AI-assisted commits. Leave PR merging to the human operator, as required by the repository's approval policy. Publishing npm packages is outside the local deployment workflow.

## Where to look next

- [Architecture hub](architecture.md): request pipeline, lanes, identity, storage and compression kernel.
- [Configuration](configuration.md) and [client integrations](clients.md): supported settings and wire routes.
- [Testing reference](../reference/testing.md): runner isolation, CI scheduling and gated integration suites.
- [Maintenance evaluation](../reference/maintenance-safety-evaluation.md): repair evidence for bounded maintenance, watchdog/rate-limit handling, native carriers and image checks.
- [Cindy workflow](../reference/cindy-project.md): setup, full-suite commands, live verification and rollback procedure.

## Validation record

Bootstrap run on **2026-11-08**, source `d6573a08`, Windows Node **24.14.0**, npm **11.9.0**:

| Suite | Passed | Failed | Skipped |
|---|---:|---:|---:|
| Host: all 1,133 files, five disjoint partitions | 10,476 | 3 | 64 |
| Kernel: complete suite | 1,609 | 0 | 0 |
| Pi-subagents: complete suite | 263 | 0 | 0 |
| **Total** | **12,348** | **3** | **64** |

**Local full-suite verdict: not green.** No tests were cancelled. Build and typecheck passed.

- Two `release-ci-gate.test.ts` cases crashed their child Node process with `UV_HANDLE_CLOSING`; expected exit code `1`, observed `3221226505`. Both reproduced when that file ran alone: 14 passed, 2 failed. The native abort's underlying cause remains unconfirmed.
- `storage-durability.test.ts` hit `EPERM` in temporary-directory teardown. Its separate run passed all 7 tests; the original full-run failure remains recorded.

No application code, assertions, cleanup policy or timeouts were changed to hide these failures. The first unsharded launcher failed before tests with `ENAMETOOLONG`; all host files were subsequently covered using the existing partitioner. Isolated diagnostic reruns are excluded from the full-suite totals above.

The project bootstrap validation is recorded in `.tmp/project-verification/` in this checkout. The summary distinguishes host, kernel and Pi-subagents suites, skipped tests, failures and any subsequent diagnostic reruns. These local logs supplement the PR's remote CI evidence. A skipped or prerequisite-gated suite is not a passing external integration test.
