// #69: stall watch for the CI test phases. `node --test` holds back the output
// of later files until the file at the head of its order finishes, so one hung
// test file makes the whole phase silent and the log never names it (#61: 40
// and 22 minutes of silence on windows-latest / Node 24, cancelled by hand).
//
// runWatched() spawns a phase and, when it prints nothing on stdout AND stderr
// for `limitMs`, (1) reports the processes still alive under it — a finished
// test file's process is gone, so what remains is usually what is stuck — plus
// node processes whose parent has exited, (2) ends the phase's process tree,
// and (3) resolves with `stalled: true`. Limit: a process orphaned by a test
// file that already exited is outside the tree; it is listed, not killed. The caller fails
// the job; a stall is never retried here (owner decision on #69: the stall
// stays a red job while its cause is unknown).
//
// Lives in its own module because run-ci-tests.mjs has top-level side effects
// and cannot be imported by a test. The limit is a parameter, not a setting:
// no environment variable reads it.
import { execFileSync, spawn } from "node:child_process";

// 10 minutes (owner decision on #69). Longest gap between two output lines in
// 20 passing windows-latest / Node 24 shard jobs on 2026-11-14: 238.5 s.
export const STALL_LIMIT_MS = 10 * 60 * 1000;

const QUERY_TIMEOUT_MS = 30_000;
const TAIL_BYTES = 2048;
const TEST_FILE_RE = /[^\s"']+\.test\.[cm]?[jt]sx?/g;

/** Every process on the machine as { pid, ppid, cmd }. Throws when the query
 *  fails or exceeds its own deadline — the caller must treat that as "no
 *  snapshot", never as "nothing is running". */
export function listProcesses() {
    if (process.platform === "win32") {
        const json = execFileSync(
            "powershell.exe",
            [
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress",
            ],
            { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: QUERY_TIMEOUT_MS, windowsHide: true },
        );
        const rows = JSON.parse(json);
        return (Array.isArray(rows) ? rows : [rows]).map((r) => ({
            pid: Number(r.ProcessId),
            ppid: Number(r.ParentProcessId),
            cmd: String(r.CommandLine ?? ""),
        }));
    }
    const text = execFileSync("ps", ["-eo", "pid=,ppid=,args="], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        timeout: QUERY_TIMEOUT_MS,
    });
    const rows = [];
    for (const line of text.split("\n")) {
        const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
        if (m) rows.push({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] });
    }
    return rows;
}

/** The root and its descendants, parents before children. Pure. */
export function descendantsOf(rootPid, rows) {
    const byParent = new Map();
    for (const r of rows) {
        if (!byParent.has(r.ppid)) byParent.set(r.ppid, []);
        byParent.get(r.ppid).push(r);
    }
    const out = [];
    const seen = new Set();
    const walk = (pid, depth) => {
        for (const r of byParent.get(pid) ?? []) {
            if (seen.has(r.pid) || r.pid === rootPid) continue; // pid reuse can fake a cycle
            seen.add(r.pid);
            out.push({ ...r, depth });
            walk(r.pid, depth + 1);
        }
    };
    const root = rows.find((r) => r.pid === rootPid);
    if (root) out.push({ ...root, depth: 0 });
    walk(rootPid, 1);
    return out;
}

/** Processes whose parent is gone and whose command line runs `execPath`.
 *  A test file that exits while something it started still holds its output
 *  leaves exactly this: the phase stays silent, but the holder is no longer
 *  under the phase's tree (Windows keeps the dead parent's pid on it), so
 *  descendantsOf() cannot see it. Listed as a hint only — nothing proves these
 *  belong to this phase, so they are never killed. Pure. */
export function orphansRunning(execPath, rows) {
    const live = new Set(rows.map((r) => r.pid));
    const needle = execPath.toLowerCase();
    return rows.filter((r) => r.ppid > 0 && !live.has(r.ppid) && r.cmd.toLowerCase().includes(needle));
}

/** Test files named on the command lines of the given processes. Pure. */
export function testFilesIn(procs) {
    const files = new Set();
    for (const p of procs) {
        // A file-level child carries exactly one test file. A command line
        // with several (the phase root's shard list) names nothing.
        const hits = p.cmd.match(TEST_FILE_RE) ?? [];
        if (hits.length === 1) files.add(hits[0].replace(/\\/g, "/"));
    }
    return [...files];
}

/** Ends the root and everything under it. `known` is the pre-kill snapshot
 *  (may be empty when the snapshot failed). Never throws. */
export function killProcessTree(rootPid, known = []) {
    if (process.platform === "win32") {
        try {
            execFileSync("taskkill", ["/PID", String(rootPid), "/T", "/F"], {
                stdio: "ignore",
                timeout: QUERY_TIMEOUT_MS,
                windowsHide: true,
            });
        } catch {
            // Already gone, or taskkill itself failed: the close-grace in
            // runWatched still resolves the phase.
        }
        return;
    }
    // runWatched starts the phase as the leader of its own process group, so
    // the group kill reaches every descendant without needing the snapshot
    // (`ps` can be missing or time out). Snapshot pids follow for anything
    // that moved itself into another group.
    const pids = [-rootPid, ...known.map((p) => p.pid).reverse(), rootPid];
    for (const pid of pids) {
        try {
            process.kill(pid, "SIGKILL");
        } catch {
            // already gone
        }
    }
}

function tailOf(cmd, n = 240) {
    const flat = cmd.replace(/\s+/g, " ").trim();
    return flat.length <= n ? flat : `…${flat.slice(-n)}`;
}

/**
 * Spawn `command args` and watch it for silence.
 *
 * Resolves with { code, signal, stalled, ms, spawnError }. `stalled: true`
 * means the phase was ended by this watch; `code`/`signal` then describe the
 * kill and MUST NOT be interpreted as a test result.
 */
export function runWatched(command, args, opts = {}) {
    const {
        cwd,
        env,
        label = "phase",
        limitMs = STALL_LIMIT_MS,
        closeGraceMs = 15_000,
        onStdout = () => {},
        onStderr = () => {},
        log = (line) => console.error(line),
        list = listProcesses,
        killTree = killProcessTree,
    } = opts;
    const t0 = Date.now();
    return new Promise((resolve) => {
        // POSIX: own process group, so killProcessTree can end the whole tree
        // by group. Windows needs nothing here (taskkill /T walks the tree).
        const posix = process.platform !== "win32";
        const child = spawn(command, args, { cwd, env, detached: posix });
        // A group leader no longer receives the terminal's or the CI agent's
        // signal with us: pass it on, then end the way the signal would have.
        // Best-effort snapshot first: a descendant that started its own group
        // (a nested watch) is outside ours and is only reachable by pid. If the
        // snapshot fails, the group kill still runs.
        const onSignal = (sig) => {
            let known = [];
            try {
                known = descendantsOf(child.pid, list());
            } catch {
                known = [];
            }
            killTree(child.pid, known);
            process.exit(sig === "SIGINT" ? 130 : 143);
        };
        if (posix) {
            process.once("SIGINT", onSignal);
            process.once("SIGTERM", onSignal);
        }
        let stalled = false;
        let settled = false;
        let graceTimer;
        let tail = Buffer.alloc(0);
        const settle = (r) => {
            if (settled) return;
            settled = true;
            clearTimeout(stallTimer);
            clearTimeout(graceTimer);
            process.removeListener("SIGINT", onSignal);
            process.removeListener("SIGTERM", onSignal);
            resolve({ spawnError: undefined, ...r, stalled, ms: Date.now() - t0 });
        };
        const onStall = () => {
            if (settled) return;
            stalled = true;
            log(
                `::error::[ci-tests] STALL: ${label} printed nothing for ${Math.round(limitMs / 1000)}s — ` +
                    `ending the phase and failing the job (#69)`,
            );
            let procs = [];
            try {
                const rows = list();
                procs = descendantsOf(child.pid, rows);
                log(`[ci-tests] STALL: ${procs.length} process(es) still alive under ${label} (pid ${child.pid}), taken before the kill:`);
                for (const p of procs) log(`[ci-tests] STALL:   ${"  ".repeat(p.depth)}pid=${p.pid} ppid=${p.ppid} ${tailOf(p.cmd)}`);
                const files = testFilesIn(procs);
                log(
                    files.length > 0
                        ? `[ci-tests] STALL: test file(s) still running: ${files.join(", ")}`
                        : `[ci-tests] STALL: no test file could be read from the command lines above`,
                );
                const orphans = orphansRunning(process.execPath, rows);
                if (orphans.length > 0) {
                    log(
                        `[ci-tests] STALL: ${orphans.length} node process(es) on this machine have no living parent — possibly left by a ` +
                            `test file that already exited and still holding its output; NOT killed, not proven to be this phase's:`,
                    );
                    for (const p of orphans) log(`[ci-tests] STALL:   pid=${p.pid} ppid=${p.ppid} (gone) ${tailOf(p.cmd)}`);
                }
            } catch (e) {
                procs = [];
                log(`[ci-tests] STALL: process snapshot unavailable (${e && e.message ? e.message.split("\n")[0] : e}) — killing anyway`);
            }
            const tailText = tail.toString("utf8").trimEnd();
            log(`[ci-tests] STALL: last output before the silence:\n${tailText === "" ? "(none)" : tailText}`);
            killTree(child.pid, procs);
            // A descendant that survived the kill keeps the pipes open and
            // 'close' never fires: do not wait for it forever.
            graceTimer = setTimeout(() => {
                log(`[ci-tests] STALL: ${label} did not close within ${Math.round(closeGraceMs / 1000)}s of the kill — abandoning its streams`);
                // Drop every handle on it so the abandoned phase cannot keep this
                // process alive either.
                child.stdin?.destroy();
                child.stdout?.destroy();
                child.stderr?.destroy();
                child.unref();
                settle({ code: null, signal: null });
            }, closeGraceMs);
        };
        const stallTimer = setTimeout(onStall, limitMs);
        const seen = (d) => {
            if (!stalled) stallTimer.refresh();
            tail = Buffer.concat([tail, d]);
            if (tail.length > TAIL_BYTES) tail = tail.subarray(tail.length - TAIL_BYTES);
        };
        child.stdout.on("data", (d) => {
            seen(d);
            onStdout(d);
        });
        child.stderr.on("data", (d) => {
            seen(d);
            onStderr(d);
        });
        child.on("error", (e) => settle({ code: -1, signal: null, spawnError: e }));
        child.on("close", (code, signal) => settle({ code, signal }));
    });
}
