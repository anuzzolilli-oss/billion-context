# Bounded maintenance: first review findings

On 2026-11-08, Kilo findings 1–5 were reproduced against `ff2b4e2`, then repaired without kernel changes. These results concern the opt-in bounded maintenance path; they do not establish a live deployment or general latency improvement.

| Finding | Reproduced failure | Repaired behavior |
| --- | --- | --- |
| Effective coverage | A 40,029-byte tool result was omitted from the summarizer request but included in committed coverage. | Tool pairs and reasoning companions remain complete units; oversized units stay visible while safe neighbors may fold. A read-only kernel preview validates exact coverage before generation and again before commit. |
| Post-fold identity | The kernel recommended m00005–m00006 at transformed indexes 2–3; maintenance selected old m00003–m00004 from originals. | Advertised refs resolve to original IDs; unknown endpoints are skipped. The second fold selects the new messages and creates a block. |
| Full retrieval | An 8,035-byte original was summarized, but its 266-byte emergency-truncated view populated the full archive cache. | The compression/cache path receives unmodified originals. Full retrieval returns the original middle, whether cached or collected from originals. |
| Hidden carrier | A retained ordinary tool call shared a provider call ID with hidden maintenance; summary stripping removed the only summary. | Hidden maintenance does not assign a native `compressCallId`. The summary survives the collision. |
| Pairing fidelity | Two different call/result associations produced byte-identical maintenance input. | Serialized calls and results retain `toolCallId`; different associations yield different source input. |

The kernel remains authoritative for actual fold eligibility and effective coverage. A preview rejection or coverage mismatch declines maintenance rather than permitting an incomplete source. The commit check also rejects a source-state or revision change during generation. The existing 32 KiB archive bound remains in force, including serialized tool IDs.

## Evidence

The original run had five causal safety-assertion failures and a passing normal-maintenance control. Each finding then passed the same target after its repair. The resulting tests are retained in `tests/bounded-maintenance-safety.test.ts` (ten scenarios, including complete and oversized reasoning/tool units, source revision changes and missing refs).

```sh
node --import ./tests/preload-test-env.mjs --import tsx --test tests/bounded-maintenance-safety.test.ts tests/bounded-maintenance.test.ts tests/native-call-carrier-e2e.test.ts tests/native-fold-invariant.test.ts tests/image-archive-judge.test.ts tests/image-archive-relay.test.ts
npm run typecheck
npm run build
```

Initial result: **58 tests passed**, no failures or skips; typecheck and build passed. Those earlier commands omitted the repository isolation preload and could write default logs or plugin-conversation maps despite the disabled SessionStore. The earlier claim that all state was isolated was too broad. No cleanup of ambient state is claimed. The corrected command above forces disposable temporary filesystem roots and contacts only loopback fake model services.

The originating task retains original RED logs, per-finding GREEN logs, combined targeted output and repair contract in its local `inspection-evidence/` directory. The hermetic preload deliberately creates temporary directories; tests can write disposable state there.

## Limits

The first patch repaired findings 1–5; the follow-up below addresses the remaining review. Existing shortened persisted block caches have not been migrated. No remote CI or live deployment verdict is implied. User-owned fork review remains separate from the running proxy.

## Remaining-review follow-up

The branch incorporates fork master `3ac3e95c` through a merge commit, retaining published history. Configuration documentation follows master's move into `docs/`; root redirect stubs remain redirects. Kernel changes and version metadata from master are preserved verbatim; this follow-up does not modify kernel source.

| Review concern | Repair and evidence |
| --- | --- |
| 6: undersized archive fragments | Kernel previews screen each candidate before ranking. A byte-heavy CJK fragment cannot displace a viable ASCII archive. |
| 7: provider credential override | Maintenance resolves and applies the same lane credential as relay; a disposable environment-key test checks the received authorization. |
| 8: downstream reprocessing | Maintenance sets the processing hop marker. A real second proxy listener forwards its two-message archive without processing it again. |
| 9: same-request overflow retry | A weak request-identity latch spans preparation reentry. Advancing cooldown cannot retry on the same incoming request object. |
| 10: watchdog cancellation | The decoding/maintenance controller is registered before processing. A real watchdog 504 aborts a delayed side call, creates no block, and does not forward the failed main request. |
| 11: expected-history decorations | Independent projection uses the configured compress predicate, consumed-call cleanup, absorption, subagent decorations, carrier suppression, reasoning policy and image pass. Decorated OpenCode and native/MCP two-fold tests pass. |
| 12: quoted summary markers | Ordinary tool results retain verified truncation handling; forged content still fails. |
| 13: protected-image resizing | Ordered trusted resize receipts carry old/new hashes and the actual smaller pixels. Real PNGs exercise archival plus multiple downscale rungs; changed pixels or omitted evidence still fail. |
| 14: disabled diagnostics | Receipt collection is gated before file verification. Instrumented relay tests observe zero archive-verification reads with diagnostics off and nonzero reads with diagnostics on; shedding remains active. |
| 15: request counts | A maintenance rebuild preserves the incoming request count. Wired tests compare request statistics against actual ordinary requests. |

Additional follow-up edges: unlimited summary length keeps a nonempty selection probe; final coverage preview retains `summaryMaxChars`; reused call IDs are treated as ambiguous without swallowing safe neighbors; reasoning groups include later assistant companions; binary search limits unit traversal to each resolved range. Original bytes now have a dedicated cache input, preserving the processed live view for shrink-ratio metrics. Post-fold tests assert successful second-block creation, full cache preservation, complete call/result IDs and the live-view shrink denominator.

Follow-up validation: **141 focused tests passed**, no failures or skips; typecheck and build passed. The broader run completed **162 tests: 154 passed, 8 failed**, all eight during Windows EPERM temporary-directory teardown in `issue1086-chain-self-exemption.test.ts`. One identical case was independently reproduced at unchanged fork master `3ac3e95c`. The focused run excludes that suite; no test assertions or cleanup policy were weakened. This is not a fully green broad-suite or remote CI verdict. Results are retained with the PR and the local follow-up report.

## Priority pass: overflow watchdog and rate-limit accounting

The review at `b2eaf2a2` identified a narrower watchdog gap: maintenance skipped during cooldown could become eligible after a delayed overflow response. Relay registration replaced the watchdog's decoding controller, leaving that later maintenance call uncancelled. A wired reproduction returned 504 but subsequently committed one block. Request abort registration now retains all phase controllers; watchdog expiry aborts every registered phase and registration after cancellation remains latched.

The same reproduction now observes zero blocks, a closed upstream maintenance fetch and zero in-flight request ownership after the watchdog 504, even after the fake upstream's delayed response would have completed. It exercises actual overflow recovery rather than only initial maintenance.

Maintenance now uses the normal throttle governor with the resolved destination, lane credential and exact request model. An active matching hold defers maintenance without egress, signature mutation or attempt consumption. Admitted responses use normal non-429 resolution or bounded provisional 429 classification, including Retry-After and conservative account scope for malformed errors. Transport/cancellation paths release their admitted probe tokens. This adds no hidden retry loop and preserves unrelated credential/model holds.

Regression cases cover matching account/credential/model holds, unrelated scope, model-specific 429 accounting, opaque 429 fallback, an expired hold's single-flight probe, successful resolution and transport-failure release. Local validation: **104 targeted tests passed** with no failures or skips, plus typecheck. The command uses the hermetic preload:

```sh
node --import ./tests/preload-test-env.mjs --import tsx --test tests/bounded-maintenance.test.ts tests/bounded-maintenance-safety.test.ts tests/issue4204-throttle-governor.test.ts tests/fix-806-request-watchdog.test.ts tests/native-call-carrier-e2e.test.ts tests/native-fold-invariant.test.ts
```

The other six warnings in that review are outside this priority pass. No live deployment or persisted-cache migration is performed; merge acceptance still requires current review and remote CI results.

## Remaining six warnings at 4dbc582d

The next pass addresses all six warnings that Kilo retained at `4dbc582d`:

| Concern | Repair and regression |
| --- | --- |
| Unbounded full-history selection previews | Candidate character minimums are checked without a kernel pass; only the four largest distinct candidates are retained. Selection performs at most four full-history previews, followed by the existing final pre-commit preview and normal execution for the chosen span. Forty subminimum fragments now require zero previews, while forty ineligible candidates require at most four. |
| Stale current-turn policy | Current delivery/policy facts are stamped before maintenance and again after rebuilding. `requireNudge` rejects an unprompted cooldown retry before generation even if an old arm was true; the pending attempt budget is unchanged. A transition from an unnudged seed to a fresh nudge successfully folds. |
| Repeated tool results | Every result retains its association with the current call until a new call of that ID. An oversized re-echo remains outside the fold while independent neighboring text can still fold; reused-call ambiguity safeguards remain active. |
| Configured carrier relocation | Independent expected projection invokes the same configured deterministic relocation after consumed-call cleanup. Native and MCP alias tests exercise a real relocated fold, both thinking configurations, and later requests. Existing two-fold native/MCP tests remain. |
| Quoted summary markers in ordinary prose | Strict projected-summary checks require structural identity or a header-anchored summary. Real emergency truncations of ordinary user/assistant prose quoting the marker in its middle pass; actual summary corruption remains a violation. |
| Preparation-plus-relay resizing | Preparation supplies a separate trusted expected-media view when no folded projection is available. Relay resize receipts validate against intermediate pixels, without claiming the request folded. A real 1900×1050 PNG is resized in preparation and again at egress; clean traffic passes, and altered pixels still fail. Disabled diagnostics avoid constructing the additional media view. |

Selection is deliberately best effort: if the bounded candidate set fails authoritative kernel checks, maintenance defers instead of scanning an unbounded number of alternatives or relaxing coverage. The four-preview bound concerns selection; final validation and actual compression still execute their normal checks. No wall-clock latency improvement is inferred from these operation-count tests.

The isolated targeted run passed **169 tests**. A separate policy/fold-point/image-rescale compatibility run passed **46 tests**, for **215 distinct passing tests**, no failures or skips. Typecheck, build and the unused-export gate passed. Commands:

```sh
node --import ./tests/preload-test-env.mjs --import tsx --test tests/bounded-maintenance-safety.test.ts tests/bounded-maintenance.test.ts tests/native-call-carrier-e2e.test.ts tests/native-fold-invariant.test.ts tests/image-archive-judge.test.ts tests/image-archive-relay.test.ts tests/invariant-judge.test.ts tests/issue4204-throttle-governor.test.ts tests/fix-806-request-watchdog.test.ts
node --import ./tests/preload-test-env.mjs --import tsx --test tests/issue5683-forbid-unprompted-compress.test.ts tests/compress-at-fold-point.test.ts tests/issue3400-image-rescale.test.ts
```

These are local checks against fake loopback services and generated images, not a full CI verdict or a live deployment. Existing persisted caches are not migrated. The latest CI and Kilo review must be assessed on the delivered head. PR #1 was already open and unmerged, so the changes preserve its branch and review history.

## Exact-head review follow-up: snapshot/media seam and whitespace quotations

Kilo's review of `0a47eacf71e93318bb1b4a50977f4d019dc4ddad` reported two warnings ([snapshot seam](https://github.com/anuzzolilli-oss/billion-context/pull/1#discussion_r4507503708), [quoted header](https://github.com/anuzzolilli-oss/billion-context/pull/1#discussion_r4507503712)). Its successful check status was not treated as approval. Earlier threads were resolved only after source/test mapping and a fresh 215-test pass on that exact head; the six most recent scopes were retained for review.

Reproduction produced **seven failing cases**: three snapshot/media corruption controls were incorrectly accepted, and leading-space quotations in both user and assistant roles falsely rejected legitimate kernel emergency truncation. Bare-newline quotations already passed because echo normalization strips their line-anchored header; leading spaces, including spaces after a newline, reproduce the narrower defect. The strict carrier fallback now uses the truncator's raw-header rule, while structural summary identities and native compression calls remain strict.

The independent media projection now maps the snapshot boundary through both message-local resizing and OpenAI wire canonicalization. Prefix and tail are resized separately, then jointly encoded; comparison with the prefix-only encoding identifies the projected boundary. A wire cell merging across that seam is included in validation in full. The projected boundary is captured with the expected view during preparation and passed to relay, rather than reusing an index into the original array. Expected bytes are never derived from actual outbound traffic. Trusted media views also require image-byte equality without an archive receipt: an additional negative control exposed that gap.

`snapshot-media-invariant.test.ts` covers adjacent assistant merging, a real 3200-pixel prefix-image resize with annotation, and a merge crossing the prefix/tail seam. It asserts the exact first live wire cell remains checked, rendered prefix differences remain exempt, and live-text rewrite/deletion plus live-image corruption fail. `native-fold-invariant.test.ts` exercises the real kernel truncator for both roles and four marker placements, retaining summary-corruption controls.

Validation: **242 tests passed**, zero failures/skips, across the previous maintenance/relay/judge/watchdog/governor/policy suites plus snapshot-media and snapshot-render suites. Typecheck, build (including dist import/external checks), and unused-export gate passed. RED and GREEN logs are retained under the task's `inspection-evidence/charis-*` artifacts. Snapshot harnesses emit listener-count warnings during repeated server startup; their assertions and teardown completed successfully. The separately documented Windows EPERM cleanup baseline remains separate and was not weakened or treated as a product pass. No kernel changes, live traffic, deployment, service restart, package publication or merge were performed. Fresh remote CI and Kilo must be checked on the resulting commit before declaring merge readiness.

## Off-request-path generation (2026-11-10)

Bounded maintenance previously awaited its model call on the request path. On the Cindy deployment (release `51a1cdbf-live`, `timeoutMs: 15000`) the proxy log recorded 392 measured runs: 387 ended at the deadline in stage `fetch` and 5 applied, and each failure stalled its request for about 15 seconds. A controlled replay of the maintenance request shape (12 requests sent directly to the upstream, not through the proxy; synthetic archive) returned valid `compress` calls in 8.9 to 23.0 seconds, never near the 6.3-second benchmark median the deadline had been tuned on. Duration tracked output length across replay and live successes; one alias spent 395 reasoning tokens despite `reasoning_effort: "low"`. The replay did not reproduce a small-request deadline failure on the alias with the most real sessions, so the cause of that share is not established.

The change moves generation off the request path and leaves the deadline, caps, prompt and options unchanged:

| Concern | Behavior |
| --- | --- |
| Request latency | A qualifying request launches one background call and is forwarded unchanged. It no longer waits for, or fails with, maintenance. |
| Upstream overlap | The background call is launched during preparation, before the launching request's own forward, so the two overlap at the upstream; before the change they were sequential. The throttle gate consults holds already observed and reserves no capacity for foreground traffic. On an upstream with a single concurrent slot left, the background call can take it and the launching request can receive the upstream's 429. That outcome has not been reproduced, the effect of a 429 on the background call on the foreground credential's hold has not been traced end to end, and whether the deployed upstream limits concurrency is not known. Accepted as a known risk; generation is not resequenced (#33). |
| Commit | A later request for the session collects the finished result under the session lock. The background task mutates no session state. |
| Staleness | The session revision always advances between requests, so collection checks identity: the refs must resolve to the same message ids and the kernel preview must cover exactly those originals. A rewritten source or a range the agent folded meanwhile is discarded as `stale`. |
| `compress.requireNudge` | A finished result is held until a turn that delivered a nudge; the engine's unprompted gate is not bypassed. |
| Rate-limit holds | An active hold defers the launch. A launch that would own the probe slot of an expired hold releases it and defers, because it now overlaps ordinary traffic. |
| Lifetime | Generation is not tied to the launching request. Server close cancels it. An uncollected result is lost on restart; the persisted retry state covers the re-attempt. |

Evidence is local, against fake loopback upstreams. A new integration test withholds the maintenance reply until the launching request's own forward has arrived; before the change it failed after a 15.3-second stall with no block, after it passes. The two suites hold 67 tests (32 integration, 35 safety), and a wider run with the carrier, fold-invariant, image, judge, throttle, watchdog and unprompted-gate suites passed 200 tests with no failures or skips. `compress.requireRecommendation` is still judged by the engine on the collecting turn: a span no longer offered for folding is not committed. Same-turn assertions moved to the following request with their negatives kept: the launching request is unfolded and carries no receipt, the next one is folded and carries the receipt once. The two watchdog tests were rewritten deliberately: a reply slower than the request watchdog no longer produces a 504, and a request that did end in 504 commits nothing and releases ownership. The earlier probe-ownership tests were replaced by the deferral above.

The overlap also reaches the launching request's own overflow recovery. One local run on `2d26085fa` (fake loopback upstream, a scratch copy of the overflow fixture that returns a usable recovery summary) had the maintenance call and the recovery's summary call generate for the same span within about 100 ms. Recovery committed its fold; the maintenance result was collected on the next request as `stale` and the session kept one block. The cost observed is one discarded generation, capped by `maxTokens`. The committed overflow fixture does not show this: its fake upstream answers the recovery summary call with a three-character completion, recovery backs off for 1500 ms and the 700 ms watchdog ends the request in 504, with or without maintenance (#35).

```sh
npm run build
node --import ./tests/preload-storage-baseline.mjs --import ./tests/preload-test-env.mjs --import tsx --test tests/bounded-maintenance.test.ts tests/bounded-maintenance-safety.test.ts tests/native-call-carrier-e2e.test.ts tests/native-fold-invariant.test.ts tests/snapshot-media-invariant.test.ts tests/image-archive-judge.test.ts tests/image-archive-relay.test.ts
```

Limits. No live deployment, remote CI verdict or real-provider run is implied. With the deployed 15-second deadline this change removes the stall but is not expected to raise the apply rate, since healthy calls were measured at 9 to 23 seconds; that needs a longer runtime deadline (the cap stays 30 seconds), which is a separate deployment decision. The second most affected alias was not replayed. The fold now lands one request later than the nudge that prompted it. Client credentials for the upstream stay in memory for the length of one generation after the launching request has ended.
