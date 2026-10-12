# 重启后验证清单

> 背景机制（真正的根因、`evictLiveSession` 的 teardown 链路、两个顺序坑）
> **以 [README.md](README.md) 为唯一事实来源** —— 本文只说「怎么验证」，
> 不再重复那份说明（此前两份各写一遍，已经漂移过一次）。

## 一、一句话概括

删不掉那个会话，是因为它**从未落盘**、却一直 live 在进程内存里，被**两条内存通路**
（`sessionQuery` 的内存态覆盖合并 + jsonl 的 pending 表）持续列出 —— 删磁盘对它无效。
修法是调用平台运行时可达的 teardown 原语（先拆 agent 再拆 session，触发
`session/disposed`）让平台真正忘掉它。细节见 README。

## 二、修法要点（只列与验证相关的两条顺序约束）

删除流程固定为 **驱逐 → 删目录 → 清记账/归档**：

- **驱逐必须早于 `rm`**：写句柄 `close()` 会 `drainLive()` 落盘，落盘路径 `mkdir`
  会把刚删的目录建回来。
- **rm 后还要复查**：`close()` 是 **fire-and-forget**（不 await），其 drain 仍可能
  晚于 `rm`；故 rm 后最多复查 3 轮、重建就再删（冷会话首次即 break，无额外延迟）。

另新增 `POST /evict` + 设置页「重试驱逐」：万一某次平台拒绝，不必等重启即可重试。

---

## 三、重启已完成（2026-10-12 15:39 实测通过）

宿主已重启，新代码已加载，历史残留已清干净 —— **本节的三步均已验证通过**，
保留作为「以后改了代码要不要重启 / 怎么确认」的可复用判据。

⚠️ **实测：`plugin_manager` 的 `set_bundle` 开关不能替代重启** —— disable→enable
返回 `application: applied`，但 Node 模块缓存让旧代码继续复用。**必须真重启。**

```sh
# 查出宿主 PID 与启动时间
# ⚠️ 不要用 ps -o ... -p $(pgrep -f "dsh/lib/bin.js web")：本机 pgrep -f 匹配单个
#    argv，而该模式含空格、跨参数，实测无输出 → ps 报 "option requires an argument"。
ps ax -o pid=,lstart=,command= | grep "lib/bin.js web" | grep -v grep
```

## 第 1 步：确认新代码已加载（版本判据）

⚠️ **判据必须是「只有新版本才有」的特征**。此前写的
`curl .../list | grep -q pendingRestart` **无效**：`pendingRestart` 字段旧版本
（`2b515eb` 起）就有，旧模块照样返回 `"pendingRestart":[]`，探测恒为「✓」。

用 `/evict` 路由是否存在来判（它是本版本才加的）：

```sh
# 已注册的 POST 路由会正常响应；未注册的路径才回 401。
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'content-type: application/json' -d '{}' \
  http://127.0.0.1:3080/api/dsh-archive-session-manager/evict
# 400 = 路由已注册（新代码）   401 = 路由不存在（旧代码）
```

⚠️ **已注册的 POST 路由是可以直接 curl 验证的**（这里此前写反了）：实测
`/delete` 400、`/repair` 200、`/cleanup-ghosts` 200、`/evict` 400、
`/detach-subagents` 200、`/empty-sessions` 200；只有**未注册**路径回 401。

## 第 2 步：清掉历史残留（已自动完成）

那个卡了很久的 `session-7601ce65-…`：重启后它不在内存里了（pending 表随进程重建），
`pruneDeadArchived()` 在首次打开面板时把它的归档 id 一并清掉。

实测确认（2026-10-12 16:00 左右）：`archivedSessionIds` 已为空、无任何工作区记账它、
宿主 `/list` 返回 `sessions: 0, pendingRestart: 0, ghosts: 0`。

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

侧栏视图菜单有三档「已归档」筛选（`dsh-client-ui-workspace/lib/client.js:2903-2905`）：
**隐藏已归档（默认）** / **显示已归档** / **仅已归档**。

如果当时选的是「显示已归档」，那么归档会话本来就**会**显示在侧栏其工作区分组下 ——
平台预期设计。请确认你现在用哪一档。

## 第 4 步：确认没有误删

```sh
find ~/.dsh/sessions -mindepth 2 -maxdepth 2 -type d | wc -l    # 与操作前对比（统计会话目录数，不是目录内文件数）
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

- 平台的**公开 Service 契约里没有**会话级删除 API（`sessionPersistence` 只有
  `create` / `open` / `flush` / `stat` / `list`）。本插件的删除始终是
  「驱逐内存态 + 删磁盘 + 清记账 + 清归档」的组合。
- `evictLiveSession` 用的是平台**内部 teardown 原语**（`detachEntered` /
  `liveEntryFor`）。它们在 `.d.ts` 里标 `private`，但**运行时可达**（不是 ES `#`
  私有字段），故插件可以调用 —— 这也是本插件唯一能真正删掉 live 会话的原因
  （README 的同一结论已按此更正，两份文档不再互相矛盾）。
  若官方改内部结构，这里需要跟着调整 —— 已用 try/catch 兜底，失败会如实回报
  并降级为「提示重启 + 可重试驱逐」，不会静默坏掉。
- 「重启后收敛」永远是最后兜底：pending 表与内存态都随进程重建。
