// TEST STAND-IN for the live proxy bundle, used only by tests/live-deploy-scripts.test.ts.
// Installed in a sandbox as releases/<name>/dist/index.mjs. Answers /__bili/health with the version of
// the package.json beside dist/ and the commit of dist/build-info.json, like the real build does.
// <runtime root>/proxy-control.json can make one release misbehave:
//   { "<release name>": { "unhealthy": true } }            health reports ok:false
//   { "<release name>": { "unhealthyFromStart": 2 } }      healthy on the first start, unhealthy from the second
//   { "<release name>": { "exitAtStart": true } }          the process exits before listening
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dist = path.dirname(fileURLToPath(import.meta.url));
const releaseDir = path.dirname(dist);
const releaseName = path.basename(releaseDir);
const runtimeRoot = path.dirname(path.dirname(releaseDir));
const port = Number(process.argv[process.argv.indexOf("--port") + 1]);
const version = JSON.parse(fs.readFileSync(path.join(releaseDir, "package.json"), "utf8")).version;
const commit = JSON.parse(fs.readFileSync(path.join(dist, "build-info.json"), "utf8")).commit;

const counterFile = path.join(runtimeRoot, `proxy-starts-${releaseName}.txt`);
let starts = 1;
try {
    starts = Number(fs.readFileSync(counterFile, "utf8")) + 1;
} catch {
    // first start
}
fs.writeFileSync(counterFile, String(starts));
fs.appendFileSync(path.join(runtimeRoot, "sandbox-pids.log"), `${process.pid}\n`);

function control() {
    try {
        return JSON.parse(fs.readFileSync(path.join(runtimeRoot, "proxy-control.json"), "utf8"))[releaseName] ?? {};
    } catch {
        return {};
    }
}

if (control().exitAtStart) process.exit(3);

http.createServer((req, res) => {
    if (req.url !== "/__bili/health") {
        res.writeHead(404).end();
        return;
    }
    const c = control();
    const unhealthy = c.unhealthy === true || (typeof c.unhealthyFromStart === "number" && starts >= c.unhealthyFromStart);
    res.writeHead(200, { "content-type": "application/json", connection: "close" });
    res.end(JSON.stringify({ ok: !unhealthy, version, commit, pid: process.pid }));
}).listen(port, "127.0.0.1");
