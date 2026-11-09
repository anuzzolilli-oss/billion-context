# Cindy 项目：billion-context

[English](cindy-project.md) · [系统架构](architecture.zh-CN.md) · [工作流程](../reference/cindy-project.zh-CN.md)

这是 Andrew 的 billion-context 压缩代理分支，供 Cindy 的 Pi 提供商路由使用。项目维护有界上下文维护、可靠的原文归档检索和准确的历史一致性检查。

## 项目标识

| 项目 | 值 |
|---|---|
| Cindy 项目 | TheGame 上的 `billion-context` |
| 开发目录 | `C:\Users\anuzz\Projects\billion-context` |
| 分支仓库 / `origin` | https://github.com/anuzzolilli-oss/billion-context |
| 默认分支 | `master` |
| 原始仓库 / `upstream` | https://github.com/ranxianglei/billion-context |
| 上游推送地址 | `disabled://upstream-push-blocked` |

除非 Andrew 明确指定其他目标，本项目的推送、issue 和 PR 均发往 Andrew 的分支仓库。保留上游推送禁用设置。

## 开发目录与运行中的服务

开发目录保存源码、本地依赖及测试/构建输出。该项目的 Cindy 任务应使用此目录。原对话目录中的旧检出保留为历史证据；新开发使用 Projects 下已登记的目录。

运行中的代理使用 `%APPDATA%\CindyGlobal\billion-context-proxy` 下独立的 release 目录，由现有计划任务 **Cindy - billion-context proxy** 管理，监听 `127.0.0.1:8787`。在开发目录构建或测试不会部署版本。

2026-11-08 验证的运行版本是 `51a1cdbf-live`，对应已评审源码 `51a1cdbf4e732bfe9cedae73aec8aee53ec20599`。其 Git tree 与已合并的 PR [#1](https://github.com/anuzzolilli-oss/billion-context/pull/1) 相同，合并提交为 `d6573a0881feb6102a3353e50060d07bf26099d9`。这是带日期的部署快照；后续操作前重新检查运行 manifest 与部署回执。

部署配置使用 `promptPack: lean` 和 `nudgeGrowthTokens: 25000`。本地运行入口调用 `startServer` 时显式传入 `boundedMaintenance: { timeoutMs: 15000, maxTokens: 1024 }`。准备替换版本时保留该运行策略；仅构建标准 CLI 不会记录这一部署选择。

## Cindy 工作指令

1. 编辑前阅读 [AGENTS.md](../AGENTS.md) 和相关参考文档，遵守 kernel 与 Pi-subagents 的组件边界。
2. 先检查工作区状态，确认 `origin` 指向 Andrew 的分支仓库；在功能分支上做范围明确、便于评审的修改。
3. 常规开发运行相关定向测试。本地全量运行需要明确请求，并使用[工作流程](../reference/cindy-project.zh-CN.md)中的 Windows 分片方法。准确推送 SHA 上的远程 CI 仍是合并依据。
4. 使用仓库的测试 preload、生成的测试数据和回环模拟上游。凭据不得写入源码、日志或报告。带门控的外部客户端/模型测试须满足其先决条件，并另获授权。
5. 仅在请求部署或重启时操作运行代理。保留设置、凭据和原文归档；先准备回滚，再验证部署 manifest、转发、折叠与检索。
6. 保留人类作者，为 AI 辅助提交添加 `Assisted-by: Cindy (https://cindy.app)`。按仓库审批规则由人类合并 PR。npm 发包不属于本地部署流程。

## 进一步阅读

- [架构总览](architecture.zh-CN.md)：请求管道、车道、身份、存储和压缩内核。
- [配置](configuration.zh-CN.md)与[客户端集成](clients.zh-CN.md)：受支持的设置和 wire 路由。
- [测试参考](../reference/testing.md)：运行隔离、CI 调度与带门控的集成测试。
- [维护评估](../reference/maintenance-safety-evaluation.md)：有界维护、watchdog/限流、原生载体与图片检查的修复证据。
- [Cindy 工作流程](../reference/cindy-project.zh-CN.md)：初始化、全量测试命令、运行验证和回滚步骤。

## 验证记录

初始化运行日期 **2026-11-08**，源码 `d6573a08`，Windows Node **24.14.0**、npm **11.9.0**：

| 套件 | 通过 | 失败 | 跳过 |
|---|---:|---:|---:|
| Host：全部 1,133 个文件，五个互斥分片 | 10,476 | 3 | 64 |
| Kernel：完整套件 | 1,609 | 0 | 0 |
| Pi-subagents：完整套件 | 263 | 0 | 0 |
| **合计** | **12,348** | **3** | **64** |

**本地全量结论：未全绿。** 无测试被取消。构建与类型检查通过。

- `release-ci-gate.test.ts` 的两个用例触发子 Node 进程 `UV_HANDLE_CLOSING` 崩溃；期望退出码 `1`，实际 `3221226505`。单独运行该文件仍复现：14 通过、2 失败。原生崩溃的底层原因尚未确认。
- `storage-durability.test.ts` 在临时目录清理时出现 `EPERM`。单独运行该文件 7 个测试全通过；首次全量失败仍保留记录。

未通过修改应用代码、断言、清理规则或超时隐藏失败。首次未分片启动在测试执行前因 `ENAMETOOLONG` 失败；随后使用现有分片器覆盖全部 host 文件。上表不计重复的独立诊断运行。

项目初始化验证保存在此检出的 `.tmp/project-verification/` 中。摘要分别列出 host、kernel 和 Pi-subagents 测试、跳过项、失败项及后续诊断重跑。本地日志补充 PR 的远程 CI 证据；跳过或缺少先决条件的测试不代表外部集成通过。
