import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test, { mock } from "node:test";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { Jimp } from "jimp";
import { openaiToCore, type OpenAIRequestBody } from "acp-kernel/wire";
import { defaultConfig } from "acp-kernel";
import { startServer } from "../src/server.js";
import { loadOptions } from "../src/config.js";
import { SessionStore, _setStoreForTest } from "../src/persist.js";
import { _setForTest as setRegistryForTest } from "../src/registry.js";
import { _setInvariantJudgeForTest, _setInvariantJudgeFaultForTest, type JudgeVerdict } from "../src/invariant-judge.js";
import { getSession } from "../src/session.js";
import { decodeImageDims } from "../src/image-tokens.js";

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

for (const corrupt of [false, true]) {
    test(`non-folded preparation and relay resize chain: corrupt=${corrupt}`, async () => {
        const saved = new Map(["BILI_IMAGE_RESCALE", "BILI_IMAGE_RESCALE_MAX_DIM", "BILI_HTTP_OUTBOUND_BYTES"].map(key => [key, process.env[key]]));
        process.env.BILI_IMAGE_RESCALE = "1"; process.env.BILI_IMAGE_RESCALE_MAX_DIM = "1600"; process.env.BILI_HTTP_OUTBOUND_BYTES = "600000";
        const verdicts: JudgeVerdict[] = [];
        _setInvariantJudgeForTest(true, verdict => verdicts.push(verdict));
        _setInvariantJudgeFaultForTest(corrupt ? exit => exit.map(message =>
            (message as { imagePart?: boolean }).imagePart ? { ...message, imageBase64: Buffer.from("altered pixels").toString("base64") } : message) : null);
        let captured: OpenAIRequestBody | undefined;
        const upstream = http.createServer(async (req, res) => {
            const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
            captured = JSON.parse(Buffer.concat(chunks).toString()) as OpenAIRequestBody;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ACK" }, finish_reason: "stop" }] }));
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
        try {
            const png = new Jimp({ width: 1900, height: 1050 });
            let seed = 34567;
            for (let index = 0; index < png.bitmap.data.length; index += 4) {
                seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
                png.bitmap.data[index] = seed & 255; png.bitmap.data[index + 1] = (seed >>> 8) & 255;
                png.bitmap.data[index + 2] = (seed >>> 16) & 255; png.bitmap.data[index + 3] = 255;
            }
            const original = (await png.getBuffer("image/png")).toString("base64");
            const cid = `prep-relay-resize-${corrupt}`;
            const response = await fetch(`http://127.0.0.1:${(proxy.address() as { port: number }).port}/bili/${target}/v1/chat/completions`, {
                method: "POST", headers: { "content-type": "application/json", "x-bili-plugin": "pi", "x-bili-plugin-conversation": cid },
                body: JSON.stringify({ model: "image-fixture", stream: false, messages: [{ role: "user", content: [
                    { type: "text", text: "Inspect disposable pixels" }, { type: "image_url", image_url: { url: `data:image/png;base64,${original}` } },
                ] }], tools: [{ type: "function", function: { name: "read_fixture", parameters: { type: "object", properties: {} } } }] }),
            });
            assert.equal(response.status, 200); await response.text();
            assert.ok(captured);
            const wire = JSON.stringify(captured);
            assert.ok(wire.includes("[bili][resized]") && wire.includes("original 1900×1050"), "preparation resized the original pixels");
            const session = getSession(cid);
            const shed = session.metadata.httpByteShed as { archived?: number; downscaled?: number };
            assert.equal(shed.archived, 0);
            assert.ok(shed.downscaled! > 0, "relay then resized the already resized protected image");
            const image = openaiToCore(captured).msgs.find(message => message.imagePart);
            assert.ok(image?.imageBase64);
            assert.ok(decodeImageDims(image.imageBase64)!.w <= 1024);
            assert.equal(verdicts.length, 1);
            assert.equal(verdicts[0].folded, false);
            assert.equal(verdicts[0].ok, !corrupt, JSON.stringify(verdicts));
        } finally {
            proxy.closeAllConnections(); await new Promise<void>(resolve => proxy.close(() => resolve()));
            upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve()));
            _setInvariantJudgeFaultForTest(null); _setInvariantJudgeForTest(true);
            for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
        }
    });
}
