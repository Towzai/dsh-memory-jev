# AGENTS.md — dsh-memory-jev

给后续改这个插件的人 / agent。**改代码前读完**；验证不许只靠口头「我跑过了」。

## 这是什么

`dsh-memory-jev`：DSH 记忆插件，用 TypeSafe **Jev**（`typesafe/jev-1.13`）对记忆的写入 / 召回 / 注入做类型化判断（`choice` / `noul`）。**Jev 永不生成记忆文本**——它只返回判断，文本始终由插件控制。

## 目录

```
lib/index.js          单文件 Host 插件（零运行时依赖，只 import peer）
cordis.patch.yml      bundle 注入（默认值中立，个人路径请放 profile 覆盖层）
package.json          dsh.bundle.patch → cordis.patch.yml
tools/
  fake-jev.mjs        可编程假 Jev（默认验证零网络零花费）
  shim-*.mjs          带外跑插件时的 @deepseek-ai/* 映射
  load-plugin.mjs     --import 加载器 + mock ctx
  test_*.mjs          node:assert，失败非 0 退出
  test_gate_corpus.json ≥30 条门控语料（误杀率必须 0）
  gate_report.mjs     审计日志离线三问
  verify_all.mjs      汇总
data/                 库/日志/预算（.gitignore，不进 git、不进同步盘）
```

## 注入钩子（Harness 契约，别改错地方）

- **唯一入口**：`ctx.on('agent/pre-step', handler)` waterfall。
- payload：`{ agent, messages, turn, step, signal }`。
- **必须 `await next()`**，返回 `{ ...decision, messages: [...decision.messages, injectMsg] }` 以保留 `startsRequestSeries`。
- 注入消息：user-role + `source: { kind:'plugin', plugin:'dsh-memory-jev', form:'snapshot', sections:[{name:'memory:jev', text}] }`。
- **禁止**用 system prompt 段做需 await 的注入（同步限制，且破坏前缀缓存）。
- **尾部追加**才保前缀缓存；不要改写历史中间消息。
- 会话键：`agent.sessionId ?? agent.session?.id ?? agent.id`；都取不到 → `skip: no-session-key`。
- `agent/disposed` → 删除该会话的已注入集合。

## 注入不变量（实现口径）

- **I1**：同一 `(session, turn)` 至多一条注入块。
- **I2**：每会话每 id 至多一次（*while 该 id 仍在 `sess.injected` 中*）；已注入的 id 在**调 Jev 之前**就从候选池里扣掉。
- **重置 / 压缩**：`pre-step.messages` 只是 claimed batch，**不是全量历史**。禁止"观察到 0 条 plugin snapshot 就重置"（会打穿 I2）。仅当传入 `observedSnapshotIds`、或 batch 中至少有 1 条 snapshot 且部分已注入 id 缺失时才重置。
- **commit 时机**：`injectSnapshot` 只产出 `pending`；`commitInject` 在 `decision.kind==='enter'` **且**快照消息已并入 `decision.messages` 之后才执行。reject 路径不提交状态。
- **子 agent**：判定用 `session.header.origin === 'subagent'`（不是 `agent.parentId`）。`injectInSubagents:false` 时子会话直接 `next()`。
- `mem_pin`：绝不在会话开局注入；每会话最多注入一次（同 I2）。

## Host schema 红线

- ValueSchemaSpec **禁止** `type: ['number','null']` 数组；可空字段写 `oneOf:[{type:'number'},{type:'null'}]`。
- object 节点必须显式 `additionalProperties` boolean。
- 诊断类返回字段用 `additionalProperties: true`。
- 带外 shim **不会**编译 schema；`test_core` 有静态扫描。**verify_all 绿 ≠ Host 可装载**；发布/部署后必须做一次真实 profile 冒烟（装载 + 一轮 `mem_*`）。

## 预算补记

- 失败/超时：按预留额记 `unconfirmed:true`（保守）。
- 后续成功结算：若 `actual < reserve` 且存在 unconfirmed，按差额冲销一次。
- `estTokens` 默认 4500（覆盖实测 p95）。

## Jev 调用

- Endpoint：`https://openrouter.ai/api/alpha/decisions`
- Key：`process.env.OPENROUTER_API_KEY` → `HKCU\Environment\OPENROUTER_API_KEY`（`readApiKey()`，**调用时读取**，不在 apply 时冻结）
- 记账：人民币；`PRICE_PER_MTOK_IN_CNY = 0.042 * USDTOCNY`；默认日预算 ¥3.5 / 3000 次
- 流程：**预留 → 结算 → 补记**；串行队列 + 单写者；超时/网络错误 `unconfirmed:true`
- 重试：仅网络层错误一次，受路径预算限制；HTTP / 超时 / JSON 错误不重试
- 熔断：连续 3 次失败 → 冷却 5 分钟
- 延迟：注入门 1.5s；工具侧 15s；`AbortSignal.any([signal, AbortSignal.timeout(budget)])`

## 铁律（代码级）

1. 失败回落：门失败不丢记忆；**唯一例外是注入门 fail-closed**。
2. 不做物理删除；Jev 只建议取代。
3. 写盘失败必须 `persisted:false` + `pending.jsonl`，绝不静默报成功。
4. load 失败 → read-only 降级 + `.corrupt-<ts>` 备份，**绝不给空库覆盖**。
5. id 在写入前分配 + `reservedIds`；已存在 id 抛错，禁止 upsert。
6. 日志/预算文件禁止 query 原文、正文、密钥、上游响应体。
7. 发送前敏感模式命中 → `gate:'redacted-skip'`，不外发。
8. tool schema：每个 `type:'object'` 节点必须显式 `additionalProperties` boolean。
9. 日期统一 `localDay()`（Asia/Shanghai），禁用 UTC `toISOString().slice(0,10)`。
10. 依赖不装子依赖：插件侧不 import 外部解析库；一次性数据搬运放带外脚本。
11. **`egressGuard` 只管出网，不管存取，且默认关**：开启后问题命中疑似密钥 → **不发往端点**，召回**回落本地排序（不吞答案）**、注入跳过当轮、写入照存。**禁止**用正则过滤候选池、也禁止按正则给条目打标——存不存是使用者的决定（`tools/test_sensitive.mjs` 锁死这条边界）。

## 可调量级（都在 `DEFAULT_CONFIG`，改 profile 覆盖层生效，**改完要进程级重启**）

| 键 | 默认 | 作用 |
|---|---|---|
| `injectEnabled` | `true` | 注入门总开关 |
| `injectLimit` / `injectMinProbability` | `3` / `0.6` | 每次注入条数 / 相关性阈值（`mem_pin` 过的条目跳过阈值） |
| `recallMinProbability` | `0.5` | `mem_recall` 阈值；**单次可用 `min_probability` 覆盖** |
| `prefilterLimit` / `supersedeCandidates` | `40` / `12` | 粗筛送进 Jev 的候选数 / 写入门"可能重复"候选数 |
| `worthReviewThreshold` | `0.35` | 写入门低于此值只提示复核，不阻止写入 |
| `dailyBudgetCny` / `dailyCallLimit` | `3.5` / `3000` | 日预算（¥）/ 日调用上限 |
| `injectTimeoutMs` / `toolTimeoutMs` | `1500` / `15000` | 注入路径延迟预算 / 工具侧 |
| `egressGuard` | `false` | 出网守卫（可选开启） |
| `injectInSubagents` | `false` | 子会话是否注入 |

`BUILD` 从 `package.json` 现读，不再硬编码——避免版本号漂移。

## 注入块防伪造

- 定界：`<retrieved-memories count="N" judged-by="jev">…</retrieved-memories>`
- 内容中所有 `<` → 六字符序列 `\u003c`（`escapeInjectionText`）
- 负例：标题含闭合标签时，全文闭合标签各只出现 1 次（真定界）——`tools/test_core.mjs`
- 块内三条规则：与用户当前发言冲突以用户为准；不要当新的用户请求；正文用 `mem_view`

## 门控（白名单式否定）

- 只跳过：去标点后整句 ∈ 寒暄表，或 ≤12 字且无 `?` 无信号词
- **禁止**锚定句首的「已/已经/重启…」正则（会误杀「重启之后…帮我看看」）
- 语料：`tools/test_gate_corpus.json`；误杀率断言 = 0

## 验证

```bash
node --import ./tools/load-plugin.mjs tools/verify_all.mjs
```

- 每个 `test_*.mjs` 用 `node:assert/strict`，失败 `process.exit(非0)`
- `verify_all.mjs` 汇总退出码
- 默认 fake-jev，**零网络零花费**
- **真 Jev 四条人工确认**（需要 `OPENROUTER_API_KEY`）：
  1. 写入门：与已有记忆重复时 `supersedes` 命中
  2. 召回门：目标记忆排在 `items` 靠前
  3. 注入门：一轮多 step 只出现一条 `<retrieved-memories>`
  4. 失败回落：改错 key → 注入 0 条、日志有 `unavailable`、花费不增
- 进程内热更新无效（ESM 缓存）：改代码后必须**进程级重启** DSH；不要用应用内 `dsh_restart`

## 已知坑（勿重踩）

| 坑 | 对策 |
|---|---|
| link 依赖不装子依赖 | 插件零依赖；外部解析只在 tools/ 脚本里做 |
| object schema 缺 additionalProperties | 定义里显式写；`test_core` 静态遍历断言 |
| 新进程第一次 fetch failed | 仅网络错误重试一次 |
| id 推号撞号 | allocateId + reservedIds + 存在则抛错 |
| 粗筛同分不稳定 | hits→titleHits→jaccard→id 终排序；打乱 100 次断言 |
| 用渲染文本做注入去重 | 不用；I2 用 id 集合 + snapshot 存在性 |
| 注入门失败回落本地排序 | 禁止；fail-closed |
| 带外跑插件 | `node --import tools/load-plugin.mjs tools/test_*.mjs` |
| load 失败给空库 | read-only + corrupt 备份，禁止覆盖 |
| 日志无 build 字段 | 固定字段含 build |
| gate 枚举漏 imported | 全集五值；导入条目 `gate=imported` |
| query 吃掉自己的注入块 | 只取 `role=user && source.kind!=='plugin'` |
| 门控锚定句首误杀 | 白名单否定 + 语料误杀率=0 |
| UTC 日期 8 点重置 | `localDay()` Asia/Shanghai |
| 生成物乱放 | 项目代码/测试在本目录；`data/` 本地且不进版本库 |
