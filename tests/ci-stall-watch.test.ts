// #69: the CI runner's stall watch (scripts/ci-stall-watch.mjs). A phase that
// prints nothing for the limit is reported, killed as a tree and flagged
// `stalled`; a phase that keeps printing, or finishes inside the limit, is
// left alone. Fixtures are real child processes: the point of the watch is
// what happens to a process tree, which a stub cannot show.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { descendantsOf, orphansRunning, runWatched, STALL_LIMIT_MS, testFilesIn } from "../scripts/ci-stall-watch.mjs";

// Short stand-in for the 10-minute limit. It also has to cover a fixture's
// start-up (spawn + node boot) on a loaded runner, since nothing is printed
// before that: 3 s leaves that room without making the file slow.
const STALL_AFTER_MS = 3000;

function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
    } catch {
        return false;
    }
    if (process.platform === "linux") {
        // kill(pid, 0) also succeeds for a zombie: a killed process nobody has
        // reaped yet (a container whose PID 1 does not reap). It is not running.
        try {
            const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
            if (stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) === "Z") return false;
        } catch {
            return false;
        }
    }
    return true;
}

/** Teardown kill. Never signals pid 0 or below: on POSIX that addresses a
 *  whole process group, which would take the test runner with it. */
function killQuietly(pid: number): void {
    if (!Number.isInteger(pid) || pid <= 0) return;
    try {
        process.kill(pid, "SIGKILL");
    } catch {
        // already gone — the expected case
    }
}

async function waitDead(pids: number[], ms = 10_000): Promise<number[]> {
    const end = Date.now() + ms;
    for (;;) {
        const left = pids.filter(alive);
        if (left.length === 0 || Date.now() > end) return left;
        await new Promise((r) => setTimeout(r, 100));
    }
}

/** A parent that starts `stuck-fixture.test.mjs` sharing its stdout, prints
 *  both pids, and then both stay silent forever — the #61 shape: a file-level
 *  process that never finishes under a phase root that waits for it. */
function stuckTree(dir: string): string {
    writeFileSync(join(dir, "stuck-fixture.test.mjs"), "setInterval(() => {}, 1000);\n");
    const parent = join(dir, "phase-root.mjs");
    writeFileSync(
        parent,
        [
            'import { spawn } from "node:child_process";',
            'const kid = spawn(process.execPath, ["stuck-fixture.test.mjs"], { stdio: "inherit" });',
            "console.log(`pids ${process.pid} ${kid.pid}`);",
            "setInterval(() => {}, 1000);",
            "",
        ].join("\n"),
    );
    return parent;
}

function pidsFrom(out: string): number[] {
    const m = out.match(/pids (\d+) (\d+)/);
    assert.ok(m, `fixture printed its pids (got: ${JSON.stringify(out)})`);
    return [Number(m[1]), Number(m[2])];
}

test("the limit is the owner-approved 10 minutes (#69)", () => {
    assert.equal(STALL_LIMIT_MS, 600_000);
});

test("a silent phase is reported, killed as a tree and flagged stalled", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "bili-stall-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const logs: string[] = [];
    let out = "";
    const t0 = Date.now();
    const r = await runWatched(process.execPath, [stuckTree(dir)], {
        cwd: dir,
        label: "fixture",
        limitMs: STALL_AFTER_MS,
        onStdout: (d) => (out += d.toString()),
        log: (l) => logs.push(l),
    });
    const [rootPid, kidPid] = pidsFrom(out);
    t.after(() => [kidPid, rootPid].forEach(killQuietly));
    const report = logs.join("\n");

    assert.equal(r.stalled, true, "flagged stalled");
    assert.ok(Date.now() - t0 >= STALL_AFTER_MS, "not before the limit");
    assert.deepEqual(await waitDead([rootPid, kidPid]), [], "the root and the process it started are both gone");
    assert.match(report, /::error::\[ci-tests\] STALL: fixture printed nothing for 3s/, "names the phase and the silence");
    assert.match(report, /test file\(s\) still running: stuck-fixture\.test\.mjs/, "names the stuck test file");
    assert.match(report, new RegExp(`pid=${kidPid} ppid=${rootPid} `), "lists the stuck process under its parent");
    assert.match(report, new RegExp(`last output before the silence:\\npids ${rootPid} ${kidPid}`), "shows the last output");
    assert.doesNotMatch(report, /snapshot unavailable|did not close within/, "took the snapshot and closed normally");
});

for (const stream of ["stdout", "stderr"] as const) {
    test(`a phase that keeps printing on ${stream} past the limit is not stalled`, async () => {
        const logs: string[] = [];
        let seen = 0;
        // Prints every 100 ms for 4.5 s against a 3 s limit: longer than the
        // limit in total, never more than a fraction of it between two lines.
        const script =
            `let n = 0; const i = setInterval(() => { process.${stream}.write("tick\\n"); ` +
            `if (++n === 45) { clearInterval(i); process.exitCode = 7; } }, 100);`;
        const r = await runWatched(process.execPath, ["-e", script], {
            limitMs: STALL_AFTER_MS,
            onStdout: () => seen++,
            onStderr: () => seen++,
            log: (l) => logs.push(l),
        });
        assert.equal(r.stalled, false);
        assert.equal(r.code, 7, "the phase's own exit code comes through");
        assert.ok(r.ms >= STALL_AFTER_MS, `ran past the limit (${r.ms} ms)`);
        assert.ok(seen > 0, "output was forwarded");
        assert.deepEqual(logs, [], "no stall report");
    });
}

test("a phase silent for less than the limit that then exits is not stalled, and the watch is disarmed", async () => {
    const logs: string[] = [];
    const r = await runWatched(process.execPath, ["-e", "setTimeout(() => process.exit(3), 400)"], {
        limitMs: STALL_AFTER_MS,
        log: (l) => logs.push(l),
    });
    assert.equal(r.stalled, false);
    assert.equal(r.code, 3);
    // Outlive the limit: a timer left armed would report now.
    await new Promise((res) => setTimeout(res, STALL_AFTER_MS + 300));
    assert.deepEqual(logs, [], "nothing reported after the phase closed");
});

test("a finished phase leaves nothing that holds the calling process open", async () => {
    // The real limit is 10 minutes: a timer left armed after the phase closed
    // would keep the runner alive that long after its last phase. Run a
    // caller with the real default limit and a phase that ends at once; the
    // caller must end on its own well inside it.
    const mod = pathToFileURL(join(process.cwd(), "scripts", "ci-stall-watch.mjs")).href;
    const caller =
        `const m = await import(${JSON.stringify(mod)}); ` +
        `const r = await m.runWatched(process.execPath, ["-e", ""]); console.log("stalled=" + r.stalled + " code=" + r.code);`;
    let out = "";
    const logs: string[] = [];
    const r = await runWatched(process.execPath, ["--input-type=module", "-e", caller], {
        limitMs: 60_000,
        onStdout: (d) => (out += d.toString()),
        log: (l) => logs.push(l),
    });
    assert.equal(r.stalled, false, `the caller ended on its own (${logs.join(" | ")})`);
    assert.equal(r.code, 0);
    assert.match(out, /stalled=false code=0/);
    assert.ok(r.ms < 30_000, `promptly (${r.ms} ms)`);
});

test("a failed process snapshot is reported and the phase is still killed and flagged", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "bili-stall-"));
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const logs: string[] = [];
    let out = "";
    const r = await runWatched(process.execPath, [stuckTree(dir)], {
        cwd: dir,
        limitMs: STALL_AFTER_MS,
        onStdout: (d) => (out += d.toString()),
        log: (l) => logs.push(l),
        list: () => {
            throw new Error("query refused");
        },
    });
    const pids = pidsFrom(out);
    t.after(() => pids.forEach(killQuietly));
    const report = logs.join("\n");
    assert.equal(r.stalled, true);
    assert.match(report, /process snapshot unavailable \(query refused\) — killing anyway/);
    assert.doesNotMatch(report, /still running:/, "claims nothing about what was running");
    // taskkill /T on Windows and the process-group kill elsewhere: neither
    // needs the snapshot.
    assert.deepEqual(await waitDead(pids), [], "whole tree ended without a snapshot");
});

test("a phase whose streams stay open after the kill is abandoned after the grace, still flagged stalled", async (t) => {
    const logs: string[] = [];
    let pid = 0;
    t.after(() => killQuietly(pid));
    const r = await runWatched(process.execPath, ["-e", "console.log(process.pid); setInterval(() => {}, 1000)"], {
        limitMs: STALL_AFTER_MS,
        closeGraceMs: 500,
        onStdout: (d) => (pid = Number(d.toString())),
        log: (l) => logs.push(l),
        list: () => [],
        killTree: () => {}, // the kill "did not work": nothing closes the pipes
    });
    assert.equal(r.stalled, true);
    assert.equal(r.code, null, "no exit code is invented");
    assert.match(logs.join("\n"), /did not close within 1s of the kill — abandoning its streams/);
    assert.ok(pid > 0 && alive(pid), "the fixture really was still running when the watch gave up");
});

test("descendantsOf walks only the phase's own tree, parents first", () => {
    const rows = [
        { pid: 10, ppid: 1, cmd: "node --test tests/a.test.ts tests/b.test.ts" },
        { pid: 11, ppid: 10, cmd: "node --import tsx tests/a.test.ts" },
        { pid: 12, ppid: 11, cmd: "node dist/index.js start" },
        { pid: 20, ppid: 1, cmd: "node --import tsx tests/unrelated.test.ts" },
        { pid: 10, ppid: 12, cmd: "reused pid" },
    ];
    const tree = descendantsOf(10, rows);
    assert.deepEqual(
        tree.map((p) => [p.pid, p.depth]),
        [
            [10, 0],
            [11, 1],
            [12, 2],
        ],
    );
    assert.deepEqual(testFilesIn(tree), ["tests/a.test.ts"], "the root's file list and other trees name nothing");
    assert.deepEqual(descendantsOf(999, rows), [], "an unknown root has no tree");
});

test("orphansRunning lists node processes whose parent is gone, and only those", () => {
    const rows = [
        { pid: 10, ppid: 1, cmd: '"C:\\Node\\node.exe" --test tests/a.test.ts' },
        { pid: 11, ppid: 10, cmd: '"C:\\Node\\node.exe" tests/a.test.ts' },
        { pid: 30, ppid: 777, cmd: '"c:\\node\\NODE.EXE" dist/index.js start' },
        { pid: 31, ppid: 778, cmd: "C:\\Windows\\explorer.exe" },
        { pid: 1, ppid: 0, cmd: "System" },
    ];
    assert.deepEqual(
        orphansRunning("C:\\Node\\node.exe", rows).map((r) => r.pid),
        [30],
        "living parent, other executables and the system root are left out",
    );
    assert.deepEqual(orphansRunning("C:\\Node\\node.exe", rows.filter((r) => r.pid !== 30)), []);
});

test("testFilesIn normalises Windows separators and skips ambiguous command lines", () => {
    assert.deepEqual(
        testFilesIn([
            { pid: 2, ppid: 1, depth: 1, cmd: '"C:\\node.exe" --import tsx tests\\dsh-native.test.ts' },
            { pid: 3, ppid: 1, depth: 1, cmd: "node tests/x.test.ts tests/y.test.ts" },
            { pid: 4, ppid: 2, depth: 2, cmd: "node dist/index.js" },
        ]),
        ["tests/dsh-native.test.ts"],
    );
});
