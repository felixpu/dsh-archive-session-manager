# 重启后验证清单

## 这次修了什么（两层，都已定位到源码行）

### 1. 删除 live 会话后掉进「未分组」（你截图的那个「疑问」）

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

---

## 现在需要你做：重启 DSH

代码已 push（`23699fd`）并装进 profile，但宿主进程仍是**旧模块**，改动不会生效。

```sh
# 重启后确认宿主换了新进程
ps -o pid=,lstart= -p $(pgrep -f "dsh/lib/bin.js web")
```

## 第 1 步：确认插件已加载

```sh
curl -s -o /dev/null -w "list -> %{http_code}\n" \
  http://127.0.0.1:3080/api/dsh-archive-session-manager/list
```

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

## 第 3 步：确认旧的遗留项已清

之前卡在「未分组」的 `session-996d624a-…` 磁盘目录已删除。重启后内存态重建，
它会自然消失。若仍看到残留的「未分组」条目，用设置页的「归位失效会话」处理。

## 第 4 步：确认没有误删

```sh
ls ~/.dsh/sessions/*/ | wc -l    # 计数与操作前一致即可
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

## 仍未解决（如实告知）

平台的 `AgentRegistry` / `SessionStore` **没有对外暴露销毁入口**
（`detachEntered` 是创建方持有的 capability，`dsh-session/lib/index.js:1882-1888`），
所以插件**无法**把 live 会话立刻踢出内存。本插件通过「保留归档态」让侧栏观感正确，
但该会话要到**重启 DSH 后**才真正从内存消失。这是平台限制，不是插件能修的。
