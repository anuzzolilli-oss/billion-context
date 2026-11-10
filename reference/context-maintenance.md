# Context maintenance / 上下文维护

## Authority / 权威来源

`AGENTS.md` is the canonical always-loaded map. `reference/development-contract.md` preserves its detailed policies as mandatory task-scoped guidance, not a second harness rules file. The extraction changes loading and placement, not permission. Its old upstream examples do not override the fork destination in AGENTS.md. No harness adapters or glossary were added: none were present, and no ambiguous domain term required a new definition.

`AGENTS.md` 是唯一常驻规则入口。`reference/development-contract.md` 保留按任务加载的强制细则，并非另一份宿主规则。此次调整只改变加载层级和位置，不改变权限；旧上游示例不能覆盖 AGENTS.md 的 fork 目标。未新增宿主适配文件或术语表：当前没有适配副本，也没有需要另立定义的歧义术语。

## Maintenance procedure / 维护步骤

1. Keep the map at ≤200 lines, one H1 and roughly seven H2 sections. Preserve hard safety boundaries and Tier A KDD consequences; put scoped procedures in references.
2. Read the relevant detailed section before changing it. Edit one authoritative location for each detailed rule; update its map pointer/consequence when needed.
3. Check internal links and legacy fragments. Do not relocate repo-root source paths, commands or external URLs while rebasing Markdown links.
4. Do not store task status, CI counts, current branches or handoffs here. Those are session evidence, not persistent project policy.
5. Any future harness adapter must be generated/a pointer, not another hand-maintained contract. Glossaries require verified terms and must respect the docs layout.

1. 常驻入口不超过 200 行，保留一个 H1、约七个 H2；硬安全边界和 Tier A KDD 后果常驻，专项流程下沉。
2. 修改前读取相关细则；详细规则只维护一个权威位置，必要时同步入口后果和指针。
3. 检查内部链接和旧锚点；修正文档相对链接时，不改写源码路径、命令或外部 URL。
4. 不在这里保存任务状态、CI 计数、分支或交接信息；这些属于会话证据。
5. 新宿主适配只能是生成文件或指针；术语表必须有已核实术语，并遵守文档布局。

## Preserved tensions / 保留待澄清的张力

These observations are not policy amendments. Ask the owner when an affected task needs an interpretation not already explicit in the applicable rule.

以下记录不构成规则修改；若具体任务需要现行条款未明确的解释，应询问负责人。

| Existing wording | Safe handling now / 当前处理 |
|---|---|
| Detailed §4 forbids agent merges; §7.4 describes auto-merge eligibility. | Agent merge prohibition remains binding. Eligibility does not authorize an agent to merge. / Agent 禁止合并仍有效，资格不等于授权。 |
| Root version rule says release branches only; kernel/pi-subagents boundaries require source-coupled bumps. | Keep both explicit scopes; do not remove either rule or infer a release authorization. Escalate ambiguous component release work. / 保留各自范围，不能据此推定发版授权。 |
| Detailed §6 says tests green before changes; §7.2 forbids local full-suite verdicts. | Targeted local checks plus exact-head remote CI; only explicit diagnostic approval permits a local full run. / 本地定向检查加精确提交 CI，全量本地诊断需明确批准。 |
| Historical install recipe uses global install and port 8787; Cindy owns a separate live copy there. | Follow the Cindy workflow; routine validation never deploys or collides with the live service. / 遵循 Cindy 工作流程，普通验证不部署、不争用运行端口。 |
| Generic context skill suggests root CONTEXT.md; repository layout permits only named root entry docs. | No glossary created without a demonstrated need and approved placement. / 未证明需求并确定位置前不新增术语表。 |
| Dependency summaries say zero runtime dependencies but list lazy exceptions; root manifest has the actual package surface. | Preserve the boundary and its stated exceptions; reconcile any proposed dependency change with owner approval, not prose cleanup. / 保留边界及例外，依赖变更须单独确认。 |

## Preservation / 保真

The detailed contract was extracted from the pre-maintenance AGENTS.md. Changes there are limited to its title/authority/loading preamble and relative Markdown link rebasing. KDD numbering, thresholds, commands, source paths and detailed policy text remain intact. The mixed-language document is intentionally not retranslated: preserving the operative wording avoids introducing a divergent policy translation. Both documentation indexes state this exception.

细则来自维护前的 AGENTS.md，仅修改标题、权威/加载说明和相对 Markdown 链接。KDD 编号、阈值、命令、源码路径及规则正文均保留。该混合语言文件刻意不另行翻译，避免产生不同含义的规则副本；两个文档总目录均注明此例外。
