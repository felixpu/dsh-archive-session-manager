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
export const inject = ['webServer']

/** 会话日志根目录（$DSH_HOME/sessions，与 DSH 官方约定一致）。 */
function sessionsRoot() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'sessions')
}

/**
 * 把会话 header.cwd 编码为持久化层用的项目目录名。
 * 与 dsh-session-persistence-jsonl 的 projectKey() 逐字对齐（该函数未导出，
 * 只能在此复刻；算法稳定——改了它等于改全平台的磁盘布局）。
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
  return `--${readable}--`
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

  /** 当前归档集合（Set 化，容缺：registry 未就绪时按空集）。 */
  const archivedSet = () => {
    try {
      return new Set(ctx.workspaceRegistry?.archivedSessionIds ?? [])
    } catch {
      return new Set()
    }
  }

  /** 列出全部已归档会话及其标题/元数据。 */
  route(`${API_BASE}/list`, async (_req, res) => {
    try {
      const archived = archivedSet()
      if (archived.size === 0) return sendJson(res, 200, { sessions: [] })
      // 用 sessionQuery 的 live-preferred 语料拿 header（含 cwd/createdAt），
      // 再批量折标题。服务缺失时降级为仅 id 列表。
      let byId = new Map()
      try {
        const records = await ctx.sessionQuery.filterSessions([
          { kind: 'id', values: [...archived] },
        ])
        byId = new Map(records.map((r) => [r.header.id, r.header]))
      } catch (error) {
        ctx.logger?.warn?.(`${NAME}: filterSessions failed: ${String(error)}`)
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
        const dir = sessionDirFor(header ?? { id, cwd: undefined })
        sessions.push({
          sessionId: id,
          title: titles.get(id) ?? '',
          createdAt: header?.createdAt ?? null,
          cwd: header?.cwd ?? null,
          live: ctx.agents?.get?.(id) !== undefined,
          sizeBytes: dir ? await dirSizeBytes(dir) : null,
        })
      }
      // 面板展示按创建时间新→旧。
      sessions.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
      sendJson(res, 200, { sessions })
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
      for (const id of ids) {
        // ① 只允许删已归档会话。
        if (!archivedSet().has(id)) {
          results.push({ sessionId: id, ok: false, error: 'not-archived' })
          continue
        }
        // ② live agent 拒删（删运行中的目录会让写句柄悬空）。
        if (ctx.agents?.get?.(id) !== undefined) {
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
          results.push({ sessionId: id, ok: false, error: 'no-session-directory' })
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
      sendJson(res, 200, { results, deletedBytes })
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
