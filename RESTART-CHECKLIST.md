# 重启后验证清单

## ⚠️ 最重要的一条：平台没有「删除会话」这个 API

这是本轮按你要求**逐一核对官方 Service 契约**得出的结论，它决定了整个插件的边界：

| 服务 | 方法 | 有删会话吗 |
|---|---|---|
| `sessionPersistence` | create / open / flush / stat / list | ❌ |
| `sessionController` | list / search / create / rename / fork / prompt / cancel / page / follow … | ❌ |
| `workspaceRegistry` | create / delete(**工作区**) / archiveSession / unarchiveSession / pin … | ❌ |
| 客户端 `workspaces` | create / rename / delete(**工作区**) / archiveSession / unarchiveSession | ❌ |

会话离开内存的唯一通路是 `AgentHandle.dispose()`，而它是**创建方持有的 capability**，
第三方插件拿不到。所以「删除」只能是 **删磁盘 + 调归档集合 + 改工作区记账** 的组合近似。

**由此推出的必然后果**：对**还活在本进程内存里**的会话，删除**不可能当场完成** ——
必须保留归档标记来让侧栏隐藏它（否则它会掉进「未分组」），而那个标记要等**重启**才能清。
这不是偷懒，是平台能力边界。

---

## 这次修了什么（四个问题）

### 0. 「删除后对应空间又出现」的真正根因 —— 我上一轮引入的 no-op ★

你要我审查是对的。上一轮为阻止 live 会话掉进「未分组」，我对它采取「保留归档标记、
什么都不改」。副作用是**删除变成了 no-op**：

- 侧栏：被归档过滤器隐藏 ✓（这部分是对的）
- 但我自己的 `/list` **仍把它当普通归档会话列出** → 分组渲染在它的工作区下
- 用户点「删除」→ 那一行**毫无变化** → 刷新 → 还在 → 「问题一如既往」

真相是它**早已删除**（磁盘无、侧栏无），只剩一个等重启清掉的标记。

**修法**：`/list` 把「磁盘已无 + 仍 live」的条目从归档会话里摘出，单列 `pendingRestart`，
界面上明确写「已删除、不在侧栏、重启后清标记、**无需重复删除**」。
另加 `pruneDeadArchived()`：重启后首次打开面板时清掉垃圾标记。

### 1. 删除 live 会话后掉进「未分组」

**实证**：宿主进程 `lsof` 仍持有 `--Users-felix--/session-996d624a-…/session.lock`，
而该目录**已被删除**（`ls` 报 No such file），且该 id 既不在任何工作区记账里、
也不在归档集合里。

**机制**：平台列表来源 `sessionQuery.listSessions`（`dsh-session-query/lib/index.js:95-116`）
先放磁盘持久化结果，**再用 `ctx.sessions.list()`（内存 live 会话）覆盖合并** ——
所以磁盘已删但 live 的会话照样被列出。而删除流程里的 `detachSession` 已摘掉它的归属
→ 不属于任何工作区 → 被 `groupByWorkspace`（`dsh-client-ui-workspace/lib/client.js:1044/1060`）
归入 stray → **显示在「未分组」**。
（`rm` / `detachSession` / `unarchiveSession` 三步全都成功了，观感却仍是坏的。）

**修法**：删除流程按 live / 冷分流 ——
- **live**：不 `detachSession`、不 `unarchiveSession`，保留归档态与归属 → 归档过滤器
  （`client.js:986`）把它隐藏，侧栏干净；重启 DSH 后内存态重建，彻底消失。
- **冷**：照常 `detachSession` + `unarchiveSession`，干净清理。

### 2. 历史遗留会话从未被记账（另一个「未分组」来源）

`dsh-workspace/lib/index.js:178` 的 `mutate()` 会按 `host.sessionPath(id) === changed.path`
剪枝，而 `sessionPath` 要求 cwd 经 realpath 后存在。从未走过 `attachSession` 的历史目录
每次写入都被剪掉 → 永久钉在「未分组」。修法 = 设置页的「归位失效会话」。

⚠️ 归位**排除子智能体**：`sessionVisible`（`client.js:981`）对 `origin === 'subagent'`
直接返回 false，子智能体永远不作为列表行显示，不可能出现在「未分组」。
实测 37 个未记账会话里 **34 个是子智能体**。

### 3. 归档页里「0 B」的幽灵条目（你截图 2）

同一次修复引出的连带问题，两个根因都在「用拼出来的路径当判据」：

- `/list` 的 `orphan: dir === null` —— `sessionDirFor()` 只按 cwd+id **拼**路径字符串，
  磁盘早删了它也不是 null → 被误判成 orphan=false、`sizeBytes: 0`
  → 归档页显示成普通「0 B」行，看起来像"删了又回来了"。
- 删除流程同样只判 `dir === null` → 磁盘没了也走 `rm(force)` 静默成功，再到「live 保留
  归档态」那步 → **状态原地不动，反复点删除毫无效果**，条目永久卡住。

**修法**：两处都改成 `existsSync(dir)` 实测磁盘。
⚠️ 字段后来从 `liveOrphan` 改成了**独立数组 `pendingRestart`**（见上面第 0 条）：
这类条目根本不该出现在归档会话列表里，而不是在列表里加个字段说明。

四象限已隔离实测：live+在 / cold+在 / live+不在 / cold+不在，四种组合行为均符合预期。

### 4. 判归属时误用 getter，导致脏记账清不掉

`findWorkspaceOf()` 与 `/list` 的 owner 映射都在用 getter `ws.sessionIds`。
getter 会按内存 header 索引过滤，会**把正需要清理的 id 自己隐藏掉** →
`detachSession` 找不到目标 → 幽灵/脏记账永远清不掉。已全部改用记账原文
`ws.record.sessionIds`（与本项目既有规则一致）。

---

## 现在需要你做：重启 DSH

代码已 push（`e329f7e`）并装进 profile，但宿主进程仍是**旧模块**。

⚠️ **实测：`plugin_manager` 的 `set_bundle` 开关不能替代重启** —— 我试过
disable→enable，返回 `application: applied`，但 Node 的模块缓存让**旧代码继续复用**
（`/list` 仍不返回 `pendingRestart` 字段）。**必须真重启宿主进程。**

```sh
# 重启后确认宿主换了新进程
ps -o pid=,lstart= -p $(pgrep -f "dsh/lib/bin.js web")
```

## 第 1 步：确认插件已加载（含版本判据）

```sh
curl -s -o /dev/null -w "list -> %{http_code}\n" \
  http://127.0.0.1:3080/api/dsh-archive-session-manager/list
```

**更可靠的一步：确认运行中的是哪个版本**（比看文件 mtime 更有力，直接证明进程内的代码）：

```sh
curl -s http://127.0.0.1:3080/api/dsh-archive-session-manager/list \
  | grep -q pendingRestart && echo "✓ 新代码已加载" || echo "✗ 仍是旧代码，需重启"
```

`pendingRestart` 是本轮新增字段。旧代码的响应里没有它 —— 有它就说明新代码在跑。

返回 `200` 即已加载。⚠️ **不要用 curl 验 `/repair` 或任何 POST 路由** ——
本机宿主对 POST 一律回 `401`，且**不存在的路由也回 401**，无法区分。

## 第 2 步：原样重测你的场景（这是关键验收）

在 felix 空间：

1. 新建一个会话；
2. 归档它；
3. 用「···」菜单里的「删除会话」删掉；
4. **刷新页面**。

**预期**：侧栏**不再出现**「未分组」里的那条会话 ✅
（删除结果提示会说：磁盘记录已删除、它不会出现在侧栏、重启 DSH 后彻底消失。）

> 原理：这类 live 会话保留了归档标记，被归档过滤器隐藏；同时保留归属，
> 所以即使平台把它重新并进列表，它也不会掉进「未分组」。

## 第 3 步：归档页里那条条目的说明应已变正确

`Single question mark inquiry`（`session-986e44ce-…`）在**设置 → 归档会话**里
现在的说明应为：

> 磁盘记录已删除；该会话在本进程内仍被平台持有（不会出现在侧栏），重启 DSH 后彻底消失

而**不再是**一个让人误解的「0 B」普通行。重启后它会从这里彻底消失。

## 第 4 步：确认没有误删

```sh
ls ~/.dsh/sessions/*/ | wc -l    # 计数与操作前一致即可
```

## 第 5 步（可选）：清理子智能体误记账

本插件早期版本曾把 33 个子智能体误挂进工作区记账（ant_link 16 / dsh-plugins 14 /
felix 3，记账总数被从基线 32 撑到 66）。重启后设置页会出现提示条：

> 检测到 33 个子智能体被记在了工作区归属里（它们本不该占用工作区的会话槽位）

点「一键摘除」即可恢复到基线。**只改记账、不动磁盘文件**，子智能体仍属于其父会话。

## 第 6 步（可选）：清理遗留空会话

重启后设置页还会出现：

> 检测到 6 个遗留空会话（建了但从未有过对话，共约 2 KB）

这是「建了却从没用过」的会话目录（事件里没有任何 `user/message`，只有配置事件）。
点「清理空会话」→ 两步确认 → 永久删除。

⚠️ **这是本插件唯一会真正删除磁盘文件的功能**，因此：
- 走两步确认（「再想想」/「确认删除」）；
- 宿主**二次逐帧校验**，任何含 `user/message` 的会话一律拒删；
- 拒删仍 live 的会话与已归档会话；
- 删除后同步摘除工作区记账（否则会留下幽灵条目）。

注意：其中 4 个是**已记账**的（felix 2 / ant_link 1 / dsh-plugins 1），
删掉后它们的工作区会话数会相应减少 —— 这是预期的，因为磁盘记录已不存在。

---

## 备份与回滚

备份：
- `~/.dsh/backups/asm-lib-index.js.before-repair-20261012-111006`
- `~/.dsh/backups/asm-profile-package.json.before-repair-20261012-111006`

回滚：
```sh
cd ~/.dsh/profiles/web && pnpm update dsh-archive-session-manager
```

## 仍未解决（如实告知）

平台的 `AgentRegistry` / `SessionStore` **没有对外暴露销毁入口**
（`detachEntered` 是创建方持有的 capability，`dsh-session/lib/index.js:1882-1888`），
所以插件**无法**把 live 会话立刻踢出内存。本插件通过「保留归档态」让侧栏观感正确，
但该会话要到**重启 DSH 后**才真正从内存消失。这是平台限制，不是插件能修的。
