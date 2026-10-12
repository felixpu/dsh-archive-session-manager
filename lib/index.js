/**
 * dsh-archive-session-manager 宿主半身。
 *
 * 职责（只干两件事）：
 * 1. `GET  /api/dsh-archive-session-manager/list` —— 只读列出当前**已归档**会话
 *    （id / 标题 / 创建时间 / 所属工作区 cwd / 磁盘占用），供客户端面板渲染。
 * 2. `POST /api/dsh-archive-session-manager/delete` —— 删除一个或多个**已归档**会话：
 *    归档校验 → live agent 排除 → 递归删磁盘目录 → 从 workspaceRegistry 归档集合移除
 *    → `connection/reset` 通知前端重拉列表。
 * 3. `POST /api/dsh-archive-session-manager/repair` —— 把「磁盘上有、但不在任何工作区
 *    记账里」的会话**归位**到它 cwd 对应的工作区（dryRun 只读预览 / 执行两种模式）。
 *    这类会话被平台侧栏统统显示成「未分组」（见下方 repair 段落的成因说明）。
 *    **本路由不删除任何磁盘内容**：它只补记账，是归位不是清理。
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
import { open, readdir, realpath, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

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

/**
 * 会话原始日志的**规范**文件名（只认这些名字，其余一律不当成会话文件）。
 *
 * ⚠️⚠️ 照抄平台常量时最容易踩的一脚：**平台那个正则匹配的是「逻辑名」，
 *     而磁盘上是「物理名」** —— 两者差一个压缩后缀。
 *     - 逻辑名规则：dsh-session-format/lib/index.js:464 的
 *       `CANONICAL_LOG_FILENAME = /^session(?:\.v([1-9][0-9]*))?\.jsonl$/u`；
 *     - 物理名 = 逻辑名 + `compressionSuffix(compression)`，见
 *       dsh-session-persistence-jsonl/lib/index.js:747-763
 *       （`logSuffix` / `generationLogFilename`，zstd 配置下补 `.zstd`）。
 *     本机实际就是 zstd ⇒ 磁盘文件名是 `session.v4.jsonl.zstd`。
 *     第一版正是照抄了逻辑名正则（以 `\.jsonl$` 结尾），于是**一个文件都匹配不上**：
 *     扫描恒为空 → 前端显示「没有待归位会话」→ **失败表现为成功**，
 *     用户完全无从察觉（而且 `node --check` 照样通过，语法上毫无破绽）。
 *     这个坑已实测踩到，勿再简化本条正则。
 *
 * 故此处允许两种物理编码：`.jsonl`（compression: none）与 `.jsonl.zstd`。
 * 版本段的 `[1-9][0-9]*` 保持官方语义：`.v0`、前导零（`.v04`）、大写（`.V4`）
 * 都不是规范名 —— 它们要么是历史遗留、要么根本不是会话文件，绝不能拿去改记账。
 */
const CANONICAL_LOG_FILENAME = /^session(?:\.v([1-9][0-9]*))?\.jsonl(?:\.zstd)?$/

/** 与 dsh-session-persistence-jsonl 的 ZSTD_MAGIC 一致（帧头魔数）。 */
const ZSTD_MAGIC = 0xfd2fb528

/**
 * 极简 Zstandard 多帧「第一帧」切分器：只为读出**首行 header**，
 * 避免为了一个会话把头几 KB 之外的数据也解压（也不吞下后续的事件帧）。
 *
 * 算法依据 dsh-session-persistence-jsonl 的 `scanZstdFrames()`
 * （magic → frame header descriptor → 逐 block 走到 last_block → optional checksum）。
 * 返回 `null` 表示「已读到的字节还不足以确定第一帧结束」（调用方再读一块），
 * 抛错表示数据不合法（上层按损坏跳过，绝不猜测）。
 */
function firstZstdFrame(bytes) {
  let offset = 0
  if (bytes.length - offset < 4) return null
  if (bytes.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error('invalid zstd frame magic')
  offset += 4
  if (offset === bytes.length) return null
  const descriptor = bytes.readUInt8(offset)
  offset += 1
  if ((descriptor & 24) !== 0) throw new Error('reserved zstd frame-header bit')
  const contentSizeFlag = descriptor >>> 6
  const singleSegment = (descriptor & 32) !== 0
  const checksum = (descriptor & 4) !== 0
  const dictionaryFlag = descriptor & 3
  const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
  const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
  const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
  if (bytes.length - offset < remainingHeaderBytes) return null
  offset += remainingHeaderBytes
  for (;;) {
    if (bytes.length - offset < 3) return null
    const blockHeader = bytes.readUIntLE(offset, 3)
    offset += 3
    const lastBlock = (blockHeader & 1) !== 0
    const blockType = (blockHeader >>> 1) & 3
    const blockSize = blockHeader >>> 3
    if (blockType === 3) throw new Error('reserved zstd block type')
    offset += blockType === 1 ? 1 : blockSize
    if (bytes.length - offset < 0) return null
    if (lastBlock) break
  }
  if (checksum) {
    if (bytes.length - offset < 4) return null
    offset += 4
  }
  return { start: 0, end: offset }
}

/** 从一段 buffer 里取一个完整 JSON 值（按括号配对 + 字符串转义感知截取）。 */
function firstJsonValue(text) {
  const start = text.search(/[{\[]/)
  if (start === -1) return null
  const open = text[start]
  const close = open === '{' ? '}' : ']'
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') { inString = true; continue }
    if (ch === open) depth += 1
    else if (ch === close) {
      depth -= 1
      if (depth === 0) return text.slice(start, i + 1)
    }
  }
  return null
}

/** 解一段（已解压的）文本里的第一个 JSON 值；拿不到返回 null。 */
function parseFirstJson(text) {
  const raw = firstJsonValue(text)
  if (raw === null) return null
  try { return JSON.parse(raw) } catch { return null }
}

/**
 * 读取单个会话文件的**首行 header**（zstd 与明文两种编码都支持）。
 *
 * 为什么不用 `ctx.sessionQuery` 拿 header：这个接口要处理的是**平台 own 语料
 * 覆盖不到的角落** —— 历史遗留的「裸 UUID 目录名」会话，官方语料是按
 * projectKey(cwd) 推导目录名的，这些目录推导不出来，于是它们在语料里
 * 时有时无（本插件的删除兜底路径正因此才需要 findWorkspaceOf + 磁盘扫描）。
 * 归位检测的判据必须是**磁盘现状**：一个会话只要磁盘上有，就该被归位。
 *
 * 只读前若干块就够：header 是独立的第一个 zstd 帧，通常几百字节。
 * 读不通/解不开/首行不是 JSON → 返回 null，由调用方如实报告（不猜、不跳过性地忽略）。
 */
async function readLogHeader(file) {
  let handle
  try {
    handle = await open(file, 'r')
  } catch {
    return null
  }
  try {
    const buf = Buffer.alloc(64 * 1024)
    let content = Buffer.alloc(0)
    let eof = false
    for (let attempt = 0; attempt < 8; attempt++) {
      const { bytesRead } = await handle.read(buf, 0, buf.length, null)
      if (bytesRead === 0) eof = true
      else content = Buffer.concat([content, buf.subarray(0, bytesRead)])
      let decoded = null
      if (content.length >= 4 && content.readUInt32LE(0) === ZSTD_MAGIC && !eof) {
        const frame = firstZstdFrame(content)
        if (frame !== null) {
          try { decoded = zstdDecompressSync(content.subarray(frame.start, frame.end)).toString('utf8') } catch { return null }
        }
      } else if (eof) {
        // 明文（compression: none）：第一行就是 header。
        const nl = content.indexOf(10)
        decoded = (nl === -1 ? content : content.subarray(0, nl)).toString('utf8')
      }
      if (decoded !== null) return parseFirstJson(decoded)
      if (eof) return null
    }
    return null
  } catch {
    return null
  } finally {
    try { await handle.close() } catch { /* 关闭失败无所谓 */ }
  }
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
    // ⚠️ 必须读记账**原文** `ws.record.sessionIds`，不能读 `ws.sessionIds`！
    //    后者是 getter，会按内存 header 索引过滤（`sessionPath(id) === record.path`），
    //    而平台索引只增不删 —— 磁盘已删的会话仍留在索引里，getter 照旧把它返回，
    //    于是幽灵永远被自己过滤掉、检测恒为空。已实测踩到（ghosts 恒为 0）。
    //    同理不要把 sessionPersistence.list() 并进来：它也谎报存在。
    //    唯一可信的判据是磁盘 + 内存态 live 会话。
    const live = new Set((ctx.sessions?.list?.() ?? []).map((s) => s.id))
    const groups = []
    for (const ws of ctx.workspaceRegistry.list() ?? []) {
      const raw = ws?.record?.sessionIds ?? ws?.sessionIds ?? []
      const ghosts = raw.filter((id) => !stored.has(id) && !live.has(id))
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
        // ⚠️ orphan 的判据必须是**磁盘是否真的有这个目录**，不能只用 `dir === null`。
        //    sessionDirFor() 返回的只是「按 cwd + id **拼出来**的路径字符串」，
        //    即使目录早被删掉它也不是 null —— 于是磁盘已无的归档会话会被误判成
        //    orphan=false、sizeBytes=0，界面上看不出异常（实测踩到：用户删掉的会话
        //    在归档页里以「0 B」的普通条目形态停在原地，观感像"删了又回来"）。
        const exists = dir !== null && existsSync(dir)
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
          sizeBytes: exists ? await dirSizeBytes(dir) : null,
          // 磁盘上已无会话目录（孤儿归档记录）→ 删除时只清理归档记录。
          orphan: !exists,
          // 磁盘已删、但该会话在本进程内仍 live（用户刚打开过就删了）：
          // 这是**正常终态**，不是错误 —— 它被保留在归档集合里，于是被侧栏隐藏；
          // 重启 DSH 后内存态重建，条目彻底消失。前端据此给出准确提示。
          liveOrphan: !exists && agent0 !== undefined,
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
        // ⚠️ 「磁盘上已无」的判据必须是**真的 stat 一下**，不能只看 dir === null。
        //    sessionDirFor() 只按 cwd+id **拼**出路径字符串，磁盘早被删了它也不是 null ——
        //    只判 null 会让「已删过的会话」继续走 ④（rm force 对不存在的目录静默成功），
        //    然后到 ⑤ 因 live 而保留归档态 → **状态原地不动**：用户反复点删除毫无效果，
        //    条目永久卡在归档页（实测踩到，用户截图里的「0 B」条目就是它）。
        const onDisk = dir !== null && existsSync(dir)
        if (!onDisk) {
          // 「孤儿归档记录」：归档集合里留着 id，但磁盘上早已没有这个会话目录
          // （典型成因：所在工作区被删、文件被手工清掉、或此前删过一次）。
          // 没有任何磁盘内容可删，正确处理 = 清理记账与归档标记。
          //
          // ⚠️ 但对**仍 live**（本进程内存里活着）的会话不能这么清：一旦摘掉归档标记，
          //    它就再没有"隐藏理由"，而 sessionQuery.listSessions() 会把内存态会话
          //    重新并进列表 → 于是它带着空归属落进侧栏「未分组」（正是本插件要修的
          //    那个 bug，见 ⑤ 段的长注释）。所以 live 的孤儿保持归档态、如实上报
          //    「重启后消失」；它不会出现在侧栏，只在归档页作为待重启项可见。
          if (agent !== undefined) {
            const liveOrphanErrors = []
            try {
              if (!archivedSet().has(id)) await ctx.workspaceRegistry.archiveSession(id, { stopActivity: true })
            } catch (error) {
              liveOrphanErrors.push(`rearchive-failed: ${String(error)}`)
            }
            results.push(liveOrphanErrors.length > 0
              ? { sessionId: id, ok: false, error: liveOrphanErrors[0] }
              : { sessionId: id, ok: true, orphan: true, wasLive: true, pendingRestart: true })
            continue
          }
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
        //
        //  ⚠️⚠️ 但 a+b 对 **live（本进程内存里仍活着）** 的会话是错的，会造成
        //  「删完刷新，会话跑到未分组」——这是用户反复反馈的原始 bug，2026-10-12
        //  用宿主 lsof 实证定位：
        //
        //  平台列表的来源是 sessionQuery.listSessions()（dsh-session-query/
        //  lib/index.js:95-116）：它先放「磁盘持久化」的会话，**再用
        //  ctx.sessions.list()（内存中的 live 会话）覆盖合并**。所以只要会话在
        //  本进程内仍是 live，即使磁盘目录已删、记账已摘，刷新页面时它照样被
        //  列出来。而它的归属已被 detachSession 摘掉 → 不属于任何工作区 →
        //  被 groupByWorkspace（dsh-client-ui-workspace/lib/client.js:1044/1060）
        //  归进 stray → 显示在**「未分组」**★
        //
        //  实证：宿主 77255 的 lsof 显示它仍持有
        //  `--Users-felix--/session-996d624a-.../session.lock`，而该目录**已被删除**
        //  （ls 报 No such file）；同时该 id 不在任何工作区记账里、也不在归档集合里
        //  → 刷新后必然出现在「未分组」，与用户截图（标题「疑问」、时间「2 分钟」）吻合。
        //
        //  为什么不能靠 detachSession 解决：平台的 AgentRegistry / SessionStore
        //  没有对外暴露销毁入口（detachEntered 是创建方持有的 capability，
        //  dsh-session/lib/index.js:1882-1888），插件无法把 live 会话踢出内存。
        //
        //  ⇒ 因此对 live 会话**保留归档标记、不摘记账**：
        //     · 保留 archivedSessionIds → sessionVisible 的 'default' 过滤器
        //       （客户端 client.js:986 `return !archived.has(session.id)`）
        //       会把它**隐藏**，侧栏干净，不会出现「未分组」；
        //     · 不 detachSession → 归属仍在，工作区记账不出现游离项；
        //     · 重启 DSH 后内存态重建，它在磁盘上已不存在 → 彻底消失。
        //    这与 README「重启后彻底消失」的既有告知一致，但**不再需要用户手动
        //    清理未分组** —— 这正是本次要修的观感问题。
        //
        //  对**非 live**（冷）会话：磁盘已删、内存无它，listSessions 不会再列出它，
        //  走原来的 a+b 清理是正确且干净的（不留下归档集合里的孤儿 id）。
        const liveNow = agent !== undefined
        const cleanupErrors = []
        if (!liveNow) {
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
        } else {
          // live：**故意保留**归档标记与记账（见上方长注释）。
          // 但要确保它确实还在归档集合里 —— 若此前不是归档状态，补一次 archiveSession，
          // 否则「保留归档标记」会落空，会话会以未归档态暴露在侧栏。
          try {
            if (!archivedSet().has(id)) {
              await ctx.workspaceRegistry.archiveSession(id, { stopActivity: true })
            }
          } catch (error) {
            cleanupErrors.push(`rearchive-failed: ${String(error)}`)
          }
        }
        if (cleanupErrors.length > 0) {
          // 磁盘已删，但平台记账没清干净：如实上报（前端会提示重启以彻底收敛）。
          results.push({ sessionId: id, ok: true, deleted: true, warnings: cleanupErrors, wasLive: liveNow })
          continue
        }
        results.push({ sessionId: id, ok: true, deleted: true, wasLive: liveNow })
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

  /**
   * 扫描磁盘上**全部**会话目录，回 [{ dir, header }]。
   *
   * 抽成独立函数是因为 /repair（找「磁盘有、记账无」）与 /detach-subagents
   * （找「被记账的子智能体」）需要**同一份**磁盘枚举，两处各写一遍必然会漂移
   * ——尤其 CANONICAL_LOG_FILENAME 的版本选择规则必须一致。
   *
   * 规则（与官方 resolveGenerationInDirectory 同口径）：
   * - 逐层 readdir，**不对目录名做 UUID 形状假设**（历史遗留目录名五花八门，
   *   形状判断会漏扫，而这正是本插件要修的问题本身的成因）；
   * - 同一会话目录取**版本最高**的规范日志，其余代是历史遗留；
   * - 没有规范日志的目录不是会话目录（残留/临时目录），无视；
   * - header 读不出来时回 header: null，由调用方决定如何处理（**绝不猜**）。
   */
  async function scanSessionDirs() {
    const root = sessionsRoot()
    const out = []
    for (const project of await readdir(root, { withFileTypes: true })) {
      if (!project.isDirectory()) continue
      const projectDir = join(root, project.name)
      let entries
      try { entries = await readdir(projectDir, { withFileTypes: true }) } catch { continue }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const dir = join(projectDir, entry.name)
        let files = []
        try { files = await readdir(dir, { withFileTypes: true }) } catch { continue }
        let selected = null
        let selectedVersion = -1
        for (const file of files) {
          if (!file.isFile()) continue
          const match = CANONICAL_LOG_FILENAME.exec(file.name)
          if (match === null) continue
          const version = match[1] === undefined ? 0 : Number(match[1])
          if (version > selectedVersion) { selectedVersion = version; selected = file.name }
        }
        if (selected === null) continue
        out.push({ dir, header: await readLogHeader(join(dir, selected)) })
      }
    }
    return out
  }

  /**
   * 扫描磁盘上**全部**会话，找出「不在任何工作区记账里」的那些（= 侧栏里的「未分组」）。
   *
   * 为什么这些会话会游离在外（已实测确诊，勿凭直觉改）：
   * - dsh-client-ui-workspace/lib/client.js:1060 把「不在任何工作区记账里」的会话
   *   归入「未分组」——所以「未分组」的判据就是工作量：它不在 ws.record.sessionIds 里。
   * - 为什么它们进不了记账：dsh-workspace/lib/index.js:178 的 mutate() 每次写入都会
   *   按 `this.host.sessionPath(id) === changed.path` 剪枝；而 sessionPath 由内存
   *   header 索引填充，需要 cwd 经 realpath 后存在。历史遗留的「裸 UUID 目录名」
   *   会话从未被 attachSession 过，于是永远被剪掉。
   * - 解药（见 repair 路由）：先 attachSession（它会校验 cwd、调
   *   host.rememberSessionPath 再 mutate，正好解开剪枝死结），必要时先 create 工作区。
   *
   * @returns { ok: true, items, scanned } 或 { ok: false, message }（扫描失败时如实上报）
   */
  async function scanUnaccounted() {
    // ① 记账原文。
    //    ⚠️ 必须读 `ws.record.sessionIds` 原文，不能读 getter `ws.sessionIds`：
    //    后者会按内存 header 索引过滤（sessionPath(id) === record.path），
    //    正是幽灵检测踩过的坑；这里若用 getter，会把「磁盘上有、但索引里没有」
    //    的会话误判成未记账，反复归位同一批。已实测踩到（同 findGhostAccounted）。
    const accounted = new Set()
    for (const ws of ctx.workspaceRegistry.list() ?? []) {
      for (const id of ws?.record?.sessionIds ?? []) accounted.add(id)
    }
    // ② 扫磁盘（共用 scanSessionDirs）。
    const items = []
    let scanned = 0
    for (const { dir, header } of await scanSessionDirs()) {
      scanned += 1
      if (header === null || typeof header.id !== 'string' || header.id.length === 0) {
        // header 读不出来 → 不能判断归位目标，如实列为需人工处理，绝不猜。
        items.push({ sessionId: null, dir, cwd: null, resolvedCwd: null, action: 'skip', reason: 'unreadable-header' })
        continue
      }
      if (accounted.has(header.id)) continue
      // ⚠️ 子智能体（origin === 'subagent'）**不归位**，这是实测后加的硬规则。
      //
      // 为什么：侧栏的可见性判据是 sessionVisible()（dsh-client-ui-workspace/
      // lib/client.js:981）——
      //     if (session.origin === "subagent") return false;
      // 即子智能体**永远不显示为列表行**，只在父会话行上以「N 个子智能体运行中」
      // 计数徽标出现（同文件 1074/2045）。所以它们根本不可能出现在侧栏的
      // 「未分组」里 —— 「未分组」只由 origin !== 'subagent' 的会话构成。
      //
      // 实测证据（2026-10-12，本机真实数据）：磁盘 69 个会话里 37 个未记账，
      // 其中 34 个是 subagent、只有 3 个是侧栏可见的普通会话。若不排除，
      // 归位会把 33 个子智能体塞进用户工作区的 sessionIds（ant_link 16 /
      // dsh-plugins 14 / felix 3），把记账撑成 66 条 —— 侧栏虽因上面的过滤
      // 而不显示，但这属于**语义错误的脏数据**：子智能体本不该占用用户工作区
      // 的归属槽位（对照：helios 工作区原生记账 2 条，全是普通会话）。
      // 排除后 pending 从 37 降到 3，与「侧栏真正可见的未分组项」数量一致。
      if (header.origin === 'subagent') {
        items.push({
          sessionId: header.id,
          dir,
          cwd: typeof header.cwd === 'string' && header.cwd.length > 0 ? header.cwd : null,
          resolvedCwd: null,
          action: 'skip',
          reason: 'subagent',
        })
        continue
      }
      items.push({
        sessionId: header.id,
        dir,
        cwd: typeof header.cwd === 'string' && header.cwd.length > 0 ? header.cwd : null,
        resolvedCwd: null,
        action: 'skip',
        reason: 'cwd-missing',
      })
    }
    // ③ 逐个解析 cwd（realpath）：只有真实存在的目录才能当工作区路径。
    //    attachSession 内部也是 realpathNormalize 后比对，这里先算一遍是为了
    //    把「cwd 已消失」在预览期就标成 skip，并让目标工作区路径与实体 path 可直接比较。
    //
    //    ⚠️ 必须跳过已经判为 skip 的条目（reason === 'subagent'）：
    //    本循环会把 action 无条件改写成 'attach'，若不过滤，就会**推翻**前面
    //    对子智能体的排除决定。实测踩到：加了 subagent 排除后 pending 仍是 3，
    //    其中混着一个 origin='subagent' 的会话（reason 被覆盖成 workspace-missing）
    //    —— 症状是「过滤写了但不生效」，根因就是这里覆盖了 action。
    for (const item of items) {
      if (item.reason === 'subagent') continue
      if (item.cwd === null) continue
      try {
        const resolved = await realpath(item.cwd)
        const info = await stat(resolved)
        if (!info.isDirectory()) { item.reason = 'cwd-not-directory'; continue }
        item.resolvedCwd = resolved
        item.action = 'attach' // 先假设已有工作区；下面按工作区清单改写
        item.reason = 'workspace-found'
      } catch (error) {
        item.reason = 'cwd-unresolvable'
        item.resolveError = String(error)
      }
    }
    // ④ 决定动作：path === resolvedCwd（与官方 create/resolveByPath 同一口径 ——
    //    它们都比较 realpath 规范化后的路径）的工作区直接挂；没有则新建。
    //    ⚠️ 这里读 getter `ws.sessionIds` 是**故意的、也是安全的**：我们不是在
    //    判断「记没记账」（那用原文），只是给用户看目标工作区现有多少个会话，
    //    而且这个条目本身就没被记账（原始数组里没有它）。
    const workspaceByPath = new Map()
    const outgoing = []
    let newWorkspaces = 0
    for (const ws of ctx.workspaceRegistry.list() ?? []) outgoing.push(ws)
    for (const item of items) {
      if (item.resolvedCwd === null) continue
      let target = workspaceByPath.get(item.resolvedCwd)
      if (target === undefined) {
        for (const ws of outgoing) {
          if (ws.path === item.resolvedCwd) { target = ws; break }
        }
        if (target !== undefined) workspaceByPath.set(item.resolvedCwd, target)
      }
      if (target !== undefined) {
        item.action = 'attach'
        item.reason = 'workspace-found'
        item.targetWorkspaceId = target.id ?? null
        item.targetTitle = target.title ?? target.path ?? ''
      } else {
        // 没有对应工作区 → 需要新建（create 对已存在的 canonical path 会复用现有实体，
        // 见 dsh-workspace/lib/index.js:406 create + createCanonical:639）。
        item.action = 'create-workspace'
        item.reason = 'workspace-missing'
        item.targetWorkspaceId = null
        item.targetTitle = basename(item.resolvedCwd)
        newWorkspaces += 1
      }
    }
    return { ok: true, items, scanned, newWorkspaces }
  }

  /**
   * 找出「被记账的子智能体」：工作区记账里记着、且 header.origin === 'subagent' 的会话。
   *
   * 为什么需要单独清理：子智能体**本不该**出现在用户工作区的归属记账里
   * （见 scanUnaccounted 里关于 sessionVisible 的说明）。本插件的 /repair 早期版本
   * 曾有缺陷：先按「磁盘有、记账无」收全量会话，再在后续步骤无条件把 action 改写成
   * 'attach'，导致**子智能体也被挂进用户工作区**（本机实测 33 个被写进
   * ant_link 16 / dsh-plugins 14 / felix 3）。归位逻辑现已修正，但已经落盘的历史
   * 污染需要一条清理通路。
   *
   * 判据同样必须是**磁盘现状**（读每个会话目录的 header），不能只信内存索引。
   * @returns [{ workspaceId, title, path, sessionIds }]
   */
  async function findAccountedSubagents() {
    // 复用 scanSessionDirs（同一份磁盘枚举，避免与 /repair 的口径漂移）。
    const originById = new Map()
    for (const { header } of await scanSessionDirs()) {
      if (header !== null && typeof header.id === 'string') originById.set(header.id, header.origin)
    }
    // 与记账原文比对（同 scanUnaccounted：读 record.sessionIds，不读 getter）。
    const groups = []
    for (const ws of ctx.workspaceRegistry.list() ?? []) {
      const raw = ws?.record?.sessionIds ?? []
      const subs = raw.filter((id) => originById.get(id) === 'subagent')
      if (subs.length > 0) {
        groups.push({ workspaceId: ws.id, title: ws.title ?? '', path: ws.path ?? '', sessionIds: subs })
      }
    }
    return groups
  }

  /**
   * 清理「被误记账的子智能体」：把这些 id 从工作区记账里摘掉。
   *
   * 这是**只改记账、不动磁盘**的维护操作：子智能体的会话文件保持原样（它们本就该
   * 留在磁盘上，只是不该占用用户工作区的归属槽位）。摘除后它们不再计入工作区会话数，
   * 侧栏表现与官方语义一致（子智能体只在父会话行上以计数徽标出现）。
   *
   * Body: { dryRun?: boolean }
   */
  route(`${API_BASE}/detach-subagents`, async (req, res) => {
    try {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method-not-allowed' })
      let dryRun = false
      try {
        const raw = await readBody(req)
        if (raw) dryRun = JSON.parse(raw).dryRun === true
      } catch {
        return sendJson(res, 400, { error: 'bad-json' })
      }
      let groups
      try {
        groups = await findAccountedSubagents()
      } catch (error) {
        // 扫描失败必须如实上报：回空清单等于谎称「没有污染」，用户会以为已经干净。
        ctx.logger?.warn?.(`${NAME}: subagent scan failed: ${String(error)}`)
        return sendJson(res, 500, { error: 'scan-failed', message: String(error) })
      }

      const total = groups.reduce((a, g) => a + g.sessionIds.length, 0)
      if (dryRun) {
        return sendJson(res, 200, { dryRun: true, total, groups })
      }

      const results = []
      let detached = 0
      for (const group of groups) {
        const ws = (ctx.workspaceRegistry.list() ?? []).find((w) => w.id === group.workspaceId)
        if (ws === undefined || typeof ws.detachSession !== 'function') {
          results.push({ workspaceId: group.workspaceId, title: group.title, ok: false, error: 'workspace-not-writable' })
          continue
        }
        const failures = []
        let okCount = 0
        for (const sessionId of group.sessionIds) {
          // 逐项 try/catch：单项失败不中断整批。
          try {
            await ws.detachSession(sessionId)
            okCount++
          } catch (error) {
            failures.push({ sessionId, error: String(error) })
          }
        }
        detached += okCount
        results.push({ workspaceId: group.workspaceId, title: group.title, ok: failures.length === 0, removed: okCount, failures })
      }
      if (detached > 0) {
        // 只改了记账归属，不涉及会话行的增删 → 不发 api-session/removed（那会把行摘掉）。
        // 发 connection/reset 让前端重拉工作区快照即可。
        try { ctx.emit('connection/reset') } catch { /* 旧宿主无该事件时静默 */ }
      }
      sendJson(res, 200, { dryRun: false, total, detached, results })
    } catch (error) {
      ctx.logger?.warn?.(`${NAME}: detach-subagents failed: ${String(error)}`)
      sendJson(res, 500, { error: 'detach-subagents-failed', message: String(error) })
    }
  })

  /**
   * 归位：把「磁盘上有、但不在任何工作区记账里」的会话挂回 cwd 对应的工作区。
   *
   * Body: { dryRun?: boolean }
   * - `{ dryRun: true }` —— **只读预览**，不写任何状态，回 items 清单；
   * - `{}` / 无 body —— 执行：逐项 attach（必要时先建工作区），逐项汇报。
   *
   * 这是**归位，不是清理**：全程不删除任何磁盘内容，只补平台记账。
   * 归位后这些会话会从侧栏「未分组」回到它们 cwd 所属的工作区。
   */
  route(`${API_BASE}/repair`, async (req, res) => {
    try {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'method-not-allowed' })
      let dryRun = false
      try {
        const raw = await readBody(req)
        if (raw) {
          const body = JSON.parse(raw)
          dryRun = body.dryRun === true
        }
      } catch {
        return sendJson(res, 400, { error: 'bad-json' })
      }

      let scan
      try {
        scan = await scanUnaccounted()
      } catch (error) {
        // 扫描失败必须如实上报：回空清单等于告诉前端「没有待归位会话」，
        // 而真相是我们压根没看到磁盘 —— 用户会以为已经修好了。
        ctx.logger?.warn?.(`${NAME}: repair scan failed: ${String(error)}`)
        return sendJson(res, 500, { error: 'scan-failed', message: String(error) })
      }
      // 待归位总数只统计**真会动作**的项（skip 的项执行后也不会变，
      // 与客户端「已归位 N 个」的口径一致）。
      const pending = scan.items.filter((it) => it.action !== 'skip')

      if (dryRun) {
        return sendJson(res, 200, {
          dryRun: true,
          scanned: scan.scanned,
          pending: pending.length,
          newWorkspaces: scan.newWorkspaces,
          items: scan.items,
        })
      }

      const results = []
      let attached = 0
      let createdWorkspaces = 0
      for (const item of scan.items) {
        // skip 项（cwd 缺失/已消失/header 读不出）如实回报，不静默丢弃。
        if (item.action === 'skip') {
          results.push({ sessionId: item.sessionId, dir: item.dir, ok: false, skipped: true, error: item.reason })
          continue
        }
        // 逐项 try/catch：单项失败绝不中断整批（归位是幂等维护动作，
        // 失败的项下次再跑一次即可，不能因为一个坏会话把其余几十个卡住）。
        try {
          let ws = null
          for (const candidate of ctx.workspaceRegistry.list() ?? []) {
            if (candidate.path === item.resolvedCwd) { ws = candidate; break }
          }
          if (ws === null) {
            // create 对已存在的 canonical path 会**复用**现有实体，不会重复建；
            // 标题用 basename（与平台 defaultWorkspaceTitle 的取向一致：
            // 展示的是用户写下的那一段目录名，而不是 realpath 之后的路径）。
            ws = await ctx.workspaceRegistry.create(item.resolvedCwd, basename(item.resolvedCwd))
            if (ws !== null && ws !== undefined) createdWorkspaces += 1
          }
          if (ws === null || ws === undefined || typeof ws.attachSession !== 'function') {
            results.push({ sessionId: item.sessionId, dir: item.dir, ok: false, error: 'workspace-not-writable' })
            continue
          }
          // attachSession 是**幂等**的；它只对首次挂载的会话做 cwd 校验
          // （不存在/非目录/与工作区 path 不一致都会抛错，我们如实上报）。
          await ws.attachSession(item.sessionId)
          attached += 1
          results.push({
            sessionId: item.sessionId,
            dir: item.dir,
            cwd: item.cwd,
            resolvedCwd: item.resolvedCwd,
            workspaceId: ws.id ?? null,
            workspaceTitle: ws.title ?? '',
            ok: true,
          })
        } catch (error) {
          results.push({ sessionId: item.sessionId, dir: item.dir, cwd: item.cwd, resolvedCwd: item.resolvedCwd, ok: false, error: String(error) })
        }
      }

      // 记账变了，通知前端重拉工作区/会话列表。
      // ⚠️ 这里**不能**复用删除那条路的 `api-session/removed`：那个事件是从列表里
      //    *移除*一行（dsh-api-session-controller 的 handleSessionRemoved），
      //    归位的语义恰恰相反 —— 会话只是换了分组，还在列表里。发错事件会让
      //    刚归位的会话从侧栏消失（实测过的语义差异，别"顺手统一"）。
      //    connection/reset 是平台「请重拉数据」的标准事件（dsh-api-gateway 在
      //    连接建立/重连后也发它），ui-workspace 收到后刷新 hostInfo 与工作区快照。
      if (attached > 0 || createdWorkspaces > 0) {
        try { ctx.emit('connection/reset') } catch { /* 旧宿主无该事件时静默 */ }
      }
      sendJson(res, 200, {
        dryRun: false,
        scanned: scan.scanned,
        attached,
        createdWorkspaces,
        results,
      })
    } catch (error) {
      ctx.logger?.warn?.(`${NAME}: repair failed: ${String(error)}`)
      sendJson(res, 500, { error: 'repair-failed', message: String(error) })
    }
  })

  // 路由必须在卸载时撤销，否则 HMR 重新 apply 撞 duplicate route。
  ctx.effect(() => () => {
    for (const dispose of registered.splice(0)) {
      try { dispose() } catch { /* 卸载期容错 */ }
    }
  }, `${NAME}: routes`)
}
