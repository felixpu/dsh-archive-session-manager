# dsh-archive-session-manager

归档会话管理插件：补上 DSH 目前缺失的「删除归档会话」能力。

- 会话「···」菜单里，**已归档**的会话多一项「删除会话」（带确认对话框，永久删除磁盘记录）。
- **设置 → 归档会话**：独立设置页，列出全部归档会话（标题 / 时间 / 目录 / 磁盘占用），支持**多选、全选、批量删除、批量取消归档**与刷新。
- **归位失效会话**：把「磁盘上有、但不在任何工作区记账里」的会话（它们会显示在侧栏「未分组」）重新挂回 cwd 对应的工作区。只修归属，不删文件。

入口放在设置页而非侧栏：这是低频的批量维护操作，不是会话内的日常动作。

## 安装

```sh
dsh plugin --profile web add github:felixpu/dsh-archive-session-manager
```

## 安全边界（设计决定）

- **只有已归档的会话可以删除**。未归档会话没有删除入口；即使直接调接口也会被 409 拒绝——归档本身就是「确认不再使用」的动作，插件不另造确认语义。
- live agent（进程内仍挂载的会话）拒绝删除。
- 会话目录路径严格限制在 `$DSH_HOME/sessions/` 之下并做前缀校验。

## 平台局限（如实告知）

- DSH 平台目前**没有官方的删除会话 API**（`workspaceRegistry` / `sessionPersistence` 均无）。本插件的删除 = 删磁盘会话目录 + 从工作区记账摘除（`detachSession`）+ 从归档集合移除。
- **被打开过的会话，刷新页面可能再次出现**：
  平台把「当前进程内打开的会话」常驻在 `ctx.sessions` 内存注册表里，而会话列表
  （`sessionQuery.listSessions`）会把内存态会话并入结果 —— 于是磁盘文件即使已被删除，
  只要该会话在本进程内仍是 live，刷新页面时平台就会把它重新列出来。
  **这不是插件能修的**：平台的 `AgentRegistry` / `SessionStore` 没有对外暴露销毁入口
  （`AgentHandle.dispose()` 只属于创建方持有的 capability）。
  **应对：重启 DSH 即彻底消失**（重启后内存态重建，只以磁盘为准）。插件会在删除结果里
  明确提示这一点。

## 「未分组」的会话从哪来（重要，曾误判）

现象：删除一个归档会话后刷新页面，侧栏里冒出「未分组」分组，里面是些点开为空、标题像
占位符的会话。

**这不是删除造成的，也不是 live 会话残留。** 上面那条「live 会话刷新重现」只解释
「刚删掉的那个会话又出现」；而「未分组」里出现的往往是**另外一批早就存在的历史会话**，
只是此前被归档列表挡着没露头。真实机制（均已读源码定位）：

1. **归组规则**：`dsh-client-ui-workspace/lib/client.js:1060` —— 会话只要**不在任何**
   `workspace.sessionIds` **里**，就被归入 `group.ungrouped`（中文即「未分组」）。
2. **为什么它会不在记账里**：`dsh-workspace/lib/index.js:178` 的 `mutate()` 写入时会做一次剪枝：
   ```js
   const sessionIds = changed.sessionIds.filter((id) => this.host.sessionPath(id) === changed.path)
   ```
   而 `sessionPath` 由 `indexHeader()` 填充，要求 header 的 `cwd` 经 realpath 后**仍是存在的目录**。
   历史遗留目录（例如旧版命名的**裸 UUID 目录**，不带 `session-` 前缀）从未走过 `attachSession`，
   于是每次记账写入都被剪掉，**永远进不了归属**，也就永久钉在「未分组」。
3. **为什么「删归档」会让你第一次看到它**：删除流程会调 `detachSession` + `unarchiveSession`，
   触发记账重写并清空归档集合；归档筛选不再遮挡后，这批本来就在「未分组」的会话才显现出来。

**修法（本插件已提供）**：设置 → 归档会话 里的「归位失效会话」——
对这些会话调 `attachSession`。该方法会**先**校验 `cwd` 并调
`host.rememberSessionPath(id, cwd)`，**再**执行 `mutate`，正好解开上面那个剪枝死结
（依据 `dsh-workspace/lib/index.js:111-127`）。对应的只读预览走
`POST /api/dsh-archive-session-manager/repair` 的 `{ "dryRun": true }`。

⚠️ 判据必须是**磁盘 + 记账原文**：读工作区记账要读 `ws.record.sessionIds`，
不要读 getter `ws.sessionIds` —— getter 会按内存 header 索引过滤，而平台索引**只增不删**，
会让「磁盘已无 / 磁盘有但未记账」这两类都被自己过滤掉，检测恒为空（幽灵检测踩过同一个坑）。

- 删除不可恢复。需要备份时请自行复制 `~/.dsh/sessions/` 下对应目录。

## 架构

| 半身 | 文件 | 职责 |
|---|---|---|
| 宿主 | `lib/index.js` | 四条同源路由：`GET /api/dsh-archive-session-manager/list`（列出归档会话 + 工作区 + 幽灵记账）、`POST .../delete`（校验 → 删目录 → `detachSession` 摘记账 → 清归档标记 → 发 `api-session/removed` 通知前端即时移除行）、`POST .../cleanup-ghosts`（清理磁盘已无却仍留在记账里的历史遗留）、`POST .../repair`（把「磁盘有、记账无」的会话用 `attachSession` 归位，支持 `dryRun` 预览；不删任何文件） |
| 客户端 | `client/client.js` | ① `sidebar.workspaces.session.menu.item` 注册「删除会话」（order 500，danger 样式，仅归档行可见）② `settings.section` 注册「归档会话」设置页（order 65，按工作区分组的批量管理正文）③ `shell.overlay` 注册单个删除的确认对话框 |

## 已知坑（开发时实测）

- **宿主 ctx 是依赖注入代理**：未在 `inject` 里声明的服务，读属性时直接抛
  `cannot get property "<name>" without inject`。第一版只声明了 `webServer`，
  于是 `ctx.workspaceRegistry` 抛错、又被容错分支吞成空集，表现为「管理页打开但一条数据都没有」。
  现在 `inject` 声明全部四个服务，且读取失败**向上抛**（不再吞异常）。
- Cordis 的 `inject` 对象形式是「服务名 → 拦截配置」，不是 `{ required, optional }`
  （依据 `cordis/lib/types/registry.d.ts` 的 `Inject` 定义），所以只能用数组形式。

许可证：MIT
