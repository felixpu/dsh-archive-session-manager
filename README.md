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

### ⚠️ 关键：live 会话会被**两条内存通路**持续列出

这是「删了又回来」的真正机制（2026-10-12 按官方文档 + 源码定位）：

1. `sessionQuery.listSessions()` 用 `ctx.sessions.list()` 内存态**覆盖合并**磁盘结果
   （`dsh-session-query/lib/index.js:107-116`）；
2. jsonl 后端的 `list()` 还会把 tracker 里 **created-but-never-materialized** 的
   pending 条目也返回（`dsh-session-persistence-jsonl/lib/index.js:2593-2596`）；
   该 pending 只在**写句柄 close 且未落盘**时清除（同文件 `:372-378`）。

⇒ 一个从未落盘、但一直被打开的会话，**磁盘上没有它的目录，它却每次都被列出来**。
这正是用户反馈「删除后刷新仍在原空间显示为归档状态」的那类会话：
删磁盘、摘记账、保留归档标记……**全都没用，因为它根本不在这一层**。

### 修法：调用官方 teardown 边缘，让平台真正忘掉它

官方文档（`reference/subsystems/persistence`）写明销毁语义：
> 「`session/disposed` 会执行同样的最终排空并关闭句柄」

平台内部 teardown 顺序 = **先摘 agent、再摘 session**：

| 步骤 | 调用 | 效果 |
|---|---|---|
| ① | `ctx.agents.store` → `detachEntered(entry)` | 摘掉 agent 半身 |
| ② | `ctx.sessions.liveEntryFor(s)` → `detachEntered(entry)` | 移出 store、派发 `session/disposed` |
| ↳ | jsonl 监听 `session/disposed` | 关闭写句柄、清掉 pending 条目 |
| ↳ | api-session-controller 监听 `session/disposed` | `emit('api-session/removed')` |
| ↳ | 客户端 `handleSessionRemoved()` | 把该行从列表摘掉 |

`evictLiveSession()` 就做 ①② 两步（全程 try/catch，失败降级为如实告知 + 提示重启）。

**删除顺序（踩过坑）**：必须**先驱逐、再 `rm` 目录**。因为写句柄 `close()` 会先
`drainLive()` 落盘，而落盘路径会 `mkdir(dir,{recursive:true})`
（`dsh-session-persistence-jsonl/lib/index.js:199-210` 与 `:660-670`）——
顺序反了，`rm` 掉的目录会被 close 的 drain **建回来**，会话文件"复活"。

### 四象限行为（隔离实测全部通过）

| 场景 | 驱逐 | 磁盘目录 | 记账/归档 | 结果 |
|---|---|---|---|---|
| live + 磁盘在 | ✅ | 删除 | 清除 | 彻底删除，列表即时摘行 |
| 冷 + 磁盘在 | — | 删除 | 清除 | 彻底删除 |
| live + 磁盘已无 | ✅ | 无需删 | 清除 | 不再被列出 |
| 冷 + 磁盘已无 | — | 无需删 | 清除 | 清理归档记录 |

⚠️ 全部走完才是「真的删掉」；任何一步失败都会在 `warnings` 里如实回报，
并提示重启收敛 —— 绝不静默留一个"点了没反应"的坏状态。

`pruneDeadArchived()` 仍保留：清理历史上遗留的、任何地方都不存在的归档 id。

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

**修法（已实现）**：宿主的删除流程先用 `evictLiveSession()` 让平台真正忘掉该会话
（见上文「调用官方 teardown 边缘」），再清记账与归档标记 —— 两者对 live / 冷会话
都执行，不再区分（驱逐成功后摘记账不会让它"回来"）。
⚠️ 早期版本对 live 会话「保留归档态、什么都不改」，那是个 **no-op**：条目仍被列出，
用户点删除毫无反应，观感就是「删了又回来」。这也是它在归档页里曾需要 `pendingRestart`
单列的原因 —— 修好驱逐后不再需要那个终态。

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
| 宿主 | `lib/index.js` | 七条同源路由 + 启动期清理：`GET .../list`（列出归档会话 + 工作区 + 幽灵记账 + **pendingRestart**）、`POST .../delete`（校验 → **`evictLiveSession` 驱逐 live 会话** → 删目录 → 清记账与归档 → 发 `api-session/removed`）、`POST .../evict`（重试驱逐：只驱逐 + 清记账，**不动磁盘**，供「已删除但仍被内存持有」时手动重试）、`POST .../cleanup-ghosts`、`POST .../repair`（`attachSession` 归位，**跳过子智能体**，支持 `dryRun`）、`POST .../detach-subagents`（只改记账）、`POST .../empty-sessions`（列出/删除**从未有过对话**的空会话；服务端二次校验、拒删有内容的）；另有 `pruneDeadArchived()` 在启动后首次列表时清掉任何地方都不存在的归档 id |
| 客户端 | `client/client.js` | ① `sidebar.workspaces.session.menu.item` 注册「删除会话」（order 500，danger 样式，仅归档行可见）② `settings.section` 注册「归档会话」设置页（order 65，按工作区分组的批量管理正文，另含「归位失效会话」「一键摘除误记账的子智能体」「清理遗留空会话」入口，以及 `pendingRestart` 状态提示）③ `shell.overlay` 注册单个删除的确认对话框 |

## 已知坑（开发时实测）

- **删磁盘 ≠ 删除会话**（本项目最大的坑，查了四轮）：live 会话会被
  `sessionQuery.listSessions`（内存态覆盖合并）**和** jsonl `list()` 的 pending 分支
  双重列出，所以删磁盘/摘记账/保留归档标记**全都无效**。必须调用官方 teardown 边缘
  （`detachEntered` → `session/disposed`）。判据：宿主持有 `session.lock` 而目录不存在
  = 「从未 materialize 的 pending 会话」，是这一类问题最典型的特征。
- **驱逐必须早于 `rm`**：写句柄 `close()` 会 `drainLive()` 落盘，落盘路径 `mkdir` 会
  把刚删的目录**建回来**。顺序：驱逐 → 删目录 → 清记账。
- **读官方文档再动手**：本插件的能力边界与销毁语义（`session/disposed` 会排空并关闭
  句柄）都写在 `reference/subsystems/session` 与 `/persistence`。此前凭源码猜了四轮，
  读文档十分钟就定位到根因。
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
