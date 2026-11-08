import test from "node:test";
import assert from "node:assert/strict";
import type { CoreMessage } from "acp-kernel";
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
