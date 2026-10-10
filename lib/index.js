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
export const inject = ['webServer', 'workspaceRegistry', 'sessionQuery', 'agents']

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

  /** 列出全部已归档会话及其标题/元数据。 */
  route(`${API_BASE}/list`, async (_req, res) => {
    try {
      const archived = archivedSet()
      if (archived.size === 0) return sendJson(res, 200, { sessions: [], workspaces: [] })
      // 工作区快照：用于把归档会话归到它所属的工作区。
      // 归档不改变工作区的 sessionIds 记账（官方明确：归档会话保留其槽位），
      // 所以 workspace.sessionIds 是归属的权威来源；
      // 不在任何工作区记账里的会话 = 真正「未分组」（例如工作区已被删除）。
      const workspaces = []
      const owner = new Map() // sessionId -> workspaceId
      try {
        for (const ws of ctx.workspaceRegistry.list() ?? []) {
          workspaces.push({ workspaceId: ws.id, title: ws.title ?? '', path: ws.path ?? '' })
          for (const sid of ws.sessionIds ?? []) owner.set(sid, ws.id)
        }
      } catch (error) {
        ctx.logger?.warn?.(`${NAME}: workspace list failed: ${String(error)}`)
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
        sessions.push({
          sessionId: id,
          title: titles.get(id) ?? '',
          createdAt: header?.createdAt ?? null,
          cwd: header?.cwd ?? null,
          // 工作区归属：优先用记账归属；没有记账则回退到 cwd 匹配（老数据兜底）。
          workspaceId: owner.get(id) ?? null,
          ownerKnown: owner.has(id),
          live: ctx.agents.get(id) !== undefined,
          sizeBytes: dir ? await dirSizeBytes(dir) : null,
          // 磁盘上已无会话目录（孤儿归档记录）→ 删除时只清理归档记录。
          orphan: dir === null,
        })
      }
      // 面板展示按创建时间新→旧（无创建时间的排在最后）。
      sessions.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
      sendJson(res, 200, { sessions, metaError })
    } catch (error) {
      ctx.logger?.warn?.(`${NAME}: list failed: ${String(error)}`)
      sendJson(res, 500, { error: 'list-failed', message: String(error) })
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
        // ② live agent 拒删（删运行中的目录会让写句柄悬空）。
        if (ctx.agents.get(id) !== undefined) {
          results.push({ sessionId: id, ok: false, error: 'session-live' })
          continue
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
          // 此时没有任何磁盘内容可删，**只清理归档记录**即为正确语义，
          // 而不是报失败——否则这些条目永远删不掉，把用户卡死在列表里。
          try {
            await ctx.workspaceRegistry.unarchiveSession(id)
            cleaned += 1
            results.push({ sessionId: id, ok: true, orphan: true })
          } catch (error) {
            results.push({ sessionId: id, ok: false, error: `unarchive-failed: ${String(error)}` })
          }
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
        // ⑤ 从归档集合移除（unarchive 对不存在的 id 也无害）。
        try {
          await ctx.workspaceRegistry.unarchiveSession(id)
        } catch (error) {
          // 磁盘已删但 registry 清理失败：如实上报，重启后 registry 自己会容忍。
          results.push({ sessionId: id, ok: false, error: `unarchive-failed: ${String(error)}` })
          continue
        }
        results.push({ sessionId: id, ok: true })
      }

      // ⑥ 有实际删除就通知前端重拉（dsh-lock 实证的 connection/reset 机制：
      //    workspace 列表监听该事件重新拉取）。
      if (results.some((r) => r.ok)) {
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
