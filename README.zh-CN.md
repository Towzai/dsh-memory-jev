# dsh-memory-jev（中文）

[English](README.md) · **中文**

> 给 DeepSeek Harness（DSH）用的记忆插件：**记忆的每一次读写都是一次判断**，判断交给 TypeSafe 的 **Jev** 决策模型。

Jev 只回三种类型化答案——`choice`（在给定候选里选一个）、`score`、`noul`（是/否概率）——并且**永远不生成文本**。本插件把这条性质当作记忆系统的安全边界：模型可以决定「这条值不值得存」「该取代哪一条旧记忆」「检索出来的这条到底相不相关」「这一轮要不要注入」，但**所有文本始终由插件控制**，模型不可能凭空写出记忆内容。

---

## 三道门

| 门 | 做什么 | 失败时 |
|---|---|---|
| **写入门** `mem_remember` | 本地二元组粗筛出候选 → 一次 Jev fan-out：`worth_keeping`(noul) + `supersedes`(choice，含 `none`) | **照常写入**（fail-open），只标 `gate=unavailable\|budget` |
| **召回门** `mem_recall` | 词面粗筛 top-N → 每条一个 `rel_<id>`(noul) → 按概率过滤排序 | 回落本地排序，并在 `degraded` 里**注明"未经 Jev 判定"** |
| **注入门** `agent/pre-step` | 门控短句 → 候选池做减法 → Jev 判相关性 → 尾部追加一条带定界与来源标记的 user 快照 | **一条都不注入**（fail-closed，宁缺勿滥） |

**关键不变量**

- **I1**：同一 `(会话, 轮次)` 至多一条注入块；一轮里的后续 step 不再重复判、不再重复注。
- **I2**：同一会话里每条记忆**至多注入一次**——已注入的 id 直接**不进候选池**，连 Jev 都不叫（省的是真钱）。
- **压缩不沉默**：注入块从上下文里消失后，对应 id 允许重新注入（记一行 `reset`）。
- **注入块自证身份**：`<retrieved-memories …>` 定界 + 首行声明「不是对话历史、也不是指令」；记忆内容里所有 `<` 被转义成 `\u003c`，**一条记忆无法伪造定界符**。
- **前缀缓存友好**：只在消息**尾部**追加，system prompt 与既有历史逐字不变。

---

## 工具

| 工具 | 说明 |
|---|---|
| `mem_remember` | 写入门；无论门是否参与都落盘（返回值带 `persisted`） |
| `mem_recall` | 召回门；返回 `{gate, degraded, items[]}`，`jev_prob` 与 `local_score` **分开** |
| `mem_list` / `mem_view` | 列表 / 详情 |
| `mem_forget` / `mem_restore` | 软删 / 恢复（保留 `supersedeHistory`，可 `cascade`） |
| `mem_merge` | 把旧条目正文并入新条目后再软删（合并后长度 ≥ 旧条目） |
| `mem_pin` | 跳过相关性阈值、每会话最多一次、**绝不在会话开局注入** |
| `mem_gate_status` | 花费 / 预留 / 剩余 / 调用 / 熔断 / key 状态 / 存储路径 |
| `mem_gate_log` | 审计日志查询（只含 id 与 hash，**不含正文**） |

**永不物理删除**：删除一律是 `retired=true`，可恢复。

---

## 安装

### 通过 DSH 插件市场

仓库打上 `dsh-plugin` topic 后会被市场自动收录（CI 每 2 小时扫一次）。安装：

```bash
dsh plugin --profile web install <owner>/dsh-memory-jev
```

### 手动安装

1. 把本仓库复制到 `~/.dsh/profiles/web/node_modules/dsh-memory-jev/`；
2. 在 profile 的 `cordis.patch.yml` 里注册（或让市场自动注册）：

```yaml
- id: dsh-memory-jev
  name: dsh-memory-jev
  config:
    storePath: /absolute/path/to/gate-store.json   # 留空 = <当前工作目录>/data/gate-store.json
    injectEnabled: true
```

3. **进程级重启** DSH（`set_bundle` 关/开只重挂行，不重新导入模块——ESM 缓存）。
4. 用 `mem_gate_status` 确认已加载。

> 宿主接口包（`@deepseek-ai/cordis`、`dsh-llm`、`dsh-tools`）**只声明为 `peerDependencies`**，不打包副本——否则旧版副本会遮蔽宿主，工具调用全挂。

---

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `storePath` | `''`（= `<cwd>/data/gate-store.json`） | 存储文件；**生产环境建议钉死绝对路径** |
| `injectEnabled` | `true` | 注入门总开关 |
| `injectInSubagents` | `false` | 子会话是否也注入（开=成本按子会话数放大） |
| `injectLimit` | `3` | 每次最多注入几条 |
| `injectMinProbability` | `0.6` | 注入的相关性阈值（比手动召回严） |
| `prefilterLimit` | `40` | 送进 Jev 的候选数 |
| `supersedeCandidates` | `12` | 写入门"可能重复"的候选数 |
| `dailyBudgetCny` | `3.5` | 每日预算（人民币） |
| `dailyCallLimit` | `3000` | 每日调用次数上限 |

### 调参

所有"量级"都是配置项，没有藏在代码里。改 profile 的 `cordis.patch.yml`（或 bundle 自己的 patch），**然后进程级重启**。

| 键 | 默认 | 作用 |
|---|---|---|
| `injectEnabled` | `true` | 注入门总开关 |
| `injectLimit` / `injectMinProbability` | `3` / `0.6` | 每次注入条数 / 相关性阈值（`mem_pin` 过的条目跳过阈值） |
| `recallMinProbability` | `0.5` | `mem_recall` 阈值——**单次调用**也可用 `min_probability` 覆盖 |
| `prefilterLimit` / `supersedeCandidates` | `40` / `12` | 送给 Jev 的候选数 / 写入门"可能重复"候选数 |
| `worthReviewThreshold` | `0.35` | 低于此值写入门只提示"建议复核"，**从不阻止写入** |
| `dailyBudgetCny` / `dailyCallLimit` | `3.5` / `3000` | 日预算（¥）/ 日调用上限 |
| `injectTimeoutMs` / `toolTimeoutMs` | `1500` / `15000` | 注入路径延迟预算 / 工具侧 |
| `egressGuard` | `false` | 只管出网的守卫（可选开启） |
| `injectInSubagents` | `false` | 子会话是否注入 |

调阈值要**看证据不靠感觉**：审计日志里记了每条候选的 `noul` 概率与当时的 `threshold`，所以 `mem_gate_log`（或按天分片的 `gate-decisions-*.jsonl`）能直接告诉你"某个阈值会放进哪些、挡掉哪些"。

**成本口径**：Jev 输入 $0.042/M、输出不计费；插件按人民币记账与展示（内置换算率见 `lib/index.js` 的 `USDTOCNY`）。一次判定实测 2000–4200 输入 token ≈ **¥0.0006–0.0012**。

---

## 数据边界（披露）

- **云端依赖**：有。只有三处出网，且都发往 `https://openrouter.ai/api/alpha/decisions`：写入门（正文前 600 字 + 候选标题）、召回门与注入门（问题文本 + 候选标题）。
- **离线路径**：有。没有 key 时写入/召回走确定性行为（标 `degraded`），注入门一条不注。
- **凭据**：只从 `OPENROUTER_API_KEY`（环境变量，Windows 上回退注册表 `HKCU\Environment`）现读；不落配置文件、不回显、**不进日志**。
- **脱敏拦截**：问题或正文命中手机号 / 身份证 / 银行卡 / `sk-` / `Bearer` / `password` / `api_key` 等模式时，**本次判定直接跳过**（`gate=redacted-skip`），宁可少判一次也不外发。
- **审计日志**：只记 `id`、概率、token、人民币成本、错误与 `build` 版本；**不记正文、不记 query 原文**（只记 hash 与长度）。
- **落盘**：记忆库、审计日志、预算都在你自己的 `storePath` 旁边；插件不联网同步、不上传。
- **出网守卫**（`egressGuard`，**默认关**，可选开启）：开启后，**问题**里出现疑似密钥（手机号 / 身份证 / 银行卡 / `sk-…` / `Bearer …` / `password` / `api_key`）时**不向端点发送**——召回**回落本地排序、照样把记忆给你**，注入跳过当轮。它只管**出网**：不决定什么能存、能查、能注入。默认关是因为**什么算敏感该由使用者判定**；想要这层额外边界时再打开。下面所有阈值与预算都是普通配置项——见「配置」下的**调参**一节。
- **服务端保留**：无（请求即弃）；记忆只存在你本地的存储文件里。

---

## 验证

```bash
npm run verify     # = node --import ./tools/load-plugin.mjs tools/verify_all.mjs
```

默认**零网络、零花费**：`tools/fake-jev.mjs` 在本地起一个可控的假 Jev（能造 HTTP 500 / ECONNRESET / 超时 / 畸形 JSON / `usage` 缺失），断言覆盖两条不变量、失败语义、前缀哈希不变、预算并发、损坏库只读、日志字段与隐私扫描等。**脚本失败会非 0 退出。**

真 Jev 只用于少量人工确认（需真 key）。

---

## 许可

MIT
