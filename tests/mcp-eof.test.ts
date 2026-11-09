import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import path from "node:path";

const source = pathToFileURL(path.resolve("src/mcp.ts")).href;

function child(script: string, origin?: string, extraEnv: NodeJS.ProcessEnv = {}) {
    const env: NodeJS.ProcessEnv = { ...process.env, BILI_MCP_PROXY: origin ?? "http://127.0.0.1:1" };
    delete env.CLAUDE_CODE_SESSION_ID;
    delete env.BILI_CONVERSATION_ID;
    const proc = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { env: { ...env, ...extraEnv }, stdio: "pipe" });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const closed = once(proc, "close").then(([code, signal]) => ({ code, signal, stdout, stderr }));
    return { proc, closed, output: () => stdout };
}

async function waitFor(check: () => boolean): Promise<void> {
    const deadline = Date.now() + 10000;
    while (!check()) {
        assert.ok(Date.now() < deadline, "child did not reach expected state");
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

for (const built of [false, true]) {
    test(`direct MCP entry drains ping at EOF (built=${built})`, { timeout: 15000 }, async (t) => {
        const args = built ? ["dist/mcp.js"] : ["--import", "tsx", "src/mcp.ts"];
        const proc = spawn(process.execPath, args, { stdio: "pipe" });
        t.after(() => { if (proc.exitCode === null) proc.kill(); });
        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
        proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
        const closed = once(proc, "close");
        proc.stdin.end('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
        const [code, signal] = await closed;
        assert.equal(code, 0, stderr);
        assert.equal(signal, null);
        assert.equal(JSON.parse(stdout).id, 1);
        assert.doesNotMatch(stderr, /Assertion failed|UV_HANDLE_CLOSING|UnhandledPromiseRejection/);
    });
}

for (const built of [false, true]) {
    test(`accepted tools/call completes before EOF cleanup (built=${built})`, { timeout: 20000 }, async (t) => {
        let release: (() => void) | undefined;
        let forwarded = "";
        const server = http.createServer((req, res) => {
            res.setHeader("content-type", "application/json");
            if (req.url?.startsWith("/__bili/plugin/tool")) {
                req.on("data", (chunk: Buffer) => { forwarded += chunk.toString(); });
                req.on("end", () => { release = () => res.end(JSON.stringify({ ok: true, result: "accepted work completed" })); });
            } else res.end(JSON.stringify({ tools: { anthropic: [{ name: "compress", input_schema: { type: "object" } }] } }));
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        t.after(() => { server.closeAllConnections(); server.close(); });
        const address = server.address();
        assert.ok(address && typeof address !== "string");
        const module = built ? pathToFileURL(path.resolve("dist/mcp.js")).href : source;
        const h = child(`
            import { runMcpStdio } from ${JSON.stringify(module)};
            runMcpStdio({ onDrained: () => process.stdout.write('cleaned\\n') });
        `, `http://127.0.0.1:${address.port}`);
        t.after(() => { if (h.proc.exitCode === null) h.proc.kill(); });
        h.proc.stdin.write('{"jsonrpc":"2.0","id":0,"method":"initialize"}\n');
        await waitFor(() => h.output().includes('"id":0'));
        h.proc.stdin.write('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"compress","arguments":{"conversation_id":"eof-session","content":"fold"}}}\n');
        await waitFor(() => release !== undefined);
        assert.deepEqual(JSON.parse(forwarded), { conversationId: "eof-session", tool: "compress", args: { content: "fold" } });
        h.proc.stdin.end();
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.doesNotMatch(h.output(), /cleaned/);
        release!();
        const result = await h.closed;
        assert.equal(result.code, 0, result.stderr);
        assert.equal(result.signal, null);
        const lines = result.stdout.trim().split("\n");
        assert.equal(JSON.parse(lines[1]).result.content[0].text, "accepted work completed");
        assert.deepEqual(lines.slice(2), ["cleaned"]);
        assert.doesNotMatch(result.stderr, /Assertion failed|UV_HANDLE_CLOSING|UnhandledPromiseRejection/);
    });
}

test("identity registration drains on EOF without delaying initialize", { timeout: 15000 }, async (t) => {
    let release: (() => void) | undefined;
    const server = http.createServer((_req, res) => { release = () => res.end('{"ok":true}'); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const h = child(`
        import { runMcpStdio } from ${JSON.stringify(source)};
        runMcpStdio({ onDrained: () => process.stdout.write('cleaned\\n') });
    `, `http://127.0.0.1:${address.port}`, { CLAUDE_CODE_SESSION_ID: "registration-eof" });
    t.after(() => { if (h.proc.exitCode === null) h.proc.kill(); });
    h.proc.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
    await waitFor(() => release !== undefined && h.output().includes('"id":1'));
    h.proc.stdin.end();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.doesNotMatch(h.output(), /cleaned/);
    release!();
    const result = await h.closed;
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /cleaned/);
});

for (const fails of [false, true]) {
    test(`EOF runs cleanup exactly once, only after EOF (failure=${fails})`, { timeout: 20000 }, async (t) => {
        const h = child(`
            import { runMcpStdio } from ${JSON.stringify(source)};
            runMcpStdio({
                onEnd: () => process.stdout.write('stopped\\n'),
                onDrained: async () => {
                    await new Promise(r => setTimeout(r, 25).unref());
                    process.stdout.write('cleaned\\n');
                    ${fails ? "throw new Error('cleanup failed');" : ""}
                },
            });
            process.stdout.write('ready\\n');
        `);
        t.after(() => { if (h.proc.exitCode === null) h.proc.kill(); });
        await waitFor(() => h.output().includes("ready"));
        assert.equal(h.output(), "ready\n");
        h.proc.stdin.end();
        const result = await h.closed;
        assert.equal(result.stdout, "ready\nstopped\ncleaned\n");
        assert.equal(result.code, fails ? 1 : 0, result.stderr);
        assert.equal(result.signal, null);
        if (fails) assert.match(result.stderr, /cleanup failed/);
        else assert.doesNotMatch(result.stderr, /Assertion failed|UV_HANDLE_CLOSING|UnhandledPromiseRejection/);
    });
}

test("EOF drains an accepted request before cleanup; incomplete final frames stay ignored", { timeout: 20000 }, async (t) => {
    let release: (() => void) | undefined;
    let requested = false;
    const server = http.createServer((_req, res) => {
        requested = true;
        release = () => {
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ tools: { anthropic: [{ name: "compress", input_schema: { type: "object" } }] } }));
        };
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const h = child(`
        import { runMcpStdio } from ${JSON.stringify(source)};
        runMcpStdio({ onEnd: async () => { process.stdout.write('stopped\\n'); throw new Error('stop failed'); }, onDrained: () => process.stdout.write('cleaned\\n') });
    `, `http://127.0.0.1:${address.port}`);
    t.after(() => { if (h.proc.exitCode === null) h.proc.kill(); });
    h.proc.stdin.write('{"jsonrpc":"2.0","id":0,"method":"initialize"}\n');
    await waitFor(() => h.output().includes('"id":0'));
    h.proc.stdin.write('{"jsonrpc":"2.0","id":1,"method":"tools/');
    h.proc.stdin.write('list"}\n');
    await waitFor(() => requested);
    h.proc.stdin.write('{"jsonrpc":"2.0","id":3,"method":42}\n');
    h.proc.stdin.end('{"jsonrpc":"2.0","id":2,"method":"ping"}');
    await new Promise((resolve) => setTimeout(resolve, 75));
    release!();
    const result = await h.closed;
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /startsWith/);
    assert.match(result.stderr, /stop failed/);
    assert.doesNotMatch(result.stderr, /UnhandledPromiseRejection/);
    const lines = result.stdout.trim().split("\n").slice(1);
    assert.equal(lines[0], "stopped");
    assert.equal(JSON.parse(lines[1]).id, 1);
    assert.equal(JSON.parse(lines[1]).result.tools[0].name, "compress");
    assert.deepEqual(lines.slice(2), ["cleaned"]);
});
