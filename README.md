# dsh-archive-session-manager

归档会话管理插件：补上 DSH 目前缺失的「删除归档会话」能力。

- 会话「···」菜单里，**已归档**的会话多一项「删除会话」（带确认对话框，永久删除磁盘记录）。
- 侧栏底部新增「归档管理」入口：列出全部归档会话（标题 / 时间 / 目录 / 磁盘占用），支持**多选、全选、批量删除、批量取消归档**。

## 安装

```sh
dsh plugin --profile web add github:felixpu/dsh-archive-session-manager
```

## 安全边界（设计决定）

- **只有已归档的会话可以删除**。未归档会话没有删除入口；即使直接调接口也会被 409 拒绝——归档本身就是「确认不再使用」的动作，插件不另造确认语义。
- live agent（进程内仍挂载的会话）拒绝删除。
- 会话目录路径严格限制在 `$DSH_HOME/sessions/` 之下并做前缀校验。

## 平台局限（如实告知）

- DSH 平台目前**没有官方的删除会话 API**（`workspaceRegistry` / `sessionPersistence` 均无）。本插件的删除 = 从归档集合移除 + 递归删除磁盘上的会话目录。
- 全文搜索索引（dsh-session-query-sqlite）可能残留已删会话的条目，待其自行重建，不影响会话列表与使用。
- 删除不可恢复。需要备份时请自行复制 `~/.dsh/sessions/` 下对应目录。

## 架构

| 半身 | 文件 | 职责 |
|---|---|---|
| 宿主 | `lib/index.js` | 两条同源路由：`GET /api/dsh-archive-session-manager/list`（只读列出归档会话）与 `POST .../delete`（校验 → 删目录 → 移出归档集合 → `connection/reset` 通知前端刷新） |
| 客户端 | `client/client.js` | ① `sidebar.workspaces.session.menu.item` 注册「删除会话」（order 500，仅归档行可见）② `sidebar.footer.action` 注册「归档管理」入口 ③ `shell.overlay` 注册确认对话框与批量管理面板 |

许可证：MIT
