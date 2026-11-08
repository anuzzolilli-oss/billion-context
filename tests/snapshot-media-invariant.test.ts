import test from "node:test";
import assert from "node:assert/strict";
import { Jimp } from "jimp";
import { coreToOpenai, openaiToCore, type BiliMessage } from "acp-kernel/wire";
import { projectOpenaiJudgeMedia } from "../src/server/judge-media-projection.js";
import { judgeInboundOutbound } from "../src/invariant-judge.js";
import { getSession } from "../src/session.js";

const text = (id: string, role: "user" | "assistant", value: string): BiliMessage => ({ id, role, contentType: "text", text: value });

for (const placement of ["tail", "prefix", "cross-boundary"] as const) {
    test(`snapshot media projection keeps the live tail checked: ${placement}`, async () => {
        const saved = process.env.BILI_IMAGE_RESCALE;
        process.env.BILI_IMAGE_RESCALE = "1";
        try {
            const png = new Jimp({ width: placement === "prefix" ? 3200 : 8, height: 64 });
            let seed = 12345;
            for (let index = 0; index < png.bitmap.data.length; index += 4) {
                seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
                png.bitmap.data[index] = seed & 255; png.bitmap.data[index + 1] = (seed >>> 8) & 255;
                png.bitmap.data[index + 2] = (seed >>> 16) & 255; png.bitmap.data[index + 3] = 255;
            }
            const bytes = (await png.getBuffer("image/png")).toString("base64");
            const image = openaiToCore({ messages: [{ role: "user", content: [
                { type: "image_url", image_url: { url: `data:image/png;base64,${bytes}` } },
            ] }] }).msgs.find(m => m.imagePart)!;
            const prefix = [text("old", "user", "old"), text("seed", "user", ""),
                ...(placement === "prefix" ? [image] : []), text("a", "assistant", "A"), text("b", "assistant", "B")];
            const live = text("live", placement === "cross-boundary" ? "assistant" : "user", "LIVE USER FACTS");
            const baseline = [...prefix, live, ...(placement === "prefix" ? [] : [image])];
            const projection = await projectOpenaiJudgeMedia(baseline, {
                session: getSession(`snapshot-media-${placement}`), sessionId: `snapshot-media-${placement}`,
                log: () => {}, maxDim: 1600, toolArmed: false,
            }, prefix.length);
            const options = { expectedMediaMessages: projection.messages, renderTailStart: projection.renderTailStart };
            assert.equal(projection.renderTailStart, projection.messages.findIndex(m => m.text?.includes("LIVE USER FACTS")), "boundary includes the first live wire cell, including seam merges");
            assert.ok(projection.renderTailStart! > 0, "rendered prefix remains exempt");
            if (placement === "prefix") assert.ok(projection.messages.some(m => m.text?.includes("[bili][resized]")), "prefix rescale actually adds an annotation");
            assert.equal(judgeInboundOutbound(baseline, projection.messages, options).ok, true, "intact tail accepted");
            assert.equal(judgeInboundOutbound(baseline, projection.messages.map((m, i) => i === 0 ? { ...m, text: "SERVER RENDERED PREFIX" } : m), options).ok, true, "server prefix is outside the tail-fidelity contract");
            for (const fault of ["rewrite", "drop"] as const) {
                const exit = openaiToCore({ messages: coreToOpenai(projection.messages.map(m => ({ ...m,
                    text: m.text?.replace("LIVE USER FACTS", fault === "rewrite" ? "CORRUPTED" : ""),
                }))) }).msgs;
                assert.equal(judgeInboundOutbound(baseline, exit, options).ok, false, `${fault} of live text rejected`);
            }
            if (placement !== "prefix") assert.equal(judgeInboundOutbound(baseline, projection.messages.map(m =>
                m.imagePart ? { ...m, imageBase64: Buffer.from("CORRUPTED PIXELS").toString("base64") } : m), options).ok, false, "tail image corruption rejected");
        } finally {
            if (saved === undefined) delete process.env.BILI_IMAGE_RESCALE; else process.env.BILI_IMAGE_RESCALE = saved;
        }
    });
}
