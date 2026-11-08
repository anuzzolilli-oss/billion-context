import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.js";
import { loadOptions } from "../src/config.js";
import { SessionStore, _setStoreForTest } from "../src/persist.js";
import { _setForTest as setRegistryForTest } from "../src/registry.js";
import { _setInvariantJudgeForTest, _setInvariantJudgeFaultForTest, type JudgeVerdict } from "../src/invariant-judge.js";

let sequence = 0;
async function nativeEcho() {
    const upstream = http.createServer(async (req, res) => {
        for await (const _chunk of req) { /* Drain the disposable request. */ }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ACK" }, finish_reason: "stop" }], usage: { prompt_tokens: 50000, completion_tokens: 1 } }));
    });
    upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
    const target = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    _setStoreForTest(new SessionStore({ enabled: false })); setRegistryForTest({});
    const proxy = await startServer({ ...loadOptions(), host: "127.0.0.1", port: 0,
        routes: { [target]: { models: { "native-fixture": { context: 200000 } } } },
        modelContextLimit: 200000, kernelConfig: defaultConfig(200000),
        compress: { injectTool: true, injectNudge: false }, passthrough: false,
        autoUpdate: false, advisoryCheck: false, releaseNotesCheck: false, log: false, debug: false,
        mitm: { enabled: false, domains: [] },
    });
    await once(proxy, "listening");
    const origin = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    const cid = `native-carrier-${++sequence}`;
    const messages: unknown[] = [{ role: "user", content: "Read the disposable history." }];
    for (let i = 0; i < 30; i++) messages.push(
        { role: "assistant", content: null, tool_calls: [{ id: `read-${i}`, type: "function", function: { name: "read_fixture", arguments: "{}" } }] },
        { role: "tool", tool_call_id: `read-${i}`, content: `Observation ${i}: ` + "consumed scenery ".repeat(100) },
    );
    messages.push({ role: "user", content: "PROTECTED-WORK: preserve current requirements." });
    const send = async () => {
        const response = await fetch(`${origin}/bili/${target}/v1/chat/completions`, {
            method: "POST", headers: { "content-type": "application/json", "x-bili-plugin": "pi", "x-bili-plugin-conversation": cid, "x-bili-plugin-context-window": "200000" },
            body: JSON.stringify({ model: "native-fixture", stream: false, max_tokens: 2048, messages,
                tools: [{ type: "function", function: { name: "read_fixture", description: "Read fixture", parameters: { type: "object", properties: {} } } }],
            }),
        });
        assert.equal(response.status, 200); await response.text();
    };
    const invoke = async (tool: string, args: unknown, toolCallId?: string) => {
        const response = await fetch(`${origin}/__bili/plugin/tool`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conversationId: cid, nativeCaller: true, tool, args, toolCallId }) });
        assert.equal(response.status, 200);
        return await response.json() as { result: string; outcome?: string };
    };
    try {
        await send();
        for (let fold = 0; fold < 2; fold++) {
            if (fold) {
                messages.push({ role: "assistant", content: "SECOND ARCHIVE " + "consumed second fixture ".repeat(1200) }, { role: "user", content: "PROTECTED-WORK: second current request." });
                await send();
            }
            const status = await invoke("acp_status", {});
            const spans = [...status.result.matchAll(/(m\d+)[–-](m\d+)\s+\d+ msgs/g)];
            const span = fold ? spans.at(-1) : spans[0];
            assert.ok(span, status.result);
            const args = { content: `${span[1]}–${span[2]} Archived fixture\nConsumed scenery observations; originals remain retrievable. No open task requirements within this range.` };
            const id = `compress-${fold}`;
            const result = await invoke("compress", args, id);
            assert.equal(result.outcome, "applied", result.result);
            messages.push({ role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: "compress", arguments: JSON.stringify(args) } }] }, { role: "tool", tool_call_id: id, content: result.result });
            await send();
        }
        await send();
    } finally {
        proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve()));
        upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
}

for (const fault of ["none", "summary", "protected"] as const) {
    test(`native Pi call/result echo across two folds: ${fault}`, async () => {
        const verdicts: JudgeVerdict[] = [];
        _setInvariantJudgeForTest(true, verdict => verdicts.push(verdict));
        _setInvariantJudgeFaultForTest(fault === "none" ? null : exit => exit.some(m => m.toolName === "compress") ? exit.map(m =>
            (fault === "summary" && m.contentType === "tool-call" && m.toolName === "compress") || (fault === "protected" && m.text?.includes("PROTECTED-WORK"))
                ? { ...m, text: "CORRUPTED" } : m) : exit);
        try {
            await nativeEcho();
            assert.ok(verdicts.some(v => v.folded));
            if (fault === "none") assert.ok(verdicts.every(v => v.ok), JSON.stringify(verdicts.filter(v => !v.ok)));
            else assert.ok(verdicts.some(v => v.folded && !v.ok));
        } finally { _setInvariantJudgeFaultForTest(null); _setInvariantJudgeForTest(true); }
    });
}
