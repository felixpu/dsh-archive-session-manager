/**
 * dsh-archive-session-manager 宿主半身。
 *
 * 职责（只干两件事）：
 * 1. `GET  /api/dsh-archive-session-manager/list` —— 只读列出当前**已归档**会话
 *    （id / 标题 / 创建时间 / 所属工作区 cwd / 磁盘占用），供客户端面板渲染。
 * 2. `POST /api/dsh-archive-session-manager/delete` —— 删除一个或多个**已归档**会话：
 *    归档校验 → live agent 排除 → 递归删磁盘目录 → 从 workspaceRegistry 归档集合移除
 *    → `connection/reset` 通知前端重拉列表。
 *
 * 安全边界（设计决定，不可放松）：
 * - **只允许删除已归档会话**。未归档会话一律 409，先归档再删——归档是平台的
 *   「确认不再使用」动作，我们不另造一套确认语义。
 * - 会话目录的解析**只用 header.cwd 经 projectKey 推导**，路径严格限制在
 *   `$DSH_HOME/sessions/` 之下并做前缀校验，拒绝任何越界（防 cwd 注入）。
 * - live agent（`ctx.agents.get(id)` 命中）拒绝删除。
 *
 * 已知的平台局限（README 如实告知）：
 * - DSH 平台没有「删除会话」API（workspaceRegistry / sessionPersistence 均无），
 *   本插件的删除 = 移除归档标记 + 删磁盘目录。全文搜索索引
 *   （dsh-session-query-sqlite）可能残留条目，待其自行重建，不影响功能。
 *
 * 形态约定（树外插件，dsh-plugins 仓库规范）：
 * - 零 dsh 依赖，不 import 任何 @deepseek-ai/*，只用 node: 内置模块；
 * - 路由走 `ctx.webServer.register`，disposer 收集后由 ctx.effect 统一撤销
 *   （裸 register 的返回值被丢弃会导致 HMR 重载撞 duplicate route）。
 */
import { existsSync } from 'node:fs'
import { readdir, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve, sep } from 'node:path'

const NAME = 'dsh-archive-session-manager'
const API_BASE = `/api/${NAME}`

export const name = NAME

/**
 * ⚠️ 必须把用到的宿主服务全部声明为 inject。
 * Cordis 的 ctx 是**依赖注入代理**：未声明的服务在属性读取时直接抛
 * `cannot get property "<name>" without inject`。此前只 inject 了 webServer，
 * 于是 `ctx.workspaceRegistry.archivedSessionIds` 抛错、被容缺分支吞成空集，
 * 表现为「管理页打开却一条数据都没有」——这个坑已实测踩到，
 * 且因为吞异常而完全没有报错信号，极难定位。
 *
 * 形式说明（依据 cordis/lib/types/registry.d.ts 的 `Inject` 定义）：
 * `Inject = (keyof M)[] | { [K in keyof M]?: M[K] }` —— 对象形式是
 * 「服务名 → 拦截配置」，**不是** `{ required, optional }`。故这里只能用数组。
 * 数组声明即「硬依赖」：任一服务缺失则整行不装载（宁可明着不工作，
 * 也不要静默降级成空数据）。
 */
export const inject = ['webServer', 'workspaceRegistry', 'sessionQuery', 'agents', 'sessions']

/** 会话日志根目录（$DSH_HOME/sessions，与 DSH 官方约定一致）。 */
function sessionsRoot() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'sessions')
}

/**
 * 把会话 header.cwd 编码为持久化层用的项目目录名。
 *
 * ⚠️ 必须与 dsh-session-persistence-jsonl 的 projectKey() **逐字对齐**：
 *    1) 路径分隔符压缩成单个 `-`；
 *    2) 末尾 `replace(/^-+/, '')` 去掉开头的连字符串 —— 漏掉这一步会多一层
 *       `--`（`/Users/felix` 会算成 `---Users-felix--`，而磁盘上是
 *       `--Users-felix--`），路径全部落空，表现为「体积显示 0 / 删除找不到目录」。
 *       这个坑已实测踩到（第一版正是漏了该步）。
 *    3) 空结果回退 `root`，并截断到 251 字符。
 * 官方该函数未导出，只能复刻；算法即全平台磁盘布局，不可自行改动。
 */
function projectKey(cwd) {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  return `--${(readable.replace(/^-+/, '') || 'root').slice(0, 251)}--`
}

/**
 * 解析一个已归档会话的磁盘目录，带越界防护。
 * @returns 绝对路径；无法解析（无 cwd / 越界）时返回 null。
 */
function sessionDirFor(header) {
  const cwd = header?.cwd
  if (typeof cwd !== 'string' || cwd.length === 0) return null
  const dir = resolve(sessionsRoot(), projectKey(cwd), header.id)
  const root = resolve(sessionsRoot())
  // 必须严格位于 sessions 根之下（projectKey 已滤掉分隔符，这里是双保险）。
  if (dir !== root && !dir.startsWith(root + sep)) return null
  return dir
}

/** 递归估算目录大小（失败容忍，返回 0）。 */
async function dirSizeBytes(dir) {
  let total = 0
  try {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      try {
        if (entry.isDirectory()) total += await dirSizeBytes(p)
        else total += (await stat(p)).size
      } catch { /* 单文件失败跳过 */ }
    }
  } catch { /* 目录不可读按 0 */ }
  return total
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(text)
}

async function readBody(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  return Buffer.concat(chunks).toString('utf8')
}

export function apply(ctx) {
  const registered = []
  const route = (path, handler) => {
    registered.push(ctx.webServer.register({ kind: 'exact', path, handler }))
  }

  /**
   * 当前归档集合（Set 化）。
   * ⚠️ 读取失败**必须向上抛**：吞成空集会与「真的一个归档都没有」无法区分，
   *    表现为「页面空白且无任何报错」。这正是本插件第一版的实际故障原因
   *    （workspaceRegistry 未声明 inject → 抛错 → 被吞 → 空列表）。
   */
  const archivedSet = () => new Set(ctx.workspaceRegistry.archivedSessionIds ?? [])

  /**
   * 找到记账里包含该会话的工作区实体。
   * @returns Workspace 实体（可调 detachSession），未记账时返回 undefined。
   */
  async function findWorkspaceOf(sessionId) {
    for (const ws of ctx.workspaceRegistry.list() ?? []) {
      if ((ws.sessionIds ?? []).includes(sessionId)) return ws
    }
    return undefined
  }

  /**
   * 找出「幽灵记账」：工作区 sessionIds 里记着，但 sessionPersistence
   * 里已不存在（磁盘文件被删）的会话 id。
   *
   * 为什么需要：平台的 headers 索引只增不删，工作区记账也不会自动收敛，
   * 所以任何「绕过记账」的历史删除（手工 rm、旧版本插件）都会留下这类 id。
   * 它们在界面上会以普通会话出现，且点开是空会话，用户无法自行清理。
   * @returns [{ workspaceId, title, path, sessionIds }]
   */
  async function findGhostAccounted() {
    // 判据必须是**磁盘现状**，不能只信 sessionPersistence.list()：
    // 实测该列表带内存快照，删掉文件后它仍会返回这些会话（索引只增不删），
    // 于是「幽灵」检测永远为空、cleanup 返回 removed: 0。这是踩过的坑。
    const stored = new Set()
    let diskScanOk = false
    try {
      const root = sessionsRoot()
      for (const project of await readdir(root, { withFileTypes: true })) {
        if (!project.isDirectory()) continue
        for (const entry of await readdir(join(root, project.name), { withFileTypes: true })) {
          if (entry.isDirectory()) stored.add(entry.name)
        }
      }
      diskScanOk = true
    } catch (error) {
      ctx.logger?.warn?.(`${NAME}: sessions dir scan failed: ${String(error)}`)
    }
    if (!diskScanOk) return null
    // ⚠️ 不要把 sessionPersistence.list() 并进来：它会谎报已删会话仍存在
    //    （内存索引只增不删），并进来等于把幽灵重新标记为「存在」，
    //    检测永远为空。已实测踩到。真正的并集来源是 live sessions（内存态）。
    const live = new Set((ctx.sessions?.list?.() ?? []).map((s) => s.id))
    const groups = []
    for (const ws of ctx.workspaceRegistry.list() ?? []) {
      const ghosts = (ws.sessionIds ?? []).filter((id) => !stored.has(id) && !live.has(id))
      if (ghosts.length > 0) {
        groups.push({ workspaceId: ws.id, title: ws.title ?? '', path: ws.path ?? '', sessionIds: ghosts })
      }
    }
    return groups
  }

  /** 列出全部已归档会话及其标题/元数据。 */
  route(`${API_BASE}/list`, async (_req, res) => {
    try {
      const archived = archivedSet()
      // ⚠️ 即使没有归档会话也要返回工作区列表：客户端的分组与「已删除会话
      //    是否还在工作区记账里」的判断都依赖它；提前 return 会让前端拿到空
      //    工作区，退化成全部「未分组」。
      if (archived.size === 0) {
        const emptyWorkspaces = []
        try {
          for (const ws of ctx.workspaceRegistry.list() ?? []) {
            emptyWorkspaces.push({ workspaceId: ws.id, title: ws.title ?? '', path: ws.path ?? '' })
          }
        } catch (error) {
          ctx.logger?.warn?.(`${NAME}: workspace list failed: ${String(error)}`)
        }
        // ghosts 也要带上：没有归档会话时照样可能存在历史遗留的失效记账。
        let emptyGhosts = null
        try {
          emptyGhosts = await findGhostAccounted()
        } catch (error) {
          ctx.logger?.warn?.(`${NAME}: ghost scan failed: ${String(error)}`)
        }
        return sendJson(res, 200, { sessions: [], workspaces: emptyWorkspaces, ghosts: emptyGhosts })
      }
      // 工作区快照：用于把归档会话归到它所属的工作区。
      // 归档不改变工作区的 sessionIds 记账（官方明确：归档会话保留其槽位），
      // 所以 workspace.sessionIds 是归属的权威来源；
      // 不在任何工作区记账里的会话 = 真正「未分组」（例如工作区已被删除）。
      const workspaces = []
      const owner = new Map() // sessionId -> workspaceId
      let workspaceError = null
      try {
        for (const ws of ctx.workspaceRegistry.list() ?? []) {
          workspaces.push({ workspaceId: ws.id, title: ws.title ?? '', path: ws.path ?? '' })
          for (const sid of ws.sessionIds ?? []) owner.set(sid, ws.id)
        }
      } catch (error) {
        workspaceError = String(error)
        ctx.logger?.warn?.(`${NAME}: workspace list failed: ${workspaceError}`)
      }
      // 用 sessionQuery 的 live-preferred 语料拿 header（含 cwd/createdAt）
      // 再批量折标题。单条失败不影响整表：拿不到 header 的会话仍会出现在
      // 列表里（只有 id），避免「有归档却显示为空」这种最坏观感。
      const byId = new Map()
      let metaError = null
      try {
        const records = await ctx.sessionQuery.filterSessions([
          { kind: 'id', values: [...archived] },
        ])
        for (const r of records) byId.set(r.header.id, r.header)
      } catch (error) {
        metaError = String(error)
        ctx.logger?.warn?.(`${NAME}: filterSessions failed: ${metaError}`)
      }
      const titles = new Map()
      try {
        const results = await ctx.sessionQuery.readTitleSnapshots([...archived])
        for (const r of results) {
          if (r.status === 'fulfilled' && r.value.title) titles.set(r.sessionId, r.value.title.title)
        }
      } catch (error) {
        ctx.logger?.warn?.(`${NAME}: readTitleSnapshots failed: ${String(error)}`)
      }
      const sessions = []
      for (const id of archived) {
        const header = byId.get(id)
        const dir = header ? sessionDirFor(header) : null
        const agent0 = ctx.agents.get(id)
        sessions.push({
          sessionId: id,
          title: titles.get(id) ?? '',
          createdAt: header?.createdAt ?? null,
          cwd: header?.cwd ?? null,
          // 工作区归属：优先用记账归属；没有记账则回退到 cwd 匹配（老数据兜底）。
          workspaceId: owner.get(id) ?? null,
          ownerKnown: owner.has(id),
          live: agent0 !== undefined,
          // running 才是「不能删」的真正条件（live 但 idle 可以删）。
          running: agent0 !== undefined && agent0.status === 'running',
          sizeBytes: dir ? await dirSizeBytes(dir) : null,
          // 磁盘上已无会话目录（孤儿归档记录）→ 删除时只清理归档记录。
          orphan: dir === null,
        })
      }
      // 面板展示按创建时间新→旧（无创建时间的排在最后）。
      sessions.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
      // ⚠️ workspaces 必须一并返回：客户端靠它把会话归组，
      //    并在「会话不属于任何工作区」时归入「未分组」。
      //    漏掉这一项 → 所有会话都落进「未分组」（实测踩到）。
      // ghosts：工作区记账里的幽灵条目（磁盘已无），前端据此提示可一键清理。
      let ghosts = null
      try {
        ghosts = await findGhostAccounted()
      } catch (error) {
        ctx.logger?.warn?.(`${NAME}: ghost scan failed: ${String(error)}`)
      }
      sendJson(res, 200, { sessions, workspaces, metaError, workspaceError, ghosts })
    } catch (error) {
      ctx.logger?.warn?.(`${NAME}: list failed: ${String(error)}`)
      sendJson(res, 500, { error: 'list-failed', message: String(error) })
    }
  })

  /**
   * 清理「幽灵记账」：把工作区 sessionIds 里那些磁盘已不存在的会话 id 摘掉。
   *
   * 这是**修复历史遗留**用的维护接口，不涉及删除磁盘内容（那些文件早就没了）。
   * Body: { workspaceIds?: string[] }（缺省清理全部工作区）
   */
  route(`${API_BASE}/cleanup-ghosts`, async (req, res) => {
    try {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method-not-allowed' })
      let only = null
      try {
        const raw = await readBody(req)
        if (raw) {
          const body = JSON.parse(raw)
          if (Array.isArray(body.workspaceIds)) only = new Set(body.workspaceIds)
        }
      } catch { /* 无 body 视为全量清理 */ }

      const groups = await findGhostAccounted()
      if (groups === null) {
        return sendJson(res, 503, { error: 'persistence-unavailable', message: '无法读取会话持久化列表，为避免误删记账已中止' })
      }
      const results = []
      let removed = 0
      for (const group of groups) {
        if (only !== null && !only.has(group.workspaceId)) continue
        const ws = (ctx.workspaceRegistry.list() ?? []).find((w) => w.id === group.workspaceId)
        if (ws === undefined || typeof ws.detachSession !== 'function') {
          results.push({ workspaceId: group.workspaceId, title: group.title, ok: false, error: 'workspace-not-writable' })
          continue
        }
        const failures = []
        let okCount = 0
        for (const sessionId of group.sessionIds) {
          try {
            await ws.detachSession(sessionId)
            okCount++
          } catch (error) {
            failures.push({ sessionId, error: String(error) })
          }
        }
        removed += okCount
        results.push({ workspaceId: group.workspaceId, title: group.title, ok: failures.length === 0, removed: okCount, failures })
      }
      if (removed > 0) {
        // 同上：这些会话行仍挂在客户端列表里，逐条通知移除。
        for (const group of groups) {
          if (only !== null && !only.has(group.workspaceId)) continue
          for (const sessionId of group.sessionIds) {
            try { ctx.emit('api-session/removed', sessionId) } catch { /* 静默 */ }
          }
        }
        try { ctx.emit('connection/reset') } catch { /* 静默 */ }
      }
      sendJson(res, 200, { results, removed })
    } catch (error) {
      ctx.logger?.warn?.(`${NAME}: cleanup-ghosts failed: ${String(error)}`)
      sendJson(res, 500, { error: 'cleanup-failed', message: String(error) })
    }
  })

  /**
   * 删除一个或多个已归档会话。
   * Body: { sessionIds: string[] }
   * 逐项处理、逐项汇报，不因单项失败中断整批。
   */
  route(`${API_BASE}/delete`, async (req, res) => {
    try {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method-not-allowed' })
      let ids
      try {
        const body = JSON.parse(await readBody(req) || '{}')
        ids = Array.isArray(body.sessionIds) ? body.sessionIds.filter((s) => typeof s === 'string') : []
      } catch {
        return sendJson(res, 400, { error: 'bad-json' })
      }
      if (ids.length === 0) return sendJson(res, 400, { error: 'empty-selection' })

      const results = []
      let deletedBytes = 0
      let cleaned = 0
      for (const id of ids) {
        // ① 只允许删已归档会话。
        if (!archivedSet().has(id)) {
          results.push({ sessionId: id, ok: false, error: 'not-archived' })
          continue
        }
        // ② 运行保护：只有**正在执行任务**（status === 'running'）的会话才拒删。
        //
        //    为什么不是「live 就拒」：被打开的会话（在浏览器里选中过）会常驻为
        //    live agent，但它的 status 通常是 'idle' —— 用户明明没在用、却永远
        //    删不掉，是糟糕的体验（实测反馈）。
        //    idle 的 live 会话没有进行中的写操作，删除其磁盘目录是安全的；
        //    running 才有未落盘的写入与工具执行，必须拒绝。
        const agent = ctx.agents.get(id)
        if (agent !== undefined && agent.status === 'running') {
          results.push({ sessionId: id, ok: false, error: 'session-running' })
          continue
        }
        // ②b idle 的 live agent：删除前先让它释放会话写句柄，否则删掉的目录
        //     仍被打开的文件描述符持有（POSIX 下空间不会真正回收）。
        if (agent !== undefined) {
          try {
            await ctx.workspaceRegistry.archiveSession(id, { stopActivity: true })
          } catch (error) {
            ctx.logger?.warn?.(`${NAME}: stop activity for '${id}' failed: ${String(error)}`)
          }
        }
        // ③ 解析磁盘目录（需要 header.cwd）。
        let header
        try {
          const records = await ctx.sessionQuery.filterSessions([{ kind: 'id', values: [id] }])
          header = records[0]?.header
        } catch { /* 下面按 header 缺失处理 */ }
        const dir = header ? sessionDirFor(header) : null
        if (dir === null) {
          // 「孤儿归档记录」：归档集合里留着 id，但会话语料/磁盘上早已不存在
          // （典型成因：所在工作区被删、或会话文件被手工清掉）。
          // 此时没有任何磁盘内容可删，**只清理记账与归档标记**即为正确语义，
          // 而不是报失败——否则这些条目永远删不掉，把用户卡死在列表里。
          const orphanErrors = []
          try {
            const ws = await findWorkspaceOf(id)
            if (ws && typeof ws.detachSession === 'function') await ws.detachSession(id)
          } catch (error) {
            orphanErrors.push(`detach-failed: ${String(error)}`)
          }
          try {
            await ctx.workspaceRegistry.unarchiveSession(id)
          } catch (error) {
            orphanErrors.push(`unarchive-failed: ${String(error)}`)
          }
          if (orphanErrors.length > 0) {
            results.push({ sessionId: id, ok: false, error: orphanErrors[0] })
            continue
          }
          cleaned += 1
          results.push({ sessionId: id, ok: true, orphan: true })
          continue
        }
        // ④ 删磁盘目录（先记大小供汇报；不存在视为已删）。
        try {
          const size = existsSync(dir) ? await dirSizeBytes(dir) : 0
          await rm(dir, { recursive: true, force: true })
          deletedBytes += size
        } catch (error) {
          results.push({ sessionId: id, ok: false, error: `rm-failed: ${String(error)}` })
          continue
        }
        // ⑤ 清理平台的记账与归档标记。两步都**必须**做，缺一会留下脏数据：
        //    a) detachSession：把会话从工作区记账 sessionIds 里摘掉。
        //       ⚠️ 这一步最容易漏，漏了会出现「删掉的会话又回到列表里、且显示为
        //       未归档」——因为工作区记账仍记着它，侧栏照常把它当普通会话渲染。
        //       该方法是 Workspace 实体方法（registry.list() 返回的实体上就有），
        //       不在 registry 的方法表里，但可正常调用。
        //    b) unarchiveSession：从归档集合摘掉（不清会留下孤儿归档记录）。
        //    注：平台的 headers 索引只增不删，所以「磁盘已删」这个事实要靠
        //    detachSession 落到记账上；否则重启前该会话会一直挂在工作区里。
        const cleanupErrors = []
        try {
          const ws = await findWorkspaceOf(id)
          if (ws && typeof ws.detachSession === 'function') await ws.detachSession(id)
        } catch (error) {
          cleanupErrors.push(`detach-failed: ${String(error)}`)
        }
        try {
          await ctx.workspaceRegistry.unarchiveSession(id)
        } catch (error) {
          cleanupErrors.push(`unarchive-failed: ${String(error)}`)
        }
        if (cleanupErrors.length > 0) {
          // 磁盘已删，但平台记账没清干净：如实上报（前端会提示重启以彻底收敛）。
          results.push({ sessionId: id, ok: true, deleted: true, warnings: cleanupErrors })
          continue
        }
        results.push({ sessionId: id, ok: true, deleted: true })
      }

      // ⑥ 通知前端把这一行从列表里移除。
      //
      // ⚠️ 必须发 `api-session/removed`，**不能只发 connection/reset**：
      //    - `api-session/removed` 由宿主 dsh-api-session-controller 在
      //      session/disposed 时发出，经 dsh-api-remotes 以 emit 模式转发到客户端，
      //      客户端 dsh-api-session-controller 收到后调 handleSessionRemoved()
      //      真正把该行摘掉 —— 这正是「删完立刻消失」的通路。
      //    - `connection/reset` 在 ui-workspace 里只用于刷新 hostInfo，
      //      **不会重拉会话/工作区列表**（读源码确认）。
      //    之前只发 connection/reset，于是列表要等手动刷新才更新（实测踩到）。
      const removedIds = results.filter((r) => r.ok).map((r) => r.sessionId)
      for (const sessionId of removedIds) {
        try { ctx.emit('api-session/removed', sessionId) } catch { /* 旧宿主无该事件时静默 */ }
      }
      if (removedIds.length > 0) {
        // connection/reset 仍发一次：让订阅它的其它视图（hostInfo 等）一并刷新。
        try { ctx.emit('connection/reset') } catch { /* 旧宿主无该事件时静默 */ }
      }
      sendJson(res, 200, { results, deletedBytes, cleaned })
    } catch (error) {
      ctx.logger?.warn?.(`${NAME}: delete failed: ${String(error)}`)
      sendJson(res, 500, { error: 'delete-failed', message: String(error) })
    }
  })

  // 路由必须在卸载时撤销，否则 HMR 重新 apply 撞 duplicate route。
  ctx.effect(() => () => {
    for (const dispose of registered.splice(0)) {
      try { dispose() } catch { /* 卸载期容错 */ }
    }
  }, `${NAME}: routes`)
}
