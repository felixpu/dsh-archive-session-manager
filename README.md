# dsh-archive-session-manager

归档会话管理插件：补上 DSH 目前缺失的「删除归档会话」能力。

- 会话「···」菜单里，**已归档**的会话多一项「删除会话」（带确认对话框，永久删除磁盘记录）。
- **设置 → 归档会话**：独立设置页，列出全部归档会话（标题 / 时间 / 目录 / 磁盘占用），支持**多选、全选、批量删除、批量取消归档**与刷新。
- **归位失效会话**：把「磁盘上有、但不在任何工作区记账里」的会话（它们会显示在侧栏「未分组」）重新挂回 cwd 对应的工作区。只修归属，不删文件；子智能体会被自动跳过（侧栏本就不显示它们）。
- **一键摘除误记账的子智能体**：子智能体不该占用用户工作区的归属槽位（侧栏也不把它们显示为列表行，只在父会话上以计数徽标出现）。若历史版本把子智能体挂进了记账，这里可一键摘除，只改记账、不动磁盘。
- **清理遗留空会话**：找出「建了但从未有过对话」（事件里没有任何 `user/message`）的历史会话目录并永久删除。**这是唯一会真删文件的功能**，因此走两步确认，且宿主会**二次校验**——任何有对话内容的会话一律拒删（判据在服务端重算，不信任前端传来的 id）。

入口放在设置页而非侧栏：这是低频的批量维护操作，不是会话内的日常动作。

## 安装

```sh
dsh plugin --profile web add github:felixpu/dsh-archive-session-manager
```

## 安全边界（设计决定）

- **只有已归档的会话可以删除**。未归档会话没有删除入口；即使直接调接口也会被 409 拒绝——归档本身就是「确认不再使用」的动作，插件不另造确认语义。
- 只有**正在执行任务**（`agent.status === 'running'`）的会话拒绝删除；被打开过但处于 idle 的会话允许删除（它只是常驻内存，并没有进行中的写入）。
- 会话目录路径严格限制在 `$DSH_HOME/sessions/` 之下并做前缀校验。

## 平台局限（如实告知，已逐一核对官方 Service 契约）

**DSH 平台没有「删除会话」这个动作。** 这不是猜测，是逐个方法核对的结论：

| 服务 | 方法 | 有删除会话吗 |
|---|---|---|
| `sessionPersistence` | `create` / `open` / `flush` / `stat` / `list` | ❌ |
| `sessionController`（Remote） | `list` / `search` / `create` / `rename` / `fork` / `prompt` / `cancel` / `page` / `follow` / `projections` / `control` | ❌ |
| `workspaceRegistry` | `create` / `delete`（**工作区**）/ `archiveSession` / `unarchiveSession` / `pin` … | ❌ |
| 客户端 `workspaces` | `create` / `rename` / `delete`（**工作区**）/ `archiveSession` / `unarchiveSession` | ❌ |

会话离开内存的唯一通路是 `AgentHandle.dispose()`，而它是**创建方持有的 capability**
（`dsh-agent` 契约原文：“The disposer is a CAPABILITY”），第三方插件**拿不到**。

⇒ 本插件的「删除」只能是**三件事的组合近似**：删磁盘目录 + 从归档集合移除 + 从工作区记账
摘除（`detachSession`）。这个边界决定了下面的行为，**无法通过改进实现绕过**。

### 于是有一个必须如实告知的终态：`pendingRestart`

`sessionQuery.listSessions()`（`dsh-session-query/lib/index.js:95-116`）**先用磁盘持久化
结果、再用 `ctx.sessions.list()` 内存 live 会话覆盖合并** —— 所以只要会话在本进程内仍
live，磁盘删掉了它仍会被列出。若此时摘掉归档标记，它就失去「隐藏理由」而落进侧栏
「未分组」；若保留标记，它会被归档过滤器隐藏（`dsh-client-ui-workspace/lib/client.js:986`），
侧栏干净，但该标记要等重启才能清。

**本插件的处理（`lib/index.js` 的 delete 路由 + `pruneDeadArchived`）**：

| 场景 | 归档标记 | 工作区记账 | 界面表现 |
|---|---|---|---|
| live + 磁盘在 | 保留 | 保留 | 删除后从归档列表消失，转入「待重启」提示 |
| 冷 + 磁盘在 | 清除 | 清除 | 彻底删除 |
| **live + 磁盘已无** | **保留** | **保留** | 归入 `pendingRestart`，**不列在归档会话里** |
| 冷 + 磁盘已无 | 清除 | 清除 | 清理归档记录 |

- `pendingRestart` 的条目**不再出现在归档会话列表**中 —— 否则用户点「删除」那一行
  原地不动，观感就是「删了又回来了」（这正是实测反馈的根因：删除对 live 会话曾是 no-op）。
  它们单独显示为一条提示：磁盘已删、不在侧栏、重启 DSH 后清掉标记、无需重复删除。
- 重启后首次打开面板时，`pruneDeadArchived()` 会把「磁盘无同名目录 **且** 非 live」
  的归档 id 清出归档集合（扫描失败则**不清**：清归档集合是破坏性动作，信息不全时宁可留着）。

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
  归档过滤器会把它隐藏，侧栏干净；重启后由 `pruneDeadArchived()` 清掉标记。
  ⚠️ 配套要求：这类条目**不能**再出现在归档会话列表里（否则用户点删除毫无变化，
  观感是「删了又回来」）—— 已改归 `pendingRestart` 单列，见上文。
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
| 宿主 | `lib/index.js` | 六条同源路由 + 启动期清理：`GET .../list`（列出归档会话 + 工作区 + 幽灵记账 + **pendingRestart**）、`POST .../delete`（校验 → 删目录 → **live 会话保留归档态与归属 / 冷会话 `detachSession` 摘记账** → 发 `api-session/removed`）、`POST .../cleanup-ghosts`、`POST .../repair`（`attachSession` 归位，**跳过子智能体**，支持 `dryRun`）、`POST .../detach-subagents`（只改记账）、`POST .../empty-sessions`（列出/删除**从未有过对话**的空会话；服务端二次校验、拒删有内容的）；另有 `pruneDeadArchived()` 在启动后首次列表时清掉「磁盘无、非 live」的垃圾归档标记 |
| 客户端 | `client/client.js` | ① `sidebar.workspaces.session.menu.item` 注册「删除会话」（order 500，danger 样式，仅归档行可见）② `settings.section` 注册「归档会话」设置页（order 65，按工作区分组的批量管理正文，另含「归位失效会话」「一键摘除误记账的子智能体」「清理遗留空会话」入口，以及 `pendingRestart` 状态提示）③ `shell.overlay` 注册单个删除的确认对话框 |

## 已知坑（开发时实测）

- **宿主 ctx 是依赖注入代理**：未在 `inject` 里声明的服务，读属性时直接抛
  `cannot get property "<name>" without inject`。第一版只声明了 `webServer`，
  于是 `ctx.workspaceRegistry` 抛错、又被容错分支吞成空集，表现为「管理页打开但一条数据都没有」。
  现在 `inject` 声明全部四个服务，且读取失败**向上抛**（不再吞异常）。
- Cordis 的 `inject` 对象形式是「服务名 → 拦截配置」，不是 `{ required, optional }`
  （依据 `cordis/lib/types/registry.d.ts` 的 `Inject` 定义），所以只能用数组形式。
- **「拼出来的路径」≠「磁盘上存在」**：`sessionDirFor()` 只按 `projectKey(cwd)+id`
  **拼**路径，磁盘早删了它也不返回 null。曾把 `orphan: dir === null` 当判据 →
  删除后条目在归档页以「0 B」普通行停留、且反复点删除**原地空转**。
  凡判「磁盘上有没有」，必须真的 `existsSync`/`stat`。
- **会话日志是多帧 zstd，`zstdDecompressSync(整个 Buffer)` 只解第一帧**：
  实测一个 1.2 MB 的 `session.v4.jsonl.zstd` 含 **826 帧**，只解首帧仅得 288 字节 header，
  会把**有真实对话的会话误判成空会话**。凡需「全部事件」的判断（如是否为空会话）
  必须逐帧解（见 `readLogText`）。
- **不要照抄平台的 `CANONICAL_LOG_FILENAME` 去扫磁盘**：平台那个常量
  （`dsh-session-format/lib/index.js:464`）匹配的是**逻辑名**（无压缩后缀），
  磁盘上的**物理名**要再拼 `.zstd`（由 `dsh-session-persistence-jsonl/lib/index.js:747-763`
  的 `logSuffix`/`generationLogFilename` 负责）。照抄会导致匹配恒为空、扫描结果 0，
  **失败表现为成功**且 `node --check` 照样通过。
- **子智能体（`origin === 'subagent'`）永远不显示为列表行**
  （`sessionVisible`，`dsh-client-ui-workspace/lib/client.js:981`），所以它们与
  「未分组」无关，归位时必须排除；它们只是不该占用工作区的归属记账槽位。
- **不要让「删除」变成 no-op**（本项目付出最多代价的教训）：为规避某个副作用而
  保留状态、什么都不改时，**用户界面上必须同步反映「这件事已经做完了」**。
  曾为阻止 live 会话掉进「未分组」而对它保留归档标记，结果 `/list` 仍把它当普通
  归档会话列出 —— 用户点删除、那一行原地不动，观感就是「删了又回来」，连查两轮。
  正确做法：把这类条目从「待办列表」里摘出去，单列成如实的状态说明。
- **先读官方契约再动手**：本插件的能力边界（平台没有删除会话的 API）是逐条核对
  `cordis_inspect_query` 的 host/client `Service` 目录 + 各包源码得出的。
  凭记忆或凭「应该有」去设计，会把平台限制误当成自己的 bug 反复"修"。

许可证：MIT
