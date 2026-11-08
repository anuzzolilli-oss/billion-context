# eph02 proxy evaluation

Status as of 2026-11-08: the native compression-carrier checker correction is deployed and verified on the original eph02 conversation.

## Finding and correction

Pi retains a compression summary in the originating `compress` tool call. The kernel intentionally omits a duplicate rendered summary message. The checker previously recognized folds only through that separate message and reported legitimate removal of archived originals as I1 history drops.

Native OpenAI preparation now derives the expected retained history from active recorded fold state, including native call carriers. The checker classifies that trusted projection as folded and verifies the complete native summary arguments, protected content and tool pairing. A model-written compress call without recorded coverage grants no exemption. Kernel behavior, archives, model routing and maintenance policy are unchanged by this checker correction.

## Recorded-history comparison

An isolated replay of 444 recorded eph02 messages forwarded 179 messages under both builds. The previous build emitted one I1 warning; the corrected build emitted none and recorded a clean fold verdict. Forwarded payloads matched after removing generated render tags, whose timestamps differed. No project tools ran in this replay.

The earlier read-only archive audit verified all 420 distinct originals covered by the five active blocks: all were present with matching lengths and SHA-256 hashes. The warnings were not evidence that those originals had been lost.

## Original live-session check

At 01:17 America/New_York on 2026-11-08, the original eph02 conversation resumed for a bounded acknowledgement on the saved Pi/Omniroute model route. Its two model requests passed as clean folds, matching **185/185** and **187/187** expected messages, with **zero new history warnings**. It returned exactly `EPH02_CHECKER_OK` and completed normally. The turn did not resume project work.

The deployed local bundle was identified as `daa082e-carrier-4013c603`; this identifies the pre-commit tested bundle, not a published upstream release. Historical warning lines remain in the logs.

## Regression evidence

The deployment check passed 119 targeted tests, typecheck and package build. Regression coverage includes two native folds and subsequent requests, tail-positioned rendered summaries, summary corruption, missing protected history, forged calls without coverage, and tool pairing. Standalone native call-carrier integration tests accompany this commit so the checker tests do not depend on the separate experimental maintenance changes.

Before committing, the exact staged files were exported into a separate validation checkout. That checker-only tree passed **98 targeted tests** with zero failures/skips, plus typecheck. The separate maintenance implementation and its tests were absent from that checkout.

Local operational evidence is retained in the originating Cindy task's `inspection-evidence/` directory: `NATIVE-CARRIER-CHECKER-RESULT.md`, `eph02-live-check.json`, `eph02-live-check.log`, and `eph02-recorded-replay-20261108-011427/result.json`. Runtime archives, conversation transcripts, credentials and replay databases are excluded from the commit.

## Limits and remaining work

This verifies the exercised eph02 native fold path, not every future traffic shape. Archive chunking and maintenance retry/cadence behavior are separate changes. The checker remains enabled to detect genuine corruption. No upstream publish or remote CI result is claimed by this evaluation.
