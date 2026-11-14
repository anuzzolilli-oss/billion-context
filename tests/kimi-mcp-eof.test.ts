import assert from "node:assert/strict";
import { test } from "node:test";
import { startWatchdog } from "../src/kimi/native-mcp.ts";

test("Kimi stop blocks recovery from a pending failed probe", { timeout: 5000 }, async () => {
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let recoveries = 0;
    let probes = 0;
    const applied = { origin: "http://127.0.0.1:1234", port: 1234, upstream: "https://example.com", modelId: "test", authSource: "test" };
    const stop = startWatchdog(applied, false, () => {}, {
        intervalMs: 1,
        probe: async () => { if (++probes === 3) { entered(); await blocked; } return false; },
        modelWindows: () => undefined,
        ensure: async () => { recoveries++; return { origin: applied.origin, port: 1234, pid: 1, attached: false, stop: async () => {} }; },
    });
    // The watchdog interval is unreferenced, so this referenced timer is what
    // keeps the event loop alive while the test waits for a watchdog tick.
    // Without it the process can end mid-wait and the runner cancels this
    // test and every later one in the file (seen below Node 24, #46 / #48).
    const hold = setTimeout(() => {}, 5000);
    try {
        await started;
        const stopped = stop();
        release();
        await stopped;
        assert.equal(recoveries, 0);
    } finally { clearTimeout(hold); release(); await stop(); }
});

for (const rejects of [false, true]) {
    test(`Kimi EOF waits for respawn activation and stops future ticks (rejects=${rejects})`, async () => {
        let release!: () => void;
        let entered!: () => void;
        const blocked = new Promise<void>((resolve) => { release = resolve; });
        const started = new Promise<void>((resolve) => { entered = resolve; });
        const applied = { origin: "http://127.0.0.1:1234", port: 1234, upstream: "https://example.com", modelId: "test", authSource: "test" };
        const events: string[] = [];
        const logs: string[] = [];
        const previous = process.env.BILI_MCP_PROXY;
        const stop = startWatchdog(applied, false, (msg) => logs.push(msg), {
            intervalMs: 1,
            probe: async () => { events.push("probe"); return false; },
            modelWindows: () => undefined,
            ensure: async () => { events.push("respawn"); return { origin: "http://127.0.0.1:1235", port: 1235, pid: 1, attached: false, stop: async () => {} }; },
            route: async () => { events.push("route"); return { ...applied, origin: "http://127.0.0.1:1235", port: 1235 }; },
            activate: async () => { events.push("activate"); entered(); await blocked; if (rejects) throw new Error("activation failed"); events.push("activated"); },
        });
        const deadline = setTimeout(() => entered(), 1000);
        try {
            await started;
            assert.ok(events.includes("activate"));
            let stopped = false;
            const drain = stop().then(() => { stopped = true; });
            await new Promise((resolve) => setTimeout(resolve, 15));
            assert.equal(stopped, false);
            release();
            await drain;
            await new Promise((resolve) => setTimeout(resolve, 15));
            assert.deepEqual(events, ["probe", "probe", "probe", "respawn", "route", "activate", ...(rejects ? [] : ["activated"])]);
            if (rejects) assert.ok(logs.some((line) => line.includes("watchdog error: activation failed")));
        } finally {
            clearTimeout(deadline);
            release();
            await stop();
            if (previous === undefined) delete process.env.BILI_MCP_PROXY;
            else process.env.BILI_MCP_PROXY = previous;
        }
    });
}
