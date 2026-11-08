import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openaiToCore, type OpenAIRequestBody } from "acp-kernel/wire";
import { shedWireImages, shedWireImagesToCount } from "../src/egress-shed.js";
import { judgeInboundOutbound } from "../src/invariant-judge.js";
import { verifyArchivedImageSource } from "../src/image-rescale.js";
import { Jimp } from "jimp";

interface Receipt { ordinal: number; mediaType: string; sha256: string; ref: string; note: string }
const data = Buffer.from("synthetic image payload ".repeat(200)).toString("base64");
const image = { type: "image_url", image_url: { url: `data:image/png;base64,${data}` } };
const body = { messages: [
    { role: "user", content: [image] },
    ...Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `Retain text ${i}` })),
    { role: "user", content: [image] },
] } as OpenAIRequestBody;
const expected = openaiToCore(body).msgs;

async function fixture() {
    const receipts: Receipt[] = [];
    const result = await Reflect.apply(shedWireImages, undefined, [JSON.stringify(body), "openai", Buffer.byteLength(JSON.stringify(body)) - 1000, {
        resolveRef: async () => "m00001", onImageArchive: (r: Receipt) => receipts.push(r),
    }]);
    assert.equal(result.stats.archived, 1);
    return { receipts, wire: JSON.parse(result.body) as OpenAIRequestBody };
}
function judge(wire: OpenAIRequestBody, receipts: Receipt[]) {
    return Reflect.apply(judgeInboundOutbound, undefined, [expected, openaiToCore(wire).msgs, { expectedFoldedMessages: expected, imageArchiveBatches: [receipts] }]);
}

test("actual image archiving emits evidence and passes folded history validation", async () => {
    const { receipts, wire } = await fixture();
    assert.equal(receipts.length, 1);
    assert.equal(receipts[0].ordinal, 0);
    assert.equal(receipts[0].ref, "m00001");
    assert.equal(judge(wire, receipts).ok, true);
});

test("real protected-image downscaling after archival is verified and corruption still fails", async () => {
    const png = new Jimp({ width: 1200, height: 800 });
    let seed = 12345;
    for (let index = 0; index < png.bitmap.data.length; index += 4) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        png.bitmap.data[index] = seed & 255;
        png.bitmap.data[index + 1] = (seed >>> 8) & 255;
        png.bitmap.data[index + 2] = (seed >>> 16) & 255;
        png.bitmap.data[index + 3] = 255;
    }
    const pixels = (await png.getBuffer("image/png")).toString("base64");
    const image = { type: "image_url", image_url: { url: `data:image/png;base64,${pixels}` } };
    const original = { messages: [{ role: "user", content: [image] },
        ...Array.from({ length: 10 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `Preserve ${i}` })),
        { role: "user", content: [image] }] } as OpenAIRequestBody;
    const receipts: unknown[] = [];
    const shed = await Reflect.apply(shedWireImages, undefined, [JSON.stringify(original), "openai", Math.floor(pixels.length * 0.4), {
        resolveRef: async () => "m00001", onImageArchive: (r: unknown) => receipts.push(r), onImageResize: (r: unknown) => receipts.push(r),
    }]);
    assert.equal(shed.stats.archived, 1);
    assert.ok(shed.stats.downscaled > 0, "real decodable pixels reached the downscale ladder");
    const expected = openaiToCore(original).msgs;
    const exit = openaiToCore(JSON.parse(shed.body) as OpenAIRequestBody).msgs;
    const judge = (output: typeof exit, evidence = receipts) => Reflect.apply(judgeInboundOutbound, undefined, [expected, output, { expectedFoldedMessages: expected, imageArchiveBatches: [evidence] }]);
    assert.equal(judge(exit).ok, true);
    assert.equal(judge(exit.map(m => m.imagePart ? { ...m, imageBase64: data } : m)).ok, false);
    assert.equal(judge(exit, receipts.slice(0, 1)).ok, false);
});

test("archive notes without evidence and altered evidence remain violations", async () => {
    const { receipts, wire } = await fixture();
    assert.equal(receipts.length, 1);
    assert.equal(judge(wire, []).ok, false);
    for (const change of [{ ordinal: 1 }, { sha256: "0".repeat(64) }, { ref: "m99999" }, { note: "forged note" }, { mediaType: "image/jpeg" }]) {
        assert.equal(judge(wire, [{ ...receipts[0], ...change }]).ok, false);
    }
    assert.equal(judge(wire, [receipts[0], receipts[0]]).ok, false);
    assert.equal(judge(body, receipts).ok, false);
});

test("protected image corruption or loss and adjacent text edits still fail", async () => {
    const { receipts, wire } = await fixture();
    assert.equal(receipts.length, 1);
    const changed = structuredClone(wire);
    changed.messages[changed.messages.length - 1].content = [{ type: "image_url", image_url: { url: "data:image/png;base64," + Buffer.from("wrong image").toString("base64") } }];
    assert.equal(judge(changed, receipts).ok, false);
    const lost = structuredClone(wire); lost.messages.pop();
    assert.equal(judge(lost, receipts).ok, false);
    const text = structuredClone(wire); text.messages[1].content = "CORRUPTED";
    assert.equal(judge(text, receipts).ok, false);
});

test("successive byte and count archive stages reconcile in order", async () => {
    const first = await fixture();
    const second: Receipt[] = [];
    const result = await Reflect.apply(shedWireImagesToCount, undefined, [JSON.stringify(first.wire), "openai", 0, {
        resolveRef: async () => "m00012", onImageArchive: (r: Receipt) => second.push(r),
    }]);
    assert.equal(second.length, 1);
    const exit = openaiToCore(JSON.parse(result.body)).msgs;
    assert.equal(Reflect.apply(judgeInboundOutbound, undefined, [expected, exit, { expectedFoldedMessages: expected, imageArchiveBatches: [first.receipts, second] }]).ok, true);
    assert.equal(Reflect.apply(judgeInboundOutbound, undefined, [expected, exit, { expectedFoldedMessages: expected, imageArchiveBatches: [second, first.receipts] }]).ok, false);
});

test("unresolved retrieval reference does not grant an image exemption", async () => {
    const receipts: Receipt[] = [];
    const result = await Reflect.apply(shedWireImages, undefined, [JSON.stringify(body), "openai", Buffer.byteLength(JSON.stringify(body)) - 1000, { onImageArchive: (r: Receipt) => receipts.push(r) }]);
    assert.equal(receipts.length, 0);
    assert.equal(judge(JSON.parse(result.body), receipts).ok, false);
});

test("archive authority requires a readable original with the matching media hash", async () => {
    const { receipts } = await fixture();
    const dir = mkdtempSync(join(tmpdir(), "bili-archive-receipt-"));
    const path = join(dir, "synthetic.bin");
    try {
        writeFileSync(path, Buffer.from(data, "base64"));
        const session = { incomingImageIndex: new Map([["m00001", [{ path, mediaType: "image/png", bytes: Buffer.from(data, "base64").length }]]]) };
        assert.equal(await verifyArchivedImageSource(session, receipts[0]), true);
        assert.equal(await verifyArchivedImageSource(session, { ...receipts[0], ref: "m99999" }), false);
        writeFileSync(path, "corrupted original");
        assert.equal(await verifyArchivedImageSource(session, receipts[0]), false);
        unlinkSync(path);
        assert.equal(await verifyArchivedImageSource(session, receipts[0]), false);
    } finally {
        try { unlinkSync(path); } catch { /* Removed by the missing-original test. */ }
        rmdirSync(dir);
    }
});
