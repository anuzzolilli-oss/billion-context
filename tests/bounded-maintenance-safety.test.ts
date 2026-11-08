import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { Socket, type AddressInfo } from 'node:net';
import { createCore, defaultConfig, assignRefs, emptyRefMap, prune, truncateLargeToolOutputs, defaultCountTokens, type CoreMessage } from 'acp-kernel';
import { createSession } from '../src/session.js';
import { loadOptions } from '../src/config.js';
import { SessionStore, _setStoreForTest } from '../src/persist.js';
import { configureBoundedMaintenance, maybeRunBoundedMaintenance } from '../src/server/bounded-maintenance.js';
import { stripKernelSummaries, type Prepared } from '../src/server.js';
import { executeProxyToolAsync } from '../src/loop/core.js';

process.env.NODE_ENV = 'test';
_setStoreForTest(new SessionStore({ enabled: false }));
interface ArchiveEntry { role: string; type?: string; tool?: string; toolCallId?: string; content?: string }
interface MaintenanceRequest { messages: { content: string }[] }
const summary = 'Archived disposable fixture facts. The task is complete; originals retain the exact details for subsequent retrieval.';
let seq = 0;
const msg = (id: string, text: string, role: 'user' | 'assistant' = 'assistant'): CoreMessage => ({ id, role, contentType: 'text', text });
const tail = () => [msg('tail-a', 'Protected recent assistant'), msg('tail-u', 'Protected current user', 'user')];
function fixture(messages: CoreMessage[]) {
    const core = createCore();
    const config = defaultConfig(200000, { preserveRecentMessages: 2, preserveRecentTokens: 0 });
    const session = createSession(`review-first-five-${++seq}`);
    session.metadata.pluginAgent = 'pi';
    session.state.messageRefs = assignRefs(messages, { existing: emptyRefMap(), nextIndex: 0 }).map;
    return { core, config, session, messages, compressMessages: messages, log: (_s: string) => {} };
}
function prepared(ctx: ReturnType<typeof fixture>, startIndex: number, endIndex: number, processed = ctx.messages): Prepared {
    const refs = ctx.session.state.messageRefs.byRaw;
    return { protocol: 'openai', pluginMode: true, stream: false, compressInjected: false,
        body: JSON.stringify({ model: 'local-fixture', messages: [], tools: [{ type: 'function', function: { name: 'compress', parameters: {} } }] }),
        session: ctx.session, originalMessages: ctx.messages, processedMessages: processed,
        nudgeOutcome: 'injected', nudge: { tier: 1, compressibleRanges: [{ startIndex, endIndex, startRef: refs[processed[startIndex].id], endRef: refs[processed[endIndex].id] }] },
    } as Prepared;
}
async function run(ctx: ReturnType<typeof fixture>, p: Prepared, callId = 'hidden-maintenance', beforeReply?: () => void) {
    let request: MaintenanceRequest | undefined;
    const logs: string[] = [];
    const server = http.createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        request = JSON.parse(Buffer.concat(chunks).toString()) as MaintenanceRequest;
        const span = /exactly (m\d+–m\d+)/.exec(request.messages[1].content)?.[1];
        beforeReply?.();
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: callId, type: 'function', function: { name: 'compress', arguments: JSON.stringify({ content: `${span} Fixture archive\n${summary}` }) } }] } }] }));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const target = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const opts = { ...loadOptions(), passthrough: false, autoUpdate: false };
    configureBoundedMaintenance(opts, { boundedMaintenance: { timeoutMs: 15000 } });
    const incoming = new http.IncomingMessage(new Socket());
    incoming.url = `/bili/${target}/v1/chat/completions`;
    try {
        const applied = await maybeRunBoundedMaintenance({ prepared: p, req: incoming,
            opts, core: ctx.core, config: ctx.config, signal: new AbortController().signal, log: (_level, text) => logs.push(text) });
        return { applied, request, logs, receipt: ctx.session.metadata.boundedMaintenanceLast };
    } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
}
function record(finding: number, details: unknown) {
    console.log(`FINDING_${finding} ${JSON.stringify(details)}`);
}

test('finding 1: oversized paired result must not be folded without being summarized', async () => {
    const marker = 'OVERSIZED-RESULT-NOT-SUPPLIED';
    const messages: CoreMessage[] = [msg('old', 'Old context '.repeat(1800), 'user'),
        { id: 'call', role: 'assistant', contentType: 'tool-call', toolName: 'read_fixture', toolCallId: 'pair-a', text: '{"path":"disposable"}' },
        { id: 'result', role: 'tool', contentType: 'tool-result', toolName: 'read_fixture', toolCallId: 'pair-a', text: marker + 'z'.repeat(40000) }, ...tail()];
    const ctx = fixture(messages);
    const result = await run(ctx, prepared(ctx, 0, 2));
    const covered = ctx.session.state.blocks.flatMap(b => b.effectiveMessageIds);
    const supplied = JSON.stringify(result.request ?? {}).includes(marker);
    const remaining = prune(messages, ctx.session.state);
    record(1, { suppliedOversizedResult: supplied, oversizedResultBytes: Buffer.byteLength(messages[2].text!), coveredIds: covered, remainingIds: remaining.map(m => m.id), receipt: result.receipt });
    assert.ok(supplied || !covered.includes('result'), 'unsummarized oversized result was folded');
    assert.ok(remaining.some(m => m.id === 'result'), 'oversized unit remains visible');
});

test('finding 2: post-fold range indexes must select advertised originals', async () => {
    const messages = [msg('old-a', 'EARLIER-A '.repeat(900), 'user'), msg('old-b', 'EARLIER-B '.repeat(900)),
        msg('old-c', 'EARLIER-C '.repeat(900), 'user'), msg('old-d', 'EARLIER-D '.repeat(900)),
        msg('new-a', 'ADVERTISED-NEW-A '.repeat(600), 'user'), msg('new-b', 'ADVERTISED-NEW-B '.repeat(600)), ...tail()];
    const ctx = fixture(messages);
    const refs = ctx.session.state.messageRefs.byRaw;
    const initial = await executeProxyToolAsync('compress', { content: `${refs['old-a']}–${refs['old-d']} Earlier archive\n${summary}` }, ctx);
    assert.equal(initial.outcome, 'applied');
    const turn = ctx.core.processTurn({ messages, state: ctx.session.state, config: ctx.config, tokenCount: 100000, renderTags: 'none' });
    ctx.session.state = turn.state;
    const view = turn.messages;
    const visible = view;
    const start = visible.findIndex(m => m.id === 'new-a');
    const end = visible.findIndex(m => m.id === 'new-b');
    assert.ok(start >= 0 && end >= start);
    const recommended = turn.nudge?.compressibleRanges.find(r => r.startRef === refs['new-a'] && r.endRef === refs['new-b']);
    assert.ok(recommended, JSON.stringify(turn.nudge));
    const p = prepared(ctx, start, end, visible);
    p.nudge = { ...turn.nudge!, tier: 1, compressibleRanges: [recommended] };
    const result = await run(ctx, p);
    const source = result.request?.messages[1].content ?? '';
    record(2, { advertisedRefs: [recommended.startRef, recommended.endRef], kernelRecommendedIndexes: [recommended.startIndex, recommended.endIndex], transformedIndexes: [start, end], originalIdsAtThoseIndexes: messages.slice(start, end + 1).map(m => m.id), suppliedNewA: source.includes('ADVERTISED-NEW-A'), suppliedNewB: source.includes('ADVERTISED-NEW-B'), suppliedEarlier: source.includes('EARLIER-'), receipt: result.receipt });
    assert.ok(source.includes('ADVERTISED-NEW-A') && source.includes('ADVERTISED-NEW-B') && !source.includes('EARLIER-'), 'maintenance selected a different archive than the advertised refs');
});

test('finding 3: full decompress must retain original middle after preparation shortening', async () => {
    const marker = 'ORIGINAL-MIDDLE-MUST-BE-RETRIEVABLE';
    const messages = [msg('seed', 'Disposable user introduction', 'user'), msg('old', 'HEAD '.repeat(800) + marker + ' TAIL'.repeat(800)), ...tail()];
    const ctx = fixture(messages);
    const truncation = truncateLargeToolOutputs(messages, 199000, ctx.config, defaultCountTokens,
        { includeTextMessages: true, minOutputTokens: 100, protectRecentMessages: 2, keepPrefixChars: 100, keepSuffixChars: 100 });
    assert.equal(truncation.truncatedCount, 1);
    const processed = truncation.messages;
    assert.ok(!processed[1].text!.includes(marker), 'setup: actual emergency truncation removed the middle');
    const result = await run(ctx, prepared(ctx, 1, 1, processed));
    assert.ok(result.applied, JSON.stringify(result));
    const blockId = ctx.session.state.blocks[0].blockId;
    const restore = await executeProxyToolAsync('decompress', { blockId, full: true }, { ...ctx, messages: processed });
    const cached = ctx.session.blockContents.get(blockId);
    ctx.session.blockContents.delete(blockId);
    const uncached = await executeProxyToolAsync('decompress', { blockId, full: true }, { ...ctx, messages: processed });
    assert.ok(uncached.text.includes(marker), 'control: originals remain retrievable when the bad cache is bypassed');
    record(3, { sourceContainsOriginal: JSON.stringify(result.request).includes(marker), cacheContainsOriginal: cached?.full.text.includes(marker), restoreText: restore.text, uncachedRestoreContainsOriginal: uncached.text.includes(marker), originalBytes: Buffer.byteLength(messages[1].text!), truncatedBytes: Buffer.byteLength(processed[1].text!), receipt: result.receipt });
    assert.ok(restore.text.includes(marker), 'full decompress omitted the original middle even though maintenance received it');
});

test('finding 4: hidden maintenance ID collision must not remove the only summary', async () => {
    const messages: CoreMessage[] = [msg('seed', 'Disposable introduction', 'user'), msg('old', 'Historical fixture '.repeat(650)),
        { id: 'retained-call', role: 'assistant', contentType: 'tool-call', toolName: 'read_fixture', toolCallId: 'collision', text: '{"path":"recent"}' },
        { id: 'retained-result', role: 'tool', contentType: 'tool-result', toolName: 'read_fixture', toolCallId: 'collision', text: 'recent protected result' }, ...tail()];
    const ctx = fixture(messages);
    const result = await run(ctx, prepared(ctx, 1, 1), 'collision');
    assert.ok(result.applied);
    const view = prune(messages, ctx.session.state);
    const before = view;
    const after = stripKernelSummaries(before, ctx.session.state);
    const isSummary = (m: CoreMessage) => m.id.startsWith('acp_summary_');
    assert.ok(!after.some(m => m.id === 'old'), 'setup: original is absent from forwarded history');
    const callId = ctx.session.state.blocks[0].compressCallId;
    assert.equal(callId, undefined, 'hidden maintenance has no native carrier association');
    ctx.session.state.blocks[0].compressCallId = 'noncolliding-hidden-id';
    const control = stripKernelSummaries(before, ctx.session.state);
    assert.ok(control.some(isSummary), 'control: noncolliding ID retains the summary');
    record(4, { compressCallId: callId, beforeIds: before.map(m => m.id), afterIds: after.map(m => m.id), summariesBefore: before.filter(isSummary).length, summariesAfter: after.filter(isSummary).length, noncollidingSummaries: control.filter(isSummary).length, receipt: result.receipt });
    assert.ok(after.some(isSummary), 'ordinary retained call with the same ID suppressed the only summary');
});

test('finding 5: serialized same-tool parallel results must preserve pairing IDs', async () => {
    const messages: CoreMessage[] = [msg('intro', 'Disposable parallel read history '.repeat(350), 'user'),
        { id: 'call-a', role: 'assistant', contentType: 'tool-call', toolName: 'read_fixture', toolCallId: 'pair-A', text: '{"path":"alpha"}' },
        { id: 'call-b', role: 'assistant', contentType: 'tool-call', toolName: 'read_fixture', toolCallId: 'pair-B', text: '{"path":"beta"}' },
        { id: 'result-b', role: 'tool', contentType: 'tool-result', toolName: 'read_fixture', toolCallId: 'pair-B', text: 'RESULT-BETA' },
        { id: 'result-a', role: 'tool', contentType: 'tool-result', toolName: 'read_fixture', toolCallId: 'pair-A', text: 'RESULT-ALPHA' }, ...tail()];
    const ctx = fixture(messages);
    const result = await run(ctx, prepared(ctx, 0, 4));
    assert.ok(result.request);
    const text = result.request.messages[1].content as string;
    const archive = JSON.parse(text.slice(text.indexOf('\n') + 1)) as ArchiveEntry[];
    const alternateMessages = messages.map(m => m.contentType === 'tool-result' ? { ...m, toolCallId: m.toolCallId === 'pair-A' ? 'pair-B' : 'pair-A' } : m);
    const alternate = fixture(alternateMessages);
    const alternateResult = await run(alternate, prepared(alternate, 0, 4));
    assert.ok(alternateResult.request);
    const indistinguishable = alternateResult.request.messages[1].content === text;
    record(5, { originalPairs: messages.filter(m => m.toolCallId).map(m => ({ id: m.id, toolCallId: m.toolCallId })), suppliedArchive: archive.filter(m => m.type !== 'text'), differentPairingsProduceIdenticalMaintenanceArchive: indistinguishable, receipt: result.receipt });
    assert.equal(archive.find(m => m.content === 'RESULT-BETA')?.toolCallId, 'pair-B', 'parallel result pairing key disappeared before summarization');
    assert.ok(!indistinguishable, 'different valid pairings must produce different maintenance archives');
});

test('control: ordinary unshortened maintenance retains full retrieval and the visible summary', async () => {
    const marker = 'CONTROL-ORIGINAL-MIDDLE';
    const messages = [msg('seed', 'Disposable introduction', 'user'), msg('old', 'old context '.repeat(600) + marker), ...tail()];
    const ctx = fixture(messages);
    const result = await run(ctx, prepared(ctx, 1, 1));
    assert.ok(result.applied);
    const blockId = ctx.session.state.blocks[0].blockId;
    const restore = await executeProxyToolAsync('decompress', { blockId, full: true }, ctx);
    assert.ok(restore.text.includes(marker));
    const visible = stripKernelSummaries(prune(messages, ctx.session.state), ctx.session.state);
    assert.ok(visible.some(m => m.id === `acp_summary_${blockId}`));
    console.log('CONTROL ordinary fold, full retrieval and visible summary passed');
});

test('oversized reasoning and its assistant response stay visible as one unit', async () => {
    const messages: CoreMessage[] = [msg('old', 'Safe neighboring context '.repeat(600), 'user'),
        { id: 'reasoning', role: 'assistant', contentType: 'reasoning', text: 'UNSELECTED-REASONING ' + 'r'.repeat(40000) },
        msg('response', 'UNSELECTED-RESPONSE ' + 'answer '.repeat(200)), ...tail()];
    const ctx = fixture(messages);
    const result = await run(ctx, prepared(ctx, 0, 2));
    assert.ok(result.applied, 'safe neighboring text can still fold');
    assert.ok(!JSON.stringify(result.request).includes('UNSELECTED-'));
    const remaining = prune(messages, ctx.session.state);
    assert.ok(remaining.some(m => m.id === 'reasoning'));
    assert.ok(remaining.some(m => m.id === 'response'));
});

test('fitting reasoning, tool call and result fold together with full result retrieval', async () => {
    const marker = 'COMPLETE-UNIT-ORIGINAL';
    const messages: CoreMessage[] = [msg('seed', 'Disposable introduction', 'user'),
        { id: 'reasoning', role: 'assistant', contentType: 'reasoning', text: 'REASONING-SOURCE ' + 'consider '.repeat(100) },
        { id: 'call', role: 'assistant', contentType: 'tool-call', toolName: 'read_fixture', toolCallId: 'fitting-pair', text: '{"path":"fixture"}' },
        { id: 'result', role: 'tool', contentType: 'tool-result', toolName: 'read_fixture', toolCallId: 'fitting-pair', text: marker + ' result'.repeat(900) }, ...tail()];
    const ctx = fixture(messages);
    const result = await run(ctx, prepared(ctx, 1, 3));
    assert.ok(result.applied);
    assert.ok(result.request);
    const source = result.request.messages[1].content.split('\n').slice(1).join('\n');
    assert.ok(Buffer.byteLength(source) <= 32768);
    assert.ok(source.includes('REASONING-SOURCE') && source.includes(marker) && source.includes('fitting-pair'));
    const block = ctx.session.state.blocks[0];
    assert.deepEqual(new Set(block.effectiveMessageIds), new Set(['reasoning', 'call', 'result']));
    const restored = await executeProxyToolAsync('decompress', { blockId: block.blockId, full: true }, ctx);
    assert.ok(restored.text.includes(marker));
});

test('a changed source revision during generation prevents committing the stale fold', async () => {
    const messages = [msg('old', 'Disposable original context '.repeat(400), 'user'), ...tail()];
    const ctx = fixture(messages);
    const result = await run(ctx, prepared(ctx, 0, 0), 'hidden-maintenance', () => {
        ctx.session.revisionEpoch = (ctx.session.revisionEpoch ?? 0) + 1;
    });
    assert.ok(result.request, 'generation began against the earlier revision');
    assert.equal(result.applied, false);
    assert.equal(ctx.session.state.blocks.length, 0);
});

test('missing advertised endpoint refs cannot fall back to positional indexes', async () => {
    const messages = [msg('old', 'Disposable original context '.repeat(400), 'user'), ...tail()];
    const ctx = fixture(messages);
    const p = prepared(ctx, 0, 0);
    p.nudge!.compressibleRanges[0].startRef = 'm99999';
    const result = await run(ctx, p);
    assert.equal(result.request, undefined);
    assert.equal(result.applied, false);
    assert.equal(ctx.session.state.blocks.length, 0);
});
