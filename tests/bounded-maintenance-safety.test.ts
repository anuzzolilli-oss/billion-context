import assert from 'node:assert/strict';
import test, { afterEach, beforeEach, mock } from 'node:test';
import http from 'node:http';
import { once } from 'node:events';
import { Socket, type AddressInfo } from 'node:net';
import { countMessageTokens, createCore, defaultConfig, assignRefs, emptyRefMap, prune, truncateLargeToolOutputs, defaultCountTokens, type CoreMessage } from 'acp-kernel';
import { createSession } from '../src/session.js';
import { loadOptions, type ProxyOptions } from '../src/config.js';
import { SessionStore, _setStoreForTest } from '../src/persist.js';
import { _boundedMaintenanceIdleForTest, configureBoundedMaintenance, maybeRunBoundedMaintenance } from '../src/server/bounded-maintenance.js';
import { startServer, stripKernelSummaries, type Prepared } from '../src/server.js';
import { executeProxyToolAsync } from '../src/loop/core.js';
import { storeUnpromptedGate } from '../src/unprompted-gate.js';
import { _resetUpstreamThrottleForTest, activeThrottleHolds, noteUpstreamThrottle429, releaseUpstreamThrottleProbe, upstreamThrottleGate, upstreamThrottlePeekReject } from '../src/upstream-throttle.js';

process.env.NODE_ENV = 'test';
_setStoreForTest(new SessionStore({ enabled: false }));
const throttleEnv = new Map<string, string | undefined>();
beforeEach(() => {
    for (const [key, value] of Object.entries({ BILI_THROTTLE_429: '1', BILI_THROTTLE_429_SCOPE: 'credential' })) {
        throttleEnv.set(key, process.env[key]); process.env[key] = value;
    }
    _resetUpstreamThrottleForTest();
});
afterEach(() => {
    _resetUpstreamThrottleForTest();
    for (const [key, value] of throttleEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});
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
async function run(ctx: ReturnType<typeof fixture>, p: Prepared, callId = 'hidden-maintenance', beforeReply?: () => void,
    settings: { credential?: boolean; content?: string; incoming?: http.IncomingMessage; chain?: boolean;
        beforeSend?: (url: string) => void; status?: number; responseBody?: string; transportFailure?: boolean;
        collectWith?: Prepared[] } = {}) {
    let request: MaintenanceRequest | undefined;
    let capturedHeaders: http.IncomingHttpHeaders | undefined;
    const logs: string[] = [];
    const server = http.createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        request = JSON.parse(Buffer.concat(chunks).toString()) as MaintenanceRequest;
        capturedHeaders = req.headers;
        const span = /exactly (m\d+–m\d+)/.exec(request.messages[1].content)?.[1];
        beforeReply?.();
        if (settings.transportFailure) { req.socket.destroy(); return; }
        res.statusCode = settings.status ?? 200;
        res.setHeader('content-type', 'application/json');
        if (settings.status === 429) res.setHeader('retry-after', '120');
        res.end(settings.responseBody ?? JSON.stringify({ choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: callId, type: 'function', function: { name: 'compress', arguments: JSON.stringify({ content: settings.content ?? `${span} Fixture archive\n${summary}` }) } }] } }] }));
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    let target = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    let downstream: http.Server | undefined;
    if (settings.chain) {
        downstream = await startServer({ ...loadOptions(), host: '127.0.0.1', port: 0, log: false, debug: false,
            autoUpdate: false, advisoryCheck: false, releaseNotesCheck: false, mitm: { enabled: false, domains: [] } });
        await once(downstream, 'listening');
        target = `http://127.0.0.1:${(downstream.address() as AddressInfo).port}/bili/${target}`;
    }
    const opts: ProxyOptions = { ...loadOptions(), passthrough: false, autoUpdate: false,
        ...(settings.credential ? { routes: { [target]: { apiKeyEnv: 'BILI_REVIEW_FIXTURE_KEY' } } } : {}) };
    configureBoundedMaintenance(opts, { boundedMaintenance: { timeoutMs: 15000 } });
    const incoming = settings.incoming ?? new http.IncomingMessage(new Socket());
    incoming.url = `/bili/${target}/v1/chat/completions`;
    try {
        settings.beforeSend?.(`${target}/v1/chat/completions`);
        // Generation is off the request path: the launching request must
        // return at once with nothing applied; the finished result is
        // collected by a later incoming request for the same session.
        const call = (current: Prepared, req: http.IncomingMessage) => maybeRunBoundedMaintenance({ prepared: current, req,
            opts, core: ctx.core, config: ctx.config, signal: new AbortController().signal, log: (_level, text) => logs.push(text) });
        const blocksBefore = ctx.session.state.blocks.length;
        const launch = await call(p, incoming);
        assert.equal(launch, false, 'the launching request never applies maintenance');
        assert.equal(ctx.session.state.blocks.length, blocksBefore, 'nothing commits while generation is in flight');
        await _boundedMaintenanceIdleForTest();
        const collects: boolean[] = [];
        if (request !== undefined) {
            for (const current of settings.collectWith ?? [p]) {
                const later = new http.IncomingMessage(new Socket());
                later.url = incoming.url;
                collects.push(await call(current, later));
            }
        }
        return { applied: collects.at(-1) ?? false, collects, request, capturedHeaders, logs, receipt: ctx.session.metadata.boundedMaintenanceLast as { failureKind?: string; outcome?: string; stage?: string } | undefined };
    } finally {
        if (downstream) { downstream.closeAllConnections(); await new Promise<void>(resolve => downstream!.close(() => resolve())); }
        server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    }
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
    assert.equal(result.applied, true, 'the new advertised originals actually create a second block');
    assert.equal(ctx.session.state.blocks.length, 2);
    const liveTokens = visible.reduce((total, message) => total + countMessageTokens(message), 0);
    assert.ok(ctx.session.lastCompress);
    assert.equal(ctx.session.lastCompress.shrinkRatio, Math.min(1, ctx.session.lastCompress.tokensCompressed / liveTokens));
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
    assert.ok(cached?.full.text.includes(messages[1].text!), 'the cached archive preserves the entire original');
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
    assert.deepEqual(archive.filter(m => m.type !== 'text').map(m => m.toolCallId), ['pair-A', 'pair-B', 'pair-B', 'pair-A']);
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

test('a source changed during generation prevents committing the stale fold', async () => {
    const messages = [msg('old', 'Disposable original context '.repeat(400), 'user'), ...tail()];
    const ctx = fixture(messages);
    const result = await run(ctx, prepared(ctx, 0, 0), 'hidden-maintenance', () => {
        ctx.messages[0] = msg('rewritten', 'Rewritten original context '.repeat(400), 'user');
    });
    assert.ok(result.request, 'generation began against the earlier source');
    assert.equal(result.applied, false);
    assert.equal(result.receipt?.failureKind, 'stale');
    assert.equal(ctx.session.state.blocks.length, 0);
});

test('a range the agent folded during generation is not folded a second time', async () => {
    const ctx = fixture([msg('old', 'Disposable original context '.repeat(400), 'user'), ...tail()]);
    const ref = ctx.session.state.messageRefs.byRaw.old;
    let agentFold: Promise<{ outcome?: string }> | undefined;
    const result = await run(ctx, prepared(ctx, 0, 0), 'hidden-maintenance', () => {
        agentFold = executeProxyToolAsync('compress', { content: `${ref}–${ref} Agent archive\n${summary}` }, ctx);
    });
    assert.equal((await agentFold)?.outcome, 'applied', 'setup: the agent folded the same range first');
    assert.equal(result.applied, false);
    assert.equal(result.receipt?.failureKind, 'stale');
    assert.equal(ctx.session.state.blocks.length, 1, 'only the agent fold exists');
});

test('control: a session revision that only advanced between requests does not block the fold', async () => {
    const ctx = fixture([msg('old', 'Disposable original context '.repeat(400), 'user'), ...tail()]);
    const result = await run(ctx, prepared(ctx, 0, 0), 'hidden-maintenance', () => {
        ctx.session.revisionEpoch = (ctx.session.revisionEpoch ?? 0) + 1;
    });
    assert.equal(result.applied, true);
    assert.equal(ctx.session.state.blocks.length, 1);
});

test('requireNudge holds a finished generation until a turn that delivered a nudge', async () => {
    const ctx = fixture([msg('old', 'Disposable archive '.repeat(500), 'user'), ...tail()]);
    storeUnpromptedGate(ctx.session, { armed: true, requireNudge: true, requireRecommendation: false });
    const unprompted = prepared(ctx, 0, 0); unprompted.nudgeOutcome = 'skipped';
    const result = await run(ctx, prepared(ctx, 0, 0), undefined, undefined, { collectWith: [unprompted, prepared(ctx, 0, 0)] });
    assert.deepEqual(result.collects, [false, true], 'the unprompted turn commits nothing; the prompted turn applies the held result');
    assert.equal(ctx.session.state.blocks.length, 1);
});

test('requireRecommendation is judged on the collecting turn: a still-recommended span applies, a withdrawn one does not', async () => {
    const still = fixture([msg('old', 'Disposable archive '.repeat(500), 'user'), ...tail()]);
    storeUnpromptedGate(still.session, { armed: true, requireNudge: false, requireRecommendation: true });
    assert.equal((await run(still, prepared(still, 0, 0))).applied, true);
    assert.equal(still.session.state.blocks.length, 1);
    const withdrawn = fixture([msg('old', 'Disposable archive '.repeat(500), 'user'), ...tail()]);
    storeUnpromptedGate(withdrawn.session, { armed: true, requireNudge: false, requireRecommendation: true });
    const result = await run(withdrawn, prepared(withdrawn, 0, 0), undefined, () => { withdrawn.config.preserveRecentMessages = withdrawn.messages.length; });
    assert.ok(result.request, 'generation ran while the span was still recommended');
    assert.equal(result.applied, false);
    assert.equal(withdrawn.session.state.blocks.length, 0, 'a span no longer offered for folding is not committed');
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

test('unlimited summary length keeps maintenance enabled', async () => {
    const ctx = fixture([msg('old', 'Disposable archive '.repeat(500), 'user'), ...tail()]);
    ctx.config.compress.maxSummaryLength = 0;
    assert.equal((await run(ctx, prepared(ctx, 0, 0))).applied, true);
});

test('complete parsed summary length override survives final coverage preview', async () => {
    const ctx = fixture([msg('old', 'Disposable archive '.repeat(500), 'user'), ...tail()]);
    ctx.config.compress.maxSummaryLength = 100;
    const ref = ctx.session.state.messageRefs.byRaw.old;
    const content = JSON.stringify([{ startId: ref, endId: ref, summary: 's'.repeat(150), summaryMaxChars: 200 }]);
    assert.equal((await run(ctx, prepared(ctx, 0, 0), undefined, undefined, { content })).applied, true);
});

test('maintenance uses route credential overrides and marks processing ownership', async () => {
    const old = process.env.BILI_REVIEW_FIXTURE_KEY;
    process.env.BILI_REVIEW_FIXTURE_KEY = 'disposable-fixture-key';
    try {
        const ctx = fixture([msg('old', 'Disposable archive '.repeat(500), 'user'), ...tail()]);
        const result = await run(ctx, prepared(ctx, 0, 0), undefined, undefined, { credential: true });
        assert.equal(result.capturedHeaders?.authorization, 'Bearer disposable-fixture-key');
        assert.ok(result.capturedHeaders?.['x-bili-hop']);
    } finally { if (old === undefined) delete process.env.BILI_REVIEW_FIXTURE_KEY; else process.env.BILI_REVIEW_FIXTURE_KEY = old; }
});

test('one incoming request cannot retry maintenance even after cooldown expires', async () => {
    const ctx = fixture([msg('old', 'Disposable archive '.repeat(500), 'user'), ...tail()]);
    const incoming = new http.IncomingMessage(new Socket());
    await run(ctx, prepared(ctx, 0, 0), undefined, undefined, { incoming, content: 'invalid range' });
    ctx.session.metadata.boundedMaintenanceRetry = { pending: true, attempts: 1, nextAttemptAt: 0 };
    const retry = await run(ctx, prepared(ctx, 0, 0), undefined, undefined, { incoming });
    assert.equal(retry.request, undefined);
    assert.equal(ctx.session.state.blocks.length, 0);
});

test('a chained listener passes maintenance through without a second processing pass', async () => {
    const ctx = fixture([msg('old', 'Disposable archive '.repeat(500), 'user'), ...tail()]);
    const result = await run(ctx, prepared(ctx, 0, 0), undefined, undefined, { chain: true });
    assert.equal(result.applied, true);
    assert.equal(result.request?.messages.length, 2);
    assert.ok(result.request?.messages[1].content.startsWith('[bili-bounded-maintenance]'));
});

test('reused call IDs do not prevent independent neighboring text from folding', async () => {
    const messages: CoreMessage[] = [msg('seed', 'Disposable introduction', 'user'),
        { id: 'call-a', role: 'assistant', contentType: 'tool-call', toolName: 'read', toolCallId: 'reused', text: '{}' },
        { id: 'result-a', role: 'tool', contentType: 'tool-result', toolName: 'read', toolCallId: 'reused', text: 'first result' },
        msg('neighbor', 'SAFE-INDEPENDENT '.repeat(500), 'user'),
        { id: 'call-b', role: 'assistant', contentType: 'tool-call', toolName: 'read', toolCallId: 'reused', text: '{}' },
        { id: 'result-b', role: 'tool', contentType: 'tool-result', toolName: 'read', toolCallId: 'reused', text: 'z'.repeat(40000) }, ...tail()];
    const ctx = fixture(messages);
    const result = await run(ctx, prepared(ctx, 1, 5));
    assert.ok(result.applied);
    assert.deepEqual(ctx.session.state.blocks[0].effectiveMessageIds, ['neighbor']);
});

test('an undersized byte-heavy fragment cannot displace a viable archive', async () => {
    const messages = [msg('small', '漢'.repeat(4000), 'user'), msg('oversized', 'z'.repeat(40000)),
        msg('viable', 'VIABLE '.repeat(900), 'user'), ...tail()];
    const ctx = fixture(messages);
    const result = await run(ctx, prepared(ctx, 0, 2));
    assert.ok(result.applied);
    assert.deepEqual(ctx.session.state.blocks[0].effectiveMessageIds, ['viable']);
});

test('all assistant companions of reasoning remain complete without swallowing safe neighbors', async () => {
    const messages: CoreMessage[] = [msg('safe', 'SAFE-NEIGHBOR '.repeat(450), 'user'),
        { id: 'reason', role: 'assistant', contentType: 'reasoning', text: 'reason '.repeat(100) },
        msg('prose', 'companion '.repeat(1500)),
        { id: 'call', role: 'assistant', contentType: 'tool-call', toolName: 'read', toolCallId: 'reason-pair', text: '{}' },
        { id: 'result', role: 'tool', contentType: 'tool-result', toolName: 'read', toolCallId: 'reason-pair', text: 'r'.repeat(30000) }, ...tail()];
    const ctx = fixture(messages);
    const result = await run(ctx, prepared(ctx, 0, 4));
    assert.ok(result.applied);
    assert.deepEqual(ctx.session.state.blocks[0].effectiveMessageIds, ['safe']);
});

test('an active account hold prevents maintenance egress without consuming an attempt', async () => {
    const ctx = fixture([msg('old', 'Disposable archive '.repeat(500), 'user'), ...tail()]);
    const retry = { pending: true, attempts: 1, nextAttemptAt: 0 };
    ctx.session.metadata.boundedMaintenanceRetry = retry;
    const result = await run(ctx, prepared(ctx, 0, 0), undefined, undefined, {
        beforeSend: url => noteUpstreamThrottle429(url, {}, '120'),
    });
    assert.equal(result.request, undefined, 'held maintenance must produce zero upstream requests');
    assert.equal(result.applied, false);
    assert.deepEqual(ctx.session.metadata.boundedMaintenanceRetry, retry);
    assert.equal(ctx.session.metadata.boundedMaintenanceAttempt, undefined);
});

test('maintenance admission uses the resolved lane credential hold', async () => {
    const previous = process.env.BILI_REVIEW_FIXTURE_KEY;
    process.env.BILI_REVIEW_FIXTURE_KEY = 'disposable-fixture-key';
    try {
        const ctx = fixture([msg('old', 'Disposable archive '.repeat(500), 'user'), ...tail()]);
        const result = await run(ctx, prepared(ctx, 0, 0), undefined, undefined, { credential: true,
            beforeSend: url => noteUpstreamThrottle429(url, { authorization: 'Bearer disposable-fixture-key' }, '120'),
        });
        assert.equal(result.request, undefined);
    } finally { if (previous === undefined) delete process.env.BILI_REVIEW_FIXTURE_KEY; else process.env.BILI_REVIEW_FIXTURE_KEY = previous; }
});

test('a maintenance 429 records Retry-After and the exact recognized model scope', async () => {
    const ctx = fixture([msg('old', 'Disposable archive '.repeat(500), 'user'), ...tail()]);
    let target = '';
    const result = await run(ctx, prepared(ctx, 0, 0), undefined, undefined, { status: 429,
        responseBody: JSON.stringify({ error: { code: 'keyring_model_temporarily_unavailable', model: 'local-fixture' } }),
        beforeSend: url => { target = url; },
    });
    assert.ok(result.request);
    assert.equal(result.applied, false);
    const blocked = upstreamThrottlePeekReject(target, {}, Date.now(), 'local-fixture');
    assert.ok(blocked, 'maintenance 429 must hold subsequent ordinary sends');
    assert.ok(blocked.retryAfterSec! >= 119);
    assert.equal(upstreamThrottlePeekReject(target, {}, Date.now(), 'other-model'), undefined);
});

test('malformed maintenance 429 conservatively records an account hold', async () => {
    const ctx = fixture([msg('old', 'Disposable archive '.repeat(500), 'user'), ...tail()]);
    let target = '';
    await run(ctx, prepared(ctx, 0, 0), undefined, undefined, { status: 429, responseBody: 'opaque gateway limit', beforeSend: url => { target = url; } });
    assert.ok(upstreamThrottlePeekReject(target, {}, Date.now(), 'other-model'));
});

test('maintenance never takes the probe slot of an expired hold from ordinary traffic', async () => {
    const ctx = fixture([msg('old', 'Disposable archive '.repeat(500), 'user'), ...tail()]);
    const retry = { pending: true, attempts: 1, nextAttemptAt: 0 };
    ctx.session.metadata.boundedMaintenanceRetry = retry;
    let target = '';
    const result = await run(ctx, prepared(ctx, 0, 0), undefined, undefined,
        { beforeSend: url => { target = url; noteUpstreamThrottle429(url, {}, '120', Date.now() - 130000); } });
    assert.equal(result.request, undefined, 'a background call must not own the single probe of an expired hold');
    assert.equal(result.applied, false);
    assert.deepEqual(ctx.session.metadata.boundedMaintenanceRetry, retry, 'the deferral consumes no attempt');
    assert.ok(activeThrottleHolds().length > 0, 'the hold is left for ordinary traffic to resolve');
    const next = upstreamThrottleGate(target, {}, Date.now(), 'local-fixture');
    assert.equal(next.reject, undefined, 'the overlapping ordinary request is still admitted');
    assert.ok(next.probeToken, 'and it is the one that probes');
    releaseUpstreamThrottleProbe(next.probeToken);
});

for (const hold of ['expired', 'active'] as const) {
    test(`a fresh trigger deferred by an ${hold} hold launches on a later unnudged turn without consuming an attempt`, async () => {
        const ctx = fixture([msg('old', 'Disposable archive '.repeat(500), 'user'), ...tail()]);
        const deferred = await run(ctx, prepared(ctx, 0, 0), undefined, undefined,
            { beforeSend: url => noteUpstreamThrottle429(url, {}, '120', hold === 'expired' ? Date.now() - 130000 : Date.now()) });
        assert.equal(deferred.request, undefined, 'the held turn sends nothing');
        const retryState = () => ctx.session.metadata.boundedMaintenanceRetry as { attempts?: number } | undefined;
        assert.equal(retryState(), undefined, 'the deferral consumes no attempt');
        _resetUpstreamThrottleForTest();
        const unnudged = prepared(ctx, 0, 0); unnudged.nudgeOutcome = 'skipped';
        const later = await run(ctx, unnudged);
        assert.ok(later.request, 'the deferred trigger launches once the hold is gone');
        assert.equal(later.applied, true);
        assert.equal(retryState()?.attempts, 1);
        const again = await run(ctx, unnudged);
        assert.equal(again.request, undefined, 'the deferred trigger is spent by its launch');
    });
}

test('control: an unnudged turn with no deferred trigger launches nothing', async () => {
    const ctx = fixture([msg('old', 'Disposable archive '.repeat(500), 'user'), ...tail()]);
    const unnudged = prepared(ctx, 0, 0); unnudged.nudgeOutcome = 'skipped';
    assert.equal((await run(ctx, unnudged)).request, undefined);
    assert.equal(ctx.session.state.blocks.length, 0);
});

for (const scope of ['credential', 'other-model', 'same-model'] as const) {
    test(`maintenance honors ${scope} hold scope without widening it`, async () => {
        const ctx = fixture([msg('old', 'Disposable archive '.repeat(500), 'user'), ...tail()]);
        const result = await run(ctx, prepared(ctx, 0, 0), undefined, undefined, {
            beforeSend: url => noteUpstreamThrottle429(url,
                scope === 'credential' ? { authorization: 'Bearer different-disposable-key' } : {}, '120', Date.now(),
                scope === 'same-model' ? 'local-fixture' : scope === 'other-model' ? 'other-model' : undefined),
        });
        assert.equal(result.applied, scope !== 'same-model');
        assert.equal(result.request !== undefined, scope !== 'same-model');
        assert.equal(activeThrottleHolds().length, 1, 'unrelated or blocked holds remain intact');
    });
}

test('repeated tool results stay with their call without swallowing a safe neighbor', async () => {
    const messages: CoreMessage[] = [msg('safe', 'SAFE-NEIGHBOR '.repeat(450), 'user'),
        { id: 'call', role: 'assistant', contentType: 'tool-call', toolName: 'read', toolCallId: 'echo', text: '{}' },
        { id: 'result', role: 'tool', contentType: 'tool-result', toolName: 'read', toolCallId: 'echo', text: 'first result' },
        { id: 'echo', role: 'tool', contentType: 'tool-result', toolName: 'read', toolCallId: 'echo', text: 'r'.repeat(40000) }, ...tail()];
    const ctx = fixture(messages);
    const result = await run(ctx, prepared(ctx, 0, 3));
    assert.ok(result.applied);
    assert.deepEqual(ctx.session.state.blocks[0].effectiveMessageIds, ['safe']);
});

for (const undersized of [true, false]) {
    test(`selection bounds full-history previews for ${undersized ? 'undersized' : 'ineligible'} fragments`, async () => {
        const messages = Array.from({ length: 40 }, (_, index) => [
            msg(`fragment-${index}`, undersized ? '漢'.repeat(4000) : 'v'.repeat(6000), 'user'),
            msg(`oversized-${index}`, 'o'.repeat(40000)),
        ]).flat();
        const ctx = fixture([...messages, ...tail()]);
        if (!undersized) ctx.config.preserveRecentMessages = ctx.messages.length;
        const apply = ctx.core.applyCompression.bind(ctx.core);
        const spy = mock.method(ctx.core, 'applyCompression', apply);
        try {
            const result = await run(ctx, prepared(ctx, 0, messages.length - 1));
            assert.equal(result.request, undefined);
            assert.ok(spy.mock.callCount() <= (undersized ? 0 : 4), `full-history previews: ${spy.mock.callCount()}`);
        } finally { spy.mock.restore(); }
    });
}

for (const armed of [false, true]) test(`requireNudge defers an unprompted cooldown retry before generation: previous arm=${armed}`, async () => {
    const ctx = fixture([msg('old', 'Disposable archive '.repeat(500), 'user'), ...tail()]);
    storeUnpromptedGate(ctx.session, { armed, requireNudge: true, requireRecommendation: false });
    const retry = { pending: true, attempts: 1, nextAttemptAt: 0 };
    ctx.session.metadata.boundedMaintenanceRetry = retry;
    const p = prepared(ctx, 0, 0); p.nudgeOutcome = 'skipped';
    const result = await run(ctx, p);
    assert.equal(result.request, undefined);
    assert.deepEqual(ctx.session.metadata.boundedMaintenanceRetry, retry);
});
