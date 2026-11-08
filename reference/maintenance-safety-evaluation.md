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
