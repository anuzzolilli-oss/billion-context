import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test, { mock } from "node:test";
import { defaultConfig } from "acp-kernel";
import { startServer, _setRequestWatchdogDelayForTest } from "../src/server.js";
import { _boundedMaintenanceIdleForTest } from "../src/server/bounded-maintenance.js";
import { loadOptions } from "../src/config.js";
import { SessionStore, _setStoreForTest } from "../src/persist.js";
import { _setForTest as setRegistryForTest } from "../src/registry.js";
import { getSession } from "../src/session.js";
import { _setInvariantJudgeForTest, _setInvariantJudgeFaultForTest, type JudgeVerdict } from "../src/invariant-judge.js";

process.env.NODE_ENV = "test";
let scenarioId = 0;

async function scenario(enabled: boolean, mode = "success") {
    const retryMode = mode.startsWith("retry-");
    const shutdownMode = mode.startsWith("shutdown");
    const overflowMode = mode.startsWith("overflow-");
    let elapsed = 0;
    const baseTime = Date.now();
    const clock = retryMode || overflowMode ? mock.method(Date, "now", () => baseTime + elapsed) : undefined;
    let maintenance = 0;
    let maintenanceAborted = 0;
    const maintenanceBodies: Record<string, unknown>[] = [];
    const mains: Record<string, unknown>[] = [];
    const extra: { shutdownIdleMs?: number; inFlightWhilePending?: number; repliesWhenObserved?: number; launchedWhenObserved?: number; recoverySummaries?: number; blocksAfterRecovery?: number } = {};
    let recoverySummaries = 0;
    let maintenanceHeld = overflowMode;
    let mainSeen: () => void = () => {};
    let releaseMaintenance: () => void = () => {};
    const maintenanceBarrier = new Promise<void>(resolve => { releaseMaintenance = resolve; });
    let maintenanceReplies = 0;
    const mainArrived = new Promise<void>(resolve => { mainSeen = resolve; });
    const upstream = http.createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(Buffer.from(c));
        const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;
        if (typeof body.tool_choice === "object" && body.tool_choice !== null) {
            maintenance++;
            res.on("close", () => { if (!res.writableEnded) maintenanceAborted++; });
            maintenanceBodies.push(body);
            assert.equal((body.tools as unknown[]).length, 1);
            assert.equal(body.parallel_tool_calls, false);
            assert.equal(body.stream, false);
            if (mode === "http-error") { res.writeHead(503); res.end("UPSTREAM_SECRET"); return; }
            if (mode === "timeout" || shutdownMode || (retryMode && (maintenance === 1 || mode === "retry-cap"))) { return; }
            if (mode === "off-path") await mainArrived;
            if (mode === "watchdog") await new Promise(resolve => setTimeout(resolve, 1500));
            if (overflowMode) await maintenanceBarrier;
            maintenanceReplies++;
            res.writeHead(200, { "content-type": "application/json" });
            const span = /exactly (m\d+\u2013m\d+)/.exec(JSON.stringify(body))?.[1];
            assert.ok(span);
            const message = mode === "malformed" ? { role: "assistant", content: "no tool" } : {
                role: "assistant", content: null,
                tool_calls: [{ id: "maint-call", type: "function", function: { name: "compress", arguments: JSON.stringify({ content: span + ' Archived disposable facts\nProject CEDAR; owner Nia; budget 4826 credits; deadline 2026-12-23. The archive code is retrievable from originals.' }) } }],
            };
            if (message.tool_calls) {
                if (mode === "wrong-tool") message.tool_calls[0].function.name = "read_fixture";
                if (mode === "wrong-range") message.tool_calls[0].function.arguments = JSON.stringify({ content: "m99998–m99999\nNot a real range" });
                if (mode === "no-op") message.tool_calls[0].function.arguments = JSON.stringify({ content: span + "\n" });
                if (mode === "encoded-extra-range") message.tool_calls[0].function.arguments = JSON.stringify({ content: span + " Topic\\nSummary of consumed fixture facts.\\nm99998–m99999 Extra\\nDo not apply this extra range." });
                if (mode === "multiple") message.tool_calls.push(message.tool_calls[0]);
            }
            res.end(JSON.stringify({ model: "measured-fixture", usage: { prompt_tokens: 8123, completion_tokens: 201, completion_tokens_details: { reasoning_tokens: 17 } }, choices: [{ message, finish_reason: mode === "truncated" ? "length" : "tool_calls" }] }));
        } else {
            if (overflowMode && mains.length === 1) {
                mains.push(body);
                elapsed += 30001;
                res.writeHead(400, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: { code: "context_length_exceeded", message: "This model's maximum context length is 32000 tokens. However, you requested 50000 tokens." } }));
                return;
            }
            // The first ordinary call after the overflow reply is the
            // request's own recovery asking for a summary. One scenario never
            // answers it, so the request watchdog fires while recovery waits;
            // the other answers it, so recovery completes.
            if (overflowMode && mains.length === 2 && recoverySummaries === 0) {
                recoverySummaries++;
                if (mode === "overflow-watchdog") return;
                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Project CEDAR; owner Nia; budget 4826 credits; deadline 2026-12-23. The earlier turns were filler exchanged between user and assistant; no further decisions, files or errors were recorded. ".repeat(3) }, finish_reason: "stop" }], usage: { prompt_tokens: 9000, completion_tokens: 120 } }));
                return;
            }
            res.writeHead(200, { "content-type": "application/json" });
            mains.push(body);
            if (mains.length === 2) mainSeen();
            res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ACK" }, finish_reason: "stop" }], usage: { prompt_tokens: 50000, completion_tokens: 1 } }));
        }
    });
    upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
    const port = (upstream.address() as { port: number }).port;
    _setStoreForTest(new SessionStore({ enabled: false })); setRegistryForTest({});
    const opts = { ...loadOptions(), host: "127.0.0.1", port: 0, log: false, debug: false,
        routes: { [`http://127.0.0.1:${port}`]: { models: { "maintenance-fixture": { context: 64000 } } } },
        modelContextLimit: 64000, kernelConfig: defaultConfig(64000),
        compress: { injectTool: true, injectNudge: true, ...(mode === "require-nudge" ? { requireNudge: true } : {}) },
        passthrough: false, autoUpdate: false, advisoryCheck: false, releaseNotesCheck: false,
        mitm: { enabled: false, domains: [] },
    };
    const proxy = await startServer(opts, enabled ? { boundedMaintenance: { timeoutMs: mode === "timeout" || retryMode ? 25 : 15000 } } : undefined);
    await once(proxy, "listening");
    if (mode === "shutdown-relisten") {
        await new Promise<void>(r => proxy.close(() => r()));
        proxy.listen(0, "127.0.0.1"); await once(proxy, "listening");
    }
    const origin = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    const headers: Record<string, string> = { "content-type": "application/json", "x-bili-plugin": "pi", "x-bili-plugin-conversation": "bounded-" + mode + enabled + "-" + ++scenarioId, "x-bili-plugin-context-window": "64000" };
    if (mode === "wire") { delete headers["x-bili-plugin"]; headers["x-acp-session"] = headers["x-bili-plugin-conversation"]; }
    const tools = [
        { type: "function", function: { name: "read_fixture", description: "Read fixture", parameters: { type: "object", properties: {} } } },
        { type: "function", function: { name: "compress", description: "Compress consumed context", parameters: { type: "object", properties: { content: { type: "string" } } } } },
    ];
    const send = async (messages: unknown[]) => {
        // The request watchdog is far shorter than the maintenance reply:
        // a request that waited for maintenance would end in 504.
        const watchdogTurn = (mode === "watchdog" || mode === "overflow-watchdog") && messages.length > 1;
        if (watchdogTurn) _setRequestWatchdogDelayForTest(700);
        const r = await fetch(`${origin}/bili/http://127.0.0.1:${port}/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify({ model: "maintenance-fixture", max_tokens: 2048, messages, tools: mode === "no-compress-tool" ? tools.slice(0, 1) : tools, tool_choice: mode === "tool-none" ? "none" : "auto", stream: false }) });
        // The overflow-watchdog 504 comes from the withheld recovery summary,
        // with or without maintenance (#35), so it is not evidence about
        // maintenance. Every other turn must succeed.
        assert.equal(r.status, watchdogTurn && mode === "overflow-watchdog" ? 504 : 200); await r.text();
        if (!shutdownMode && !maintenanceHeld) await _boundedMaintenanceIdleForTest();
    };
    try {
        const old = "Project CEDAR; owner Nia; budget 4826 credits; deadline 2026-12-23. ARCHIVE-ORIGINAL-ONLY. " + "old scenery ".repeat(1800);
        const toolFirst = mode === "tool-first";
        const seed = toolFirst ? [{ role: "assistant", content: null, tool_calls: [{ id: "first-read", type: "function", function: { name: "read_fixture", arguments: "{}" } }] }, { role: "tool", tool_call_id: "first-read", content: old }, { role: "user", content: "inspect fixture" }] : [{ role: "user", content: "hello" }];
        await send(seed);
        if (overflowMode) getSession(headers["x-bili-plugin-conversation"]).metadata.boundedMaintenanceRetry = { pending: true, attempts: 1, nextAttemptAt: baseTime + 30000 };
        const messages: unknown[] = toolFirst ? [...seed, { role: "assistant", content: "ACK" }] : [{ role: "user", content: "hello" }, { role: "assistant", content: "ACK" }, { role: "user", content: "inspect fixture" }, { role: "assistant", content: old }];
        for (let i = 0; i < 12; i++) messages.push({ role: "user", content: mode === "chunked" ? "漢字🙂".repeat(350) : "u".repeat(1000) }, { role: "assistant", content: "a".repeat(1000) });
        if (mode === "chunked") messages.push({ role: "assistant", content: "ARCHIVE-UNSELECTED-MUST-STAY " + "later archive ".repeat(2000) });
        if (mode === "chunked") messages[3] = { role: "assistant", content: old + "漢字🙂".repeat(5000) };
        if (mode === "oversized") messages[3] = { role: "assistant", content: "OVERSIZED-ORIGINAL-MUST-STAY " + "漢字🙂".repeat(10000) };
        messages.push({ role: "user", content: "LATEST-WORK-MUST-STAY: continue" });
        if (mode === "media") messages[2] = { role: "user", content: [{ type: "text", text: "Inspect old image" }, { type: "image_url", image_url: { url: "https://example.invalid/disposable.png" } }] };
        if (mode === "native-echo") {
            await send(messages);
            for (let fold = 0; fold < 2; fold++) {
                if (fold === 1) {
                    messages.push({ role: "assistant", content: "SECOND ARCHIVE " + "consumed second fixture ".repeat(1200) }, { role: "user", content: "LATEST-WORK-MUST-STAY: second protected request" });
                    await send(messages);
                }
                const invoke = async (tool: string, args: unknown, toolCallId?: string) => {
                    const response = await fetch(`${origin}/__bili/plugin/tool`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId: headers["x-bili-plugin-conversation"], nativeCaller: true, tool, args, toolCallId }) });
                    assert.equal(response.status, 200);
                    return await response.json() as { result: string; outcome?: string };
                };
                const status = await invoke("acp_status", {});
                const spans = [...status.result.matchAll(/(m\d+)[–-](m\d+)\s+\d+ msgs/g)];
                const span = fold === 0 ? spans[0] : spans.at(-1);
                assert.ok(span, status.result);
                const args = { content: `${span[1]}–${span[2]} Archived disposable facts\nProject CEDAR; owner Nia; budget 4826 credits; deadline 2026-12-23. Original details remain retrievable.` };
                const id = `native-compress-${fold}`;
                const result = await invoke("compress", args, id);
                assert.equal(result.outcome, "applied", result.result);
                messages.push({ role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: "compress", arguments: JSON.stringify(args) } }] }, { role: "tool", tool_call_id: id, content: result.result });
                await send(messages);
            }
        }
        else if (mode === "concurrent") await Promise.all([send(messages), send(messages)]);
        else await send(messages);
        if (overflowMode || shutdownMode) {
            const session = getSession(headers["x-bili-plugin-conversation"]);
            extra.recoverySummaries = recoverySummaries;
            if (overflowMode) {
                // The maintenance reply is held behind the barrier, so
                // ownership observed here was released while generation was
                // still pending; a request that kept it would never reach 0.
                const limit = performance.now() + 5000;
                while ((maintenance === 0 || session.inFlight > 0) && performance.now() < limit) await new Promise(resolve => setTimeout(resolve, 10));
                extra.inFlightWhilePending = session.inFlight;
                extra.repliesWhenObserved = maintenanceReplies;
                extra.launchedWhenObserved = maintenance;
                extra.blocksAfterRecovery = session.state.blocks.length;
                maintenanceHeld = false;
                releaseMaintenance();
                await _boundedMaintenanceIdleForTest();
                // The generation finished after recovery had already folded
                // its span; the next request collects it.
                if (mode === "overflow-recovers") await send([...messages, { role: "assistant", content: "ACK" }, { role: "user", content: "continue again" }]);
            }
            return { maintenance, maintenanceAborted, inFlight: session.inFlight, maintenanceBodies, mains, blocks: session.state.blocks.length, requests: session.stats.requests, receipt: undefined, extra };
        }
        if (retryMode) {
            assert.equal(maintenance, 1);
            assert.equal(getSession(headers["x-bili-plugin-conversation"]).state.blocks.length, 0);
            assert.ok(JSON.stringify(mains.at(-1)).includes("ARCHIVE-ORIGINAL-ONLY"));
            // Phases are explicit: a request that finds a finished job only
            // collects it, so each guard is probed by a request sent after
            // that collection.
            const retryState = () => getSession(headers["x-bili-plugin-conversation"]).metadata.boundedMaintenanceRetry as { pending: boolean; attempts: number } | undefined;
            await send(messages);
            assert.deepEqual([retryState()?.pending, retryState()?.attempts], [true, 1], "the failed first attempt is collected");
            await send(messages);
            assert.equal(maintenance, 1, "No retry during cooldown");
            elapsed += 30001;
            if (mode === "retry-changed") messages[3] = { role: "assistant", content: "CHANGED ARCHIVE " + "replacement facts ".repeat(1300) };
            await Promise.all([send(messages), send(messages)]);
            assert.equal(maintenance, 2, "Exactly one retry after cooldown, even concurrently");
            await send(messages);
            assert.equal(maintenance, 2, "collecting the retry launches nothing");
            if (mode === "retry-cap") {
                assert.deepEqual([retryState()?.pending, retryState()?.attempts], [true, 2], "the failed retry is collected");
                elapsed += 59999; await send(messages);
                assert.equal(maintenance, 2, "Second retry has a longer cooldown");
                elapsed += 2; await send(messages);
                assert.equal(maintenance, 3);
                await send(messages);
                assert.deepEqual([retryState()?.pending, retryState()?.attempts], [true, 3], "the failed last attempt is collected");
                elapsed += 120000; await send(messages);
                assert.equal(maintenance, 3, "Exhausted budget cannot retry on every request");
                messages[3] = { role: "assistant", content: "Changed after exhaustion " + "new archive ".repeat(1500) };
                await send(messages);
                assert.equal(maintenance, 3, "Changed archive alone cannot reset the budget");
            } else {
                assert.equal(getSession(headers["x-bili-plugin-conversation"]).state.blocks.length, 1);
                if (mode === "retry-changed") assert.ok(!JSON.stringify(maintenanceBodies[1]).includes("ARCHIVE-ORIGINAL-ONLY"));
                elapsed += 120000; await send(messages);
                assert.equal(maintenance, 2, "Success closes the retry cycle");
            }
        }
        await send([...messages, { role: "assistant", content: "ACK" }, { role: "user", content: "continue again" }]);
        if (mode === "receipt") await send([...messages, { role: "assistant", content: "ACK" }, { role: "user", content: "continue again" }, { role: "assistant", content: "ACK" }, { role: "user", content: "and once more" }]);
        const session = getSession(headers["x-bili-plugin-conversation"]);
        return { maintenance, maintenanceAborted, inFlight: session.inFlight, maintenanceBodies, mains, blocks: session.state.blocks.length, requests: session.stats.requests, receipt: session.metadata.boundedMaintenanceLast as { blocksCreated?: number; outcome?: string; sourceBytes?: number; requestBytes?: number; requestedModel?: string; returnedModel?: string; requestedReasoningEffort?: string; inputTokens?: number; reasoningTokens?: number; failureKind?: string; httpStatus?: number; stage?: string; headersMs?: number } | undefined, extra };
    } finally {
        proxy.closeAllConnections(); await new Promise<void>(r => proxy.close(() => r()));
        if (shutdownMode) {
            // The fake upstream is still open and never answers, and the
            // deadline is 15 s: only the server-close abort can end generation.
            const closed = performance.now();
            await _boundedMaintenanceIdleForTest();
            extra.shutdownIdleMs = performance.now() - closed;
        }
        upstream.closeAllConnections(); await new Promise<void>(r => upstream.close(() => r()));
        clock?.mock.restore();
        _setRequestWatchdogDelayForTest(null);
    }
}

for (const mode of ["retry-recovery", "retry-cap", "retry-changed"]) {
    test(`${mode}: induced timeout recovery is cooldown-bound and capped`, async () => {
        const result = await scenario(true, mode);
        assert.equal(result.maintenance, mode === "retry-cap" ? 3 : 2);
        assert.equal(result.blocks, mode === "retry-cap" ? 0 : 1);
    });
}

test("wired Pi native call echo stays clean across two folds and later requests", async () => {
    const verdicts: JudgeVerdict[] = [];
    _setInvariantJudgeForTest(true, v => verdicts.push(v));
    try {
        const result = await scenario(false, "native-echo");
        assert.ok(result.blocks >= 2);
        assert.ok(verdicts.some(v => v.folded));
        assert.ok(verdicts.every(v => v.ok), JSON.stringify(verdicts.filter(v => !v.ok)));
    } finally { _setInvariantJudgeForTest(true); }
});

test("wired native tool-first fold is clean and protected-tail corruption still fires", async () => {
    const verdicts: JudgeVerdict[] = [];
    _setInvariantJudgeForTest(true, v => verdicts.push(v));
    try {
        await scenario(true, "tool-first");
        assert.ok(verdicts.some(v => v.folded));
        assert.ok(verdicts.every(v => v.ok), JSON.stringify(verdicts.filter(v => !v.ok)));
        verdicts.length = 0;
        _setInvariantJudgeFaultForTest(exit => exit.some(m => m.text?.includes("[Compressed conversation section]"))
            ? exit.map(m => m.text?.includes("LATEST-WORK-MUST-STAY") ? { ...m, text: "CORRUPTED PROTECTED TAIL" } : m) : exit);
        await scenario(true, "tool-first");
        assert.ok(verdicts.some(v => v.folded && !v.ok));
    } finally {
        _setInvariantJudgeFaultForTest(null);
        _setInvariantJudgeForTest(true);
    }
});

test("opt-in runs one verified maintenance turn and forwards folded history with normal tool choice", async () => {
    const result = await scenario(true);
    assert.equal(result.maintenance, 1);
    assert.equal(result.blocks, 1);
    assert.equal(result.mains.length, 3);
    assert.equal(result.requests, result.mains.length, "maintenance rebuild does not count as a second incoming request");
    assert.equal(result.receipt?.blocksCreated, 1);
    assert.equal(result.receipt?.outcome, "applied");
    assert.ok(JSON.stringify(result.mains[1]).includes("ARCHIVE-ORIGINAL-ONLY"), "the launching request is forwarded as it arrived");
    assert.equal(result.mains[2].tool_choice, "auto");
    assert.ok(!JSON.stringify(result.mains[2]).includes("ARCHIVE-ORIGINAL-ONLY"));
    assert.ok(JSON.stringify(result.mains[2]).includes("LATEST-WORK-MUST-STAY"));
    assert.ok(JSON.stringify(result.mains[2]).includes("CEDAR"));
});

test("maintenance generation runs off the request path and its fold lands on the next request", async () => {
    // The fake upstream withholds the maintenance reply until the triggering
    // request's own forward has arrived: only an off-path launch can pass.
    const result = await scenario(true, "off-path");
    assert.equal(result.maintenance, 1);
    assert.equal(result.blocks, 1);
    assert.ok(JSON.stringify(result.mains[1]).includes("ARCHIVE-ORIGINAL-ONLY"), "the triggering request is forwarded unfolded");
    assert.ok(!JSON.stringify(result.mains[1]).includes("[bili-maintenance-receipt]"));
    assert.ok(!JSON.stringify(result.mains[2]).includes("ARCHIVE-ORIGINAL-ONLY"), "the next request carries the fold");
    assert.ok(JSON.stringify(result.mains[2]).includes("[bili-maintenance-receipt]"));
    assert.ok(JSON.stringify(result.mains[2]).includes("LATEST-WORK-MUST-STAY"));
});

test("a newly delivered nudge arms maintenance using current-turn policy", async () => {
    const result = await scenario(true, "require-nudge");
    assert.equal(result.maintenance, 1);
    assert.equal(result.blocks, 1, "the previous unnudged seed turn must not veto the fresh prompted fold");
});

test("a maintenance reply slower than the request watchdog no longer fails the request", async () => {
    const result = await scenario(true, "watchdog");
    assert.equal(result.maintenance, 1);
    assert.equal(result.maintenanceAborted, 0, "the request ending does not cancel generation");
    assert.equal(result.mains.length, 3, "the launching request reached the ordinary upstream instead of ending in 504");
    assert.ok(JSON.stringify(result.mains[1]).includes("ARCHIVE-ORIGINAL-ONLY"));
    assert.equal(result.blocks, 1, "the result is committed by the next request");
    assert.ok(!JSON.stringify(result.mains[2]).includes("ARCHIVE-ORIGINAL-ONLY"));
    assert.equal(result.inFlight, 0);
});

test("maintenance launched during overflow recovery cannot commit after the watchdog 504 and releases ownership", async () => {
    const result = await scenario(true, "overflow-watchdog");
    assert.equal(result.maintenance, 1, "maintenance was skipped initially and first attempted in overflow recovery");
    assert.equal(result.mains.length, 2, "the request reached the relay, returned overflow and was not forwarded again");
    assert.equal(result.extra.recoverySummaries, 1, "recovery was entered: it asked the upstream for a summary, which was withheld");
    assert.equal(result.blocks, 0, "a finished generation is never committed by the request that already ended in 504");
    assert.equal(result.maintenanceAborted, 0, "generation is independent of the request that launched it");
    assert.equal(result.extra.launchedWhenObserved, 1, "generation had been launched when ownership was observed");
    assert.equal(result.extra.repliesWhenObserved, 0, "and its reply was still withheld");
    assert.equal(result.extra.inFlightWhilePending, 0, "request ownership is released without waiting for generation");
    assert.equal(result.inFlight, 0);
});

test("overflow recovery completes while a maintenance generation is pending, and the late result adds no second fold", async () => {
    const result = await scenario(true, "overflow-recovers");
    assert.equal(result.extra.recoverySummaries, 1, "recovery asked the upstream for a summary");
    assert.equal(result.extra.launchedWhenObserved, 1, "maintenance had been launched by the same request");
    assert.equal(result.extra.repliesWhenObserved, 0, "and its reply was still withheld when the request returned 200");
    assert.equal(result.extra.blocksAfterRecovery, 1, "recovery committed its own fold without waiting for maintenance");
    assert.equal(result.mains.length, 4, "seed, overflowed forward, accepted re-forward and the collecting request");
    assert.ok(JSON.stringify(result.mains[1]).includes("ARCHIVE-ORIGINAL-ONLY"));
    assert.ok(!JSON.stringify(result.mains[2]).includes("ARCHIVE-ORIGINAL-ONLY"), "the re-forward carried the recovery fold");
    assert.equal(result.maintenance, 1, "collecting the late result launches nothing");
    assert.equal(result.blocks, 1, "the late maintenance result for the already-folded span adds no second block");
    assert.equal(result.maintenanceAborted, 0);
    assert.equal(result.inFlight, 0);
});

test("closing the server cancels a background generation", async () => {
    const result = await scenario(true, "shutdown");
    assert.equal(result.maintenance, 1);
    assert.equal(result.blocks, 0);
    assert.ok(result.extra.shutdownIdleMs !== undefined && result.extra.shutdownIdleMs < 5000, `generation ended ${result.extra.shutdownIdleMs} ms after close`);
});

test("closing a server that closed and re-listened still cancels a background generation", async () => {
    const result = await scenario(true, "shutdown-relisten");
    assert.equal(result.maintenance, 1);
    assert.equal(result.blocks, 0);
    assert.ok(result.extra.shutdownIdleMs !== undefined && result.extra.shutdownIdleMs < 5000, `generation ended ${result.extra.shutdownIdleMs} ms after close`);
});

test("default startup never runs hidden maintenance", async () => {
    assert.equal((await scenario(false)).maintenance, 0);
});

test("chunked maintenance bounds UTF-8 archive bytes and preserves unselected history", async () => {
    const result = await scenario(true, "chunked");
    assert.ok(result.maintenance >= 1);
    const request = result.maintenanceBodies[0];
    const user = (request.messages as { content: string }[])[1].content;
    const source = user.slice(user.indexOf("\n") + 1);
    assert.ok(Buffer.byteLength(source) <= 32768, `archive bytes ${Buffer.byteLength(source)}`);
    assert.ok(!source.includes("ARCHIVE-UNSELECTED-MUST-STAY"));
    assert.ok(JSON.stringify(result.mains[1]).includes("ARCHIVE-UNSELECTED-MUST-STAY"));
    assert.ok(JSON.stringify(result.mains[2]).includes("ARCHIVE-UNSELECTED-MUST-STAY"), "the folded request still carries the unselected archive");
    assert.ok(result.blocks >= 1, JSON.stringify(result.receipt));
});

test("oversized originals are never truncated or falsely claimed by a fold", async () => {
    const result = await scenario(true, "oversized");
    assert.ok(JSON.stringify(result.mains[1]).includes("OVERSIZED-ORIGINAL-MUST-STAY"));
    assert.ok(JSON.stringify(result.mains[2]).includes("OVERSIZED-ORIGINAL-MUST-STAY"));
    for (const request of result.maintenanceBodies) assert.ok(!JSON.stringify(request).includes("OVERSIZED-ORIGINAL-MUST-STAY"));
});

test("maintenance measures requested and returned model and actual usage", async () => {
    const result = await scenario(true);
    assert.equal(result.receipt?.requestedModel, "maintenance-fixture");
    assert.equal(result.receipt?.returnedModel, "measured-fixture");
    assert.equal(result.receipt?.requestedReasoningEffort, "low");
    assert.equal(result.receipt?.inputTokens, 8123);
    assert.equal(result.receipt?.reasoningTokens, 17);
    assert.ok((result.receipt?.sourceBytes ?? Infinity) <= 32768);
    assert.ok((result.receipt?.requestBytes ?? 0) > (result.receipt?.sourceBytes ?? 0));
    assert.ok(typeof result.receipt?.headersMs === "number");
    assert.equal(result.receipt?.stage, "complete");
});

test("maintenance records sanitized HTTP and deadline failures", async () => {
    const http = await scenario(true, "http-error");
    assert.equal(http.receipt?.failureKind, "http");
    assert.equal(http.receipt?.httpStatus, 503);
    assert.ok(!JSON.stringify(http.receipt).includes("UPSTREAM_SECRET"));
    const timeout = await scenario(true, "timeout");
    assert.equal(timeout.receipt?.failureKind, "deadline");
    assert.equal(timeout.receipt?.stage, "fetch");
    assert.equal(timeout.receipt?.blocksCreated, 0);
});

test("maintenance reads only eligible originals and leaves protected working content with the normal request", async () => {
    const result = await scenario(true, "source-only");
    assert.equal(result.maintenance, 1);
    assert.ok(JSON.stringify(result.maintenanceBodies[0]).includes("ARCHIVE-ORIGINAL-ONLY"));
    assert.equal(result.maintenanceBodies[0].max_tokens, 1024);
    assert.equal(result.maintenanceBodies[0].reasoning_effort, "low");
    assert.ok(!JSON.stringify(result.maintenanceBodies[0]).includes("LATEST-WORK-MUST-STAY"));
    assert.ok(JSON.stringify(result.mains[1]).includes("LATEST-WORK-MUST-STAY"));
    assert.ok(JSON.stringify(result.mains[2]).includes("LATEST-WORK-MUST-STAY"));
});

test("resumed task receives a factual completion receipt only after a verified new block", async () => {
    const result = await scenario(true, "receipt");
    assert.ok(!JSON.stringify(result.mains[1]).includes("[bili-maintenance-receipt]"), "no receipt before a block exists");
    const resumed = JSON.stringify(result.mains[2]);
    assert.ok(resumed.includes("[bili-maintenance-receipt]"));
    assert.ok(resumed.includes("b1"));
    assert.equal(result.mains.length, 4);
    assert.ok(!JSON.stringify(result.mains[3]).includes("[bili-maintenance-receipt]"), "the receipt is delivered exactly once");
});

test("malformed maintenance is bounded and leaves originals available to the normal request", async () => {
    const result = await scenario(true, "malformed");
    assert.equal(result.maintenance, 1);
    assert.ok(JSON.stringify(result.mains[1]).includes("ARCHIVE-ORIGINAL-ONLY"));
    assert.ok(JSON.stringify(result.mains[2]).includes("ARCHIVE-ORIGINAL-ONLY"), "the collecting request keeps the originals too");
    assert.equal(result.blocks, 0);
});

for (const mode of ["wrong-tool", "wrong-range", "no-op", "encoded-extra-range", "multiple", "http-error", "timeout", "truncated"]) {
    test(`${mode} maintenance cannot drop originals or repeat on the collecting request`, async () => {
        const result = await scenario(true, mode);
        assert.equal(result.maintenance, 1);
        assert.equal(result.mains.length, 3);
        assert.equal(result.blocks, 0);
        // mains[1] launched the generation; mains[2] collected its failure.
        for (const main of result.mains.slice(1)) {
            assert.equal(main.tool_choice, "auto");
            assert.ok(JSON.stringify(main).includes("ARCHIVE-ORIGINAL-ONLY"));
            assert.ok(JSON.stringify(main).includes("LATEST-WORK-MUST-STAY"));
            assert.ok(!JSON.stringify(main).includes("[bili-maintenance-receipt]"));
        }
    });
}

test("concurrent requests for one session cannot duplicate maintenance", async () => {
    const result = await scenario(true, "concurrent");
    assert.equal(result.maintenance, 1);
    assert.equal(result.blocks, 1);
});

for (const mode of ["tool-none", "no-compress-tool", "wire", "media"]) {
    test(`${mode} does not opt into native bounded maintenance`, async () => {
        const result = await scenario(true, mode);
        assert.equal(result.maintenance, 0);
        assert.ok(JSON.stringify(result.mains[1]).includes("ARCHIVE-ORIGINAL-ONLY"));
    });
}
