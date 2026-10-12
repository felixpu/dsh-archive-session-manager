# dsh-archive-session-manager

归档会话管理插件：补上 DSH 目前缺失的「删除归档会话」能力。

- 会话「···」菜单里，**已归档**的会话多一项「删除会话」（带确认对话框，永久删除磁盘记录）。
- **设置 → 归档会话**：独立设置页，列出全部归档会话（标题 / 时间 / 目录 / 磁盘占用），支持**多选、全选、批量删除、批量取消归档**与刷新。
- **归位失效会话**：把「磁盘上有、但不在任何工作区记账里」的会话（它们会显示在侧栏「未分组」）重新挂回 cwd 对应的工作区。只修归属，不删文件；子智能体会被自动跳过（侧栏本就不显示它们）。
- **一键摘除误记账的子智能体**：子智能体不该占用用户工作区的归属槽位（侧栏也不把它们显示为列表行，只在父会话上以计数徽标出现）。若历史版本把子智能体挂进了记账，这里可一键摘除，只改记账、不动磁盘。

入口放在设置页而非侧栏：这是低频的批量维护操作，不是会话内的日常动作。

## 安装

```sh
dsh plugin --profile web add github:felixpu/dsh-archive-session-manager
```

## 安全边界（设计决定）

- **只有已归档的会话可以删除**。未归档会话没有删除入口；即使直接调接口也会被 409 拒绝——归档本身就是「确认不再使用」的动作，插件不另造确认语义。
- 只有**正在执行任务**（`agent.status === 'running'`）的会话拒绝删除；被打开过但处于 idle 的会话允许删除（它只是常驻内存，并没有进行中的写入）。
- 会话目录路径严格限制在 `$DSH_HOME/sessions/` 之下并做前缀校验。

## 平台局限（如实告知）

- DSH 平台目前**没有官方的删除会话 API**（`workspaceRegistry` / `sessionPersistence` 均无）。本插件的删除 = 删磁盘会话目录 + 从工作区记账摘除（`detachSession`）+ 从归档集合移除。
- **被打开过的会话，磁盘文件删掉后仍会被平台列出**：
  平台把「当前进程内打开的会话」常驻在 `ctx.sessions` 内存注册表里，而会话列表
  （`sessionQuery.listSessions`，`dsh-session-query/lib/index.js:95-116`）会**先用磁盘
  持久化结果、再用内存 live 会话覆盖合并** —— 于是磁盘文件即使已被删除，
  只要该会话在本进程内仍是 live，刷新页面时平台就会把它重新列出来。
  **这不是插件能修的**：平台的 `AgentRegistry` / `SessionStore` 没有对外暴露销毁入口
  （`AgentHandle.dispose()` / `detachEntered` 只属于创建方持有的 capability，
  `dsh-session/lib/index.js:1882-1888`）。
  **本插件的处理**：对这类 live 会话**保留归档标记、且不摘记账** —— 归档标记让它被
  侧栏的归档过滤器隐藏（不会掉进「未分组」），记账保留让它保持归属。
  **应对：重启 DSH 即彻底消失**（重启后内存态重建，只以磁盘为准）。插件会在删除结果里
  明确提示这一点。

## 「未分组」的会话从哪来（两个来源，都实测确诊）

现象：删除一个归档会话后刷新页面，侧栏里冒出「未分组」分组。

⚠️ 这里有**两个不同的成因**，早期版本曾把它们混为一谈（先误判为只有 live 残留，
后又误判为只有历史遗留），实际两者都会发生：

### 来源一：live 会话被摘记账（「刚删的那个又回来了」）

这正是上面「被打开过的会话」那条。删除时插件调 `detachSession` 摘掉了归属，但会话
仍活在内存里、被列表重新并入 —— 结果是**一个没有任何归属的会话**，必然落进「未分组」。

**实证**（2026-10-12）：宿主 `lsof` 显示进程仍持有
`--Users-felix--/session-996d624a-…/session.lock`，而该目录**已被删除**（`ls` 报
No such file）；同时该 id 既不在任何工作区记账里、也不在归档集合里 → 刷新后必然出现在
「未分组」，与用户截图（标题「疑问」、时间「2 分钟」）完全吻合。

**修法（已实现）**：宿主的删除流程区分 live / 冷会话 ——
- **live**：**不** `detachSession`、**不** `unarchiveSession`，保持归档态与归属。
  归档过滤器会把它隐藏，侧栏干净；重启后彻底消失。
- **冷**（不在内存中）：照常 `detachSession` + `unarchiveSession`，干净清理，
  不留下归档集合里的孤儿 id。

### 来源二：从未被记账的历史遗留会话（「另外一批老会话」）

会话只要**不在任何** `workspace.sessionIds` **里**，就被归入 `group.ungrouped`
（`dsh-client-ui-workspace/lib/client.js:1060`）。而有些会话**从来没进过记账**：

`dsh-workspace/lib/index.js:178` 的 `mutate()` 写入时会剪枝：
```js
const sessionIds = changed.sessionIds.filter((id) => this.host.sessionPath(id) === changed.path)
```
`sessionPath` 由 `indexHeader()` 填充，要求 header 的 `cwd` 经 realpath 后**仍是存在的目录**。
历史遗留目录从未走过 `attachSession`，于是每次记账写入都被剪掉，永久钉在「未分组」。

**修法（已实现）**：设置 → 归档会话 里的「归位失效会话」—— 对这些会话调 `attachSession`。
该方法会**先**校验 `cwd` 并调 `host.rememberSessionPath(id, cwd)`，**再**执行 `mutate`，
正好解开上面那个剪枝死结（依据 `dsh-workspace/lib/index.js:111-127`）。只读预览走
`POST /api/dsh-archive-session-manager/repair` 的 `{ "dryRun": true }`。

⚠️ **归位必须排除子智能体**：侧栏可见性判据是 `sessionVisible()`
（`dsh-client-ui-workspace/lib/client.js:981`）——
`if (session.origin === "subagent") return false;`
子智能体**永远不作为列表行显示**（只在父会话行上以「N 个子智能体运行中」计数徽标出现），
所以它们不可能出现在「未分组」里。实测本机 37 个未记账会话中 **34 个是子智能体**，
若不排除会把它们塞进用户工作区的记账（属语义错误的脏数据）。归位逻辑已显式跳过
`origin === 'subagent'`。

⚠️ 判据必须是**磁盘 + 记账原文**：读工作区记账要读 `ws.record.sessionIds`，
不要读 getter `ws.sessionIds` —— getter 会按内存 header 索引过滤，而平台索引**只增不删**，
会让「磁盘已无 / 磁盘有但未记账」这两类都被自己过滤掉，检测恒为空（幽灵检测踩过同一个坑）。

- 删除不可恢复。需要备份时请自行复制 `~/.dsh/sessions/` 下对应目录。

## 架构

| 半身 | 文件 | 职责 |
|---|---|---|
| 宿主 | `lib/index.js` | 五条同源路由：`GET /api/dsh-archive-session-manager/list`（列出归档会话 + 工作区 + 幽灵记账）、`POST .../delete`（校验 → 删目录 → **live 会话保留归档态与归属 / 冷会话 `detachSession` 摘记账** → 发 `api-session/removed` 通知前端即时移除行）、`POST .../cleanup-ghosts`（清理磁盘已无却仍留在记账里的历史遗留）、`POST .../repair`（把「磁盘有、记账无」的会话用 `attachSession` 归位，**跳过子智能体**，支持 `dryRun` 预览；不删任何文件）、`POST .../detach-subagents`（把被误记账的子智能体从工作区归属中摘除，只改记账不动磁盘） |
| 客户端 | `client/client.js` | ① `sidebar.workspaces.session.menu.item` 注册「删除会话」（order 500，danger 样式，仅归档行可见）② `settings.section` 注册「归档会话」设置页（order 65，按工作区分组的批量管理正文，另含「归位失效会话」「一键摘除误记账的子智能体」两个维护入口）③ `shell.overlay` 注册单个删除的确认对话框 |

## 已知坑（开发时实测）

- **宿主 ctx 是依赖注入代理**：未在 `inject` 里声明的服务，读属性时直接抛
  `cannot get property "<name>" without inject`。第一版只声明了 `webServer`，
  于是 `ctx.workspaceRegistry` 抛错、又被容错分支吞成空集，表现为「管理页打开但一条数据都没有」。
  现在 `inject` 声明全部四个服务，且读取失败**向上抛**（不再吞异常）。
- Cordis 的 `inject` 对象形式是「服务名 → 拦截配置」，不是 `{ required, optional }`
  （依据 `cordis/lib/types/registry.d.ts` 的 `Inject` 定义），所以只能用数组形式。

许可证：MIT
