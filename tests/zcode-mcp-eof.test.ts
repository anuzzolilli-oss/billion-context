import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import * as entry from "../src/zcode/mcp-entry.ts";
import { defaultZcodeRoutePolicy } from "../src/zcode/json-edit.ts";

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    return { promise, resolve };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Known issue #46: below Node 24 the unreferenced watchdog interval lets the
// event loop drain while a test waits for the first tick, and the runner then
// cancels that test and every later one in this file. Skipped there until the
// wait is fixed; the tests run unchanged on Node 24 and later.
const NODE_MAJOR = Number(process.versions.node.split(".")[0]);
const skipLoopDrain = NODE_MAJOR < 24 ? "known issue #46: event-loop drain below Node 24" : false;

test("EOF stops future watchdog ticks and waits for the active tick before one handoff", async () => {
    const tick = deferred();
    const entered = deferred();
    const events: string[] = [];
    const state = { origin: "http://127.0.0.1:1234", failures: 0, policy: defaultZcodeRoutePolicy() };
    const stop = entry.startWatchdog(state, true, () => {}, {
        intervalMs: 1,
        probe: async () => { events.push("tick"); entered.resolve(); await tick.promise; return true; },
        repair: async () => { events.push("repair"); },
    });
    const emitter = new EventEmitter();
    const handoff = entry.installExitHandoff(state, () => {}, {
        events: emitter,
        handoff: async () => { events.push("handoff"); },
        exit: () => { assert.fail("EOF must not force exit"); },
    });
    const deadline = setTimeout(() => entered.resolve(), 1000);
    try {
        await entered.promise;
        assert.deepEqual(events, ["tick"]);
        const drained = stop().then(handoff);
        await delay(20);
        assert.deepEqual(events, ["tick"]);
        tick.resolve();
        await drained;
        await handoff();
        emitter.emit("beforeExit");
        await delay(10);
        assert.deepEqual(events, ["tick", "repair", "handoff"]);
    } finally { clearTimeout(deadline); tick.resolve(); await stop(); }
});

for (const recoveryStarted of [false, true]) {
    test(`stop blocks new recovery but joins started recovery (started=${recoveryStarted})`, { timeout: 5000, skip: skipLoopDrain }, async () => {
        const blocked = deferred();
        const entered = deferred();
        let recoveries = 0;
        let repairs = 0;
        let joined = false;
        const state = { origin: "http://127.0.0.1:1234", failures: 2, policy: defaultZcodeRoutePolicy() };
        const stop = entry.startWatchdog(state, false, () => {}, {
            intervalMs: 1,
            probe: async () => {
                if (!recoveryStarted) { entered.resolve(); await blocked.promise; }
                return false;
            },
            ensure: async () => {
                recoveries++;
                if (recoveryStarted) { entered.resolve(); await blocked.promise; }
                return { origin: state.origin };
            },
            repair: async () => { repairs++; },
        });
        try {
            await entered.promise;
            const stopped = stop().then(() => { joined = true; });
            await delay(20);
            assert.equal(joined, false);
            blocked.resolve();
            await stopped;
            assert.equal(recoveries, recoveryStarted ? 1 : 0);
            assert.equal(repairs, recoveryStarted ? 1 : 0);
        } finally { blocked.resolve(); await stop(); }
    });
}

for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
    test(`signal ${signal} during EOF handoff retains exit ${code}`, async () => {
        const work = deferred();
        const emitter = new EventEmitter();
        let calls = 0;
        const exits: number[] = [];
        const handoff = entry.installExitHandoff({ origin: "http://127.0.0.1:1234" }, () => {}, {
            events: emitter,
            handoff: async () => { calls++; await work.promise; },
            exit: (value) => { exits.push(value); },
        });
        const done = handoff();
        emitter.emit(signal);
        assert.deepEqual(exits, []);
        work.resolve();
        await done;
        await delay(0);
        assert.equal(calls, 1);
        assert.deepEqual(exits, [code]);
    });
}

test("signal deadline forces the original code while overlapping handoff runs once", async () => {
    const work = deferred();
    const emitter = new EventEmitter();
    let calls = 0;
    const exits: number[] = [];
    const handoff = entry.installExitHandoff({ origin: "http://127.0.0.1:1234" }, () => {}, {
        events: emitter,
        handoff: async () => { calls++; await work.promise; },
        timeoutMs: 5,
        exit: (code) => { exits.push(code); },
    });
    const done = handoff();
    try {
        emitter.emit("SIGTERM");
        emitter.emit("beforeExit");
        await delay(20);
        assert.deepEqual(exits, [143]);
        assert.equal(calls, 1);
    } finally { work.resolve(); await done; }
});

test("EOF awaits actual handoff beyond the signal deadline and reports handoff failure", async () => {
    const work = deferred();
    const logs: string[] = [];
    let complete = false;
    const handoff = entry.installExitHandoff({ origin: "http://127.0.0.1:1234" }, (msg) => logs.push(msg), {
        events: new EventEmitter(),
        handoff: async () => { await work.promise; throw new Error("handoff failed"); },
        timeoutMs: 5,
        exit: () => { assert.fail("EOF must not force exit"); },
    });
    const done = handoff().then(() => { complete = true; });
    await delay(20);
    assert.equal(complete, false);
    work.resolve();
    await done;
    assert.match(logs.join("\n"), /handoff failed/);
});
