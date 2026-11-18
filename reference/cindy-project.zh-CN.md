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

1. 固定人工合并后已评审的源码 SHA，并检查该准确 SHA 的 CI 与评审结果。按步骤 3 的方法构建独立候选产物，记录其哈希及任何本地运行 wrapper；使用生成数据和回环模拟上游，在隔离进程中测试该同一产物：保留的 `iso-test.mjs` 检查启动、身份与转发，保留的 `fold-test.mjs` 检查折叠与检索。两者都以运行配置的副本在各自的端口上启动 bundle，从不使用运行端口。
2. 验证现有 supervisor、配置哈希、监听 PID/进程身份及空闲状态。准备新的 release 目录，备份 supervisor 和部署回执；保留认证、设置、原文及计划任务的登录启动/恢复职责。
3. 运行版本的 bundle 由小型本地启动 wrapper `live-entry.ts` 配合保留的 esbuild 脚本 `build.mjs` 构建，而非标准 CLI 入口；只构建标准 CLI 无法体现该部署的运行时策略。这两个文件都不在仓库中：它们位于下文所述的保留工具目录。把 wrapper 复制到已固定源码 SHA 的检出目录中的 `src/live-entry.ts`，在该检出目录的根目录运行 `build.mjs`，并以完整源码 SHA 作为参数；不得提交复制进来的文件。该 wrapper 要求显式 `--port`（拒绝非整数以及小于 1024 或大于 65535 的端口），随后调用 `startServer({ ...loadOptions(), host: "127.0.0.1", port, passthrough: false, autoUpdate: false, autoRestartOnUpdate: false }, { boundedMaintenance: { timeoutMs: 15000, maxTokens: 1024 } })`，并记录已启用的 bounded maintenance。`build.mjs` 打包 `src/live-entry.ts` → `out/dist/index.mjs`（bundle/esm/node20，别名 `@earendil-works/pi-coding-agent` → `src/agent/pi-host-stub.ts`，external 为 `jimp, mysql2, mysql2/promise, bufferutil, utf-8-validate`，带 createRequire banner），并写出 `out/dist/build-info.json`，内含 `sourceCommit`、`bundleSha256`、`commit`（前 8 位加 `-live`）与 `localPatchSha256`；把这些哈希记入回执。交给切换步骤的候选目录包含 `dist\index.mjs`、`dist\build-info.json`、`package.json` 和 `LICENSE`。
4. 编辑 launcher 前必须先暂停监管，顺序如下：在运行根目录创建 `maintenance.inhibit`，该文件会抑制 supervisor 的接管、启动与重启；禁用计划任务，否则其重复触发器会重新拉起 supervisor；然后停止 supervisor。被抑制期间已监控的子进程继续运行，因此旧代理仍在服务：确认它仍然健康。在 supervisor 存活时修改 launcher 默认值不安全：接管按 PID 加进程创建时间进行，并在持有句柄后复核；每个安装只允许一个 supervisor，由 `supervisor.lock` 上的操作系统排他锁保持，因此第二次启动会立即以 0 退出。这一暂停是临时的：步骤 6 在切换时解除，回滚后由步骤 8 再次解除。
5. 仅更改 launcher 中标识 release 的默认值，launcher 的其他内容一律不动：`ProxyPath` 和 `ExpectedCommit`，版本号变化时再加上 `ExpectedVersion`。它们必须与新 release 一致，否则 supervisor 会失败关闭（fail closed）。新值取自候选产物，而非本页：`ProxyPath` 是新 release 目录中的 `dist\index.mjs`，`ExpectedCommit` 是候选产物 `dist\build-info.json` 中的 `commit`，`ExpectedVersion` 是步骤 1 隔离测试中其健康端点报告的版本号。被替换 release 的值即 launcher 当前的默认值；回执也记录同一 release：`tuned-deployment.json` 的 `releaseRoot` 与 `build`，以及 `supervision-receipt.json` 的 `masterDeploy.proxyRelease`（其中还含版本号）。`Deploy-LiveProxy.ps1` 以参数接收候选产物的版本号、commit、源码 commit 与 bundle 哈希，候选产物与之不符即拒绝；它只改写这三行中取值发生变化的行，若改动会触及其他行则在暂停监管之前停止。其余默认值保持不变：`Port` = `8787`、`NodePath` = `C:\Program Files\nodejs\node.exe`、`RestartDelaySeconds` 5、`PollSeconds` 5、`HeartbeatSeconds` 15 及 `-ReportOnly` 开关。
6. 仅在空闲时切换：只要运行端口上还有客户端连接，就中止，而不是等待请求结束。脚本把回环连接计为客户端，除非其所属进程是脚本自身或 supervisor，后者的健康探测不算客户端。只停止旧代理，等待端口释放，然后删除 `maintenance.inhibit`、启用计划任务并启动它。此时没有匹配的代理且端口无人监听，因此由 supervisor 自行启动新 release；不得手动启动代理。监管运行期间，遇到外来或未经验证的监听者、不可读/正在启动/不匹配的健康结果、匹配但未监听的进程、缺失的可执行文件，以及检查错误或超时，supervisor 会失败关闭：既不终止也不启动任何进程，状态每 `PollSeconds` 复核一次，且仅在变化时记录日志。只有当健康结果由唯一监听者的 PID 报告预期版本号与 commit，且新 release 的代理进程恰好一个、supervisor 恰好一个时，切换才算成功；`Deploy-LiveProxy.ps1` 最多等待 `-HealthWaitSeconds`（默认 90）秒，直到上述条件连同步骤 9 所述的 supervisor 自身报告全部成立。否则走步骤 8 的回滚分支。
7. 在监管运行的状态下，检查 manifest 源码身份、唯一监听者及配置哈希不变。验证转发、实际折叠、原文/图片精确检索及该测试 session 的检查日志。获授权后可发送一个小型认证提供商请求。`Deploy-LiveProxy.ps1` 只检查步骤 6 的成功判定与步骤 9 的监管状态，随后即改写回执并报告 `deployed`，因此这些检查在脚本结束后进行，此处失败时须在回执已被改写的情况下用 `Rollback-LiveProxy.ps1` 回滚。
8. 切换或上述检查失败时，在重新暂停监管后回滚：创建 `maintenance.inhibit`、禁用计划任务、停止 supervisor，再停止已启动的候选代理（如有）。恢复保存的 launcher，若回执已被改写则一并恢复两份回执：切换过程中失败时回执尚未改动，部署脚本结束后在步骤 7 失败时则已改写，`Rollback-LiveProxy.ps1` 在给定该次部署的备份目录后会恢复这三个文件。在 supervisor 存活时修改或恢复 launcher，与步骤 4 同理并不安全。随后按步骤 6 的方式解除暂停，由 supervisor 启动旧 release，并对它重做步骤 6 的成功判定与步骤 7 的检查。若恢复后的 release 同样未通过，即回滚失败：重新暂停监管（inhibit 已设、计划任务已禁用、supervisor 已停止），不再尝试任何启动、恢复或编辑，并携带证据向所有者报告：未通过的检查、`supervisor.log`、`bili.log`，以及端口当前由谁占用（如有）。此后运行中的代理处于无人监管或停止状态，直至所有者决定；这是有意设定的终态，以免失败的代理被反复重启。两个脚本都会自行落到这一终态，不触碰任何代理进程，把证据保存到备份目录，并以退出码 4 结束。
9. 确认维护状态已结束，成功路径与回滚路径同样适用：`maintenance.inhibit` 不存在、计划任务已启用，且恰好有一个 supervisor 在运行。该文件存在期间 supervisor 拒绝接管、启动与重启，因此遗留该文件的部署即使通过全部检查，也没有自动接管与重启。确认 supervisor 正在监控当前运行的 release（候选版本或已恢复版本）：`supervisor-status.json` 显示一个受监控的子进程，`healthMatch` 为 true 且无 inhibit，其 `childPid` 即唯一监听者的 PID，且健康端点由该 PID 报告预期版本号与 commit。唯一的例外是步骤 8 的回滚失败，它有意以暂停监管的状态结束。
10. 成功路径：完成部署回执，报告已部署的 SHA、结果及回滚位置。回滚路径：没有完成任何部署，确认回执描述的是已恢复的 release，并报告失败、保持运行的 release 及备份位置。回滚失败时：报告没有任何 release 被确认在运行，且监管处于暂停状态。本地代理部署不包含 npm 发包或更新承载任务的 Cindy 应用。

部署与回滚脚本位于仓库的 `scripts/live-deploy/`，说明见下文。构建与隔离测试工具则不在仓库中：每次 master 切换都把它们保留在各自的备份中，即部署回执 `tuned-deployment.json` 的 `masterBackupRoot` 所指备份根目录下的 `tooling\` 目录，当前为 `%APPDATA%\CindyGlobal\billion-context-proxy\backups\before-master-20261114-214204`。其中恰好包含 `Deploy-Master.ps1`、`build.mjs`、`fold-test.mjs`、`iso-test.mjs` 和 `live-entry.ts`；更早的 `before-master-20261114-191918` 备份中有一份逐字节相同的副本。按步骤对应：`iso-test.mjs` 与 `fold-test.mjs` 用于步骤 1，`live-entry.ts` 与 `build.mjs` 用于步骤 3，`Deploy-Master.ps1` 是执行 2026-11-14 各次切换的一次性脚本，作为历史保留，已被 `Deploy-LiveProxy.ps1` 取代。请把该工具目录以 `-ToolingDir` 传给部署脚本，使下一个备份也保留一份副本。在 `tooling\` 旁边，该备份根目录保存切换前的 `Start-BillionContextProxy.ps1`、`proxy.identity.json`、`supervision-receipt.json`、`supervisor-status.json` 和 `tuned-deployment.json`，以及 `Rollback-MasterDeploy.ps1`；后者是 `Deploy-Master.ps1` 为这一次已完成的切换生成的回滚文本：从该备份恢复 launcher 与两份回执，并通过计划任务重启旧 release。由 `Deploy-LiveProxy.ps1` 生成的备份则保存 `deploy-record.json`，`Rollback-LiveProxy.ps1` 读取的正是它；该脚本无法回滚由旧脚本完成的切换。运行中的 launcher 是运行根目录中的 `Start-BillionContextProxy.ps1`。同一根目录下的 `Rollback-TunedLiveProxy.ps1` 是另一种更深的回滚：它从回执的 `backupRoot`（2026-11-07 首次 tuned 部署之前的备份）恢复配置与 launcher，而不是回到上一个 release。

步骤 4–9 采用保留的 `Deploy-Master.ps1` 所实现的顺序：由 supervisor 而非操作者启动新 release，健康检查在监管运行的状态下进行。依据所有者 2026-11-16 的决定（[#78](https://github.com/anuzzolilli-oss/billion-context/issues/78)），这是认可的顺序；此前在 inhibit 下手动启动并检查新代理的写法已被取代，手动启动的代理如何纳入监管的问题也随之不复存在。仓库中的脚本实现了这一顺序，包括步骤 8 的回滚失败终态（[#80](https://github.com/anuzzolilli-oss/billion-context/issues/80)）。保留的 `Deploy-Master.ps1` 与 `Rollback-MasterDeploy.ps1` 则不然：两者都会删除 inhibit 并启动计划任务，而不要求旧 release 健康（前者只报告结果，后者不做检查），并且含固定的构建哈希与旧版本假设。不得用 `Deploy-Master.ps1` 进行新的部署。如果必须用 `Rollback-MasterDeploy.ps1` 撤销 2026-11-14 的切换，须自行完成步骤 8 的检查，未通过时手动重新暂停监管。

### 部署与回滚脚本

`scripts/live-deploy/Deploy-LiveProxy.ps1` 与 `scripts/live-deploy/Rollback-LiveProxy.ps1` 需要 PowerShell 7.2 或更高版本，所有与具体安装相关的值都以参数传入；脚本中不写入任何 release、端口或计划任务的信息。同一运行时根目录同一时间只能运行一个部署或回滚，第二个会被拒绝。请以非交互方式运行，并先用 `-PreflightOnly` 运行部署脚本：它执行全部检查、打印计划，且不做任何更改。

```powershell
pwsh -NoProfile -NonInteractive -File scripts\live-deploy\Deploy-LiveProxy.ps1 `
    -RuntimeRoot "<运行根目录>" -Port <端口> -TaskName "<计划任务名称>" `
    -CandidateRoot "<候选目录>" -ReleaseName "<新 release 目录名>" `
    -CandidateVersion "<步骤 1 测试报告的版本号>" -CandidateCommit "<步骤 1 测试报告的 commit>" `
    -CandidateSourceCommit "<已固定的源码 SHA>" -CandidateBundleSha256 "<构建时记录的 bundle 哈希>" `
    -ExpectedConfigSha256 "<步骤 2 核实的配置哈希>" -ToolingDir "<保留的工具目录>" -PreflightOnly

pwsh -NoProfile -NonInteractive -File scripts\live-deploy\Rollback-LiveProxy.ps1 `
    -RuntimeRoot "<运行根目录>" -BackupRoot "<运行根目录>\backups\<备份目录>" -PreflightOnly
```

四个候选值取自步骤 1 的记录，而非候选目录，这样脚本才能证明该目录中的产物就是经过测试的那一个。预期配置哈希同样由操作者提供：`tuned-deployment.json` 中的 `deployedConfigSha256` 既不被读取，也不被改写。

| 步骤 | 由谁完成 |
|---|---|
| 1、3 | 手动，使用保留的构建与测试工具 |
| 2、4、5、6 | `Deploy-LiveProxy.ps1` |
| 7 | 回执改写：`Deploy-LiveProxy.ps1`。功能检查：在其报告 `deployed` 之后手动进行 |
| 8 | 切换过程中：`Deploy-LiveProxy.ps1`。步骤 7 失败之后：`Rollback-LiveProxy.ps1` |
| 9 | 两个脚本，作为其成功判定的一部分 |
| 10 | 回执与打印的结果：脚本。向所有者的报告：操作者 |

每个脚本对每个事件打印一行，并以一行 `NEXT` 和一行 `RESULT` 结束；部署脚本在 `BACKUP` 行打印备份目录，并在其中保存 `deploy-record.json` 与 `result.json`。

| 退出码 | 结果 | 留下的状态 | 接下来做什么 |
|---|---|---|---|
| 0 | `deployed` | 新 release 在监管下健康运行 | 进行步骤 7 的检查；回滚命令见 `NEXT` 行 |
| 0 | `restored`（回滚脚本） | 旧 release 在监管下健康运行 | 按步骤 10 报告；之后的部署需要新的 release 名称 |
| 0 | `preflight-ok` | 未做任何更改 | 去掉 `-PreflightOnly` 再次运行 |
| 2 | `refused` | 未做任何更改 | 修正未通过的检查 |
| 3 | `rolled-back` | 旧 release 在监管下健康运行；新 release 目录已删除 | `reason=not-idle`：稍后重试。`hold-failed`、`cutover-failed`：先查明原因 |
| 4 | `rollback-failed` | 监管处于暂停状态；代理进程保持原状；没有任何 release 被确认在运行 | 携带证据文件与两份日志向所有者报告；原因修复后用 `Rollback-LiveProxy.ps1` 重试 |
| 5 | `deployed-receipts-incomplete` | 新 release 在监管下健康运行；有回执未被替换 | 复制 `NEXT` 行列出的待写回执文件，然后进行步骤 7 的检查 |
| 6 | `error-before-hold` | 运行中的一切均未更改；新 release 目录已删除 | 修正问题后再次运行 |
| 其他 | 未打印 | 未知，例如脚本被终止 | 阅读 `deploy-record.json`，然后运行 `Rollback-LiveProxy.ps1 -PreflightOnly` |

这些脚本只在沙箱中测试，从不针对运行中的代理：`tests/live-deploy-scripts.test.ts` 建立一个临时运行根目录，其中是替身 launcher 与替身代理，并以测试驱动代替计划任务。脚本只对带有 `sandbox.marker` 的运行根目录接受该驱动，对这样的根目录拒绝使用真实的计划任务，并对位于正式安装区域内的任何根目录拒绝该驱动。
