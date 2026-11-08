import test from "node:test";
import assert from "node:assert/strict";
import type { CoreMessage } from "acp-kernel";
import { defaultConfig, defaultCountTokens, truncateLargeToolOutputs } from "acp-kernel";
import { judgeInboundOutbound } from "../src/invariant-judge.js";

const old: CoreMessage = { id: "old", role: "assistant", contentType: "text", text: "consumed original" };
const recent: CoreMessage = { id: "recent", role: "user", contentType: "text", text: "protected working facts" };
const summary: CoreMessage = { id: "acp_summary_b1", role: "user", contentType: "text", text: "[Compressed conversation section]\nArchived old facts" };
const entry = [old, recent];
const expected = [recent, summary];

test("verified fold projection accepts a tail-positioned native summary and retained working history", () => {
    const v = Reflect.apply(judgeInboundOutbound, undefined, [entry, expected, { expectedFoldedMessages: expected }]);
    assert.equal(v.ok, true);
    assert.equal(v.folded, true);
    assert.equal(v.matched, 2);
});

for (const [label, exit] of [
    ["protected rewrite", [{ ...recent, text: "corrupted facts" }, summary]],
    ["protected drop", [summary]],
    ["missing summary", [recent]],
    ["changed summary", [recent, { ...summary, text: "[Compressed conversation section]\nWrong facts" }]],
    ["moved summary", [summary, recent]],
] as const) {
    test(`${label} is still rejected with recorded fold projection`, () => {
        const v = Reflect.apply(judgeInboundOutbound, undefined, [entry, exit, { expectedFoldedMessages: expected }]);
        assert.equal(v.ok, false);
    });
}

test("a forged tail summary without recorded coverage remains a violation", () => {
    assert.equal(judgeInboundOutbound(entry, expected).ok, false);
});

const nativeCall: CoreMessage = { id: "native-call", role: "assistant", contentType: "tool-call", toolName: "compress", toolCallId: "native-1", text: '{"content":"m00001–m00002 Archived facts\\nKeep project CEDAR."}' };
const nativeResult: CoreMessage = { id: "native-result", role: "tool", contentType: "tool-result", toolName: "compress", toolCallId: "native-1", text: "Compressed into b1" };
const nativeExpected = [recent, nativeCall, nativeResult];

test("recorded native call-carrier fold is classified as folded without a summary marker", () => {
    const v = judgeInboundOutbound([old, ...nativeExpected], nativeExpected, { expectedFoldedMessages: nativeExpected });
    assert.equal(v.ok, true);
    assert.equal(v.folded, true);
});

test("native summary corruption and missing protected content remain violations", () => {
    for (const exit of [
        [recent, { ...nativeCall, text: '{"content":"wrong summary"}' }, nativeResult],
        [nativeCall, nativeResult],
        [recent, nativeResult],
    ]) assert.equal(judgeInboundOutbound([old, ...nativeExpected], exit, { expectedFoldedMessages: nativeExpected }).ok, false);
    assert.equal(judgeInboundOutbound([old, ...nativeExpected], nativeExpected).ok, false);
});

test("a tool result quoting the summary marker retains verified truncation handling", () => {
    const call: CoreMessage = { id: "read-call", role: "assistant", contentType: "tool-call", toolName: "read", toolCallId: "quoted-marker", text: "{}" };
    const result: CoreMessage = { id: "read-result", role: "tool", contentType: "tool-result", toolName: "read", toolCallId: "quoted-marker", text: "FILE-HEAD [Compressed conversation section] " + "source ".repeat(1000) + " FILE-TAIL" };
    const clipped = { ...result, text: "FILE-HEAD\n...[truncated for context space] original...\nFILE-TAIL" };
    const expected = [summary, call, result, recent];
    assert.equal(judgeInboundOutbound(expected, [summary, call, clipped, recent], { expectedFoldedMessages: expected }).ok, true);
    assert.equal(judgeInboundOutbound(expected, [summary, call, { ...clipped, text: "CORRUPTED" }, recent], { expectedFoldedMessages: expected }).ok, false);
});

for (const role of ["user", "assistant"] as const) {
    test(`ordinary ${role} text quoting a summary marker retains real truncation handling`, () => {
        const paste: CoreMessage = { id: `paste-${role}`, role, contentType: "text", text: "PASTE-HEAD quoted [Compressed conversation section] " + "source ".repeat(1000) + " PASTE-TAIL" };
        const expected = [summary, paste, recent];
        const clipped = truncateLargeToolOutputs(expected, 199000, defaultConfig(200000), defaultCountTokens,
            { includeTextMessages: true, minOutputTokens: 100, protectRecentMessages: 1, keepPrefixChars: 20, keepSuffixChars: 20 });
        assert.equal(clipped.truncatedCount, 1);
        assert.equal(judgeInboundOutbound(expected, clipped.messages, { expectedFoldedMessages: expected }).ok, true);
        assert.equal(judgeInboundOutbound(expected, clipped.messages.map(m => m.id === summary.id ? { ...m, text: "CORRUPTED SUMMARY" } : m), { expectedFoldedMessages: expected }).ok, false);
    });
}
