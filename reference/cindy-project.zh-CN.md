# Cindy 项目工作流程

[English](cindy-project.md) · [项目指南](../docs/cindy-project.zh-CN.md) · [测试参考](testing.md)

## 打开并初始化开发目录

在 Cindy 项目列表选择 **billion-context**。TheGame 上的工作目录是 `C:\Users\anuzz\Projects\billion-context`。以下命令使用本地 PowerShell。

```powershell
Set-Location C:\Users\anuzz\Projects\billion-context
git status --short
git remote -v
git fetch --prune origin
git switch master
git pull --ff-only origin master
npm ci --ignore-scripts --no-fund --no-audit
npm run build
```

若存在无关的本地修改，先保留并确定其归属，再决定切换或拉取。`origin` 必须指向 `https://github.com/anuzzolilli-oss/billion-context.git`；`upstream` 的推送地址应禁用。编辑前创建范围明确的功能分支。初始化不包含全局安装。

## 验证修改

常规开发使用隔离数据目录的定向测试：

```powershell
npm run build
if ($LASTEXITCODE -ne 0) { throw 'Build failed; do not test stale component output' }
node --import ./tests/preload-storage-baseline.mjs --import ./tests/preload-test-env.mjs --import tsx --test tests/native-fold-invariant.test.ts tests/snapshot-media-invariant.test.ts
npm run typecheck
npm run check:unused-exports
node tools/check-architecture-docs.mjs
git diff --check
```

按修改范围选择测试文件，并遵守 [AGENTS.md](../AGENTS.md) 和 [testing.md](testing.md) 中的组件、签名载荷及真实客户端门控。CI 和评审结果须对应准确的推送 SHA。评审检查显示绿色也可能有发现，仍需阅读摘要与评论。

### 仅在所有者明确批准时运行本地全量诊断

这是所有者明确请求的诊断例外，并非对定向本地测试流程的常规放宽。准确推送 SHA 上的远程 CI 仍是全量回归的唯一合并依据；本地结果不能替代它。

Windows 未分片启动可能出现 `spawn ENAMETOOLONG`：完整 host 文件列表超过进程命令行限制。使用现有 CI 分片器，顺序运行五片，每片保持正常的文件并发数四。确定性且互斥的分区覆盖同一完整顶层 host 测试集合，不排除失败套件。同一时间只运行一个完整集合。

```powershell
New-Item -ItemType Directory .tmp/project-verification -Force | Out-Null
$priorShard = $env:CI_TEST_SHARD
$failedShards = @()
try {
    foreach ($part in 1..5) {
        $env:CI_TEST_SHARD = "$part/5"
        node scripts/run-ci-tests.mjs *> ".tmp/project-verification/host-shard-$part.log"
        if ($LASTEXITCODE -ne 0) { $failedShards += $part }
    }
} finally {
    $env:CI_TEST_SHARD = $priorShard
}
if ($failedShards.Count) { throw "Host partitions failed: $failedShards" }
npm --prefix kernel test
if ($LASTEXITCODE -ne 0) { throw 'Kernel tests failed' }
npm --prefix pi-subagents test
if ($LASTEXITCODE -ne 0) { throw 'Pi-subagents tests failed' }
```

在本地 shell 执行，不模拟 GitHub 合并事件，也不擅自启用带门控的外部客户端。标准 preload 隔离 host 数据。保留首次运行与自动重试日志，并分别记录每个套件的通过、失败、取消和跳过数。非零退出、取消或断言失败均不能宣称全绿。跳过项必须可见。MySQL、真实模型、浏览器及外部客户端门控需满足文档中的服务、凭据或可执行文件要求；默认集合不证明这些外部集成已通过。

启动器出错属于启动失败，不能计作测试通过。修改产品代码前，先单独运行失败文件复现断言。将 Windows 清理/锁定问题与历史一致性、取消传播缺陷分别记录。不得通过削弱断言、猜测性增加超时或关闭隔离获得绿色报告。

## 检查运行中的代理

开发构建留在检出目录。运行版本独立保存在 `%APPDATA%\CindyGlobal\billion-context-proxy`。

```powershell
$proxyRoot = Join-Path $env:APPDATA 'CindyGlobal\billion-context-proxy'
Invoke-RestMethod http://127.0.0.1:8787/__bili/plugin/manifest |
    Select-Object commit, version
Get-ScheduledTask -TaskName 'Cindy - billion-context proxy' |
    Select-Object TaskName, State
Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 8787 -State Listen |
    Select-Object LocalAddress, OwningProcess
Get-Content (Join-Path $proxyRoot 'tuned-deployment.json')
```

回执记录当前版本、旧版本、bundle 哈希及备份。日志位于运行根目录中的 `state\billion-context\bili.log` 和 `supervisor.log`。按一次性测试 session ID 筛选诊断；历史警告或旧 PID 本身不能证明新故障或当前存在两个写入进程。不得把提供商密钥、加密凭据或私有会话内容复制进文档或证据。

## 仅在明确请求时部署

1. 固定人工合并后已评审的源码 SHA，并检查该准确 SHA 的 CI 与评审结果。构建独立候选产物，记录其哈希及任何本地运行 wrapper；使用生成数据和回环模拟上游，在隔离进程中测试该同一产物。
2. 验证现有 supervisor、配置哈希、监听 PID/进程身份及空闲状态。准备新的 release 目录，备份 supervisor 和部署回执；保留认证、设置、原文及计划任务的登录启动/恢复职责。
3. 运行版本的 bundle 由小型本地启动 wrapper `src/live-entry.ts` 配合保留的 esbuild 脚本 `build.mjs` 构建，而非标准 CLI 入口；只构建标准 CLI 无法体现该部署的运行时策略。该 wrapper 要求显式 `--port`（拒绝非整数以及小于 1024 或大于 65535 的端口），随后调用 `startServer({ ...loadOptions(), host: "127.0.0.1", port, passthrough: false, autoUpdate: false, autoRestartOnUpdate: false }, { boundedMaintenance: { timeoutMs: 15000, maxTokens: 1024 } })`，并记录已启用的 bounded maintenance。`build.mjs` 打包 `src/live-entry.ts` → `out/dist/index.mjs`（bundle/esm/node20，别名 `@earendil-works/pi-coding-agent` → `src/agent/pi-host-stub.ts`，external 为 `jimp, mysql2, mysql2/promise, bufferutil, utf-8-validate`，带 createRequire banner），并写出 `out/dist/build-info.json`，内含 `sourceCommit`、`bundleSha256`、`commit`（前 8 位加 `-live`）与 `localPatchSha256`；把这些哈希记入回执。
4. 编辑 launcher 前必须先停止 supervisor，并在运行根目录创建 `maintenance.inhibit`；该文件会抑制 supervisor 的接管、启动与重启，被抑制期间已监控的子进程继续运行。在 supervisor 存活时修改 launcher 默认值不安全：接管按 PID 加进程创建时间进行，并在持有句柄后复核；每个安装只允许一个 supervisor，由 `supervisor.lock` 上的操作系统排他锁保持，因此第二次启动会立即以 0 退出。inhibit 是临时的：由步骤 9 删除。
5. 仅更改现有代理的 release 路径。launcher 的 `ProxyPath`、`ExpectedVersion` 和 `ExpectedCommit` 默认值必须改为与新 release 一致，否则 supervisor 会失败关闭（fail closed）。当前 release 的已验证默认值为 `ProxyPath` = `...\releases\master-d4aad618\dist\index.mjs`、`ExpectedVersion` = `0.1.213`、`ExpectedCommit` = `d4aad618-live`，另有 `Port` = `8787`、`NodePath` = `C:\Program Files\nodejs\node.exe`、`RestartDelaySeconds` 5、`PollSeconds` 5、`HeartbeatSeconds` 15 及 `-ReportOnly` 开关。
6. 遇到外来或未经验证的监听者、不可读/正在启动/不匹配的健康结果、匹配但未监听的进程、缺失的可执行文件，以及检查错误或超时，supervisor 会失败关闭：既不终止也不启动任何进程，状态每 `PollSeconds` 复核一次，且仅在变化时记录日志。等待活跃请求结束后只重启该代理。启动失败时走步骤 8 的回滚分支，而不是重启监管。
7. 检查 manifest 源码身份、唯一监听者及配置哈希不变。验证转发、实际折叠、原文/图片精确检索及该测试 session 的检查日志。获授权后可发送一个小型认证提供商请求。
8. Canary 失败时，在监管仍处于停止且已抑制的状态下完成回滚：恢复保存的 launcher 与回执、恢复旧 release、重启该旧版本并对它重做步骤 7 的检查，然后报告失败。为回滚而修改 launcher 默认值时若 supervisor 存活，与步骤 4 同理并不安全；且 launcher 仍携带候选版本的 release 默认值，因此 supervisor 可能因步骤 5 与 6 所述原因对已恢复的监听者 fail closed。必须先完成该分支，再退出维护状态。
9. 当将要保持运行的 release（候选版本或已恢复的旧版本）通过其检查后退出维护状态，成功路径与回滚路径同样适用：删除 `maintenance.inhibit` 并通过计划任务重启 supervisor。该文件存在期间 supervisor 拒绝接管、启动与重启，因此停在 canary 的部署会让代理在无人监管下运行——手动启动的代理可能通过全部检查，却仍没有自动接管与重启。随后确认 supervisor 报告的是当前运行的 release（候选版本或已恢复版本）：其 `supervisor-status.json` 状态、预期版本号与运行 commit，以及它接管的监听 PID。
10. 完成部署回执，报告源码 SHA、结果及回滚位置。本地代理部署不包含 npm 发包或更新承载任务的 Cindy 应用。

初次修复的部署工具保留在 `%APPDATA%\CindyGlobal\billion-context-proxy\backups\before-master-20261114-191918\tooling\`，其中恰好包含 `Deploy-Master.ps1`、`build.mjs`、`fold-test.mjs`、`iso-test.mjs` 和 `live-entry.ts`，回滚脚本 `Rollback-MasterDeploy.ps1` 就在同一位置旁边；该备份根目录同时保存 `Start-BillionContextProxy.ps1`、`proxy.identity.json`、`supervision-receipt.json`、`supervisor-status.json` 和 `tuned-deployment.json`。运行中的 launcher 是运行根目录中的 `Start-BillionContextProxy.ps1`，同一根目录下的 `Rollback-TunedLiveProxy.ps1` 用于回滚该 launcher。复用前检查这些保留的工具：它们含固定的构建哈希与旧版本假设。不得在当前版本已变化时直接执行旧安装脚本，应重新建立身份及回滚检查。
