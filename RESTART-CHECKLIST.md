# 重启后验证清单

## 一、这轮找到的真正根因（按你给的官方文档定位）

你给的 `reference/subsystems/session` 与 `/persistence` 两页**非常有用** —— 它们
直接指向了此前四轮都没看到的机制：

**一个 live 会话会被两条内存通路持续列出，删磁盘对它毫无影响：**

1. `sessionQuery.listSessions()` 用 `ctx.sessions.list()` 内存态**覆盖合并**磁盘结果
   （`dsh-session-query/lib/index.js:107-116`）；
2. jsonl 后端的 `list()` 还会返回 tracker 里 **created-but-never-materialized** 的
   pending 条目（`dsh-session-persistence-jsonl/lib/index.js:2593-2596`）；
   该 pending 只在**写句柄 close 且未落盘**时清除（同文件 `:372-378`，`pending` 是
   `new Map()` 纯内存态）。

你这台机器上那个删不掉的会话（`session-7601ce65-…`）恰好就是这种：
**磁盘上根本没有它的目录**（从未 materialize），但宿主一直持有它的 `session.lock`。
所以前几轮我删磁盘、摘记账、保留归档标记……**全都没用，因为它不在那一层。**

官方文档写明的销毁语义（原话）：
> 「`session/disposed` 会执行同样的最终排空并关闭句柄」

## 二、修法：调用官方 teardown 边缘（`evictLiveSession`）

平台内部 teardown 顺序 = **先摘 agent、再摘 session**：

| 步骤 | 调用 | 效果 |
|---|---|---|
| ① | `ctx.agents.store.get(id)` → `detachEntered(entry)` | 摘掉 agent 半身 |
| ② | `ctx.sessions.get(id)` → `liveEntryFor` → `detachEntered(entry)` | 移出 store、派发 `session/disposed` |
| ↳ | jsonl 收到 `session/disposed` | 关闭写句柄、**清掉 pending 条目** |
| ↳ | api-session-controller 收到 | `emit('api-session/removed')` |
| ↳ | 客户端 `handleSessionRemoved()` | 把该行从列表摘掉 |

删除流程现在按 **驱逐 → 删目录 → 清记账/归档** 执行。两个顺序坑都已处理：

- **驱逐必须早于 `rm`**：写句柄 `close()` 会 `drainLive()` 落盘，落盘路径 `mkdir`
  会把刚删的目录建回来。
- **rm 后还要复查**：`close()` 是 **fire-and-forget**（不 await），其 drain 仍可能
  晚于 `rm`；故 rm 后最多复查 3 轮、重建就再删（冷会话首次即 break，无额外延迟）。

另新增 `POST /evict` + 设置页「重试驱逐」：万一某次平台拒绝，不必等重启即可重试。

---

## 三、现在需要你做：重启 DSH

代码已 push（`537da86`）并装进 profile，但宿主进程仍是**旧模块**。

⚠️ **实测：`plugin_manager` 的 `set_bundle` 开关不能替代重启** —— disable→enable
返回 `application: applied`，但 Node 模块缓存让旧代码继续复用。**必须真重启。**

```sh
# 重启后确认宿主换了新进程
ps -o pid=,lstart= -p $(pgrep -f "dsh/lib/bin.js web")
```

## 第 1 步：确认新代码已加载（版本判据）

```sh
curl -s http://127.0.0.1:3080/api/dsh-archive-session-manager/list \
  | grep -q pendingRestart && echo "✓ 新代码已加载" || echo "✗ 仍是旧代码，需重启"
```

⚠️ **不要用 curl 验 POST 路由**（`/delete`、`/evict`、`/repair` 等）：本机宿主对 POST
一律回 `401`，且**不存在的路由也回 401**，无法区分。

## 第 2 步：清掉历史残留

那个卡了很久的 `session-7601ce65-…`：重启后它已不在内存（pending 表清空），
`pruneDeadArchived()` 会在首次打开面板时把它的归档 id 一并清掉。

## 第 3 步：原样重测你的场景（关键验收）

在任意空间：

1. 新建一个会话（**关键：新建后就在浏览器里打开它**，让它成为 live —— 这正是
   触发 pending 通路的条件）；
2. 归档它；
3. 用「···」菜单里的「删除会话」删掉；
4. **刷新页面**。

**预期（全部满足才算修好）**：
- 侧栏**不再出现**该会话（前提：视图筛选是「隐藏已归档」）；
- 「设置 → 归档会话」里也**没有**它，且**不出现**「待重启」提示；
- 磁盘上它的目录已删除。

若侧栏仍出现、或设置页出现「待重启」提示，点那条提示右侧的「**重试驱逐**」，
一般即可清掉；仍不行请把当时的界面发我。

### ⚠️ 顺便确认一件事（可能单独解释你之前看到的现象）

侧栏视图菜单有三档「已归档」筛选（`client.js:2900-2906`）：
**隐藏已归档（默认）** / **显示已归档** / **仅已归档**。

如果当时选的是「显示已归档」，那么归档会话本来就**会**显示在侧栏其工作区分组下 ——
平台预期设计。请确认你现在用哪一档。

## 第 4 步：确认没有误删

```sh
ls ~/.dsh/sessions/*/ | wc -l    # 与操作前对比
```

---

## 备份与回滚

备份：
- `~/.dsh/backups/asm-lib-index.js.before-repair-20261012-111006`
- `~/.dsh/backups/asm-profile-package.json.before-repair-20261012-111006`

回滚：
```sh
cd ~/.dsh/profiles/web && pnpm update dsh-archive-session-manager
```

## 仍未解决 / 如实告知

- 平台**没有**会话级删除 API（`sessionPersistence` 只有 create/open/stat/list）。
  本插件的删除始终是「驱逐内存态 + 删磁盘 + 清记账」的组合。
- `evictLiveSession` 用的是平台**内部 teardown 原语**（运行时可达，但不在公开
  Service 契约里）。若官方改内部结构，这里需要跟着调整 —— 已用 try/catch 兜底，
  失败会如实回报并降级为「重启收敛」，不会静默坏掉。
- 「重启后收敛」永远是最后兜底：pending 表与内存态都随进程重建。
