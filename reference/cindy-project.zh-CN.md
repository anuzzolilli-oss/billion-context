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
node --import ./tests/preload-storage-baseline.mjs --import ./tests/preload-test-env.mjs --import tsx --test tests/native-fold-invariant.test.ts tests/snapshot-media-invariant.test.ts
npm run typecheck
npm run build
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

1. 固定已评审源码 SHA，并检查该 SHA 的 CI 与评审。构建独立候选产物，记录哈希及本地运行 wrapper；使用生成数据和回环模拟上游，在隔离进程中测试同一产物。
2. 验证现有 supervisor、配置哈希、监听 PID/进程身份及空闲状态。准备新的 release 目录，备份 supervisor 和部署回执；保留认证、设置、原文及计划任务的登录启动/恢复职责。
3. 仅更改现有代理的 release 路径。等待活跃请求结束后只重启该代理。启动失败时恢复保存的 launcher/回执，并重启旧版本。
4. 检查 manifest 源码身份、唯一监听者及配置哈希不变。验证转发、实际折叠、原文/图片精确检索及该测试 session 的检查日志。获授权后可发送一个小型认证提供商请求。
5. 完成部署回执，报告源码 SHA、结果及回滚位置。Canary 失败则恢复旧版本并报告。本地代理部署不包含 npm 发包或更新承载任务的 Cindy 应用。

初次修复的部署工具和详细历史日志保留在原任务的 `inspection-evidence` 目录。复用前检查其固定哈希和旧版本假设；不得在当前版本已变化时直接执行旧安装脚本，应重新建立身份及回滚检查。
