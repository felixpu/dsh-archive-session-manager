# 开发者文档

面向维护者。用户文档见 [../README.md](../README.md)。

本文记录实现细节、所依赖的平台内部机制（含源码位置）、实测结论与排查方法。

## 一、平台能力边界（逐一核对官方 Service 契约）

**公开 Service 契约里没有「删除会话」这个动作**，这是逐个方法核对的结论：

| 服务 | 方法 | 有删除会话吗 |
|---|---|---|
| `sessionPersistence` | `create` / `open` / `flush` / `stat` / `list` | ❌ |
| `sessionController`（Remote） | `list` / `search` / `create` / `rename` / `fork` / `prompt` / `cancel` / `page` / `follow` / `projections` / `control` | ❌ |
| `workspaceRegistry` | `create` / `delete`（**工作区**）/ `archiveSession` / `unarchiveSession` / `pin` … | ❌ |
| 客户端 `workspaces` | `create` / `rename` / `delete`（**工作区**）/ `archiveSession` / `unarchiveSession` | ❌ |

⚠️ **但「公开契约没有」不等于「做不到」**：会话可以通过**运行时可达的内部 teardown 原语**
离开内存 —— `ctx.agents.detachEntered` 与 `ctx.sessions.detachEntered`（后者派发
`session/disposed`）。官方文档写明「`session/disposed` 会执行同样的最终排空并关闭句柄」。
这些方法在 `.d.ts` 里标 `private`，但不是 ES `#` 私有字段，运行时可以调用。

⇒ 本插件的「删除」= **四件事的组合**：驱逐内存态 → 删磁盘目录 → 从归档集合移除
→ 从工作区记账摘除（`detachSession`）。

## 二、live 会话会被**两条内存通路**持续列出

这是「删了又回来」的根因（曾误判四轮，最终按官方文档 + 源码定位）：

1. `sessionQuery.listSessions()` 用 `ctx.sessions.list()` 内存态**覆盖合并**磁盘结果
   （`dsh-session-query/lib/index.js:107-116`）；
2. jsonl 后端的 `list()` 还会把 tracker 里 **created-but-never-materialized** 的
   pending 条目也返回（`dsh-session-persistence-jsonl/lib/index.js:2593-2596`）；
   该 pending 只在**写句柄 close 且未落盘**时清除（同文件 `:372-378`），
   或在**会话成功落盘**时清除（`materialized()`，同文件 `:351-353`，调用点 `:2876` / `:2888`）。

⇒ 一个从未落盘、但一直被打开的会话，**磁盘上没有它的目录，它却每次都被列出来**。
此时删磁盘、摘记账、保留归档标记**全都无效** —— 它根本不在那一层。

**判别特征**：宿主持有 `session.lock`（`lsof -p <PID> | grep sessions/`）而磁盘上
**没有**该会话目录 = 「从未 materialize 的 pending 会话」。

## 三、驱逐链路（`evictLiveSession`）

平台内部 teardown 顺序 = **先摘 agent、再摘 session**：

| 步骤 | 调用 | 效果 |
|---|---|---|
| ① | `ctx.agents.store` → `detachEntered(entry)` | 摘掉 agent 半身 |
| ② | `ctx.sessions.liveEntryFor(s)` → `detachEntered(entry)` | 移出 store、派发 `session/disposed` |
| ↳ | jsonl 监听 `session/disposed` | 关闭写句柄、清掉 pending 条目 |
| ↳ | api-session-controller 监听 `session/disposed` | `emit('api-session/removed')` |
| ↳ | 客户端 `handleSessionRemoved()` | 把该行从列表摘掉 |

`evictLiveSession()` 就做 ①② 两步（全程 try/catch，失败降级为如实告知 + 提示重启）。

**删除顺序：必须先驱逐、再 `rm` 目录。** 写句柄 `close()` 会先 `drainLive()` 落盘，
而落盘路径会 `mkdir(dir,{recursive:true})`
（`dsh-session-persistence-jsonl/lib/index.js:199-210` 与 `:660-670`）—— 顺序反了，
`rm` 掉的目录会被 close 的 drain **建回来**，会话文件"复活"。

**`rm` 之后还要复查**：`close()` 是 **fire-and-forget**（`ctx.on("session/disposed",
s => { writer.close().catch(...) })`，`:421-427`，没有 await），其 drain 可能**晚于** `rm`。
故 `rm` 后最多复查 3 轮 × 60ms，重建就再删；首次复查已不存在则 break
（冷会话实测 11ms，无额外延迟）。

### 四象限行为（隔离实测全部通过）

| 场景 | 驱逐 | 磁盘目录 | 记账/归档 | 结果 |
|---|---|---|---|---|
| live + 磁盘在 | ✅ | 删除 | 清除 | 彻底删除，列表即时摘行 |
| 冷 + 磁盘在 | — | 删除 | 清除 | 彻底删除 |
| live + 磁盘已无 | ✅ | 无需删 | 清除 | 不再被列出 |
| 冷 + 磁盘已无 | — | 无需删 | 清除 | 清理归档记录 |

⚠️ **驱逐/记账/归档清理**失败会进该条的 `warnings`（如实回报、可重试驱逐）；
**删目录**失败则整条 `ok:false, error:'rm-failed'` —— 绝不静默留一个"点了没反应"的坏状态。

`pruneDeadArchived()` 在启动后首次列表时清理「任何地方都不存在」的归档 id。

## 四、「未分组」的两个来源

### 来源一：live 会话被摘记账（早期版本）

删除时调 `detachSession` 摘掉了归属，但会话仍活在内存里、被列表重新并入 ——
结果是**一个没有任何归属的会话**，必然落进「未分组」。

**实证**：宿主 `lsof` 显示进程仍持有
`--Users-felix--/session-996d624a-…/session.lock`，而该目录**已被删除**；
该 id 既不在任何工作区记账里、也不在归档集合里 → 刷新后必然出现在「未分组」。

**现状**：删除流程先用 `evictLiveSession()` 让平台真正忘掉该会话，再清记账与归档 ——
两者对 live / 冷会话都执行。早期版本对 live「保留归档态、什么都不改」是个 **no-op**
（条目仍被列出、用户点删除毫无反应），已废弃。

### 来源二：从未被记账的历史遗留会话

会话只要**不在任何** `workspace.sessionIds` **里**，就被归入 `group.ungrouped`
（`dsh-client-ui-workspace/lib/client.js:1060`）。而有些会话**从来没进过记账**：

`dsh-workspace/lib/index.js:178` 的 `mutate()` 写入时会剪枝：

```js
const sessionIds = changed.sessionIds.filter((id) => this.host.sessionPath(id) === changed.path)
```

`sessionPath` 由 `indexHeader()` 填充，要求 header 的 `cwd` 经 realpath 后**仍是存在的目录**。
历史遗留目录从未走过 `attachSession`，于是每次记账写入都被剪掉，永久钉在「未分组」。

**修法**：设置 → 归档会话 里的「归位失效会话」—— 对这些会话调 `attachSession`。
该方法会**先**校验 `cwd` 并调 `host.rememberSessionPath(id, cwd)`，**再**执行 `mutate`，
正好解开上面那个剪枝死结（依据 `dsh-workspace/lib/index.js:111-127`）。只读预览走
`POST /api/dsh-archive-session-manager/repair` 的 `{ "dryRun": true }`。

⚠️ **归位必须排除子智能体**：侧栏可见性判据是 `sessionVisible()`
（`dsh-client-ui-workspace/lib/client.js:982`）—— `if (session.origin === "subagent") return false;`
子智能体**永远不作为列表行显示**（只在父会话行上以「N 个子智能体运行中」计数徽标出现），
所以它们不可能出现在「未分组」里。实测本机 37 个未记账会话中 **34 个是子智能体**，
若不排除会把它们塞进用户工作区的记账（属语义错误的脏数据）。

⚠️ **判据必须是磁盘 + 记账原文**：读工作区记账要读 `ws.record.sessionIds`，
不要读 getter `ws.sessionIds` —— getter 会按内存 header 索引过滤，而平台索引**只增不删**，
会让「磁盘已无 / 磁盘有但未记账」这两类都被自己过滤掉，检测恒为空
（幽灵检测踩过同一个坑）。

## 五、HTTP 路由

七条同源路由，均在 `/api/dsh-archive-session-manager/` 下。已注册的 POST 路由可以直接
用 curl 验证（未注册路径才回 401）：

| 路由 | 方法 | 作用 |
|---|---|---|
| `/list` | GET | 归档会话 + 工作区 + 幽灵记账 + `pendingRestart` |
| `/delete` | POST | 校验 → 驱逐 live → 删目录 → 清记账与归档 → 发 `api-session/removed` |
| `/evict` | POST | 重试驱逐：只驱逐 + 清记账，**不动磁盘** |
| `/cleanup-ghosts` | POST | 清理失效的记账条目 |
| `/repair` | POST | `attachSession` 归位，**跳过子智能体**，支持 `dryRun` |
| `/detach-subagents` | POST | 只改记账，摘掉误记账的子智能体 |
| `/empty-sessions` | POST | 列出/删除从未有过对话的空会话（服务端二次校验） |

## 六、客户端落点

| 落点 | 槽 | 说明 |
|---|---|---|
| 单个删除入口 | `sidebar.workspaces.session.menu.item` | order 500，danger 样式，仅归档行可见 |
| 批量管理正文 | `settings.section` | order 65，id 借用 `'archived-sessions'` |
| 单个删除确认框 | `shell.overlay` | 全屏浮层，条目需自行 opt-in pointer events |

⚠️ `settings.section` 的 id 为什么是 `'archived-sessions'` 而不是包名：该槽的注册选项
只有 `id`/`order`/`label`，**没有 icon 字段**；设置页导航的 `navIcon(id)` 按 id 硬编码五个
图标，其余一律兜底齿轮。官方为「归档会话」预留了 `archived-sessions` 图标，但全安装树内
无人注册该 id（官方没有归档设置页），故借用它换取档案盒图标。
代价：同 id 是**替换而非并列**，若官方将来真出了归档页会互相顶掉，届时改回包名即可
（纯登记信息，不影响菜单/路由/批量删除）。

## 七、已知坑（开发时实测）

- **删磁盘 ≠ 删除会话**（本项目最大的坑，查了四轮）：详见第二、三节。
- **驱逐必须早于 `rm`**，且 `rm` 后需复查（close 是 fire-and-forget）—— 见第三节。
- **先读官方文档 / 契约再动手**：① 能力边界与销毁语义（`session/disposed` 会排空并关闭
  句柄）都写在 `reference/subsystems/session` 与 `/persistence` —— 此前凭源码猜了四轮，
  读文档十分钟就定位到根因；② 平台有没有「删除会话」API，要逐条核对
  `cordis_inspect_query` 的 host/client `Service` 目录 + 各包源码。
- **宿主 ctx 是依赖注入代理**：未在 `inject` 里声明的服务，读属性时直接抛
  `cannot get property "<name>" without inject`。第一版只声明了 `webServer`，
  于是 `ctx.workspaceRegistry` 抛错、又被容错分支吞成空集，表现为「管理页打开但一条数据都没有」。
  现在 `inject` 声明全部**五个**服务（`webServer` / `workspaceRegistry` / `sessionQuery` /
  `agents` / `sessions`），且读取失败**向上抛**。
- Cordis 的 `inject` 对象形式是「服务名 → 拦截配置」，不是 `{ required, optional }`
  （依据 `@deepseek-ai/cordis/lib/types/registry.d.ts:13` 的 `Inject` 定义），只能用数组形式。
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
- **不要让「删除」变成 no-op**：为规避某个副作用而保留状态、什么都不改时，
  **用户界面上必须同步反映「这件事已经做完了」**。正确做法是把这类条目从「待办列表」
  里摘出去，单列成如实的状态说明。
- **React 18 自动批处理会吞掉紧跟 `load()` 的提示文案**：`load()` 开头 `setStatus(null)`，
  若先写成功文案、再在**同一同步块**调 `load()`，文案被覆盖（同一 state 只保留最后一次写入）
  → 用户看不到结果。需要保留提示时用 `load({ keepStatus: true })`。
- **`findGhostAccounted` 不可给记账读法留 getter 兜底**：`?? ws?.sessionIds` 一旦生效就会
  退回被明令禁止的 getter，静默让幽灵检测恒为空。`record` 是 WorkspaceEntity 构造里
  无条件赋值的实例字段（`dsh-workspace/lib/index.js:88`），故直接用 `?? []`。

## 八、验证

无浏览器控制权时的分层验证：

1. 语法：`node --check lib/index.js client/client.js`；
2. 宿主半身：从 profile 侧 `await import('<包名>')`，用假 ctx 收集注册到的路由，跑真实请求；
3. 客户端：语法 + 种子表审计（正则抓 `require`）+ 用**打桩 React** 执行组件函数、
   跑遍分支并采集文本节点。⚠️ 打桩遍历要判 `typeof node.type === 'function'`
   并用 `node.type(node.props)` 展开，否则采不到子组件里的文字。
4. 装完确认包已进 `dsh.profile.bundles`，且 `dsh --profile web --dump-config` 输出里有
   `# == dsh-archive-session-manager` 层。
5. **客户端 bundle 不会被自动重载**（本 profile 未装 `dsh-client-hmr`）：
   改代码后必须重启宿主，`plugin_manager` 的 `set_bundle` 开关**不能**替代重启
   （返回 `application: applied`，但 Node 模块缓存让旧代码继续复用）。

升级后的验证步骤见 [VERIFICATION.md](VERIFICATION.md)。
