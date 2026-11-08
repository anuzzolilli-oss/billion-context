import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test, { mock } from "node:test";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.js";
import { loadOptions } from "../src/config.js";
import { SessionStore, _setStoreForTest } from "../src/persist.js";
import { _setForTest as setRegistryForTest } from "../src/registry.js";
import { _setInvariantJudgeForTest, _setInvariantJudgeFaultForTest, type JudgeVerdict } from "../src/invariant-judge.js";

for (const fault of ["none", "image", "note", "disabled"] as const) {
    test(`actual OpenAI relay image archival: ${fault}`, async () => {
        const oldBudget = process.env.BILI_HTTP_OUTBOUND_BYTES;
        process.env.BILI_HTTP_OUTBOUND_BYTES = "8000";
        const verdicts: JudgeVerdict[] = [];
        let captured: { messages: { content?: unknown }[] } | undefined;
        _setInvariantJudgeForTest(fault !== "disabled", verdict => verdicts.push(verdict));
        _setInvariantJudgeFaultForTest(fault === "none" || fault === "disabled" ? null : exit => exit.map(m =>
            fault === "image" && (m as { imagePart?: boolean }).imagePart ? { ...m, imageBase64: Buffer.from("corrupted pixels").toString("base64") }
                : fault === "note" && m.text?.includes("omitted for size limit") ? { ...m, text: "forged archive note" } : m));
        const upstream = http.createServer(async (req, res) => {
            const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
            captured = JSON.parse(Buffer.concat(chunks).toString());
            res.writeHead(200, { "content-type": "application/json" });
            res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ACK" }, finish_reason: "stop" }], usage: { prompt_tokens: 10000, completion_tokens: 1 } }));
        });
        upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
        const target = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
        _setStoreForTest(new SessionStore({ enabled: false })); setRegistryForTest({});
        const proxy = await startServer({ ...loadOptions(), host: "127.0.0.1", port: 0, log: false, debug: false,
            routes: { [target]: { models: { "image-fixture": { context: 200000 } } } }, modelContextLimit: 200000, kernelConfig: defaultConfig(200000),
            compress: { injectTool: true, injectNudge: false }, passthrough: false, autoUpdate: false, advisoryCheck: false, releaseNotesCheck: false,
            mitm: { enabled: false, domains: [] },
        });
        await once(proxy, "listening");
        let verificationReads = 0;
        const originalRead = fsPromises.readFile;
        const readProbe = mock.method(fsPromises, "readFile", (...args: Parameters<typeof fsPromises.readFile>) => {
            if (new Error().stack?.includes("verifyArchivedImageSource")) verificationReads++;
            return originalRead(...args);
        });
        syncBuiltinESMExports();
        try {
            const data = Buffer.from("synthetic image payload ".repeat(200)).toString("base64");
            const protectedData = Buffer.from("protected synthetic pixels ".repeat(150)).toString("base64");
            const image = { type: "image_url", image_url: { url: `data:image/png;base64,${data}` } };
            const protectedImage = { type: "image_url", image_url: { url: `data:image/png;base64,${protectedData}` } };
            const messages = [{ role: "user", content: [image] }, ...Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `Retain text ${i}` })), { role: "user", content: [protectedImage] }];
            const response = await fetch(`http://127.0.0.1:${(proxy.address() as { port: number }).port}/bili/${target}/v1/chat/completions`, {
                method: "POST", headers: { "content-type": "application/json", "x-bili-plugin": "pi", "x-bili-plugin-conversation": `image-relay-${fault}` },
                body: JSON.stringify({ model: "image-fixture", max_tokens: 2048, stream: false, messages, tools: [{ type: "function", function: { name: "read_fixture", parameters: { type: "object", properties: {} } } }] }),
            });
            assert.equal(response.status, 200); await response.text();
            assert.ok(captured);
            const wire = JSON.stringify(captured);
            assert.ok(wire.includes("omitted for size limit"));
            assert.ok(wire.includes(protectedData));
            assert.ok(!wire.includes(data));
            if (fault === "disabled") {
                assert.equal(verdicts.length, 0);
                assert.equal(verificationReads, 0, "disabled diagnostics perform no archive-verification reads");
            } else {
                assert.ok(verificationReads > 0, "enabled diagnostics actually verify the original file");
                assert.equal(verdicts.length, 1);
                assert.equal(verdicts[0].ok, fault === "none", JSON.stringify(verdicts));
            }
        } finally {
            readProbe.mock.restore(); syncBuiltinESMExports();
            proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve()));
            upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()));
            _setInvariantJudgeFaultForTest(null); _setInvariantJudgeForTest(true);
            if (oldBudget === undefined) delete process.env.BILI_HTTP_OUTBOUND_BYTES; else process.env.BILI_HTTP_OUTBOUND_BYTES = oldBudget;
        }
    });
}
