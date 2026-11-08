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
node --import tsx --test tests/bounded-maintenance-safety.test.ts tests/bounded-maintenance.test.ts tests/native-call-carrier-e2e.test.ts tests/native-fold-invariant.test.ts tests/image-archive-judge.test.ts tests/image-archive-relay.test.ts
npm run typecheck
npm run build
```

Result: **58 tests passed**, no failures or skips; typecheck and build passed. Checks execute actual maintenance, kernel, truncate, archive-cache, summary-strip and decompress paths using disposable in-memory sessions and a loopback fake model service. They do not contact a paid model or modify live proxy state.

The originating task retains the original RED logs, per-finding GREEN logs, combined targeted output and repair contract in its local `inspection-evidence/` directory. Regression tests do not write artifacts outside the checkout.

## Limits

This patch repairs findings 1–5. Other review findings remain to be triaged. It does not repair already-shortened persisted block caches, migrate existing blocks, rebase the branch onto newer master, certify remote CI, or deploy the fix. User-owned fork review remains separate from the running proxy.
