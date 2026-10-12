# dsh-archive-session-manager

归档会话管理插件：补上 DSH 目前缺失的「删除归档会话」能力。

- 会话「···」菜单里，**已归档**的会话多一项「删除会话」（带确认对话框，永久删除磁盘记录）。
- **设置 → 归档会话**：独立设置页，列出全部归档会话（标题 / 时间 / 目录 / 磁盘占用），支持**多选、全选、批量删除、批量取消归档**与刷新。

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
- **被打开过的会话，刷新页面可能再次出现（重要）**：
  平台把「当前进程内打开的会话」常驻在 `ctx.sessions` 内存注册表里，而会话列表
  （`sessionQuery.listSessions`）会把内存态会话并入结果 —— 于是磁盘文件即使已被删除，
  只要该会话在本进程内仍是 live，刷新页面时平台就会把它重新列出来（通常落在「未分组」，
  因为工作区记账已经摘掉了）。
  **这不是插件能修的**：平台的 `AgentRegistry` / `SessionStore` 没有对外暴露销毁入口
  （`AgentHandle.dispose()` 只属于创建方持有的 capability）。
  **应对：重启 DSH 即彻底消失**（重启后内存态重建，只以磁盘为准）。插件会在删除结果里
  明确提示这一点。
- 删除不可恢复。需要备份时请自行复制 `~/.dsh/sessions/` 下对应目录。

## 架构

| 半身 | 文件 | 职责 |
|---|---|---|
| 宿主 | `lib/index.js` | 三条同源路由：`GET /api/dsh-archive-session-manager/list`（列出归档会话 + 工作区 + 幽灵记账）、`POST .../delete`（校验 → 删目录 → `detachSession` 摘记账 → 清归档标记 → 发 `api-session/removed` 通知前端即时移除行）、`POST .../cleanup-ghosts`（清理磁盘已无却仍留在记账里的历史遗留） |
| 客户端 | `client/client.js` | ① `sidebar.workspaces.session.menu.item` 注册「删除会话」（order 500，danger 样式，仅归档行可见）② `settings.section` 注册「归档会话」设置页（order 65，按工作区分组的批量管理正文）③ `shell.overlay` 注册单个删除的确认对话框 |

## 已知坑（开发时实测）

- **宿主 ctx 是依赖注入代理**：未在 `inject` 里声明的服务，读属性时直接抛
  `cannot get property "<name>" without inject`。第一版只声明了 `webServer`，
  于是 `ctx.workspaceRegistry` 抛错、又被容错分支吞成空集，表现为「管理页打开但一条数据都没有」。
  现在 `inject` 声明全部四个服务，且读取失败**向上抛**（不再吞异常）。
- Cordis 的 `inject` 对象形式是「服务名 → 拦截配置」，不是 `{ required, optional }`
  （依据 `cordis/lib/types/registry.d.ts` 的 `Inject` 定义），所以只能用数组形式。

许可证：MIT
