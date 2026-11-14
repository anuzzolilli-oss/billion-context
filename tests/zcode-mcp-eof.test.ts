import assert from "node:assert/strict";
import { test } from "node:test";
import { EventEmitter } from "node:events";
import * as entry from "../src/zcode/mcp-entry.ts";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultZcodeRoutePolicy, detectCurrentZcodeOrigin, zcodeStoreCandidates } from "../src/zcode/json-edit.ts";
import { handoffZcodeRoutingOnExit, routeZcodeConfig } from "../src/zcode/native.ts";
import { rmrf } from "./tmp-rm.ts";

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => { resolve = r; });
    return { promise, resolve };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));


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
    test(`stop blocks new recovery but joins started recovery (started=${recoveryStarted})`, { timeout: 5000 }, async () => {
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
        // The watchdog interval is unreferenced, so this referenced timer is what
        // keeps the event loop alive while the test waits for a watchdog tick.
        // Without it the process can end mid-wait and the runner cancels this
        // test and every later one in the file (seen below Node 24, #46 / #48).
        const hold = setTimeout(() => {}, 5000);
        try {
            await entered.promise;
            const stopped = stop().then(() => { joined = true; });
            await delay(20);
            assert.equal(joined, false);
            blocked.resolve();
            await stopped;
            assert.equal(recoveries, recoveryStarted ? 1 : 0);
            assert.equal(repairs, recoveryStarted ? 1 : 0);
        } finally { clearTimeout(hold); blocked.resolve(); await stop(); }
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

const OLD = "http://127.0.0.1:18787";
const NEW = "http://127.0.0.1:28787";

function routedStore(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "zcode-eof-"));
    mkdirSync(path.join(dir, "v2"), { recursive: true });
    writeFileSync(
        zcodeStoreCandidates(dir, "legacy", {})[0],
        JSON.stringify({ provider: { "builtin:bigmodel-coding-plan": { options: { baseURL: "https://open.bigmodel.cn/api/anthropic" } } } }) + "\n",
    );
    return dir;
}

for (const blockedAt of ["activate", "ensure"] as const) {
    test(`signal during a watchdog replacement hands off the route the replacement wrote (blocked in ${blockedAt})`, { timeout: 5000 }, async () => {
        const dir = routedStore();
        const blocked = deferred();
        const entered = deferred();
        const exited = deferred();
        const emitter = new EventEmitter();
        const exits: number[] = [];
        let routes = 0;
        const state = { origin: OLD, failures: 2, policy: defaultZcodeRoutePolicy() };
        await routeZcodeConfig({ origin: OLD, dataDir: dir, env: {}, log: () => {} });
        const stop = entry.startWatchdog(state, false, () => {}, {
            intervalMs: 1,
            probe: async () => false,
            ensure: async () => {
                if (blockedAt === "ensure") { entered.resolve(); await blocked.promise; }
                return { origin: NEW };
            },
            route: async (opts) => { routes++; return routeZcodeConfig({ ...opts, dataDir: dir, env: {}, log: () => {} }); },
            activate: async () => {
                if (blockedAt === "activate") { entered.resolve(); await blocked.promise; }
            },
            repair: async () => {},
        });
        entry.installExitHandoff(state, () => {}, {
            events: emitter,
            handoff: (ownOrigin) => handoffZcodeRoutingOnExit({ ownOrigin, dataDir: dir, env: {}, log: () => {}, findReplacement: async () => undefined }),
            exit: (code) => { exits.push(code); exited.resolve(); },
        });
        const hold = setTimeout(() => {}, 5000);
        try {
            await entered.promise;
            assert.equal(detectCurrentZcodeOrigin(dir, {}), blockedAt === "activate" ? NEW : OLD);
            emitter.emit("SIGTERM");
            await exited.promise;
            assert.deepEqual(exits, [143]);
            assert.equal(detectCurrentZcodeOrigin(dir, {}), undefined);
            blocked.resolve();
            await stop();
            assert.equal(detectCurrentZcodeOrigin(dir, {}), undefined);
            assert.equal(routes, blockedAt === "activate" ? 1 : 0);
        } finally { clearTimeout(hold); blocked.resolve(); await stop(); rmrf(dir); }
    });
}

for (const signalled of [true, false]) {
    test(`watchdog replacement waiting on the config lock writes its route only if shutdown has not begun (signalled=${signalled})`, { timeout: 8000 }, async () => {
        const dir = routedStore();
        const lockDir = path.join(dir, "v2", ".bili-config.lock");
        const entered = deferred();
        const exited = deferred();
        const emitter = new EventEmitter();
        const exits: number[] = [];
        const logs: string[] = [];
        let storeAtExit: string | undefined = "unset";
        const state = { origin: OLD, failures: 2, policy: defaultZcodeRoutePolicy() };
        await routeZcodeConfig({ origin: OLD, dataDir: dir, env: {}, log: () => {} });
        // Another live process holds the config lock, so the replacement's
        // write waits inside routeZcodeConfig.
        const holdLock = () => { mkdirSync(lockDir); writeFileSync(path.join(lockDir, "pid"), String(process.pid)); };
        const releaseLock = () => rmSync(lockDir, { recursive: true, force: true });
        holdLock();
        const stop = entry.startWatchdog(state, false, (msg) => logs.push(msg), {
            intervalMs: 1,
            probe: async () => false,
            ensure: async () => ({ origin: NEW }),
            route: (opts) => { entered.resolve(); return routeZcodeConfig({ ...opts, dataDir: dir, env: {}, log: () => {} }); },
            activate: async () => {},
            repair: async () => {},
        });
        entry.installExitHandoff(state, () => {}, {
            events: emitter,
            handoff: async (ownOrigin) => {
                const outcome = await handoffZcodeRoutingOnExit({ ownOrigin, dataDir: dir, env: {}, log: () => {}, findReplacement: async () => undefined });
                // The lock frees after the handoff finished but before the
                // process exits; the waiting replacement gets its turn.
                releaseLock();
                await delay(300);
                return outcome;
            },
            exit: (code) => { exits.push(code); storeAtExit = detectCurrentZcodeOrigin(dir, {}); exited.resolve(); },
        });
        const hold = setTimeout(() => {}, 8000);
        try {
            await entered.promise;
            assert.equal(detectCurrentZcodeOrigin(dir, {}), OLD);
            if (signalled) {
                emitter.emit("SIGTERM");
                await exited.promise;
                assert.deepEqual(exits, [143]);
                assert.equal(storeAtExit, undefined, "no route may be written after the exit handoff reverted the store");
                await stop();
                assert.equal(detectCurrentZcodeOrigin(dir, {}), undefined);
                assert.equal(state.origin, OLD);
                assert.doesNotMatch(logs.join("\n"), /watchdog error/);
            } else {
                releaseLock();
                for (let i = 0; i < 50 && state.origin !== NEW; i++) await delay(20);
                assert.equal(state.origin, NEW);
                assert.equal(detectCurrentZcodeOrigin(dir, {}), NEW);
                await stop();
            }
        } finally { clearTimeout(hold); releaseLock(); await stop(); rmrf(dir); }
    });
}

for (const allow of [true, false]) {
    test(`routeZcodeConfig asks shouldWrite under the config lock and writes only on true (allow=${allow})`, async () => {
        const dir = routedStore();
        const file = zcodeStoreCandidates(dir, "legacy", {})[0];
        const lockDir = path.join(dir, "v2", ".bili-config.lock");
        const logs: string[] = [];
        const lockHeld: boolean[] = [];
        try {
            const before = readFileSync(file, "utf8");
            const routed = await routeZcodeConfig({
                origin: NEW, dataDir: dir, env: {}, log: (msg) => logs.push(msg),
                shouldWrite: () => { lockHeld.push(existsSync(lockDir)); return allow; },
            });
            assert.deepEqual(lockHeld, [true]);
            assert.equal(existsSync(lockDir), false);
            if (allow) {
                assert.equal(routed?.origin, NEW);
                assert.equal(detectCurrentZcodeOrigin(dir, {}), NEW);
                assert.doesNotMatch(logs.join("\n"), /declined/);
            } else {
                assert.equal(routed, undefined);
                assert.equal(readFileSync(file, "utf8"), before);
                assert.match(logs.join("\n"), /route write declined/);
            }
        } finally { rmrf(dir); }
    });
}

for (const attachable of [true, false]) {
    test(`EOF during a watchdog respawn leaves routing to the exit handoff (respawned proxy attachable=${attachable})`, { timeout: 5000 }, async () => {
        const dir = routedStore();
        const blocked = deferred();
        const entered = deferred();
        let routes = 0;
        const state = { origin: OLD, failures: 2, policy: defaultZcodeRoutePolicy() };
        await routeZcodeConfig({ origin: OLD, dataDir: dir, env: {}, log: () => {} });
        const stop = entry.startWatchdog(state, false, () => {}, {
            intervalMs: 1,
            probe: async () => false,
            ensure: async () => { entered.resolve(); await blocked.promise; return { origin: NEW }; },
            route: async (opts) => { routes++; return routeZcodeConfig({ ...opts, dataDir: dir, env: {}, log: () => {} }); },
            activate: async () => {},
            repair: async () => {},
        });
        const handoff = entry.installExitHandoff(state, () => {}, {
            events: new EventEmitter(),
            handoff: (ownOrigin) => handoffZcodeRoutingOnExit({
                ownOrigin, dataDir: dir, env: {}, log: () => {},
                findReplacement: async () => (attachable ? { origin: NEW } : undefined),
            }),
            exit: () => { assert.fail("EOF must not force exit"); },
        });
        const hold = setTimeout(() => {}, 5000);
        try {
            await entered.promise;
            const drained = stop().then(handoff);
            blocked.resolve();
            await drained;
            // The tick never routes to the proxy it spawned during shutdown;
            // the handoff routes to it only when discovery reports it live.
            assert.equal(routes, 0);
            assert.equal(state.origin, OLD);
            assert.equal(detectCurrentZcodeOrigin(dir, {}), attachable ? NEW : undefined);
        } finally { clearTimeout(hold); blocked.resolve(); await stop(); rmrf(dir); }
    });
}

for (const first of ["reverted-direct", "not-ours"] as const) {
    test(`exit handoff tries the in-flight routing origin only when the adopted origin is not the owner (first=${first})`, async () => {
        const asked: string[] = [];
        const handoff = entry.installExitHandoff({ origin: OLD, routing: NEW }, () => {}, {
            events: new EventEmitter(),
            handoff: async (ownOrigin) => { asked.push(ownOrigin); return ownOrigin === OLD ? first : "reverted-direct"; },
            exit: () => { assert.fail("EOF must not force exit"); },
        });
        await handoff();
        assert.deepEqual(asked, first === "not-ours" ? [OLD, NEW] : [OLD]);
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
