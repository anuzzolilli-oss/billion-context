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

function runRunner(dir: string): Promise<{ code: number | null; out: string; runs: number }> {
    const env = { ...process.env };
    // The copy must run its own two files as a plain top-level `node --test`:
    // not this job's shard slice, and not as a nested child of this test run.
    delete env.CI_TEST_SHARD;
    delete env.NODE_TEST_CONTEXT;
    delete env.GITHUB_EVENT_NAME;
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["scripts/run-ci-tests.mjs"], { cwd: dir, env });
        let out = "";
        child.stdout.on("data", (d) => (out += d.toString()));
        child.stderr.on("data", (d) => (out += d.toString()));
        // Settles once, and only after the child has closed: the caller's
        // teardown deletes the fixture directory, so nothing may read it
        // after this promise settles.
        let timedOut = false;
        let spawnError: Error | undefined;
        const deadline = setTimeout(() => {
            timedOut = true;
            child.kill();
        }, 120_000);
        child.on("error", (e) => {
            spawnError = e;
            // A failed spawn emits no 'close'.
            if (child.pid === undefined) {
                clearTimeout(deadline);
                reject(e);
            }
        });
        child.on("close", (code) => {
            clearTimeout(deadline);
            if (spawnError) return reject(spawnError);
            if (timedOut) return reject(new Error(`runner copy did not finish in 120s. Output so far:\n${out}`));
            try {
                resolve({ code, out, runs: JSON.parse(readFileSync(join(dir, "plan.json"), "utf8")).runs });
            } catch (e) {
                reject(e);
            }
        });
    });
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
