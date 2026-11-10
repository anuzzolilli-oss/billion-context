import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { existsSync } from "node:fs";

process.env.NODE_ENV = "test";
process.env.BILI_REPLAY_RETRY_MAX = "1";
process.env.BILI_PREFLIGHT_HOLD_MS = "300";

import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.ts";
import type { ProxyOptions } from "../src/config.ts";
import { SessionStore, _setStoreForTest } from "../src/persist.ts";
import { _setForTest as setRegistryForTest } from "../src/registry.ts";
import { EXIT_CONCERNS, WIRE_EXITS, type ExitConcernId } from "../src/exit-matrix.ts";

// #588 exit-enumeration matrix. Two layers:
//
// 1. META: the registry (src/exit-matrix.ts) is exhaustive over exits x
//    concerns and every `coveredBy` file exists on disk — renaming or
//    deleting a covering test breaks the matrix here, and adding a wire
//    exit without registry rows already fails typecheck.
// 2. BEHAVIOR: per-cell scenarios for the cells that had NO coverage before
//    this file: proxy-side client-abort propagation on all four proxy
//    exits, and the openai-chat in-band preflight error (the other in-band
//    cells were covered by tests/preflight-hold.test.ts).

const SLOW_MS = 1500;

// Retain the existing teardown budget (#4599); the historical Windows failures
// did not establish starvation as their cause. Readiness and close observations
// below must be proven independently of elapsed time (fork issue #6).
const ABORT_TEARDOWN_BUDGET_MS = process.platform === "win32" ? 20000 : 10000;
const TEARDOWN_POLL_MS = 100;

/** May the teardown poll keep going? base + measured event-loop lag, capped
 *  at 2×base — see the budget comment above for the starvation mechanics. */
function teardownPollContinues(elapsedMs: number, baseMs: number, lagMs: number): boolean {
    return elapsedMs < baseMs + Math.min(lagMs, baseMs);
}

async function awaitUpstreamTeardown(socketsClosed: () => number): Promise<void> {
    const base = ABORT_TEARDOWN_BUDGET_MS;
    const t0 = Date.now();
    let lagMs = 0;
    let last = t0;
    while (socketsClosed() < 1 && teardownPollContinues(Date.now() - t0, base, lagMs)) {
        await new Promise((r) => setTimeout(r, TEARDOWN_POLL_MS));
        const now = Date.now();
        const lateBy = now - last - TEARDOWN_POLL_MS;
        if (lateBy > 0) lagMs += lateBy;
        last = now;
    }
}

const SUMMARY_TEXT =
    "PREFLIGHT SUMMARY: the segment covered a debugging session. " +
    "Key decisions: chose the preflight approach. Files touched: src/a.ts:10. Outcome: fixed.";

function anthropicSse(): string {
    return (
        `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { id: "m1", role: "assistant", usage: { input_tokens: 1000 } } })}\n\n` +
        `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } })}\n\n` +
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`
    );
}

function openaiSsePartial(): string {
    return `data: ${JSON.stringify({ id: "c1", object: "chat.completion.chunk", choices: [{ index: 0, delta: { content: "par" }, finish_reason: null }] })}\n\n`;
}

function responsesSsePartial(): string {
    return `event: response.created\ndata: ${JSON.stringify({ response: { id: "r1", status: "in_progress" } })}\n\n`;
}

function bigConversation(turns = 12): Array<{ role: string; content: string }> {
    const msgs: Array<{ role: string; content: string }> = [];
    for (let i = 0; i < turns; i++) {
        const role = i % 2 === 0 ? "user" : "assistant";
        msgs.push({ role, content: `Message ${i} of the long conversation. ` + `MARKER_${i}_content_`.repeat(250) });
    }
    return msgs;
}

function bigResponsesInput(): Array<{ type: string; role: string; content: string }> {
    const input: Array<{ type: string; role: string; content: string }> = [];
    for (let i = 0; i < 12; i++) {
        input.push({ type: "message", role: i % 2 === 0 ? "user" : "assistant", content: `Message ${i} of the working session. ` + `WORK_${i}_content_`.repeat(290) });
    }
    return input;
}

type UpstreamMode = "hang-openai" | "hang-anthropic" | "hang-responses" | "hang-json" | "slow-summary-fwd-429" | "slow-summary-429";

function startUpstream(mode: UpstreamMode): Promise<{ server: http.Server; port: number; socketsClosed: () => number; requests: () => number; summaryDoneMs: () => number; headersSent: Promise<void> }> {
    let markHeadersSent!: () => void;
    const headersSent = new Promise<void>((resolve) => { markHeadersSent = resolve; });
    let closed = 0;
    let requests = 0;
    let summaryDoneMs = 0;
    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            requests++;
            const raw = Buffer.concat(chunks).toString("utf8");
            let parsed: { stream?: boolean; messages?: unknown[] } = {};
            try { parsed = JSON.parse(raw); } catch { /* keep {} */ }
            const isSummary = !parsed.stream;
            if (mode === "slow-summary-fwd-429" || mode === "slow-summary-429") {
                if (isSummary && mode === "slow-summary-429") {
                    // Fail the summarization itself AFTER the hold grace so the
                    // early 200 is already committed (→ emitPreflightError path).
                    setTimeout(() => {
                        summaryDoneMs = Date.now();
                        res.writeHead(429, { "content-type": "application/json" });
                        res.end(JSON.stringify({ error: { message: "rate limited", type: "rate_limit_error" } }));
                    }, SLOW_MS);
                    return;
                }
                if (isSummary) {
                    setTimeout(() => {
                        summaryDoneMs = Date.now();
                        res.writeHead(200, { "content-type": "application/json" });
                        res.end(JSON.stringify({ id: "sum", object: "chat.completion", choices: [{ index: 0, message: { role: "assistant", content: SUMMARY_TEXT }, finish_reason: "stop" }], usage: { prompt_tokens: 500, completion_tokens: 50, total_tokens: 550 } }));
                    }, SLOW_MS);
                    return;
                }
                // The post-preflight FORWARD fails fast — after the early commit
                // (→ emitStreamError mid-stream path).
                res.writeHead(429, { "content-type": "text/event-stream" });
                res.end(`data: ${JSON.stringify({ error: { message: "rate limited", type: "rate_limit_error" } })}\n\ndata: [DONE]\n\n`);
                return;
            }
            // hang-* modes: commit headers + one partial chunk, then never end.
            // The proxy MUST destroy this socket when its client aborts.
            if (mode === "hang-openai") {
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.write(openaiSsePartial());
            } else if (mode === "hang-anthropic") {
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.write(anthropicSse().split("event: content_block_delta")[0]!);
            } else if (mode === "hang-responses") {
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.write(responsesSsePartial());
            } else {
                res.writeHead(200, { "content-type": "application/json" });
                res.flushHeaders();
                markHeadersSent();
            }
        });
    });
    server.on("connection", (socket) => { socket.once("close", () => { closed++; }); });
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            resolve({ server, port: (server.address() as { port: number }).port, socketsClosed: () => closed, requests: () => requests, summaryDoneMs: () => summaryDoneMs, headersSent });
        });
    });
}

function assertUpstreamOpen(up: { requests: () => number; socketsClosed: () => number }): void {
    assert.equal(up.requests(), 1, "upstream request exists before client abort");
    assert.equal(up.socketsClosed(), 0, "upstream socket is still open immediately before client abort");
}

async function closeFixtureServers(...servers: http.Server[]): Promise<void> {
    await Promise.all(servers.map((server) => new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
    })));
}

function startProxy(upstreamPort: number): Promise<http.Server> {
    _setStoreForTest(new SessionStore({ enabled: false }));
    setRegistryForTest({});
    return startServer({
        port: 0,
        host: "127.0.0.1",
        upstream: "http://127.0.0.1",
        routes: { [`http://127.0.0.1:${upstreamPort}`]: { models: { "m-test": { context: 10_000 } } } },
        modelContextLimit: 400_000,
        kernelConfig: defaultConfig(400_000),
        compress: { injectTool: true, injectNudge: true },
        promptCache: { routing: "auto" },
        sessionHeader: "x-acp-session",
        log: false,
        debug: false,
        passthrough: false,
        autoUpdate: false,
autoRestartOnUpdate: false,
        advisoryCheck: false,
        releaseNotesCheck: false,
        compat: { roles: {} },
        streamErrorShape: "protocol",
        passthroughSource: null,
        updateTag: "latest",
mitm: { enabled: false, domains: [] },
    } as ProxyOptions);
}

type AbortReadiness = ({ kind: "first-byte"; marker: string; onChunk?: (chunk: string) => void } | { kind: "header"; headersSent?: Promise<void> }) & { timeoutMs?: number; beforeAbort?: () => void };

// JSON is buffered by the proxy, so its fixture signals flushed upstream headers.
// SSE must contain fixture content, not merely the proxy's preflight comments.
function abortAfterFirstByte(url: string, headers: Record<string, string>, body: string, readiness: AbortReadiness): Promise<"header" | "first-byte"> {
    return new Promise((resolve, reject) => {
        let settled = false;
        let response: http.IncomingMessage | undefined;
        let text = "";
        const finish = (error?: Error) => {
            if (settled) return;
            if (!error) {
                try { readiness.beforeAbort?.(); } catch (e) { error = e instanceof Error ? e : new Error(String(e)); }
            }
            settled = true;
            clearTimeout(timer);
            response?.off("data", onData);
            response?.off("end", onEnd);
            response?.off("close", onEnd);
            req.destroy();
            if (error) reject(error);
            else resolve(readiness.kind);
        };
        const onError = (error: Error) => finish(error);
        const onEnd = () => finish(new Error(`Response ended before abort readiness: ${readiness.kind}`));
        const onData = (chunk: Buffer) => {
            const fragment = chunk.toString("utf8");
            text += fragment;
            if (readiness.kind === "first-byte") {
                readiness.onChunk?.(fragment);
                if (text.includes(readiness.marker)) finish();
            }
        };
        const req = http.request(url, { method: "POST", headers }, (res) => {
            response = res;
            res.on("error", onError);
            res.once("close", () => res.off("error", onError));
            res.on("data", onData);
            res.once("end", onEnd);
            res.once("close", onEnd);
            if (readiness.kind === "header" && !readiness.headersSent) finish();
        });
        req.on("error", onError);
        req.once("close", () => req.off("error", onError));
        const timer = setTimeout(() => {
            finish(new Error(`Timed out waiting for abort readiness: ${readiness.kind}`));
        }, readiness.timeoutMs ?? ABORT_TEARDOWN_BUDGET_MS);
        if (readiness.kind === "header") readiness.headersSent?.then(() => finish(), onError);
        req.end(body);
    });
}

for (const sendComment of [false, true]) {
    test(`abort fixture: delayed SSE readiness ignores ${sendComment ? "preflight comments" : "elapsed 400ms"}`, { timeout: 5000 }, async () => {
        let response: http.ServerResponse | undefined;
        const server = http.createServer((req, res) => {
            req.resume();
            response = res;
            if (sendComment) {
                res.writeHead(200, { "content-type": "text/event-stream" });
                res.write(": preflight hold\n\n");
            }
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        let settled = false;
        let observed = "";
        let markPartial!: () => void;
        const partialObserved = new Promise<void>((resolve) => { markPartial = resolve; });
        const outcome = abortAfterFirstByte(`http://127.0.0.1:${(server.address() as { port: number }).port}`, {}, "{}", {
            kind: "first-byte", marker: '"content":"par"', timeoutMs: 2000,
            onChunk: (fragment) => {
                observed += fragment;
                if (observed.includes('"cont')) markPartial();
            },
        }).finally(() => { settled = true; });
        void outcome.catch(() => {});
        try {
            await new Promise((resolve) => setTimeout(resolve, 550));
            assert.equal(settled, false, "neither elapsed time nor proxy comments prove upstream stream readiness");
            assert.ok(response);
            const chunk = openaiSsePartial();
            const split = chunk.indexOf('"content"') + 5;
            response.write(chunk.slice(0, split));
            await Promise.race([
                partialObserved,
                outcome.then(() => { throw new Error("Abort completed before partial-marker observation"); }),
            ]);
            assert.equal(settled, false, "a partial fixture marker is not readiness");
            response.write(chunk.slice(split));
            assert.equal(await outcome, "first-byte");
        } finally {
            await closeFixtureServers(server);
            await outcome.catch(() => {});
        }
    });
}

test("abort fixture: missing readiness rejects instead of reporting successful abort", { timeout: 5000 }, async () => {
    const server = http.createServer((req) => { req.resume(); });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
        await assert.rejects(abortAfterFirstByte(`http://127.0.0.1:${(server.address() as { port: number }).port}`, {}, "{}", {
            kind: "first-byte", marker: '"content":"par"', timeoutMs: 600,
        }), /Timed out waiting for abort readiness: first-byte/);
    } finally {
        await closeFixtureServers(server);
    }
});

for (const failure of ["ping-only", "end", "reset"] as const) {
    test(`abort fixture: ${failure} before SSE readiness rejects`, { timeout: 5000 }, async () => {
        const server = http.createServer((req, res) => {
            req.resume();
            if (failure === "reset") { req.socket.destroy(); return; }
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.write(": preflight hold\n\n");
            if (failure === "end") res.end();
        });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        try {
            await assert.rejects(abortAfterFirstByte(`http://127.0.0.1:${(server.address() as { port: number }).port}`, {}, "{}", {
                kind: "first-byte", marker: '"content":"par"', timeoutMs: 600,
            }), failure === "ping-only" ? /Timed out waiting for abort readiness/ : failure === "end" ? /Response ended before abort readiness/ : /socket hang up/);
        } finally {
            await closeFixtureServers(server);
        }
    });
}

for (const sendHeaders of [false, true]) {
    test(`abort fixture: JSON ${sendHeaders ? "waits for actual delayed headers" : "missing headers rejects"}`, { timeout: 5000 }, async () => {
        let response: http.ServerResponse | undefined;
        const server = http.createServer((req, res) => { req.resume(); response = res; });
        server.listen(0, "127.0.0.1");
        await once(server, "listening");
        let settled = false;
        const outcome = abortAfterFirstByte(`http://127.0.0.1:${(server.address() as { port: number }).port}`, {}, "{}", {
            kind: "header", timeoutMs: sendHeaders ? 2000 : 600,
        }).finally(() => { settled = true; });
        void outcome.catch(() => {});
        try {
            if (sendHeaders) {
                await new Promise((resolve) => setTimeout(resolve, 550));
                assert.equal(settled, false, "JSON must not abort before headers");
                assert.ok(response);
                response.writeHead(200, { "content-type": "application/json" });
                response.flushHeaders();
                assert.equal(await outcome, "header");
            } else {
                await assert.rejects(outcome, /Timed out waiting for abort readiness: header/);
            }
        } finally {
            await closeFixtureServers(server);
            await outcome.catch(() => {});
        }
    });
}

test("abort fixture: request completion is not upstream socket closure", { timeout: 5000 }, async () => {
    const up = await startUpstream("hang-openai");
    let client: http.ClientRequest | undefined;
    try {
        let socketClosed: Promise<unknown> | undefined;
        const completed = once(up.server, "request", { signal: AbortSignal.timeout(2000) }).then(async ([req]: http.IncomingMessage[]) => {
            assert.ok(req);
            socketClosed = once(req.socket, "close", { signal: AbortSignal.timeout(2000) });
            void socketClosed.catch(() => {});
            await once(req, "close", { signal: AbortSignal.timeout(2000) });
        });
        void completed.catch(() => {});
        client = http.request(`http://127.0.0.1:${up.port}`, { method: "POST" });
        client.on("error", () => {});
        client.end("{}");
        const [response] = await once(client, "response", { signal: AbortSignal.timeout(2000) }) as [http.IncomingMessage];
        response.resume();
        await completed;
        assert.equal(up.requests(), 1);
        assert.equal(up.socketsClosed(), 0, "completed IncomingMessage must not count as a closed upstream socket");
        client.destroy();
        await socketClosed;
        assert.equal(up.socketsClosed(), 1, "actual upstream closure must be observed before server cleanup");
    } finally {
        client?.destroy();
        await closeFixtureServers(up.server);
    }
});

test("matrix meta: every concern table is exhaustive and every coveredBy test file exists", () => {
    const concernIds = Object.keys(EXIT_CONCERNS) as ExitConcernId[];
    assert.ok(concernIds.length >= 3);
    for (const concern of concernIds) {
        const table = EXIT_CONCERNS[concern] as Record<string, { implementer: unknown[]; contract: string; coveredBy: string[] }>;
        assert.deepEqual(
            Object.keys(table).sort(),
            [...WIRE_EXITS].sort(),
            `${concern} must enumerate exactly WIRE_EXITS (a new exit needs a row here — and typecheck enforces it)`,
        );
        for (const [exitId, cell] of Object.entries(table)) {
            assert.ok(cell.implementer.length > 0, `${concern}/${exitId}: implementer refs are live imports, not strings`);
            assert.ok(cell.contract.length > 20, `${concern}/${exitId}: contract must state the cell's observable behavior`);
            for (const f of cell.coveredBy) {
                assert.ok(existsSync(f), `${concern}/${exitId}: coveredBy "${f}" does not exist — coverage reference went stale`);
            }
        }
    }
});

test("abort x proxy-openai-sse: client abort mid-stream destroys the upstream request", async () => {
    const up = await startUpstream("hang-openai");
    const proxy = await startProxy(up.port);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${up.port}/v1/chat/completions`;
        const outcome = await abortAfterFirstByte(url, { "content-type": "application/json", "x-acp-session": "mx-abort-oai" }, JSON.stringify({ model: "m-test", max_tokens: 1024, stream: true, messages: [{ role: "user", content: "hi" }] }), {
            kind: "first-byte", marker: '"content":"par"', beforeAbort: () => assertUpstreamOpen(up),
        });
        assert.equal(outcome, "first-byte");
        await awaitUpstreamTeardown(up.socketsClosed);
        assert.ok(up.socketsClosed() >= 1, `upstream socket(s) must be destroyed after the client abort (closed=${up.socketsClosed()})`);
        assert.equal(up.requests(), 1, "exactly one upstream request");
    } finally {
        await closeFixtureServers(proxy, up.server);
    }
});

test("abort x proxy-anthropic-sse: client abort mid-stream destroys the upstream request", async () => {
    const up = await startUpstream("hang-anthropic");
    const proxy = await startProxy(up.port);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${up.port}/v1/messages`;
        await abortAfterFirstByte(url, { "content-type": "application/json", "x-acp-session": "mx-abort-ant" }, JSON.stringify({ model: "m-test", max_tokens: 1024, stream: true, messages: [{ role: "user", content: "hi" }] }), {
            kind: "first-byte", marker: '"id":"m1"', beforeAbort: () => assertUpstreamOpen(up),
        });
        await awaitUpstreamTeardown(up.socketsClosed);
        assert.ok(up.socketsClosed() >= 1, `upstream socket(s) destroyed after client abort (closed=${up.socketsClosed()})`);
    } finally {
        await closeFixtureServers(proxy, up.server);
    }
});

test("abort x proxy-responses-sse: client abort mid-stream destroys the upstream request", async () => {
    const up = await startUpstream("hang-responses");
    const proxy = await startProxy(up.port);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${up.port}/v1/responses`;
        await abortAfterFirstByte(url, { "content-type": "application/json", "x-acp-session": "mx-abort-resp" }, JSON.stringify({ model: "m-test", max_tokens: 1024, stream: true, instructions: "You are a test agent.", input: [{ type: "message", role: "user", content: "hi" }] }), {
            kind: "first-byte", marker: '"id":"r1"', beforeAbort: () => assertUpstreamOpen(up),
        });
        await awaitUpstreamTeardown(up.socketsClosed);
        assert.ok(up.socketsClosed() >= 1, `upstream socket(s) destroyed after client abort (closed=${up.socketsClosed()})`);
    } finally {
        await closeFixtureServers(proxy, up.server);
    }
});

test("abort x proxy-json: client abort while the JSON is buffering destroys the upstream request", async () => {
    const up = await startUpstream("hang-json");
    const proxy = await startProxy(up.port);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        const url = `http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${up.port}/v1/chat/completions`;
        await abortAfterFirstByte(url, { "content-type": "application/json", "x-acp-session": "mx-abort-json" }, JSON.stringify({ model: "m-test", max_tokens: 1024, messages: [{ role: "user", content: "hi" }] }), {
            kind: "header", headersSent: up.headersSent, beforeAbort: () => assertUpstreamOpen(up),
        });
        await awaitUpstreamTeardown(up.socketsClosed);
        assert.ok(up.socketsClosed() >= 1, `upstream socket(s) destroyed after client abort (closed=${up.socketsClosed()})`);
    } finally {
        await closeFixtureServers(proxy, up.server);
    }
});

test("error-delivery x proxy-openai-sse: upstream 429 AFTER the early 200 commit arrives in-band as a top-level error frame + [DONE]", async () => {
    const up = await startUpstream("slow-summary-fwd-429");
    const proxy = await startProxy(up.port);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        // ~13k-token history vs 10k window → preflight; the summary call is
        // slow (outlives the 300ms hold grace) and the FORWARD after it hits
        // 429 — both after the early 200 commit, so the error must arrive
        // in-band on the openai wire.
        const r = await new Promise<{ status: number; headers: http.IncomingHttpHeaders; t0: number; tHeaderMs: number; body: string }>((resolve, reject) => {
            const t0 = Date.now();
            const req = http.request(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${up.port}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", "x-acp-session": "mx-inband-oai" } }, (res) => {
                const tHeaderMs = Date.now() - t0;
                const chunks: Buffer[] = [];
                res.on("data", (c: Buffer) => chunks.push(c));
                res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, t0, tHeaderMs, body: Buffer.concat(chunks).toString("utf8") }));
            });
            req.on("error", reject);
            req.end(JSON.stringify({ model: "m-test", max_tokens: 1024, stream: true, messages: bigConversation() }));
        });
        assert.equal(r.status, 200, "early commit owns the status line");
        assert.equal(String(r.headers["content-type"]), "text/event-stream");
        // #3228: assert the RELATIVE invariant (headers before the mock's actual
        // summarization completion), not an absolute wall-clock bound — a loaded
        // runner stalls both timers equally and eats the fixed margin while the
        // behavior stays correct (same fix as #3152-C in preflight-hold). If early
        // commit regresses, headers land at stream end, i.e. AFTER summarization.
        assert.ok(up.summaryDoneMs() > 0, "the slow summarization call completed");
        assert.ok(r.tHeaderMs < up.summaryDoneMs() - r.t0, `headers committed before summarization finished (${r.tHeaderMs}ms vs ${up.summaryDoneMs() - r.t0}ms)`);
        assert.ok(r.body.includes(": bili-preflight"), "keep-alive comment present");
        // Post-commit upstream failure goes through emitStreamError: openai
        // shape = top-level error frame + [DONE]. #1455: the legacy
        // error-delta + finish_reason looked like a successful completion and
        // silenced client retry — it is now opt-out only.
        assert.ok(r.body.includes("upstream HTTP 429"), `in-band error frame carries the upstream status body=${r.body.slice(-600)}`);
        assert.ok(r.body.includes('"code":"stream_error"'), "error frame carries the stream_error code");
        assert.ok(!r.body.includes('"finish_reason"'), "no fabricated completion after the failure");
        assert.ok(r.body.includes("data: [DONE]"), "stream terminates with [DONE]");
        assert.ok(!r.body.includes('"choices":[{"index":0,"message"'), "no fabricated model content after the failure");
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        up.server.close();
        up.server.closeIdleConnections?.();
        await once(up.server, "close");
    }
});

test("error-delivery x proxy-openai-sse: preflight failure after the early commit arrives in-band as a top-level error + [DONE]", async () => {
    const up = await startUpstream("slow-summary-429");
    const proxy = await startProxy(up.port);
    await once(proxy, "listening");
    const proxyPort = (proxy.address() as { port: number }).port;
    try {
        const r = await new Promise<{ status: number; headers: http.IncomingHttpHeaders; t0: number; tHeaderMs: number; body: string }>((resolve, reject) => {
            const t0 = Date.now();
            const req = http.request(`http://127.0.0.1:${proxyPort}/bili/http://127.0.0.1:${up.port}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", "x-acp-session": "mx-inband-oai2" } }, (res) => {
                const tHeaderMs = Date.now() - t0;
                const chunks: Buffer[] = [];
                res.on("data", (c: Buffer) => chunks.push(c));
                res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, t0, tHeaderMs, body: Buffer.concat(chunks).toString("utf8") }));
            });
            req.on("error", reject);
            req.end(JSON.stringify({ model: "m-test", max_tokens: 1024, stream: true, messages: bigConversation() }));
        });
        assert.equal(r.status, 200, "early commit owns the status line");
        assert.equal(String(r.headers["content-type"]), "text/event-stream");
        // #3228: RELATIVE invariant — see the sibling test above (#3152-C pattern).
        // Early-commit regression lands headers at stream end, i.e. AFTER the
        // slow summarization failed, so the order still catches it.
        assert.ok(up.summaryDoneMs() > 0, "the slow summarization call completed");
        assert.ok(r.tHeaderMs < up.summaryDoneMs() - r.t0, `headers committed before the slow summarization failed (${r.tHeaderMs}ms vs ${up.summaryDoneMs() - r.t0}ms)`);
        assert.ok(r.body.includes(": bili-preflight"), "keep-alive comment present");
        // Post-commit PREFLIGHT failure goes through emitPreflightError: openai
        // shape = top-level {error} object + [DONE] (no choices framing).
        assert.ok(r.body.includes('"error"'), "top-level in-band error object present");
        assert.ok(r.body.includes("data: [DONE]"), "stream terminates with [DONE]");
        assert.ok(!r.body.includes('"choices"'), "no model content fabricated after the failure");
        assert.equal(up.requests(), 1, "the failed preflight means no forward happened");
    } finally {
        proxy.close();
        proxy.closeIdleConnections?.();
        await once(proxy, "close");
        up.server.close();
        up.server.closeIdleConnections?.();
        await once(up.server, "close");
    }
});

test("abort x teardown-budget arithmetic: measured lag extends the window, capped at 2×base", () => {
    const base = 10_000;
    assert.equal(teardownPollContinues(9_999, base, 0), true, "healthy loop: inside the flat budget");
    assert.equal(teardownPollContinues(10_000, base, 0), false, "healthy loop: boundary unchanged (zero lag ⇒ old flat gate byte-for-byte)");
    assert.equal(teardownPollContinues(12_000, base, 5_000), true, "measured event-loop lag extends the window");
    assert.equal(teardownPollContinues(15_000, base, 5_000), false, "extension equals the measured lag, no more");
    assert.equal(teardownPollContinues(19_999, base, 999_999), true, "runaway lag cannot push the window past 2×base");
    assert.equal(teardownPollContinues(20_000, base, 999_999), false, "hard ceiling at 2×base guarantees termination");
});
