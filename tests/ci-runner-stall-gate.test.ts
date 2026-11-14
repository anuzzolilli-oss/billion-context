// #69: the stall gate in scripts/run-ci-tests.mjs itself. The runner has
// top-level side effects and cannot be imported, so each case runs a COPY of
// it (and of the modules it imports) as a subprocess against a two-file
// fixture suite. The only edit to the copy is the stall limit, shortened so a
// stall takes seconds; the gate, the classifier and the retry are the real
// code. A stall in ANY phase must fail the job at once — no isolated re-run,
// no retry, no pass — while a clean run and a recoverable failure behave as
// before.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { descendantsOf, killProcessTree, listProcesses } from "../scripts/ci-stall-watch.mjs";

const REPO = process.cwd();
const LIMIT_MS = 4000;

/** What tests/flaky.test.ts does on each successive run of the file. */
type Step = "pass" | "hang" | "die";

function makeSuite(steps: Step[]): string {
    // Under the repo so `--import tsx` resolves from the copy's cwd.
    mkdirSync(join(REPO, ".tmp"), { recursive: true });
    const dir = mkdtempSync(join(REPO, ".tmp", "stall-gate-"));
    mkdirSync(join(dir, "scripts"));
    mkdirSync(join(dir, "tests"));
    for (const f of ["run-ci-tests.mjs", "ci-failure-shapes.mjs", "ci-shard-partition.mjs", "ci-shard-weights.json"]) {
        copyFileSync(join(REPO, "scripts", f), join(dir, "scripts", f));
    }
    const watch = readFileSync(join(REPO, "scripts", "ci-stall-watch.mjs"), "utf8");
    const shortened = watch.replace("export const STALL_LIMIT_MS = 10 * 60 * 1000;", `export const STALL_LIMIT_MS = ${LIMIT_MS};`);
    assert.notEqual(shortened, watch, "the limit constant was found and shortened in the copy");
    writeFileSync(join(dir, "scripts", "ci-stall-watch.mjs"), shortened);
    writeFileSync(join(dir, "scripts", "live-files.mjs"), "export const LIVE_FILES = [];\n");
    for (const f of ["preload-storage-baseline.mjs", "preload-test-env.mjs", "preload-zone-slot.mjs"]) {
        writeFileSync(join(dir, "tests", f), "\n");
    }
    writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ name: "stall-gate-fixture", private: true, type: "module", scripts: { pretest: 'node -e ""' } }),
    );
    writeFileSync(join(dir, "plan.json"), JSON.stringify({ steps, runs: 0 }));
    writeFileSync(join(dir, "tests", "always.test.ts"), 'import { test } from "node:test";\ntest("always passes", () => {});\n');
    writeFileSync(
        join(dir, "tests", "flaky.test.ts"),
        [
            'import { test } from "node:test";',
            'import { readFileSync, writeFileSync } from "node:fs";',
            'const planFile = new URL("../plan.json", import.meta.url);',
            'const plan = JSON.parse(readFileSync(planFile, "utf8"));',
            'const step: string = plan.steps[plan.runs] ?? "pass";',
            "plan.runs += 1;",
            "writeFileSync(planFile, JSON.stringify(plan));",
            "// A silent death before any test reports: the #3029 swallowed shape,",
            "// which the runner re-runs in isolation and then retries.",
            'if (step === "die") process.exit(1);',
            'test("flaky step", async () => {',
            '    if (step === "hang") await new Promise<void>(() => void setInterval(() => {}, 1000));',
            "});",
            "",
        ].join("\n"),
    );
    return dir;
}

interface Finished {
    code: number | null;
    out: string;
}

interface RunOptions {
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    graceMs?: number;
    /** Ends the process tree at the deadline. Injectable so a test can leave
     *  the tree alive and prove the fallback settlement. */
    kill?: (pid: number) => void;
}

function killTree(pid: number): void {
    let known: ReturnType<typeof descendantsOf> = [];
    try {
        known = descendantsOf(pid, listProcesses());
    } catch {
        // no snapshot: the tree kill below still reaches the group / the tree
    }
    killProcessTree(pid, known);
}

/** Runs a command to its end and settles exactly once. Normally that is the
 *  child's 'close'. At the deadline the whole tree is killed; if 'close' still
 *  has not come graceMs later (something the kill did not reach holds the
 *  output pipes), the streams are abandoned and the promise rejects anyway, so
 *  the wait is bounded. Nothing runs after settlement: the caller's teardown
 *  deletes the fixture directory. */
function runToClose(command: string, args: string[], opts: RunOptions): Promise<Finished> {
    const { cwd, env = process.env, timeoutMs = 120_000, graceMs = 15_000, kill = killTree } = opts;
    return new Promise((resolve, reject) => {
        // Its own process group on POSIX, so the deadline kill reaches every
        // descendant, including ones started before the runner's own handlers.
        const child = spawn(command, args, { cwd, env, detached: process.platform !== "win32" });
        let out = "";
        child.stdout.on("data", (d) => (out += d.toString()));
        child.stderr.on("data", (d) => (out += d.toString()));
        let settled = false;
        let timedOut = false;
        let fallback: NodeJS.Timeout | undefined;
        const settle = (fn: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(deadline);
            clearTimeout(fallback);
            for (const [sig, h] of onSignal) process.removeListener(sig, h);
            fn();
        };
        // The child is outside the caller's process group on POSIX, so a
        // cancelled run (Ctrl+C on a targeted run) must take it down itself.
        const onSignal = new Map<NodeJS.Signals, () => void>();
        if (process.platform !== "win32") {
            for (const [sig, exitCode] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
                const h = () => {
                    if (child.pid !== undefined) killTree(child.pid);
                    process.exit(exitCode);
                };
                onSignal.set(sig, h);
                process.once(sig, h);
            }
        }
        const timeoutError = (how: string) => new Error(`command did not finish in ${timeoutMs}ms (${how}). Output so far:\n${out}`);
        const deadline = setTimeout(() => {
            timedOut = true;
            if (child.pid !== undefined) kill(child.pid);
            fallback = setTimeout(() => {
                child.stdin?.destroy();
                child.stdout.destroy();
                child.stderr.destroy();
                child.unref();
                settle(() => reject(timeoutError(`output pipes still open ${graceMs}ms after the kill; abandoned`)));
            }, graceMs);
        }, timeoutMs);
        child.on("error", (e) => settle(() => reject(e)));
        child.on("close", (code) => {
            if (timedOut) return settle(() => reject(timeoutError("killed")));
            settle(() => resolve({ code, out }));
        });
    });
}

async function runRunner(dir: string): Promise<Finished & { runs: number }> {
    const env = { ...process.env };
    // The copy must run its own two files as a plain top-level node --test:
    // not this job's shard slice, and not as a nested child of this test run.
    delete env.CI_TEST_SHARD;
    delete env.NODE_TEST_CONTEXT;
    delete env.GITHUB_EVENT_NAME;
    const r = await runToClose(process.execPath, ["scripts/run-ci-tests.mjs"], { cwd: dir, env });
    return { ...r, runs: JSON.parse(readFileSync(join(dir, "plan.json"), "utf8")).runs };
}

const RETRY = /retrying full phase once/;
const ISOLATED = /DIAGNOSTIC isolated re-run/;
const STALL = /STALL/;

interface Case {
    name: string;
    steps: Step[];
    code: number;
    runs: number;
    has: RegExp[];
    lacks: RegExp[];
}

const CASES: Case[] = [
    {
        name: "a stall in the main phase fails the job with no isolated re-run and no retry",
        steps: ["hang"],
        code: 1,
        runs: 1,
        has: [/::error::\[ci-tests\] STALL: all printed nothing for 4s/, /test file\(s\) still running: tests\/flaky\.test\.ts/, /\[ci-tests\] all STALLED .* failing WITHOUT retry/],
        lacks: [ISOLATED, RETRY, /FLAKE CONFIRMED/, /all ok/],
    },
    {
        name: "a stall in an isolated re-run fails the job with no retry",
        steps: ["die", "hang"],
        code: 1,
        runs: 2,
        has: [/swallowed file-level failure/, ISOLATED, /\[ci-tests\] isolated re-run tests\/flaky\.test\.ts STALLED .* failing WITHOUT retry/],
        lacks: [RETRY, /FLAKE CONFIRMED/, /PASSED in isolation|REPRODUCED in isolation/],
    },
    {
        name: "a stall in the full retry fails the job and is not read as a retry result",
        steps: ["die", "die", "hang"],
        code: 1,
        runs: 3,
        has: [ISOLATED, RETRY, /\[ci-tests\] all \(retry\) STALLED .* failing WITHOUT retry/],
        lacks: [/FLAKE CONFIRMED/, /full retry also FAILED/, /DRAIN-PASS/],
    },
    {
        name: "control: a clean run passes and reports no stall",
        steps: ["pass"],
        code: 0,
        runs: 1,
        has: [/\[ci-tests\] all ok in/],
        lacks: [STALL, ISOLATED, RETRY],
    },
    {
        name: "control: a recoverable failure is still re-run, retried and passed, with no stall",
        steps: ["die", "pass", "pass"],
        code: 0,
        runs: 3,
        has: [/swallowed file-level failure/, /PASSED in isolation/, RETRY, /FLAKE CONFIRMED/],
        lacks: [STALL],
    },
];

for (const c of CASES) {
    test(c.name, async (t) => {
        const dir = makeSuite(c.steps);
        t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
        const r = await runRunner(dir);
        const ctx = `\n--- runner output ---\n${r.out}`;
        assert.equal(r.code, c.code, `exit code${ctx}`);
        assert.equal(r.runs, c.runs, `how many times the flaky file was started${ctx}`);
        for (const re of c.has) assert.match(r.out, re, `expected ${re}${ctx}`);
        for (const re of c.lacks) assert.doesNotMatch(r.out, re, `unexpected ${re}${ctx}`);
    });
}

// The deadline in runToClose, which every case above relies on to stay bounded.
// The fixture is the shape that used to hang it: a parent whose child inherits
// the output pipes and outlives it.

function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
    } catch {
        return false;
    }
    if (process.platform === "linux") {
        // kill(pid, 0) also succeeds for a zombie, which is not running.
        try {
            const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
            if (stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) === "Z") return false;
        } catch {
            return false;
        }
    }
    return true;
}

async function waitDead(pids: number[], ms = 10_000): Promise<number[]> {
    const end = Date.now() + ms;
    for (;;) {
        const left = pids.filter(alive);
        if (left.length === 0 || Date.now() > end) return left;
        await new Promise((r) => setTimeout(r, 100));
    }
}

function pipeHolder(): { dir: string; script: string } {
    mkdirSync(join(REPO, ".tmp"), { recursive: true });
    const dir = mkdtempSync(join(REPO, ".tmp", "stall-gate-pipes-"));
    writeFileSync(join(dir, "holder.mjs"), "setInterval(() => {}, 1000);\n");
    const script = join(dir, "parent.mjs");
    writeFileSync(
        script,
        [
            'import { spawn } from "node:child_process";',
            'const kid = spawn(process.execPath, ["holder.mjs"], { stdio: "inherit" });',
            "console.log(`pids ${process.pid} ${kid.pid}`);",
            "setInterval(() => {}, 1000);",
            "",
        ].join("\n"),
    );
    return { dir, script };
}

function pidsIn(message: string): number[] {
    const m = message.match(/pids (\d+) (\d+)/);
    assert.ok(m, `the fixture printed its pids (got: ${JSON.stringify(message)})`);
    return [Number(m[1]), Number(m[2])];
}

test("the deadline kills the whole tree, including a child holding the output pipes", async (t) => {
    const { dir, script } = pipeHolder();
    t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
    const t0 = Date.now();
    const err = await runToClose(process.execPath, [script], { cwd: dir, timeoutMs: 2000, graceMs: 30_000 }).then(
        () => undefined,
        (e: Error) => e,
    );
    assert.ok(err, "a run past its deadline rejects");
    assert.match(err.message, /did not finish in 2000ms \(killed\)/);
    assert.ok(Date.now() - t0 < 20_000, "settled on the kill, well inside the grace");
    assert.deepEqual(await waitDead(pidsIn(err.message)), [], "parent and pipe-holding child are both gone");
});

test("a pipe holder that survives the kill cannot keep the wait open", async (t) => {
    const { dir, script } = pipeHolder();
    let pids: number[] = [];
    // Known from the kill callback, not from the fixture's output: teardown
    // must reach the tree even if the pids were never printed.
    let root = 0;
    t.after(async () => {
        if (root > 0) killTree(root);
        for (const pid of pids) if (pid > 0) killProcessTree(pid);
        await waitDead(pids);
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    });
    const t0 = Date.now();
    // A kill that reaches nothing: both processes keep the pipes open.
    const err = await runToClose(process.execPath, [script], { cwd: dir, timeoutMs: 2000, graceMs: 1500, kill: (pid) => void (root = pid) }).then(
        () => undefined,
        (e: Error) => e,
    );
    assert.ok(err, "the wait ends even though 'close' never came");
    assert.ok(root > 0, "the deadline handed the root pid to the kill");
    pids = pidsIn(err.message);
    assert.match(err.message, /output pipes still open 1500ms after the kill; abandoned/);
    assert.ok(Date.now() - t0 < 20_000, "bounded by deadline plus grace");
    assert.ok(pids.every(alive), "the fixture really was still running when the wait ended");
});

test("control: a command that finishes in time resolves with its exit code and output", async () => {
    const r = await runToClose(process.execPath, ["-e", "console.log('done'); process.exit(3)"], { cwd: REPO, timeoutMs: 30_000 });
    assert.equal(r.code, 3);
    assert.match(r.out, /done/);
});
