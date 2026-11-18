// Tests for scripts/live-deploy/ (issue #80): the live-proxy deploy and rollback scripts, driven against
// throw-away sandboxes. A sandbox is a temporary runtime root with a stand-in launcher, a stand-in proxy
// and a test driver in place of the Windows scheduled task (tests/fixtures/live-deploy/).
//
// Nothing here may reach a real installation: every sandbox lives under the temp folder with a random
// name, uses a port handed out by the OS, and is torn down by PIDs its own processes reported.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const WIN = process.platform === "win32";
const SKIP = WIN ? false : "live-proxy deploy scripts are Windows-only (PowerShell, scheduled task, CIM)";
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS = path.join(REPO, "scripts", "live-deploy");
const FIXTURES = path.join(REPO, "tests", "fixtures", "live-deploy");
const DEPLOY = path.join(SCRIPTS, "Deploy-LiveProxy.ps1");
const ROLLBACK = path.join(SCRIPTS, "Rollback-LiveProxy.ps1");
const COMMON = path.join(SCRIPTS, "LiveProxy.Common.ps1");
const DRIVER = path.join(FIXTURES, "TestTaskDriver.ps1");
const WINPS = path.join(process.env.WINDIR ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const LAUNCHER = "Start-BillionContextProxy.ps1";
const FORBIDDEN_PORT = 8787;

const PREV = { name: "prev-1", version: "0.9.1", commit: "aaaaaaa1-live", source: "a".repeat(40) };
const CAND = { version: "0.9.2", commit: "bbbbbbb2-live", source: "b".repeat(40) };

// ---- harness ----------------------------------------------------------------------------------------

const sha256 = (buf: Buffer | string) => crypto.createHash("sha256").update(buf).digest("hex").toUpperCase();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tempBase = () => fs.realpathSync.native(os.tmpdir());

/** Refuses anything that is not a throw-away sandbox. Exported shape is tested below. */
function assertSandbox(root: string, port: number): void {
    const base = tempBase().toLowerCase();
    const r = path.resolve(root).toLowerCase();
    if (path.dirname(r) !== base || !/^bili-live-deploy-[0-9a-f]{10}[a-z0-9]*$/.test(path.basename(r))) {
        throw new Error("sandbox root must be <temp>\\bili-live-deploy-<random>");
    }
    const roaming = (process.env.APPDATA ?? "").toLowerCase();
    if (roaming && (r === roaming || r.startsWith(roaming + path.sep))) throw new Error("sandbox root must not be under the roaming application-data folder");
    if (port === FORBIDDEN_PORT) throw new Error("the live port must never be used by a sandbox");
}

function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.once("error", reject);
        s.listen(0, "127.0.0.1", () => {
            const port = (s.address() as net.AddressInfo).port;
            s.close(() => resolve(port));
        });
    });
}

interface Candidate {
    dir: string;
    version: string;
    commit: string;
    source: string;
    sha: string;
}
interface Sandbox {
    root: string;
    port: number;
    taskName: string;
    configSha: string;
    canary: string;
    cand: Candidate;
    extraDirs: string[];
}

function writeReleaseFiles(dir: string, version: string, commit: string, source: string, tag: string): string {
    fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
    const bundle = fs.readFileSync(path.join(FIXTURES, "stand-in-proxy.mjs"), "utf8").replace(/\r\n/g, "\n") + `// ${tag}\n`;
    fs.writeFileSync(path.join(dir, "dist", "index.mjs"), bundle);
    fs.writeFileSync(path.join(dir, "dist", "build-info.json"), JSON.stringify({ commit, sourceCommit: source }));
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "stand-in", version, type: "module" }));
    fs.writeFileSync(path.join(dir, "LICENSE"), "test fixture\n");
    return sha256(bundle);
}

function launcherText(sb: { root: string; port: number }, proxyPath: string, version: string, commit: string): string {
    const values: Record<string, string> = { __NODE__: process.execPath, __PROXY__: proxyPath, __VERSION__: version, __COMMIT__: commit };
    const portLine = `[int]$Port = ${sb.port},`;
    const text = fs
        .readFileSync(path.join(FIXTURES, LAUNCHER), "utf8")
        .replace(/\r\n/g, "\n")
        .replace(/__(NODE|PROXY|VERSION|COMMIT)__/g, (m) => values[m])
        .replace("[int]$Port = 0,", () => portLine);
    assert.equal(text.includes(portLine), true, "the launcher template must carry the port line");
    return text;
}

function candidateDir(root: string): string {
    return `${root}-cand`;
}

async function makeSandbox(suffix = "", cand = CAND, stem = crypto.randomBytes(5).toString("hex")): Promise<Sandbox> {
    const port = await freePort();
    const root = path.join(tempBase(), `bili-live-deploy-${stem}${suffix}`);
    assertSandbox(root, port);
    const canary = `CANARY-${crypto.randomBytes(6).toString("hex")}`;
    fs.mkdirSync(path.join(root, "config", "billion-context"), { recursive: true });
    fs.mkdirSync(path.join(root, "releases"));
    fs.mkdirSync(path.join(root, "backups"));
    fs.mkdirSync(path.join(root, "shared-node-modules"));
    fs.writeFileSync(path.join(root, "sandbox.marker"), "test sandbox\n");
    const config = JSON.stringify({ note: canary });
    fs.writeFileSync(path.join(root, "config", "billion-context", "billion-context.json"), config);
    const prevDir = path.join(root, "releases", PREV.name);
    const prevSha = writeReleaseFiles(prevDir, PREV.version, PREV.commit, PREV.source, "previous");
    fs.symlinkSync(path.join(root, "shared-node-modules"), path.join(prevDir, "node_modules"), "junction");
    const sb: Sandbox = {
        root,
        port,
        taskName: `Sandbox task ${path.basename(root)}`,
        configSha: sha256(config),
        canary,
        cand: { dir: candidateDir(root), ...cand, sha: "" },
        extraDirs: [],
    };
    fs.writeFileSync(path.join(root, LAUNCHER), launcherText(sb, path.join(prevDir, "dist", "index.mjs"), PREV.version, PREV.commit), "ascii");
    fs.writeFileSync(
        path.join(root, "tuned-deployment.json"),
        JSON.stringify({ deployedAt: "2026-01-01T00:00:00.0000000-05:00", releaseRoot: prevDir, bundleSha256: prevSha, build: PREV.commit, sourceCommit: PREV.source, deployedConfigSha256: "stale-on-purpose", livePid: 0 }, null, 2),
    );
    fs.writeFileSync(path.join(root, "supervision-receipt.json"), JSON.stringify({ task: "sandbox", proxyRelease: "stale-on-purpose" }, null, 2));
    setTask(sb, { taskName: sb.taskName, enabled: true, port, calls: { info: 0, disable: 0, enable: 0, start: 0 }, failOn: [], onCall: [] });
    sb.cand.sha = writeReleaseFiles(sb.cand.dir, cand.version, cand.commit, cand.source, "candidate");
    try {
        startSupervisor(sb);
        await waitSupervised(sb, PREV.version, PREV.commit);
    } catch (e) {
        await teardown(sb);
        throw e;
    }
    return sb;
}

const taskPath = (sb: Sandbox) => path.join(sb.root, "sandbox-task.json");
const getTask = (sb: Sandbox) => JSON.parse(fs.readFileSync(taskPath(sb), "utf8"));
const setTask = (sb: Sandbox, state: unknown) => fs.writeFileSync(taskPath(sb), JSON.stringify(state));
function patchTask(sb: Sandbox, patch: Record<string, unknown>): void {
    setTask(sb, { ...getTask(sb), ...patch });
}

function startSupervisor(sb: Sandbox): void {
    const child = spawn(WINPS, [`-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${path.join(sb.root, LAUNCHER)}"`], {
        // Not detached: Windows PowerShell exits at once without a console.
        stdio: "ignore",
        windowsHide: true,
        windowsVerbatimArguments: true,
    });
    child.unref();
}

function health(port: number): Promise<{ ok: boolean; version: string; commit: string; pid: number } | null> {
    return new Promise((resolve) => {
        const req = http.get({ host: "127.0.0.1", port, path: "/__bili/health", agent: false, timeout: 2000 }, (res) => {
            let body = "";
            res.on("data", (c) => (body += c));
            res.on("end", () => {
                try {
                    resolve(JSON.parse(body));
                } catch {
                    resolve(null);
                }
            });
        });
        req.on("timeout", () => req.destroy());
        req.on("error", () => resolve(null));
    });
}

function status(sb: Sandbox): Record<string, unknown> | null {
    try {
        return JSON.parse(fs.readFileSync(path.join(sb.root, "supervisor-status.json"), "utf8"));
    } catch {
        return null;
    }
}

async function waitFor(what: string, cond: () => Promise<boolean> | boolean, ms = 30000): Promise<void> {
    const end = Date.now() + ms;
    for (;;) {
        if (await cond()) return;
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await sleep(150);
    }
}

/** Waits until the given release answers health and the sandbox supervisor monitors it. */
async function waitSupervised(sb: Sandbox, version: string, commit: string): Promise<number> {
    let pid = 0;
    await waitFor(`${commit} under supervision`, async () => {
        const h = await health(sb.port);
        const st = status(sb);
        if (!h || !h.ok || h.version !== version || h.commit !== commit || !st) return false;
        pid = h.pid;
        return (st.state === "adopted" || st.state === "spawned") && st.childPid === h.pid && st.healthMatch === true;
    });
    return pid;
}

const alive = (pid: number) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
};

/** Stops the processes the sandbox itself reported, after checking each still belongs to this sandbox. */
function stopSandboxProcesses(sb: Sandbox): void {
    let pids: number[] = [];
    try {
        pids = [...new Set(fs.readFileSync(path.join(sb.root, "sandbox-pids.log"), "utf8").split(/\r?\n/).map(Number).filter((n) => n > 0))];
    } catch {
        return;
    }
    if (pids.length === 0) return;
    const script =
        "$ids = $env:LP_TD_PIDS -split ','; $token = $env:LP_TD_ROOT; " +
        "Get-CimInstance Win32_Process | Where-Object { $ids -contains [string]$_.ProcessId -and $null -ne $_.CommandLine -and " +
        "($_.CommandLine.IndexOf($token + '\\', [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -or $_.CommandLine.IndexOf($token + '\"', [System.StringComparison]::OrdinalIgnoreCase) -ge 0) } | " +
        "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
    spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", script], { env: { ...process.env, LP_TD_PIDS: pids.join(","), LP_TD_ROOT: sb.root }, encoding: "utf8", timeout: 60000 });
}

function clearReadOnly(dir: string): void {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isFile()) fs.chmodSync(path.join(dir, e.name), 0o666);
    }
}

async function teardown(sb: Sandbox): Promise<void> {
    stopSandboxProcesses(sb);
    await sleep(300);
    stopSandboxProcesses(sb); // a supervisor may have started one more child while it was being stopped
    for (const dir of [...sb.extraDirs, sb.cand.dir, sb.root]) {
        const st = fs.lstatSync(dir, { throwIfNoEntry: false });
        if (!st) continue;
        if (st.isSymbolicLink()) {
            fs.rmSync(dir, { force: true, maxRetries: 20, retryDelay: 200 });
            continue;
        }
        try {
            clearReadOnly(dir);
        } catch {
            // best effort
        }
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
    }
}

async function withSandbox(fn: (sb: Sandbox) => Promise<void>, suffix = "", cand = CAND, stem?: string): Promise<void> {
    const sb = await makeSandbox(suffix, cand, stem);
    try {
        await fn(sb);
    } finally {
        await teardown(sb);
    }
}

interface Run {
    code: number | null;
    out: string;
}
function runScript(script: string, args: Record<string, string | number | true | null>): Promise<Run> {
    const argv: string[] = [];
    for (const [k, v] of Object.entries(args)) {
        if (v === null) continue;
        argv.push(`-${k}`);
        if (v !== true) argv.push(String(v));
    }
    // Asynchronous, so that scenarios in separate sandboxes can run side by side.
    return new Promise((resolve, reject) => {
        const child = spawn("pwsh", ["-NoProfile", "-NonInteractive", "-File", script, ...argv], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
        child.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
        const timer = setTimeout(() => child.kill(), 240000);
        child.once("error", (e) => {
            clearTimeout(timer);
            reject(e);
        });
        child.once("close", (code) => {
            clearTimeout(timer);
            resolve({ code, out: `${stdout}\n${stderr}` });
        });
    });
}

function deploy(sb: Sandbox, overrides: Record<string, string | number | true | null> = {}): Promise<Run> {
    return runScript(DEPLOY, {
        RuntimeRoot: sb.root,
        Port: sb.port,
        TaskName: sb.taskName,
        CandidateRoot: sb.cand.dir,
        ReleaseName: "cand-1",
        CandidateVersion: sb.cand.version,
        CandidateCommit: sb.cand.commit,
        CandidateSourceCommit: sb.cand.source,
        CandidateBundleSha256: sb.cand.sha,
        ExpectedConfigSha256: sb.configSha,
        HealthWaitSeconds: 30,
        StopWaitSeconds: 30,
        TestTaskDriver: DRIVER,
        ...overrides,
    });
}

function rollback(sb: Sandbox, backup: string, overrides: Record<string, string | number | true | null> = {}): Promise<Run> {
    return runScript(ROLLBACK, { RuntimeRoot: sb.root, BackupRoot: backup, HealthWaitSeconds: 30, StopWaitSeconds: 30, TestTaskDriver: DRIVER, ...overrides });
}

function expectResult(r: Run, code: number, name: string, reason?: string): void {
    assert.equal(r.code, code, `expected exit ${code}\n${r.out}`);
    assert.match(r.out, new RegExp(` RESULT ${name} \\(exit ${code}\\)${reason ? ` reason=${reason}` : ""}`), r.out);
    assert.match(r.out, /TEST SEAM ACTIVE/, "a sandbox run must announce the test seam");
}

const backups = (sb: Sandbox) => fs.readdirSync(path.join(sb.root, "backups")).map((n) => path.join(sb.root, "backups", n));
const onlyBackup = (sb: Sandbox) => {
    const b = backups(sb);
    assert.equal(b.length, 1, "expected exactly one backup folder");
    return b[0];
};
const record = (backup: string) => JSON.parse(fs.readFileSync(path.join(backup, "deploy-record.json"), "utf8"));
const inhibit = (sb: Sandbox) => {
    try {
        return fs.readFileSync(path.join(sb.root, "maintenance.inhibit"), "utf8").trim();
    } catch {
        return null;
    }
};
const launcher = (sb: Sandbox) => fs.readFileSync(path.join(sb.root, LAUNCHER), "utf8");
const releaseDir = (sb: Sandbox, name = "cand-1") => path.join(sb.root, "releases", name);
const supervisorPid = (sb: Sandbox) => Number(status(sb)?.supervisorPid ?? 0);

function assertUntouched(sb: Sandbox, launcherBefore: string, ids: { sup?: number; proxy?: number } = {}): void {
    const calls = getTask(sb).calls;
    assert.deepEqual({ disable: calls.disable, enable: calls.enable, start: calls.start }, { disable: 0, enable: 0, start: 0 }, "the task must not be disabled, enabled or started");
    if (ids.sup) assert.equal(alive(ids.sup) && supervisorPid(sb) === ids.sup, true, "the same supervisor must still be running");
    if (ids.proxy) assert.equal(alive(ids.proxy), true, "the same proxy process must still be running");
    assert.equal(fs.existsSync(path.join(sb.root, "live-deploy.lock")), false, "no operation lock may be left behind");
    assert.equal(inhibit(sb), null, "no inhibit may be left behind");
    assert.equal(fs.existsSync(releaseDir(sb)), false, "no release directory may be created");
    assert.equal(backups(sb).length, 0, "no backup folder may be created");
    assert.equal(launcher(sb), launcherBefore, "the launcher must be unchanged");
    assert.equal(getTask(sb).enabled, true, "the task must stay enabled");
}

/** Hold in place: inhibit owned by this deployment, task disabled, no supervisor process. */
function assertHold(sb: Sandbox, backup: string, supervisorBefore: number): void {
    assert.match(inhibit(sb) ?? "", new RegExp(`^(deploy|rollback) ${path.basename(backup)}$`));
    assert.equal(getTask(sb).enabled, false, "the task must be disabled");
    assert.equal(alive(supervisorBefore), false, "the supervisor must be stopped");
}

// ---- static checks ----------------------------------------------------------------------------------

describe("live-deploy scripts: static rules", () => {
    const sources = [DEPLOY, ROLLBACK, COMMON].map((f) => ({ file: path.basename(f), text: fs.readFileSync(f, "utf8") }));

    test("no release identity, port, task name or personal path is written into the scripts", () => {
        const banned: [string, RegExp][] = [
            ["40-hex string", /\b[0-9a-fA-F]{40}\b/],
            ["version literal", /(?<![\d.])\d+\.\d+\.\d+(?![\d.])/],
            ["live port", /8787/],
            ["user-profile path", /Users\\/i],
            ["live task name", /Cindy - billion-context proxy/i],
            ["release directory literal", /releases[\\/][A-Za-z0-9]/],
        ];
        for (const { file, text } of sources) {
            for (const [label, re] of banned) assert.equal(re.test(text), false, `${file} contains a ${label}`);
        }
        const all = sources.map((s) => s.text).join("\n");
        assert.equal((all.match(/CindyGlobal/g) ?? []).length, 1, "the live installation folder may be named once, in the seam guard");
        // Negative control: the scan does find these shapes when they are present.
        assert.equal(banned[1][1].test("version -eq '0.1.213'"), true);
        assert.equal(banned[1][1].test("http://127.0.0.1:1/x"), false);
    });

    test("the scripts take exactly the documented parameters and no test hook", () => {
        const params = (text: string) => {
            const block = text.slice(text.indexOf("param("), text.indexOf("\n)", text.indexOf("param(")));
            return [...block.matchAll(/\$([A-Za-z0-9]+)(?=\s*(?:=|,|$))/gm)].map((m) => m[1]).sort();
        };
        const deployParams = "CandidateBundleSha256 CandidateCommit CandidateRoot CandidateSourceCommit CandidateVersion ExpectedConfigSha256 HealthWaitSeconds Port PreflightOnly ReleaseName RuntimeRoot StopWaitSeconds TaskName TestTaskDriver ToolingDir";
        assert.deepEqual(params(sources[0].text), deployParams.split(" "));
        assert.deepEqual(params(sources[1].text), "BackupRoot HealthWaitSeconds PreflightOnly RuntimeRoot StopWaitSeconds TestTaskDriver".split(" "));
        for (const { file, text } of sources) {
            const env = [...text.matchAll(/\$env:([A-Za-z_]+)/g)].map((m) => m[1].toUpperCase());
            assert.deepEqual([...new Set(env)].filter((n) => n !== "WINDIR"), [], `${file} reads an environment variable for behaviour`);
        }
    });

    test("committed files of this feature contain no user-profile path", () => {
        const files = [DEPLOY, ROLLBACK, COMMON, ...fs.readdirSync(FIXTURES).map((f) => path.join(FIXTURES, f)), fileURLToPath(import.meta.url)];
        const profile = new RegExp(["[A-Za-z]:", "Users", "[^<\\\\]"].join("\\\\"));
        for (const f of files) assert.equal(profile.test(fs.readFileSync(f, "utf8")), false, `${path.basename(f)} contains a user-profile path`);
        assert.equal(profile.test(["C:", "Users", "someone", "x"].join("\\")), true, "negative control");
    });

    test("the harness refuses anything that is not a throw-away sandbox", () => {
        const good = path.join(tempBase(), "bili-live-deploy-0123456789");
        assert.doesNotThrow(() => assertSandbox(good, 40000));
        assert.throws(() => assertSandbox(good, FORBIDDEN_PORT), /live port/);
        assert.throws(() => assertSandbox(path.join(tempBase(), "something-else"), 40000), /bili-live-deploy/);
        assert.throws(() => assertSandbox(path.join(tempBase(), "nested", "bili-live-deploy-0123456789"), 40000), /bili-live-deploy/);
        const roaming = process.env.APPDATA;
        if (roaming) assert.throws(() => assertSandbox(path.join(roaming, "bili-live-deploy-0123456789"), 40000));
    });

    test("the seam guard recognises the live installation area in every spelling", { skip: SKIP }, () => {
        // The guard is a pure function, so no folder is created anywhere near a real installation.
        const base = "X:\\Profiles\\someone\\AppData\\Roaming";
        const cases: [string, boolean][] = [
            [`${base}\\CindyGlobal\\billion-context-proxy`, true],
            [`${base.toUpperCase()}\\CINDYGLOBAL\\x\\`, true],
            [`\\\\?\\${base}\\CindyGlobal\\x`, true],
            [`${base}\\CindyGlobal`, true],
            [`${base}\\CindyGlobalOther\\x`, false],
            [`${base}\\Other\\CindyGlobal\\x`, false],
            ["X:\\Temp\\bili-live-deploy-0123456789", false],
        ];
        const lines = cases.map(([p]) => `Test-LpLiveArea @('${p}') '${base}\\'`).join("; ");
        const r = spawnSync("pwsh", ["-NoProfile", "-NonInteractive", "-Command", `. '${COMMON}'; ${lines}`], { encoding: "utf8", timeout: 60000 });
        assert.equal(r.status, 0, r.stderr);
        assert.deepEqual(r.stdout.trim().split(/\r?\n/), cases.map(([, want]) => (want ? "True" : "False")));
    });
});

// ---- refusals: nothing may change ---------------------------------------------------------------------

describe("live-deploy scripts: refusals leave everything untouched", { skip: SKIP }, () => {
    test("input validation and preflight refuse, each for its own reason", async () => {
        await withSandbox(async (sb) => {
            const before = launcher(sb);
            // Identities of the running supervisor and proxy: no refusal may replace either.
            let ids: { sup?: number; proxy?: number } = { sup: supervisorPid(sb), proxy: (await health(sb.port))!.pid };
            const refuse = async (label: string, args: Record<string, string | number | true | null>, reasons: RegExp[]) => {
                const r = await deploy(sb, { PreflightOnly: true, ...args });
                assert.equal(r.code, 2, `${label}: expected exit 2\n${r.out}`);
                assert.match(r.out, / RESULT refused \(exit 2\)/, label);
                for (const re of reasons) assert.match(r.out, re, `${label}\n${r.out}`);
                assertUntouched(sb, before, ids);
            };

            // Positive control first: the same sandbox passes when nothing is wrong.
            const ok = await deploy(sb, { PreflightOnly: true });
            expectResult(ok, 0, "preflight-ok");
            assert.equal(/ CHECK FAIL /.test(ok.out), false, ok.out);
            assert.match(ok.out, /plan: replace 0\.9\.1, aaaaaaa1-live .* with 0\.9\.2, bbbbbbb2-live/);
            assertUntouched(sb, before);

            // Input validation.
            await refuse("version", { CandidateVersion: "1.2" }, [/FAIL candidate version format/]);
            await refuse("commit", { CandidateCommit: "XYZ" }, [/FAIL candidate commit format/]);
            await refuse("source commit", { CandidateSourceCommit: "abc123" }, [/FAIL candidate source commit format/]);
            await refuse("bundle hash", { CandidateBundleSha256: "zz" }, [/FAIL candidate bundle hash format/]);
            await refuse("config hash", { ExpectedConfigSha256: "zz" }, [/FAIL expected config hash format/]);
            await refuse("release name", { ReleaseName: ".." }, [/FAIL release name/]);
            await refuse("reserved name", { ReleaseName: "nul" }, [/reserved device name/]);
            await refuse("task wildcard", { TaskName: "Sandbox*" }, [/wildcard characters are not allowed/]);
            await refuse("relative root", { RuntimeRoot: "relative\\root" }, [/FAIL runtime root: .*not absolute/]);
            await refuse("candidate inside root", { CandidateRoot: path.join(sb.root, "releases", PREV.name) }, [/inside the runtime root/]);
            const quoted = `${sb.root}-q'x`;
            fs.mkdirSync(quoted);
            sb.extraDirs.push(quoted);
            await refuse("quote in a path", { CandidateRoot: quoted }, [/forbidden character/]);
            const link = `${sb.root}-link`;
            fs.symlinkSync(sb.root, link, "junction");
            sb.extraDirs.push(link);
            await refuse("root reached through a link", { RuntimeRoot: link }, [/FAIL runtime root: a folder in the path is a link/]);

            // Sandbox seam.
            await refuse("real task driver on a marked sandbox", { TestTaskDriver: null }, [/real scheduled task may not be used/]);
            fs.renameSync(path.join(sb.root, "sandbox.marker"), path.join(sb.root, "sandbox.marker.off"));
            await refuse("test driver without the marker", {}, [/sandbox\.marker is absent/]);
            fs.renameSync(path.join(sb.root, "sandbox.marker.off"), path.join(sb.root, "sandbox.marker"));
            await refuse("test driver that is a folder", { TestTaskDriver: FIXTURES }, [/must be a regular file/]);

            // Preflight: candidate identity (one check, so one reason per run).
            await refuse("candidate commit", { CandidateCommit: "ccccccc3-live" }, [/expected commit ccccccc3-live/]);
            await refuse("candidate source", { CandidateSourceCommit: "c".repeat(40) }, [/different source commit/]);
            await refuse("candidate version", { CandidateVersion: "9.9.9" }, [/expected version 9\.9\.9/]);
            await refuse("candidate bundle", { CandidateBundleSha256: "0".repeat(64) }, [/bundle hash differs/]);
            fs.renameSync(path.join(sb.cand.dir, "LICENSE"), path.join(sb.cand.dir, "LICENSE.off"));
            await refuse("candidate file missing", {}, [/LICENSE is missing/]);
            fs.renameSync(path.join(sb.cand.dir, "LICENSE.off"), path.join(sb.cand.dir, "LICENSE"));

            // Preflight: independent checks all run and all report in one pass.
            fs.writeFileSync(path.join(sb.root, "maintenance.inhibit"), "someone else");
            patchTask(sb, { enabled: false });
            const otherPort = await freePort();
            const r = await deploy(sb, { PreflightOnly: true, ExpectedConfigSha256: "1".repeat(64), ReleaseName: PREV.name, ToolingDir: path.join(sb.root, "no-such-folder"), Port: otherPort });
            assert.equal(r.code, 2, r.out);
            for (const re of [
                /FAIL port matches the launcher/,
                /FAIL scheduled task runs this launcher: the task is disabled/,
                /FAIL configuration hash/,
                /FAIL current release healthy from the single listener/,
                /FAIL no maintenance in progress/,
                /FAIL new release directory is absent/,
                /FAIL tooling folder/,
                /PASS candidate files and identity/,
                /PASS current release node_modules link/,
            ]) {
                assert.match(r.out, re, r.out);
            }
            fs.rmSync(path.join(sb.root, "maintenance.inhibit"));
            patchTask(sb, { enabled: true });
            assertUntouched(sb, before);
            await refuse("unknown task", { TaskName: "No such task" }, [/expected exactly one task with this name, found 0/]);
            // A task whose action only resembles this launcher, or is not run by Windows PowerShell.
            patchTask(sb, { launcherSuffix: ".disabled" });
            await refuse("task runs another file", {}, [/FAIL scheduled task runs this launcher: the task action does not run the launcher/]);
            patchTask(sb, { launcherSuffix: `.other.ps1" -File "${path.join(sb.root, LAUNCHER)}` });
            await refuse("task passes the launcher as data to another script", {}, [/FAIL scheduled task runs this launcher: the task action does not run the launcher/]);
            patchTask(sb, { launcherSuffix: "", execute: "pwsh.exe" });
            await refuse("task runs another program", {}, [/FAIL scheduled task runs this launcher: the task action is not Windows PowerShell/]);
            patchTask(sb, { execute: "" });

            // Preflight: launcher shape.
            fs.appendFileSync(path.join(sb.root, LAUNCHER), "    [string]$ExpectedCommit = 'again',\n");
            {
                const run = await deploy(sb, { PreflightOnly: true });
                assert.equal(run.code, 2, run.out);
                assert.match(run.out, /launcher has 2 lines defining ExpectedCommit/);
            }
            fs.writeFileSync(path.join(sb.root, LAUNCHER), before + "# caf\u00e9\n", "utf8");
            {
                const run = await deploy(sb, { PreflightOnly: true });
                assert.equal(run.code, 2, run.out);
                assert.match(run.out, /not plain ASCII/);
            }
            fs.writeFileSync(path.join(sb.root, LAUNCHER), before, "ascii");

            // Preflight: node_modules must be a link.
            const nm = path.join(sb.root, "releases", PREV.name, "node_modules");
            fs.rmdirSync(nm);
            fs.mkdirSync(nm);
            await refuse("node_modules is a folder", {}, [/not a junction or symbolic link/]);
            fs.rmdirSync(nm);
            fs.symlinkSync(path.join(sb.root, "shared-node-modules"), nm, "junction");

            // Preflight: an unhealthy current release.
            fs.writeFileSync(path.join(sb.root, "proxy-control.json"), JSON.stringify({ [PREV.name]: { unhealthy: true } }));
            await refuse("unhealthy current release", {}, [/FAIL current release healthy from the single listener: .*observed ok=False/]);
            fs.rmSync(path.join(sb.root, "proxy-control.json"));
            await waitSupervised(sb, PREV.version, PREV.commit);

            // Idle: a connected client is reported by -PreflightOnly and refused by a full run.
            const client = net.connect({ host: "127.0.0.1", port: sb.port });
            await new Promise((res, rej) => client.once("connect", res).once("error", rej));
            try {
                const dry = await deploy(sb, { PreflightOnly: true });
                expectResult(dry, 0, "preflight-ok");
                assert.match(dry.out, /open client connections now: [1-9]/);
                const full = await deploy(sb);
                assert.equal(full.code, 2, full.out);
                assert.match(full.out, /client connection\(s\) open; not idle/);
                assertUntouched(sb, before);
            } finally {
                client.destroy();
            }

            // No supervisor (last: it changes the sandbox).
            const sup = supervisorPid(sb);
            process.kill(sup);
            await waitFor("supervisor to exit", () => !alive(sup));
            ids = { proxy: ids.proxy };
            await refuse("no supervisor", {}, [/expected one supervisor, found 0/]);
        });
    });
});

// ---- deployments ------------------------------------------------------------------------------------

// Every scenario owns its sandbox (folder, port, task state), so they run side by side.
describe("live-deploy scripts: deployment and rollback", { skip: SKIP, concurrency: 4 }, () => {
    test("deploys, proves supervision, rewrites receipts; the standalone rollback restores everything", async () => {
        // A second sandbox whose name is a prefix-sibling of the first proves the scripts never touch another installation.
        const stem = crypto.randomBytes(5).toString("hex");
        const other = await makeSandbox("0", CAND, stem);
        try {
            await withSandbox(async (sb) => {
                assert.equal(other.root.startsWith(sb.root) && other.root !== sb.root, true, "the other root must extend this root's name");
                const otherPids = { sup: supervisorPid(other), proxy: (await health(other.port))!.pid };
                const before = launcher(sb);
                const tunedBefore = fs.readFileSync(path.join(sb.root, "tuned-deployment.json"));
                const supBefore = fs.readFileSync(path.join(sb.root, "supervision-receipt.json"));
                const tooling = `${sb.root}-tools`;
                fs.mkdirSync(tooling);
                fs.writeFileSync(path.join(tooling, "build.mjs"), "// kept tooling\n");
                sb.extraDirs.push(tooling);

                const r = await deploy(sb, { ToolingDir: tooling });
                expectResult(r, 0, "deployed");
                const backup = onlyBackup(sb);
                assert.match(r.out, new RegExp(` BACKUP ${backup.replace(/[\\.]/g, "\\$&")}`));
                assert.match(r.out, / NEXT run the step 7 checks now\. If they fail, roll back with: pwsh .*Rollback-LiveProxy\.ps1/);

                // Supervision: the supervisor, not the script, runs the new release.
                const livePid = await waitSupervised(sb, CAND.version, CAND.commit);
                assert.equal(inhibit(sb), null);
                assert.equal(getTask(sb).enabled, true);
                assert.equal(status(sb)!.state, "spawned", "the supervisor must have started the new release itself");

                // Launcher: only the identity lines changed.
                const after = launcher(sb).split("\n");
                const changed = before.split("\n").flatMap((l, i) => (l === after[i] ? [] : [after[i].trim()]));
                assert.deepEqual(changed, [
                    `[string]$ProxyPath = '${path.join(releaseDir(sb), "dist", "index.mjs")}',`,
                    `[string]$ExpectedVersion = '${CAND.version}',`,
                    `[string]$ExpectedCommit = '${CAND.commit}',`,
                ]);

                // Release directory and backup.
                assert.equal(fs.lstatSync(path.join(releaseDir(sb), "node_modules")).isSymbolicLink(), true);
                assert.equal(fs.realpathSync(path.join(releaseDir(sb), "node_modules")), fs.realpathSync(path.join(sb.root, "shared-node-modules")));
                for (const f of [LAUNCHER, "tuned-deployment.json", "supervision-receipt.json", "deploy-record.json", "result.json", path.join("tooling", "build.mjs")]) {
                    assert.equal(fs.existsSync(path.join(backup, f)), true, `${f} missing from the backup`);
                }
                assert.equal(fs.readFileSync(path.join(backup, LAUNCHER), "utf8"), before);
                const rec = record(backup);
                assert.equal(rec.stage, "receipts-written");
                assert.equal(rec.reachedStage, "receipts-written");
                assert.equal(rec.deploymentId, path.basename(backup));

                // Receipts: the documented fields, computed values, nothing else lost.
                const tuned = JSON.parse(fs.readFileSync(path.join(sb.root, "tuned-deployment.json"), "utf8"));
                const old = JSON.parse(tunedBefore.toString());
                assert.equal(tuned.releaseRoot, releaseDir(sb));
                assert.equal(tuned.build, CAND.commit);
                assert.equal(tuned.previousBuild, PREV.commit);
                assert.equal(tuned.sourceCommit, CAND.source);
                assert.equal(tuned.bundleSha256, sb.cand.sha);
                assert.equal(tuned.livePid, livePid);
                assert.equal(tuned.masterBackupRoot, backup);
                assert.equal(tuned.masterPreviousReleaseRoot, old.releaseRoot);
                assert.equal(tuned.masterPreviousBuild, old.build);
                assert.equal(tuned.masterPreviousBundleSha256, old.bundleSha256);
                assert.equal(tuned.masterPreviousSourceCommit, old.sourceCommit);
                assert.equal(tuned.deployedAt, old.deployedAt, "an untouched date field must keep its exact text");
                assert.equal(tuned.deployedConfigSha256, "stale-on-purpose", "the stale config hash is neither trusted nor rewritten");
                assert.equal(tuned.deployedSupervisorSha256, sha256(launcher(sb)));
                const sup = JSON.parse(fs.readFileSync(path.join(sb.root, "supervision-receipt.json"), "utf8"));
                assert.equal(sup.proxyRelease, "stale-on-purpose");
                assert.equal(sup.masterDeploy.proxyRelease, `releases/cand-1 (${CAND.version}, ${CAND.commit})`);
                assert.equal(sup.masterDeploy.change, "ProxyPath, ExpectedCommit and ExpectedVersion defaults only");
                assert.equal(sup.masterDeploy.launcherSha256, sha256(launcher(sb)).toLowerCase());

                // Nothing was written where the scripts have no business.
                assert.deepEqual(fs.readdirSync(path.join(sb.root, "config", "billion-context")), ["billion-context.json"]);
                assert.equal(fs.existsSync(path.join(sb.root, "state")), false);
                assert.equal(r.out.includes(sb.canary), false, "config content must never be printed");
                // The sandbox root, the temp folder and the scripts' own folder (in the ready-to-paste rollback
                // command) are under a profile on every machine; nothing else may be.
                const redacted = [sb.root, path.dirname(sb.root), SCRIPTS].reduce((text, known) => text.split(known).join("<known>"), r.out);
                assert.equal(/Users\\/i.test(redacted), false, "no personal path other than the sandbox and the scripts' folder may be printed");

                // Standalone rollback: preflight changes nothing, then the real thing.
                const dry = await rollback(sb, backup, { PreflightOnly: true });
                expectResult(dry, 0, "preflight-ok");
                assert.equal(fs.existsSync(path.join(backup, "rollback-result.json")), false);
                assert.equal((await health(sb.port))!.commit, CAND.commit);

                const back = await rollback(sb, backup);
                expectResult(back, 0, "restored");
                assert.match(back.out, / ROLLBACK from cand-1 \(0\.9\.2, bbbbbbb2-live\) to 0\.9\.1, aaaaaaa1-live/);
                await waitSupervised(sb, PREV.version, PREV.commit);
                assert.equal(launcher(sb), before);
                assert.deepEqual(fs.readFileSync(path.join(sb.root, "tuned-deployment.json")), tunedBefore);
                assert.deepEqual(fs.readFileSync(path.join(sb.root, "supervision-receipt.json")), supBefore);
                assert.equal(inhibit(sb), null);
                assert.equal(getTask(sb).enabled, true);
                assert.equal(alive(livePid), false, "the deployed release must be stopped");
                assert.equal(fs.existsSync(releaseDir(sb)), true, "the standalone rollback keeps the release directory");
                assert.equal(record(backup).stage, "rolled-back");
                assert.equal(JSON.parse(fs.readFileSync(path.join(backup, "result.json"), "utf8")).result, "deployed", "the deploy result must not be overwritten");
                assert.equal(JSON.parse(fs.readFileSync(path.join(backup, "rollback-result.json"), "utf8")).result, "restored");

                const again = await rollback(sb, backup);
                assert.equal(again.code, 2, again.out);
                assert.match(again.out, /already rolled back/);

                // The other installation was never touched.
                assert.equal(supervisorPid(other), otherPids.sup);
                assert.equal(alive(otherPids.sup), true);
                assert.equal((await health(other.port))!.pid, otherPids.proxy);
                assert.equal(inhibit(other), null);
                assert.equal(getTask(other).calls.disable, 0);
            }, "", CAND, stem);
        } finally {
            await teardown(other);
        }
    });

    test("a rebuild of the same commit changes only the release path", async () => {
        await withSandbox(
            async (sb) => {
                const r = await deploy(sb);
                expectResult(r, 0, "deployed");
                assert.match(r.out, /launcher updated: ProxyPath$/m);
                const sup = JSON.parse(fs.readFileSync(path.join(sb.root, "supervision-receipt.json"), "utf8"));
                assert.equal(sup.masterDeploy.change, "ProxyPath defaults only");
                const h = await health(sb.port);
                assert.equal(h!.commit, PREV.commit);
                assert.equal(String(status(sb)!.childPid), String(h!.pid));
            },
            "",
            { version: PREV.version, commit: PREV.commit, source: PREV.source },
        );
    });

    test("a candidate that never becomes healthy is rolled back to the previous release", async () => {
        await withSandbox(async (sb) => {
            // The same wait also bounds the previous release coming back, so it must not be tight.
            const before = launcher(sb);
            fs.writeFileSync(path.join(sb.root, "proxy-control.json"), JSON.stringify({ "cand-1": { unhealthy: true } }));
            const r = await deploy(sb, { HealthWaitSeconds: 20 });
            expectResult(r, 3, "rolled-back", "cutover-failed");
            await waitSupervised(sb, PREV.version, PREV.commit);
            assert.equal(launcher(sb), before);
            assert.equal(inhibit(sb), null);
            assert.equal(getTask(sb).enabled, true);
            assert.equal(fs.existsSync(releaseDir(sb)), false, "the release directory this run created must be removed");
            assert.equal(fs.existsSync(path.join(sb.root, "shared-node-modules")), true, "removing the release must not follow the node_modules link");
            const backup = onlyBackup(sb);
            assert.equal(record(backup).stage, "rolled-back");
            assert.equal(record(backup).reachedStage, "cut");
            assert.equal(JSON.parse(fs.readFileSync(path.join(sb.root, "tuned-deployment.json"), "utf8")).build, PREV.commit, "receipts must be untouched");
            const after = await rollback(sb, backup);
            assert.equal(after.code, 2, after.out);
            assert.match(after.out, /already rolled back/);
        });
    });

    test("a client that connects after the hold makes the script stand down without stopping the proxy", async () => {
        await withSandbox(async (sb) => {
            const pid = (await health(sb.port))!.pid;
            patchTask(sb, { onCall: [{ op: "disable", call: 1, action: "openClient" }] });
            const r = await deploy(sb);
            expectResult(r, 3, "rolled-back", "not-idle");
            assert.match(r.out, / NEXT retry later with the same parameters/);
            await waitSupervised(sb, PREV.version, PREV.commit);
            assert.equal((await health(sb.port))!.pid, pid, "the serving proxy must never have been stopped");
            assert.equal(status(sb)!.state, "adopted");
            assert.equal(record(onlyBackup(sb)).reachedStage, "held");
            assert.equal(fs.existsSync(releaseDir(sb)), false);
        });
    });

    test("a failed rollback ends with the hold in place and the proxy left as it is; a retry restores", async () => {
        await withSandbox(async (sb) => {
            const before = launcher(sb);
            const sup = supervisorPid(sb);
            fs.writeFileSync(path.join(sb.root, "proxy-control.json"), JSON.stringify({ "cand-1": { unhealthy: true }, [PREV.name]: { unhealthyFromStart: 2 } }));
            const r = await deploy(sb, { HealthWaitSeconds: 6 });
            expectResult(r, 4, "rollback-failed", "previous-unhealthy");
            const backup = onlyBackup(sb);
            assertHold(sb, backup, sup);
            assert.equal(launcher(sb), before, "the launcher was restored before the previous release was tried");
            const left = await health(sb.port);
            assert.equal(left!.ok, false);
            assert.equal(left!.commit, PREV.commit);
            assert.equal(alive(left!.pid), true, "the unhealthy proxy must be left running");
            assert.equal(record(backup).stage, "rollback-failed");
            assert.equal(record(backup).reachedStage, "cut");
            assert.match(r.out, / NEXT report to the owner with .*evidence-.*no release is confirmed live/);
            const evidence = fs.readdirSync(backup).filter((f) => f.startsWith("evidence-"));
            assert.equal(evidence.length, 1);
            const text = fs.readFileSync(path.join(backup, evidence[0]), "utf8");
            assert.match(text, /hold in place: inhibit set, task disabled, no supervisor/);
            assert.match(text, /health: ok=False/);
            assert.equal(text.includes(sb.canary), false, "evidence must not contain config content");
            assert.equal(r.out.includes(sb.canary), false);
            // No supervisor comes back by itself while the hold is in place.
            await sleep(1500);
            assert.equal(status(sb)!.supervisorPid === sup || !alive(Number(status(sb)!.supervisorPid)), true);

            // The owner fixes the release; the standalone rollback accepts its own hold and finishes the job.
            fs.rmSync(path.join(sb.root, "proxy-control.json"));
            const retry = await rollback(sb, backup);
            expectResult(retry, 0, "restored");
            await waitSupervised(sb, PREV.version, PREV.commit);
            assert.equal((await health(sb.port))!.pid, left!.pid, "the running proxy is adopted, not restarted");
            assert.equal(inhibit(sb), null);
            assert.equal(getTask(sb).enabled, true);
        });
    });

    test("an error while restoring the launcher ends with the hold in place", async () => {
        await withSandbox(async (sb) => {
            const sup = supervisorPid(sb);
            fs.writeFileSync(path.join(sb.root, "proxy-control.json"), JSON.stringify({ "cand-1": { unhealthy: true } }));
            patchTask(sb, { onCall: [{ op: "disable", call: 2, action: "makeLauncherReadOnly" }] });
            const r = await deploy(sb, { HealthWaitSeconds: 6 });
            expectResult(r, 4, "rollback-failed", "rollback-error");
            assert.match(r.out, /rollback failed at: launcher restore/);
            assertHold(sb, onlyBackup(sb), sup);
            assert.equal((await health(sb.port)) === null, true, "nothing was started after the failure");
        });
    });

    test("when the hold cannot be re-applied the script still stops and says which part is missing", async () => {
        await withSandbox(async (sb) => {
            fs.writeFileSync(path.join(sb.root, "proxy-control.json"), JSON.stringify({ "cand-1": { unhealthy: true }, [PREV.name]: { unhealthyFromStart: 2 } }));
            patchTask(sb, { failOn: [{ op: "disable", call: 3 }] });
            const r = await deploy(sb, { HealthWaitSeconds: 6 });
            expectResult(r, 4, "rollback-failed", "previous-unhealthy");
            assert.match(r.out, /hold NOT fully in place: task could not be disabled/);
            assert.match(inhibit(sb) ?? "", /^rollback /);
            assert.equal(getTask(sb).enabled, true);
        });
    });

    test("a hold that cannot be applied is undone with the proxy untouched", async () => {
        await withSandbox(async (sb) => {
            const before = launcher(sb);
            const pid = (await health(sb.port))!.pid;
            const sup = supervisorPid(sb);
            patchTask(sb, { failOn: [{ op: "disable", call: 1 }] });
            const r = await deploy(sb);
            expectResult(r, 3, "rolled-back", "hold-failed");
            assert.equal(inhibit(sb), null);
            assert.equal(getTask(sb).enabled, true);
            assert.equal(alive(sup), true, "the supervisor was never stopped");
            assert.equal((await health(sb.port))!.pid, pid);
            assert.equal(launcher(sb), before);
            assert.equal(record(onlyBackup(sb)).reachedStage, "holding");
            assert.equal(fs.existsSync(releaseDir(sb)), false);
        });
    });

    test("maintenance started by someone else after preflight is left alone", async () => {
        await withSandbox(async (sb) => {
            const before = launcher(sb);
            const sup = supervisorPid(sb);
            patchTask(sb, { onCall: [{ op: "info", call: 2, action: "writeForeignInhibit" }] });
            const r = await deploy(sb);
            expectResult(r, 6, "error-before-hold");
            assert.equal(inhibit(sb), "someone else", "the other maintenance's inhibit must be untouched");
            assert.equal(getTask(sb).enabled, true);
            assert.equal(getTask(sb).calls.disable, 0);
            assert.equal(alive(sup), true);
            assert.equal(launcher(sb), before);
            assert.equal(fs.existsSync(releaseDir(sb)), false);
            const backup = onlyBackup(sb);
            assert.equal(record(backup).stage, "aborted");
            const refused = await rollback(sb, backup);
            assert.equal(refused.code, 2, refused.out);
            assert.match(refused.out, /belongs to other maintenance/);
            fs.rmSync(path.join(sb.root, "maintenance.inhibit"));
            const nothing = await rollback(sb, backup);
            assert.equal(nothing.code, 2, nothing.out);
            assert.match(nothing.out, /stopped at stage 'aborted' and changed nothing/);
        });
    });

    test("a launcher edited by someone else during the hold is never overwritten", async () => {
        await withSandbox(async (sb) => {
            const sup = supervisorPid(sb);
            const pid = (await health(sb.port))!.pid;
            patchTask(sb, { onCall: [{ op: "disable", call: 1, action: "editLauncher" }] });
            const r = await deploy(sb);
            expectResult(r, 4, "rollback-failed", "foreign-launcher-edit");
            assert.match(launcher(sb), /# foreign edit/);
            assertHold(sb, onlyBackup(sb), sup);
            assert.equal(alive(pid), true, "the serving proxy is left as it is");
            const refused = await rollback(sb, onlyBackup(sb));
            assert.equal(refused.code, 2, refused.out);
            assert.match(refused.out, /launcher was changed after this deployment/);
        });
    });

    test("a launcher edited by someone else while the rollback runs is never overwritten", async () => {
        await withSandbox(async (sb) => {
            const sup = supervisorPid(sb);
            fs.writeFileSync(path.join(sb.root, "proxy-control.json"), JSON.stringify({ "cand-1": { unhealthy: true } }));
            // The second "disable" is the rollback's own hold: the edit lands after the rollback has started.
            patchTask(sb, { onCall: [{ op: "disable", call: 2, action: "editLauncher" }] });
            const r = await deploy(sb, { HealthWaitSeconds: 6 });
            expectResult(r, 4, "rollback-failed", "foreign-launcher-edit");
            assertHold(sb, onlyBackup(sb), sup);
            assert.match(launcher(sb), /# foreign edit/, "the foreign edit must survive");
            assert.match(launcher(sb), /cand-1/, "the launcher must be left as found, not restored");
        });
    });

    test("a healthy candidate that the supervisor does not vouch for is rolled back", async () => {
        await withSandbox(async (sb) => {
            const before = launcher(sb);
            // The candidate itself answers health correctly in both runs; only the supervisor's report is off.
            for (const [override, why] of [
                [{ healthMatch: false }, /not healthy under supervision: supervisor reports no health match/],
                [{ childPid: 1 }, /not healthy under supervision: supervisor monitors a process that is not the listener/],
            ] as const) {
                fs.writeFileSync(path.join(sb.root, "status-control.json"), JSON.stringify({ [CAND.commit]: override }));
                const r = await deploy(sb, { HealthWaitSeconds: 20 });
                expectResult(r, 3, "rolled-back", "cutover-failed");
                assert.match(r.out, why);
                await waitSupervised(sb, PREV.version, PREV.commit);
                assert.equal(launcher(sb), before);
                assert.equal(fs.existsSync(releaseDir(sb)), false);
            }
        });
    });

    test("a task changed after preflight stops the run before anything is touched", async () => {
        await withSandbox(async (sb) => {
            const before = launcher(sb);
            const ids = { sup: supervisorPid(sb), proxy: (await health(sb.port))!.pid };
            // The second task read is the comparison with the task that preflight validated.
            patchTask(sb, { onCall: [{ op: "info", call: 2, action: "changeTaskAction" }] });
            const r = await deploy(sb);
            expectResult(r, 6, "error-before-hold");
            assert.match(r.out, /the scheduled task was changed after preflight/);
            assert.equal(record(onlyBackup(sb)).stage, "aborted");
            const calls = getTask(sb).calls;
            assert.deepEqual([calls.disable, calls.enable, calls.start], [0, 0, 0]);
            assert.equal(inhibit(sb), null);
            assert.equal(launcher(sb), before);
            assert.equal(fs.existsSync(releaseDir(sb)), false);
            assert.equal(alive(ids.sup) && supervisorPid(sb) === ids.sup, true);
            assert.equal((await health(sb.port))!.pid, ids.proxy);
        });
    });

    test("an inhibit replaced by someone else during the hold is kept and nothing is restarted", async () => {
        await withSandbox(async (sb) => {
            const before = launcher(sb);
            const proxy = (await health(sb.port))!.pid;
            const sup = supervisorPid(sb);
            // This run's own inhibit exists by the first "disable"; the fault overwrites it with a foreign one.
            patchTask(sb, { onCall: [{ op: "disable", call: 1, action: "writeForeignInhibit" }] });
            const r = await deploy(sb);
            expectResult(r, 4, "rollback-failed", "rollback-error");
            assert.match(r.out, /maintenance\.inhibit is no longer the one this run created/);
            assert.match(r.out, /hold NOT fully in place: inhibit present but owned by other maintenance/);
            assert.equal(inhibit(sb), "someone else", "the foreign inhibit must be kept exactly");
            const task = getTask(sb);
            assert.equal(task.enabled, false);
            assert.deepEqual([task.calls.enable, task.calls.start], [0, 0], "supervision must not be restarted under someone else's maintenance");
            assert.equal(alive(sup), false);
            assert.equal(launcher(sb), before, "the launcher must not have been edited");
            const h = await health(sb.port);
            assert.equal(h!.pid, proxy, "the running proxy must not have been stopped");
            assert.equal(h!.commit, PREV.commit);
        });
    });

    test("a second deploy is refused while one is running", async () => {
        await withSandbox(async (sb) => {
            // The first run is paused inside its hold, so it provably still owns the lock when the second starts.
            patchTask(sb, { onCall: [{ op: "disable", call: 1, action: "pause" }] });
            const first = deploy(sb);
            try {
                await waitFor("the first run to pause", () => fs.existsSync(path.join(sb.root, "sandbox-paused")));
                const second = await deploy(sb, { ReleaseName: "cand-2" });
                assert.equal(second.code, 2, second.out);
                assert.match(second.out, /another deploy or rollback is running for this runtime root/);
                assert.equal(fs.existsSync(releaseDir(sb, "cand-2")), false);
                const back = await rollback(sb, onlyBackup(sb));
                assert.equal(back.code, 2, back.out);
                assert.match(back.out, /another deploy or rollback is running for this runtime root/);
            } finally {
                fs.writeFileSync(path.join(sb.root, "sandbox-release"), "go");
            }
            expectResult(await first, 0, "deployed");
            assert.equal(backups(sb).length, 1);
            assert.equal(fs.existsSync(path.join(sb.root, "live-deploy.lock")), false, "the operation lock goes away with the process");
        });
    });

    test("a standalone rollback that died mid-run can be run again", async () => {
        await withSandbox(async (sb) => {
            const before = launcher(sb);
            expectResult(await deploy(sb), 0, "deployed");
            const backup = onlyBackup(sb);
            // Killed in the middle of its lift: candidate stopped, inhibit removed, task still disabled.
            patchTask(sb, { onCall: [{ op: "enable", call: 2, action: "killSelf" }] });
            const killed = await rollback(sb, backup);
            assert.notEqual(killed.code, 0);
            assert.equal(record(backup).stage, "rolling-back");
            assert.equal(inhibit(sb), null);
            assert.equal(getTask(sb).enabled, false);
            patchTask(sb, { onCall: [] });
            // A live receipt that went missing is restored from the backup, not a reason to stop.
            fs.rmSync(path.join(sb.root, "tuned-deployment.json"));
            const back = await rollback(sb, backup);
            expectResult(back, 0, "restored");
            await waitSupervised(sb, PREV.version, PREV.commit);
            assert.equal(launcher(sb), before);
            assert.equal(getTask(sb).enabled, true);
            assert.deepEqual(fs.readFileSync(path.join(sb.root, "tuned-deployment.json")), fs.readFileSync(path.join(backup, "tuned-deployment.json")));
            assert.equal(record(backup).stage, "rolled-back");
        });
    });

    test("a receipt that cannot be replaced does not roll back a healthy release", async () => {
        await withSandbox(async (sb) => {
            fs.chmodSync(path.join(sb.root, "tuned-deployment.json"), 0o444);
            const r = await deploy(sb);
            expectResult(r, 5, "deployed-receipts-incomplete");
            assert.match(r.out, /not every receipt was updated \(tuned-deployment\.json, supervision-receipt\.json\)/);
            assert.match(r.out, / NEXT finish the receipts: Copy-Item -LiteralPath .*tuned-deployment\.pending\.json/);
            await waitSupervised(sb, CAND.version, CAND.commit);
            const backup = onlyBackup(sb);
            assert.equal(record(backup).stage, "healthy");
            assert.equal(JSON.parse(fs.readFileSync(path.join(backup, "tuned-deployment.pending.json"), "utf8")).build, CAND.commit);
            assert.equal(JSON.parse(fs.readFileSync(path.join(sb.root, "tuned-deployment.json"), "utf8")).build, PREV.commit);
            // Rolling back from this stage works and leaves the receipts as they were.
            const back = await rollback(sb, backup);
            expectResult(back, 0, "restored");
            await waitSupervised(sb, PREV.version, PREV.commit);
        });
    });

    test("a deploy script that died mid-run can be rolled back from its record", async () => {
        // Killed after its own inhibit exists but before the task was disabled.
        await withSandbox(async (sb) => {
            const pid = (await health(sb.port))!.pid;
            patchTask(sb, { onCall: [{ op: "disable", call: 1, action: "killSelf" }] });
            const r = await deploy(sb);
            assert.notEqual(r.code, 0);
            assert.equal(/ RESULT /.test(r.out), false, "a killed script prints no result");
            const backup = onlyBackup(sb);
            assert.equal(record(backup).stage, "holding");
            assert.match(inhibit(sb) ?? "", /^deploy /);
            patchTask(sb, { onCall: [] });
            const back = await rollback(sb, backup);
            expectResult(back, 0, "restored");
            await waitSupervised(sb, PREV.version, PREV.commit);
            assert.equal((await health(sb.port))!.pid, pid);
            assert.equal(inhibit(sb), null);
        });
        // Killed in the middle of the lift: previous proxy stopped, launcher edited, task still disabled.
        await withSandbox(async (sb) => {
            const before = launcher(sb);
            patchTask(sb, { onCall: [{ op: "enable", call: 1, action: "killSelf" }] });
            const r = await deploy(sb);
            assert.notEqual(r.code, 0);
            const backup = onlyBackup(sb);
            assert.equal(record(backup).stage, "cut");
            assert.equal(inhibit(sb), null);
            assert.equal(getTask(sb).enabled, false);
            assert.equal(await health(sb.port), null);
            patchTask(sb, { onCall: [] });
            const back = await rollback(sb, backup);
            expectResult(back, 0, "restored");
            await waitSupervised(sb, PREV.version, PREV.commit);
            assert.equal(launcher(sb), before);
            assert.equal(getTask(sb).enabled, true);
        });
    });

    test("the standalone rollback refuses a backup that is not the current deployment's", async () => {
        await withSandbox(async (sb) => {
            expectResult(await deploy(sb), 0, "deployed");
            const backup = onlyBackup(sb);
            const recPath = path.join(backup, "deploy-record.json");
            const good = fs.readFileSync(recPath, "utf8");
            const live = launcher(sb);
            const refuse = async (label: string, reason: RegExp, target = backup) => {
                const r = await rollback(sb, target);
                assert.equal(r.code, 2, `${label}: expected exit 2\n${r.out}`);
                assert.match(r.out, reason, `${label}\n${r.out}`);
                assert.equal(inhibit(sb), null, label);
                assert.equal(launcher(sb), live, label);
                assert.equal(getTask(sb).enabled, true, label);
            };
            const withRecord = async (label: string, change: (rec: Record<string, any>) => void, reason: RegExp) => {
                const rec = JSON.parse(good);
                change(rec);
                fs.writeFileSync(recPath, JSON.stringify(rec));
                await refuse(label, reason);
                fs.writeFileSync(recPath, good);
            };
            await withRecord("unknown field", (r) => (r.extra = 1), /deployment record is not valid \(unexpected or missing fields\)/);
            await withRecord("other root", (r) => (r.runtimeRoot = `${sb.root}-elsewhere`), /belongs to another runtime root/);
            await withRecord("forbidden port", (r) => (r.port = 70000), /malformed port/);
            await withRecord("path outside releases", (r) => (r.candidate.proxyPath = path.join(sb.root, "dist", "index.mjs")), /candidate release path in the record is not/);
            await withRecord("nothing changed", (r) => (r.stage = "prepared"), /stopped at stage 'prepared' and changed nothing/);
            await withRecord("other previous release", (r) => (r.previous.commit = "ddddddd4-live"), /does not name the previous release/);
            fs.renameSync(recPath, `${recPath}.off`);
            await refuse("record missing", /deploy-record\.json is missing/);
            fs.renameSync(`${recPath}.off`, recPath);
            await refuse("outside backups", /not directly under <runtime root>\\backups/, path.join(sb.root, "releases", PREV.name));
            fs.writeFileSync(path.join(sb.root, "maintenance.inhibit"), "someone else");
            const foreign = await rollback(sb, backup);
            assert.equal(foreign.code, 2, foreign.out);
            assert.match(foreign.out, /belongs to other maintenance/);
            assert.equal(inhibit(sb), "someone else");
            fs.rmSync(path.join(sb.root, "maintenance.inhibit"));
            // A task disabled by someone else: a finished deployment does not explain it.
            patchTask(sb, { enabled: false });
            const disabled = await rollback(sb, backup);
            assert.equal(disabled.code, 2, disabled.out);
            assert.match(disabled.out, /scheduled task is disabled and neither this deployment's hold nor its stage/);
            assert.equal(getTask(sb).enabled, false, "a task disabled by someone else stays disabled");
            assert.equal(launcher(sb), live);
            patchTask(sb, { enabled: true });
            // Still the current deployment: the same backup is accepted once nothing is wrong.
            expectResult(await rollback(sb, backup, { PreflightOnly: true }), 0, "preflight-ok");
        });
    });
});
