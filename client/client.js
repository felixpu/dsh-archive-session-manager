// dsh-archive-session-manager —— 归档会话管理的**浏览器半身**。
//
// 三个 UI 落点（契约均经 cordis_inspect_query 实时核对，非猜测）：
//
// 1) 单个删除入口 = `sidebar.workspaces.session.menu.item` 槽（会话「···」菜单）。
//    官方注册了 pin(100)/rename(200)/fork(300)/archive(400)，本插件以 order 500
//    追加「删除会话」，且**仅当该行会话在归档集合中时渲染**。
//    ownerProps: { sessionId, displayTitle }；菜单状态经注入的 useMenuOpenState 关闭。
//    归档判定用 standardProps 的 useWorkspaces（快照含 archivedSessionIds），
//    与官方 ArchiveSessionMenuItem 的 useArchived 同源（都是 workspaces.list 的 derive）。
//
// 2) 批量管理正文 = `settings.section` 设置页（id 借用 'archived-sessions'，
//    原因见该注册处；order 65）。**不是** sidebar.footer.action —— 早期版本曾计划
//    放侧栏底部，后改为设置页（低频批量维护，不是会话内日常动作）。
//
// 3) 单个删除的确认对话框 = `shell.overlay` 槽（全屏浮层，click-through，
//    条目需自行 opt-in pointer events）。批量管理面板已移入上面第 2 项。
//
// ⚠️ 只允许 require 平台种子表 9 项内的模块；slots 服务走 package.json
//    里 dsh.client.inject 声明的 "@deepseek-ai/dsh-client-ui-slots"。
window.__ModuleLoader__.load({
  id: 'dsh-archive-session-manager',
  factory(require) {
    var React = require('react');
    var h = React.createElement;
    var Primitives = require('@deepseek-ai/dsh-client-ui-primitives');

    var API = '/api/dsh-archive-session-manager';

    // ---- 文案字典（官方 locale 服务；中英双语必须成对）----
    //
    // 走平台官方 locale 服务（`ctx.locale.register(ns, {zh, en})` + `bind`），
    // 与官方插件同一套机制（参见 dsh-client-ui-schedule / dsh-restart-autostart）。
    // 语言切换时插槽渲染的文案会**实时**跟著变（注册期文案用 thunk label）。
    //
    // ⚠️ 命名空间用包名，绝不复用官方或他人命名空间 —— 同名会撞（duplicate
    //    (ns, locale) 会抛错）。
    //
    // ⚠️ 以下键**刻意不定义**，直接复用平台 `common` 字典（lookup 在本命名空间
    //    未命中后会回落到 common）：
    //      cancel / loading / unknown / retry
    //    自己再写一遍会与平台文案不一致（例如 common 的 cancel 是「取消」/Cancel）。
    //
    // ⚠️ 每条都是**一个完整句子**，变量用 `{name}` 占位。不要拆成片段再拼接：
    //    英文语序与中文不同（"3 sessions deleted" vs 「已删除 3 个会话」），
    //    拼接式无法重排，且片段本身也成了需要翻译的字符串。
    var NS = 'dsh-archive-session-manager';
    var zh = {
      // 菜单 / 对话框
      'menu.delete': '删除会话',
      'menu.navLabel': '归档会话',
      'dlg.title': '删除归档会话',
      'dlg.body': '将永久删除会话「{title}」的全部记录（磁盘上的会话日志），此操作不可恢复。',
      'dlg.cascade': '它名下派生的子智能体会话也会一并删除（子智能体不作为列表行显示，平台不会自动级联，因此由本插件连带清理）。',
      'dlg.cancel': '取消',
      'dlg.confirm': '永久删除',
      'dlg.deleting': '删除中…',
      // 状态行（{n} 为数量）
      'res.deleted': '已删除 {n} 个会话',
      'res.released': '释放 {size}',
      'res.subagents': '连同 {n} 个子智能体会话',
      'res.cleanedOnly': '其中 {n} 个仅清理了归档记录（磁盘已无文件）',
      'res.evicted': '其中 {n} 个会话已连同内存态一并驱逐',
      'res.warned': '{n} 个的列表记账未能立即清理，可在面板点「重试驱逐」或重启后自动收敛',
      'res.partialFail': '已删除 {ok} 个，失败 {fail} 个：{reason}',
      'res.unarchived': '已取消归档 {n} 个会话',
      'res.unarchivePartial': '完成 {ok} 个，失败 {fail} 个',
      'res.cleaned': '已清理 {n} 个失效的列表记账',
      'res.evictedOne': '已驱逐 {n} 个会话的内存态',
      'res.evictedNone': '这些会话已不在内存中',
      'res.evictPartial': '驱逐 {n} 个，失败 {fail} 个：{reason}',
      'res.detached': '已从工作区记账中摘除 {n} 个子智能体（会话文件未动）',
      'res.detachPartial': '已摘除 {n} 个，失败 {fail} 个：{reason}',
      'res.empties': '已删除 {n} 个遗留空会话',
      'res.emptiesSkipped': '跳过 {n} 个（{reason}）',
      'res.repaired': '已归位 {n} 个，失败 {fail} 个：{reason}',
      'res.repairedAll': '已归位 {n} 个会话',
      'res.newWorkspaces': '新建 {n} 个工作区',
      // 提示条
      'notice.ghosts': '检测到 {n} 个失效的列表记账（会话文件已不在磁盘上，多为历史手工删除遗留），它们会在侧栏显示为空会话。',
      'notice.cleanup': '清理',
      'notice.cleaning': '清理中…',
      'notice.repair': '检测到 {n} 个会话不在任何工作区记账里（会显示在侧栏「未分组」），可一键归位。',
      'notice.repairNewWs': '其中 {n} 个需要新建工作区。',
      'notice.repairHint': '归位只修复列表归属（把这些会话挂到其工作目录对应的工作区），不删除任何文件；预览是只读的。',
      'notice.previewAgain': '重新预览',
      'notice.repairBtn': '一键归位',
      'notice.repairing': '归位中…',
      'notice.subs': '检测到 {n} 个子智能体被记在了工作区归属里（它们本不该占用工作区的会话槽位）。',
      'notice.subsHint': '摘除只修改列表归属记账，不删除任何会话文件；子智能体仍属于其父会话。',
      'notice.detachBtn': '一键摘除',
      'notice.detaching': '摘除中…',
      'notice.evict': '有 {n} 个会话已删除但内存态仍被持有，暂时无法彻底清除。',
      'notice.evictHint': '它们不会出现在侧栏；点右侧重试一次即可当场清除，重启 DSH 也会自动收敛。',
      'notice.evictBtn': '重试驱逐',
      'notice.evicting': '处理中…',
      'notice.emptiesTitle': '清理遗留空会话',
      'notice.emptiesHint': '找出「建了但从未有过对话」的会话目录并删除。需要扫描全部会话日志，可能耗时几秒 —— 因此不自动运行。',
      'notice.emptiesScan': '开始扫描',
      'notice.emptiesScanning': '扫描中…',
      'notice.emptiesFound': '检测到 {n} 个遗留空会话（建了但从未有过对话，共 {size}）。',
      'notice.emptiesNone': '已扫描：没有发现遗留空会话。',
      'notice.emptiesConfirm': '确认永久删除这些磁盘记录？不可恢复。',
      'notice.emptiesWarn': '删除会永久移除它们的磁盘记录（不可恢复）；宿主会拒绝删除任何有对话内容的会话。',
      'notice.emptiesDelete': '清理空会话',
      'notice.emptiesDeleting': '删除中…',
      'notice.emptiesDeleteConfirm': '确认删除',
      'notice.back': '再想想',
      // 页头 / 表格 / 页脚
      'page.desc': '这里列出全部已归档会话。可多选后批量删除（永久删除磁盘记录）或批量取消归档。',
      'page.batchConfirm': '确认永久删除选中的 {n} 个会话？磁盘记录不可恢复。它们名下派生的子智能体会话也会一并删除（子智能体不作为列表行显示，平台不会自动级联，因此由本插件连带清理）。',
      'page.empty': '没有已归档的会话',
      'page.loading': '加载中…',
      'page.untitled': '（无标题会话）',
      'page.orphan': ' · 磁盘上已不存在（仅清理归档记录）',
      'page.ungrouped': '未分组',
      'page.summary': '共 {n} 个归档会话',
      'page.orphans': '{n} 个磁盘已不存在',
      'page.unarchive': '取消归档',
      'page.batchDelete': '批量删除',
      'page.confirmDelete': '确认删除',
      'page.refresh': '刷新',
      'page.selectAll': '全选（{n}/{total}）',
      'page.targetsEtc': '等',
      // 日期格式化用的区域标签（与官方 ui-schedule 同做法：由字典驱动，
      // 这样组件不需要额外注入 locale 服务，语言切换时自然跟随）。
      'time.locale': 'zh-CN',
      // 错误（{msg} 为底层原因）
      'err.delete': '删除失败：{msg}',
      'err.batchDelete': '批量删除失败：{msg}',
      'err.unarchive': '取消归档失败：{msg}',
      'err.cleanup': '清理失败：{msg}',
      'err.evict': '驱逐失败：{msg}',
      'err.detach': '摘除失败：{msg}',
      'err.empties': '删除空会话失败：{msg}',
      'err.repair': '归位失败：{msg}',
      'err.listLoad': '列表加载失败：{msg}',
      'err.partial': '部分数据获取失败 → {msg}',
      'err.meta': '会话元数据：{msg}',
      'err.workspaces': '工作区列表：{msg}',
      'err.routeDown': '{what}不可用（宿主 /{route} 路由无响应）：{msg}',
      'what.repair': '归位预览',
      'what.subagents': '子智能体预览',
      'what.empties': '空会话扫描',
      'err.sessionRunning': '该会话正在执行任务，无法删除；请先停止它',
      'code.not-archived': '该会话未被归档（只有归档会话可以删除）',
      'code.session-running': '该会话正在执行任务',
      'code.session-live': '该会话仍在运行中',
      'code.session-archived': '该会话已归档（请到归档页删除）',
      'code.has-content': '该会话有对话内容',
      'code.log-missing': '找不到会话日志',
      'code.log-unreadable': '会话日志无法读取',
      'code.persistence-unavailable': '持久化服务不可用',
      'code.workspace-not-writable': '目标工作区不可写',
      'code.not-found': '找不到该会话',
      'code.scan-failed': '扫描失败',
      'code.bad-json': '请求格式错误',
      'code.empty-selection': '未选择任何会话',
      'code.method-not-allowed': '不支持的请求方法',
      'code.delete-failed': '删除失败',
      'code.repair-failed': '归位失败',
      'code.cleanup-failed': '清理失败',
      'code.evict-failed': '驱逐失败',
      'code.detach-subagents-failed': '摘除失败',
      'code.empty-sessions-failed': '清理空会话失败',
      'code.list-failed': '列表加载失败',
    };
    var en = {
      'menu.delete': 'Delete session',
      'menu.navLabel': 'Archived sessions',
      'dlg.title': 'Delete archived session',
      'dlg.body': 'Permanently delete session "{title}" — all of its records (the session log on disk). This cannot be undone.',
      'dlg.cascade': 'Subagent sessions spawned by it are deleted as well (subagents are never shown as list rows and the platform does not cascade automatically, so this plugin cleans them up).',
      'dlg.cancel': 'Cancel',
      'dlg.confirm': 'Delete permanently',
      'dlg.deleting': 'Deleting…',
      'res.deleted': 'Deleted {n} session(s)',
      'res.released': 'freed {size}',
      'res.subagents': 'including {n} subagent session(s)',
      'res.cleanedOnly': '{n} of them only had their archive record cleaned up (no files left on disk)',
      'res.evicted': '{n} of them were evicted from memory as well',
      'res.warned': '{n} listing record(s) could not be cleaned up immediately — use "Retry eviction" in the panel, or restart DSH to converge',
      'res.partialFail': 'Deleted {ok}, failed {fail}: {reason}',
      'res.unarchived': 'Unarchived {n} session(s)',
      'res.unarchivePartial': 'Done {ok}, failed {fail}',
      'res.cleaned': 'Cleaned up {n} stale listing record(s)',
      'res.evictedOne': 'Evicted {n} session(s) from memory',
      'res.evictedNone': 'These sessions are no longer in memory',
      'res.evictPartial': 'Evicted {n}, failed {fail}: {reason}',
      'res.detached': 'Removed {n} subagent(s) from workspace accounting (no session files touched)',
      'res.detachPartial': 'Removed {n}, failed {fail}: {reason}',
      'res.empties': 'Deleted {n} leftover empty session(s)',
      'res.emptiesSkipped': 'skipped {n} ({reason})',
      'res.repaired': 'Reattached {n}, failed {fail}: {reason}',
      'res.repairedAll': 'Reattached {n} session(s)',
      'res.newWorkspaces': 'created {n} workspace(s)',
      'notice.ghosts': 'Found {n} stale listing record(s) (the session files are gone from disk, usually from manual deletion). They show up in the sidebar as empty sessions.',
      'notice.cleanup': 'Clean up',
      'notice.cleaning': 'Cleaning…',
      'notice.repair': 'Found {n} session(s) in no workspace accounting (they show up under “Ungrouped” in the sidebar). You can reattach them in one click.',
      'notice.repairNewWs': '{n} of them need a new workspace.',
      'notice.repairHint': 'Reattaching only fixes listing ownership (it attaches these sessions to the workspace matching their working directory) and deletes nothing. The preview is read-only.',
      'notice.previewAgain': 'Refresh preview',
      'notice.repairBtn': 'Reattach all',
      'notice.repairing': 'Reattaching…',
      'notice.subs': 'Found {n} subagent(s) recorded as workspace-owned (they should not take up a workspace session slot).',
      'notice.subsHint': 'Removing them only edits listing ownership and deletes no session files; subagents still belong to their parent session.',
      'notice.detachBtn': 'Remove all',
      'notice.detaching': 'Removing…',
      'notice.evict': '{n} deleted session(s) are still held in memory and cannot be fully cleared yet.',
      'notice.evictHint': 'They do not appear in the sidebar. Click retry to clear them now — restarting DSH also converges.',
      'notice.evictBtn': 'Retry eviction',
      'notice.evicting': 'Working…',
      'notice.emptiesTitle': 'Clean up leftover empty sessions',
      'notice.emptiesHint': 'Finds session directories that were created but never used in a conversation, and deletes them. This scans every session log and may take a few seconds — so it does not run automatically.',
      'notice.emptiesScan': 'Start scan',
      'notice.emptiesScanning': 'Scanning…',
      'notice.emptiesFound': 'Found {n} leftover empty session(s) (created but never used in a conversation, {size} total).',
      'notice.emptiesNone': 'Scanned: no leftover empty sessions found.',
      'notice.emptiesConfirm': 'Permanently delete these disk records? This cannot be undone.',
      'notice.emptiesWarn': 'This permanently removes their disk records (irreversible). The host refuses to delete any session that has conversation content.',
      'notice.emptiesDelete': 'Clean up empty sessions',
      'notice.emptiesDeleting': 'Deleting…',
      'notice.emptiesDeleteConfirm': 'Confirm delete',
      'notice.back': 'Not now',
      'page.desc': 'All archived sessions are listed here. Select some to delete them in bulk (permanently removes disk records) or to unarchive them in bulk.',
      'page.batchConfirm': 'Permanently delete the {n} selected session(s)? Their disk records cannot be recovered. Subagent sessions spawned by them are deleted as well (subagents are never shown as list rows and the platform does not cascade automatically, so this plugin cleans them up).',
      'page.empty': 'No archived sessions',
      'page.loading': 'Loading…',
      'page.untitled': '(untitled session)',
      'page.orphan': ' · no longer on disk (archive record only)',
      'page.ungrouped': 'Ungrouped',
      'page.summary': '{n} archived session(s)',
      'page.orphans': '{n} no longer on disk',
      'page.unarchive': 'Unarchive',
      'page.batchDelete': 'Delete selected',
      'page.confirmDelete': 'Confirm delete',
      'page.refresh': 'Refresh',
      'page.selectAll': 'Select all ({n}/{total})',
      'page.targetsEtc': 'etc.',
      'time.locale': 'en-US',
      'err.delete': 'Delete failed: {msg}',
      'err.batchDelete': 'Bulk delete failed: {msg}',
      'err.unarchive': 'Unarchive failed: {msg}',
      'err.cleanup': 'Cleanup failed: {msg}',
      'err.evict': 'Eviction failed: {msg}',
      'err.detach': 'Removal failed: {msg}',
      'err.empties': 'Empty-session deletion failed: {msg}',
      'err.repair': 'Reattach failed: {msg}',
      'err.listLoad': 'Failed to load the list: {msg}',
      'err.partial': 'Some data could not be fetched → {msg}',
      'err.meta': 'Session metadata: {msg}',
      'err.workspaces': 'Workspace list: {msg}',
      'err.routeDown': '{what} unavailable (host route /{route} did not respond): {msg}',
      'what.repair': 'Reattach preview',
      'what.subagents': 'Subagent preview',
      'what.empties': 'Empty-session scan',
      'err.sessionRunning': 'This session is running a task and cannot be deleted; stop it first',
      'code.not-archived': 'this session is not archived (only archived sessions can be deleted)',
      'code.session-running': 'this session is running a task',
      'code.session-live': 'this session is still live',
      'code.session-archived': 'this session is archived (delete it from the archive page)',
      'code.has-content': 'this session has conversation content',
      'code.log-missing': 'session log not found',
      'code.log-unreadable': 'session log could not be read',
      'code.persistence-unavailable': 'persistence service unavailable',
      'code.workspace-not-writable': 'target workspace is not writable',
      'code.not-found': 'session not found',
      'code.scan-failed': 'scan failed',
      'code.bad-json': 'malformed request',
      'code.empty-selection': 'no session selected',
      'code.method-not-allowed': 'unsupported request method',
      'code.delete-failed': 'delete failed',
      'code.repair-failed': 'reattach failed',
      'code.cleanup-failed': 'cleanup failed',
      'code.evict-failed': 'eviction failed',
      'code.detach-subagents-failed': 'removal failed',
      'code.empty-sessions-failed': 'empty-session cleanup failed',
      'code.list-failed': 'failed to load the list',
    };

    // ---- 样式（只用 Theme.listTokens 实报的 --dsw-* token，明暗自动切换）----
    var CSS = [
      '.asm-veil{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;',
      'background:color-mix(in srgb,var(--dsw-alias-bg-base) 72%,transparent);pointer-events:auto;padding:24px}',
      '.asm-card{display:flex;flex-direction:column;gap:14px;padding:22px;border-radius:14px;pointer-events:auto;',
      'border:.5px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);',
      'box-shadow:0 12px 40px color-mix(in srgb,var(--dsw-alias-label-primary) 12%,transparent)}',
      '.asm-card-confirm{width:100%;max-width:400px}',
      // 设置页正文容器：铺满设置面板内容列，不设 max-width（由设置骨架控制宽度）。
      '.asm-section{display:flex;flex-direction:column;gap:12px;width:100%}',
      '.asm-title{margin:0;font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary)}',
      '.asm-desc{margin:0;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-secondary)}',
      '.asm-desc strong{color:var(--dsw-alias-label-primary)}',
      '.asm-warn{color:var(--dsw-alias-state-error-primary)}',
      '.asm-row-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:2px}',
      '.asm-btn{font-size:13px;padding:7px 14px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l1);cursor:pointer;',
      'background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.asm-btn:hover{border-color:var(--dsw-alias-border-l2)}',
      '.asm-btn:disabled{opacity:.5;cursor:not-allowed}',
      '.asm-btn-danger{background:var(--dsw-alias-state-error-primary);border-color:transparent;color:var(--dsw-alias-bg-base)}',
      '.asm-btn-primary{background:var(--dsw-alias-brand-primary);border-color:transparent;color:var(--dsw-alias-bg-base)}',
      '.asm-list{max-height:52vh;overflow-y:auto;display:flex;flex-direction:column;gap:14px;margin:0 -6px;padding:0 6px}',
      // 工作区分组
      '.asm-group{display:flex;flex-direction:column;gap:2px}',
      '.asm-group-head{display:flex;align-items:center;gap:8px;padding:6px 10px 4px;position:sticky;top:0;',
      'background:var(--dsw-alias-bg-layer-1);border-bottom:.5px solid var(--dsw-alias-border-l2);z-index:1}',
      '.asm-group-title-wrap{display:flex;align-items:center;gap:8px;cursor:pointer;min-width:0}',
      '.asm-group-title{font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.asm-group-count{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.asm-group-path{flex:1;min-width:0;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;',
      'text-overflow:ellipsis;text-align:right;direction:rtl}',
      '.asm-item{display:flex;align-items:center;gap:10px;padding:7px 10px;border-radius:8px;cursor:pointer}',
      '.asm-item-disabled{cursor:not-allowed;opacity:.55}',
      '.asm-item-disabled:hover{background:transparent}',
      '.asm-item:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.asm-item input{flex:none;accent-color:var(--dsw-alias-brand-primary)}',
      '.asm-item-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}',
      '.asm-item-title{font-size:13px;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.asm-item-meta{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.asm-item-bytes{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.asm-toolbar{display:flex;align-items:center;justify-content:space-between;gap:8px}',
      '.asm-toolbar-label{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.asm-empty{padding:32px 0;text-align:center;font-size:13px;color:var(--dsw-alias-label-secondary)}',
      // 提示条（幽灵记账清理 / 未记账会话归位）
      '.asm-notice{display:flex;align-items:center;gap:12px;justify-content:space-between;padding:10px 12px;border-radius:10px;',
      'border:.5px solid var(--dsw-alias-state-warn-primary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 10%,transparent);',
      'font-size:12px;line-height:1.55;color:var(--dsw-alias-label-primary)}',
      // 提示条正文：占满剩余宽度；右侧只放按钮，按钮不许被压扁或换行。
      '.asm-notice-main{flex:1;min-width:0}',
      '.asm-notice-actions{flex:none;display:flex;align-items:center;gap:8px}',
      '.asm-notice-actions .asm-btn{white-space:nowrap}',
      '.asm-notice-detail{margin-top:4px;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      // 中性提示（不是警告）：用于「可选、尚未运行」的项，避免一进页面就一片告警色。
      '.asm-notice-optional{border-color:var(--dsw-alias-border-l1);background:transparent}',
      '.asm-footer{display:flex;align-items:center;justify-content:space-between;gap:8px;border-top:.5px solid var(--dsw-alias-border-l1);padding-top:12px}',
      '.asm-status{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.asm-status-err{color:var(--dsw-alias-state-error-primary)}',
    ].join('\n');

    function useCss() {
      React.useEffect(function () {
        if (document.head.querySelector('style[data-plugin-css="dsh-archive-session-manager"]')) return undefined;
        var el = document.createElement('style');
        el.setAttribute('data-plugin-css', 'dsh-archive-session-manager');
        el.textContent = CSS;
        document.head.appendChild(el);
        return function () { el.remove(); };
      }, []);
    }

    // ---- 全局 UI 状态（模块级 store + 简单订阅）----
    // 只剩「单个会话删除」的确认框；批量管理已成为设置页正文，无需全局开合状态。
    var listeners = new Set();
    var uiState = {
      confirm: null,   // { sessionId, displayTitle }
    };
    function setUi(patch) {
      uiState = Object.assign({}, uiState, patch);
      listeners.forEach(function (fn) { fn(); });
    }
    function useUi() {
      var sub = React.useSyncExternalStore(
        function (fn) { listeners.add(fn); return function () { listeners.delete(fn); }; },
        function () { return uiState; },
        function () { return uiState; }
      );
      return sub;
    }

    /**
     * 宿主路由的统一调用：GET 取 JSON。
     * @param path 路由路径（不含 API 前缀），如 '/list'
     * @param label 出错时的短标识，用于拼 "list http 500"
     */
    async function apiGet(path, label) {
      var res = await fetch(API + path, { credentials: 'same-origin' });
      if (!res.ok) throw new Error(label + ' http ' + res.status);
      return res.json();
    }

    /**
     * 宿主路由的统一调用：POST JSON 并取 JSON。
     *
     * 原先 6 个 POST 包装函数各自重复 `method/credentials/headers` 三行加
     * 「!res.ok 抛错 + return res.json()」两行，共 ~70 行只差端点、body、label 三处。
     * 收敛到这里后新增路由只需一行，也避免将来只改一处（例如加重试、超时、
     * 统一错误体解析）造成行为不一致。
     */
    async function apiPost(path, body, label) {
      var res = await fetch(API + path, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      if (!res.ok) throw new Error(label + ' http ' + res.status);
      return res.json();
    }

    async function apiList() {
      return apiGet('/list', 'list');
    }
    /** 清理幽灵记账（不删磁盘内容——那些文件早已不存在）。 */
    async function apiCleanupGhosts() {
      return apiPost('/cleanup-ghosts', {}, 'cleanup');
    }
    /**
     * 清理「被误记账的子智能体」：把子智能体从工作区归属记账里摘掉。
     * 子智能体不该占用用户工作区的归属槽位（侧栏也不把它们显示为列表行），
     * 本插件的 /repair 早期版本曾误挂入，这里提供清理入口。
     * 只改记账、不动磁盘文件；dryRun=true 为只读预览。
     */
    async function apiDetachSubagents(dryRun) {
      return apiPost('/detach-subagents', dryRun ? { dryRun: true } : {}, 'detach-subagents');
    }
    /**
     * 磁盘遗留空会话：建了却从未用过（无任何 user/message）的会话目录。
     * 与 /repair、/detach-subagents 不同，这个接口**真删磁盘目录**，
     * 因此只由用户显式点击触发，且宿主会二次校验（有内容的会话一律拒删）。
     */
    async function apiEmptySessions(dryRun, sessionIds) {
      var body = dryRun ? { dryRun: true } : (sessionIds ? { sessionIds: sessionIds } : {});
      return apiPost('/empty-sessions', body, 'empty-sessions');
    }
    /**
     * 重试驱逐：对「已删除但当时驱逐失败」的会话再走一次驱逐。
     * 复用 /evict 路由（宿主侧只做驱逐 + 清理标记，不碰磁盘——磁盘早已删除）。
     */
    async function apiEvict(sessionIds) {
      return apiPost('/evict', { sessionIds: sessionIds }, 'evict');
    }
    async function apiDelete(sessionIds) {
      return apiPost('/delete', { sessionIds: sessionIds }, 'delete');
    }
    /**
     * 归位：把「磁盘上有、但不在任何工作区记账里」的会话挂回它 cwd 对应的工作区。
     * 这类会话没有归属，平台侧栏只能把它们统统塞进「未分组」。
     * dryRun=true 是**只读预览**，宿主不写任何状态（按钮上也要向用户说清这一点）。
     */
    async function apiRepair(dryRun) {
      return apiPost('/repair', dryRun ? { dryRun: true } : {}, 'repair');
    }

    function formatBytes(n) {
      if (n === null || n === undefined) return '';
      if (n < 1024) return n + ' B';
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
      return (n / 1024 / 1024).toFixed(1) + ' MB';
    }
    /**
     * 格式化会话时间。
     *
     * ⚠️ 区域必须跟随**当前语言**，不能写死 'zh-CN' —— 否则英文界面里会
     *    出现中文格式的日期（`2026/10/12 17:04` 对 en 用户是错的读法）。
     *    zh 用 'zh-CN'，其余跟随活动 locale；取不到就退回浏览器默认。
     */
    function formatTime(ms, localeTag) {
      if (!ms) return '';
      try {
        return new Date(ms).toLocaleString(localeTag || undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      } catch { return ''; }
    }

    /**
     * 把宿主返回的**错误码**翻译成可读文案。
     *
     * ⚠️ 宿主刻意只回机器可读的 code（如 `not-archived`），不回合成的自然语言 ——
     *    这样文案归客户端所有（可随语言切换），宿主也不必知道 UI 语言。
     *    因此**绝不能把 code 直接拼进面向用户的句子里**，否则用户会看到
     *    「删除失败：not-archived」这种半成品。
     */
    function codeText(t, code) {
      if (!code) return t('unknown');
      return t('code.' + code);
    }

    // ---- 1) 菜单行：删除会话（仅归档行可见）----
    // props：ownerProps { sessionId, displayTitle } + slotInject { useMenuOpenState }
    //        + standardProps { useWorkspaces }
    function DeleteSessionMenuItem(props) {
      var t = props.t;
      var sessionId = props.sessionId;
      var displayTitle = props.displayTitle;
      var setMenuOpen = props.useMenuOpenState ? props.useMenuOpenState()[1] : function () {};
      // 归档集合判定：useWorkspaces 是 SnapshotSelectorHook，选择 archivedSessionIds。
      var archived = false;
      try {
        if (props.useWorkspaces) {
          archived = !!props.useWorkspaces(function (snap) {
            var ids = snap && snap.archivedSessionIds;
            return ids && ids.indexOf(sessionId) !== -1;
          });
        }
      } catch { archived = false; }
      if (!archived) return null;

      var Icon = Primitives.IconTrashOutlineRegular;
      return h(Primitives.MenuItemButton, {
        icon: Icon ? h(Icon, { size: 14 }) : undefined,
        // danger=true 是 ui-primitives MenuItemButton 的原生属性（读源码确认，
        // 渲染 css.item + css.danger），即平台统一的红色危险项样式。
        // 不要自造颜色 —— 官方主题/明暗切换下才能与其它危险操作保持一致。
        danger: true,
        // 在「取消归档」等常规行下方加分隔线，降低误点概率。
        separatorBefore: true,
        onSelect: function () {
          setMenuOpen(false);
          setUi({ confirm: { sessionId: sessionId, displayTitle: displayTitle || sessionId } });
        },
      }, t('menu.delete'));
    }

    // ---- 2) 单个删除确认对话框 ----
    function ConfirmDeleteDialog(props) {
      useCss();
      var t = props.t;
      var ui = useUi();
      var pending = ui.confirm;
      var _busy = React.useState(false), busy = _busy[0], setBusy = _busy[1];
      var _err = React.useState(''), err = _err[0], setErr = _err[1];
      if (!pending) return null;

      function close() { if (!busy) { setErr(''); setUi({ confirm: null }); } }
      async function doDelete() {
        setBusy(true); setErr('');
        try {
          var out = await apiDelete([pending.sessionId]);
          var r = out.results && out.results[0];
          if (r && r.ok) {
            setUi({ confirm: null });
          } else {
            setErr(t('err.delete', { msg: codeText(t, r && r.error) }));
          }
        } catch (e) {
          setErr(t('err.delete', { msg: String(e && e.message || e) }));
        } finally {
          setBusy(false);
        }
      }

      return h('div', { className: 'asm-veil', onClick: close },
        h('div', { className: 'asm-card asm-card-confirm', onClick: function (e) { e.stopPropagation(); } },
          h('p', { className: 'asm-title' }, t('dlg.title')),
          h('p', { className: 'asm-desc' },
            t('dlg.body', { title: pending.displayTitle }),
            ' ',
            t('dlg.cascade')),
          err ? h('p', { className: 'asm-desc asm-warn' }, err) : null,
          h('div', { className: 'asm-row-actions' },
            h('button', { type: 'button', className: 'asm-btn', onClick: close, disabled: busy }, t('dlg.cancel')),
            h('button', { type: 'button', className: 'asm-btn asm-btn-danger', onClick: doDelete, disabled: busy },
              busy ? t('dlg.deleting') : t('dlg.confirm')))));
    }

    // ---- 3) 设置页：归档会话管理（settings.section，正文即管理页）----
    //
    // 为什么是设置页而不是侧栏按钮/浮层：这是一项**低频的批量维护**操作，
    // 不是会话内的日常动作。设置页（settings.section，kind=list，scope=root）
    // 是平台给「一个独立设置页面」的标准座位，与「插件」页并列；
    // 侧栏底部是「日常快捷动作」的位置，放管理入口语义不符。
    // ownerProps 只有 { close }，数据由本插件自己的宿主路由提供。
    function ArchiveManagerSection(props) {
      useCss();
      var t = props.t;
      // items = 扁平会话列表；workspaces = 宿主下发的工作区清单（含 sessionIds 归属）。
      var _items = React.useState(null), items = _items[0], setItems = _items[1];
      var _wss = React.useState([]), workspaces = _wss[0], setWorkspaces = _wss[1];
      var _sel = React.useState({}), sel = _sel[0], setSel = _sel[1];
      var _status = React.useState(null), status = _status[0], setStatus = _status[1]; // { kind:'info'|'err', text }
      var _busy = React.useState(false), busy = _busy[0], setBusy = _busy[1];
      var _confirming = React.useState(false), confirming = _confirming[0], setConfirming = _confirming[1];
      // 幽灵记账：工作区里记着、磁盘上已无的会话（历史手工删除的遗留）。
      var _ghosts = React.useState(null), ghosts = _ghosts[0], setGhosts = _ghosts[1];
      // 未记账会话（归位）预览：磁盘上有、但不在任何工作区记账里的会话。
      // 它们没有归属，平台侧栏只能显示成「未分组」。
      // 两个状态分开存的原因：repair 是**独立于 /list 的第二条路由**，它可能单独失败
      // （宿主版本旧、路由缺失…）。若把清单和错误合成一个状态，一旦 repair 失败
      // 就把整个面板打成错误态，用户连归档列表都用不了 —— 故 repair 的失败只落在
      // repairError 上，绝不影响上面 load() 的结果。
      var _repair = React.useState(null), repair = _repair[0], setRepair = _repair[1];
      var _repairErr = React.useState(''), repairError = _repairErr[0], setRepairError = _repairErr[1];
      var _repairing = React.useState(false), repairing = _repairing[0], setRepairing = _repairing[1];
      var _repairMsg = React.useState(null), repairMsg = _repairMsg[0], setRepairMsg = _repairMsg[1]; // { kind:'info'|'err', text }
      // 被误记账的子智能体：「本不该占用工作区归属槽位」的脏数据。
      // 同样是独立路由，失败只落在 subagentError，不连坐归档列表。
      var _subs = React.useState(null), subs = _subs[0], setSubs = _subs[1];
      var _subsErr = React.useState(''), subagentError = _subsErr[0], setSubagentError = _subsErr[1];
      var _detaching = React.useState(false), detaching = _detaching[0], setDetaching = _detaching[1];
      // 磁盘遗留空会话（建了没用过）。这是唯一会**真删文件**的维护项，
      // 因此需要单独确认态，不与其它「只改记账」的操作共用 confirming。
      var _empties = React.useState(null), empties = _empties[0], setEmpties = _empties[1];
      var _emptiesErr = React.useState(''), emptiesError = _emptiesErr[0], setEmptiesError = _emptiesErr[1];
      var _emptiesBusy = React.useState(false), emptiesBusy = _emptiesBusy[0], setEmptiesBusy = _emptiesBusy[1];
      var _emptiesConfirm = React.useState(false), emptiesConfirm = _emptiesConfirm[0], setEmptiesConfirm = _emptiesConfirm[1];
      // 是否已请求过「空会话」扫描（null=未扫；[]=扫过但无结果）。全库扫描成本高，
      // 故不在挂载时自动跑，用户点「开始扫描」后才置 true。
      var _emptiesScanned = React.useState(false), emptiesScanned = _emptiesScanned[0], setEmptiesScanned = _emptiesScanned[1];
      // 删除已执行、但当时驱逐失败的会话（磁盘已无、内存态仍在）。
      // 它们**不是**归档会话 —— 单列出来，绝不允许混进归档列表
      // （混进去会让用户点删除后那一行原地不动，观感就是「删了又回来」）。
      // 正常删除会在宿主侧当场驱逐成功，根本不进这里；这里是罕见兜底，可「重试驱逐」。
      var _pendingRestart = React.useState([]), pendingRestart = _pendingRestart[0], setPendingRestart = _pendingRestart[1];

      /**
       * 拉归位预览（只读）。任何异常都咽进 repairError，不抛给调用方。
       * @returns 待归位条目数组（失败时为空数组）
       */
      function previewRepair() {
        return apiRepair(true).then(function (out) {
          var list = (out && out.items) || [];
          setRepair(list);
          setRepairError('');
          return list;
        }).catch(function (e) {
          // 这条路由可能不存在（旧宿主）：如实记录，但不打扰用户主动操作。
          setRepair([]);
          setRepairError(String((e && e.message) || e));
          return [];
        });
      }

      /**
       * 拉子智能体污染预览（只读）。异常咽进 subagentError，不抛给调用方。
       * @returns { total, groups }（失败时 total=0, groups=[]）
       */
      function previewSubagents() {
        return apiDetachSubagents(true).then(function (out) {
          var res = { total: (out && out.total) || 0, groups: (out && out.groups) || [] };
          setSubs(res);
          setSubagentError('');
          return res;
        }).catch(function (e) {
          setSubs({ total: 0, groups: [] });
          setSubagentError(String((e && e.message) || e));
          return { total: 0, groups: [] };
        });
      }

      /**
       * 拉空会话预览（只读）。异常咽进 emptiesError，不连坐面板其余部分。
       *
       * ⚠️ 这是**全库扫描**（宿主需遍历每个会话日志判断「有没有对话」，本机实测
       *    ~70 MB / 数万帧），因此只由用户显式触发（「开始扫描」按钮），
       *    不在面板挂载时自动跑 —— 否则每次打开设置页都要白等。
       */
      function previewEmpties() {
        setEmptiesScanned(true);
        return apiEmptySessions(true).then(function (out) {
          var list = ((out && out.sessions) || []).filter(function (s) { return !!s; });
          setEmpties(list);
          setEmptiesError('');
          return list;
        }).catch(function (e) {
          setEmpties([]);
          setEmptiesError(String((e && e.message) || e));
          return [];
        });
      }

      /**
       * 只刷新「待驱逐」清单，不碰面板其余状态。
       *
       * 为什么需要单独一个：删除完成后若不刷新它，那条提示要等用户手动点「刷新」
       * 或重开面板才出现 —— 用户刚删完看到的仍是"什么也没发生"，正是本轮要消除的观感。
       * 不能直接调 load()：load() 开头会 setStatus(null)，把刚写好的删除结果提示清掉。
       */
      function refreshPendingRestart() {
        return apiList().then(function (out) {
          setPendingRestart(((out && out.pendingRestart) || []).filter(function (x) { return !!x; }));
        }).catch(function () { /* 失败就保持原样，不打扰用户 */ });
      }

      /**
       * 重拉面板数据。
       *
       * ⚠️ 默认会 `setStatus(null)`（清掉上一次的提示）。React 18 自动批处理下，
       * 若调用方先写成功文案、再在同一同步块里调 `load()`，那条文案会被这里的
       * `setStatus(null)` **覆盖掉**（同一 state 只保留最后一次写入）→ 用户看不到结果。
       * 需要保留提示的调用方必须传 `{ keepStatus: true }`，或改用 refreshPendingRestart()。
       */
      function load(opts) {
        const keepStatus = !!(opts && opts.keepStatus);
        setItems(null); setSel({}); if (!keepStatus) setStatus(null); setConfirming(false); setGhosts(null); setPendingRestart([]);
        apiList().then(function (out) {
          setItems(out.sessions || []);
          setWorkspaces(out.workspaces || []);
          setGhosts(out.ghosts || []);
          setPendingRestart(((out && out.pendingRestart) || []).filter(function (x) { return !!x; }));
          // 宿主拿不到数据时如实告知，而不是静默显示成「没有数据」——
          // 之前正是静默吞异常让「工作区为空 → 全部未分组」极难定位。
          var errs = [];
          if (out.metaError) errs.push(t('err.meta', { msg: out.metaError }));
          if (out.workspaceError) errs.push(t('err.workspaces', { msg: out.workspaceError }));
          if (errs.length > 0) setStatus({ kind: 'err', text: t('err.partial', { msg: errs.join('; ') }) });
        }).catch(function (e) {
          setItems([]); setWorkspaces([]); setGhosts(null);
          setStatus({ kind: 'err', text: t('err.listLoad', { msg: String((e && e.message) || e) }) });
        });
      }
      // 打开设置页即拉取（依赖为空 → 只在挂载时跑一次）。
      React.useEffect(load, []);
      // 挂载时并行预览「待归位会话」：与 load() 的 /list 互不等待、互不影响
      // （失败只体现在 repairError 上，面板其余部分照常可用）。
      React.useEffect(function () { previewRepair(); }, []);
      // 同理并行预览「被误记账的子智能体」（独立路由，失败不连坐）。
      React.useEffect(function () { previewSubagents(); }, []);
      // ⚠️ 「磁盘遗留空会话」**故意不在这里自动预览**：它要遍历全部会话日志才能
      //    判断「有没有对话」，是全库扫描（本机实测 ~70 MB、数万帧）。面板一打开
      //    就跑它会明显拖慢首屏，且宿主的解压会占用 CPU。改为用户点「开始扫描」后
      //    才执行（见下方渲染分支的按钮）。

      // 待归位条目（字段做容错：契约由宿主侧实现，缺字段、甚至数组里混入 null 时
      // 都不能让整个设置页崩掉 —— 归位是「锦上添花」的修复功能，绝不能连坐）。
      var repairItems = ((repair && repair.length) ? repair : []).filter(function (it) { return !!it; });
      // 只统计真正会被归位的：action 为 skip 的项（cwd 已消失、无法解析）执行后也不会变，
      // 若一起计数，用户会看到「点了按钮却少归位几个」而不知道为什么。
      var repairable = repairItems.filter(function (it) { return it.action !== 'skip'; });
      var repairCreates = repairable.filter(function (it) { return it.action === 'create-workspace'; }).length;
      // 目标工作区概要：按标题去重后取前几个。
      var repairTargets = [];
      for (var ri = 0; ri < repairable.length; ri++) {
        var rTitle = repairable[ri].targetTitle || repairable[ri].resolvedCwd || repairable[ri].cwd || '';
        if (rTitle && repairTargets.indexOf(rTitle) === -1) repairTargets.push(rTitle);
      }
      var repairTargetText = repairTargets.slice(0, 3).join(', ') + (repairTargets.length > 3 ? ' ' + t('page.targetsEtc') : '');

      var selectedIds = Object.keys(sel).filter(function (k) { return sel[k]; });
      var allSelected = !!items && items.length > 0 && selectedIds.length === items.length;
      // 磁盘上已无对应目录的归档条目（孤儿）：删除时只清理归档记录。
      var orphans = items ? items.filter(function (s) { return s.orphan; }).length : 0;

      // ---- 按工作区分组 ----
      // 归属以宿主下发的 workspace.sessionIds 为准（权威记账；归档不改变记账）。
      // 不在任何工作区记账里的 → 「未分组」（典型是工作区已被删除的遗留归档）。
      // 组内保持宿主给的顺序（创建时间新→旧），组按「最新会话时间」排序。
      var groups = React.useMemo(function () {
        if (!items) return null;
        var byWs = {};
        for (var i = 0; i < workspaces.length; i++) byWs[workspaces[i].workspaceId] = { ws: workspaces[i], list: [] };
        var ungrouped = [];
        for (var j = 0; j < items.length; j++) {
          var s = items[j];
          var bucket = s.workspaceId != null ? byWs[s.workspaceId] : undefined;
          if (bucket) bucket.list.push(s); else ungrouped.push(s);
        }
        var out = [];
        for (var k = 0; k < workspaces.length; k++) {
          var g = byWs[workspaces[k].workspaceId];
          if (g && g.list.length > 0) out.push({ id: g.ws.workspaceId, title: g.ws.title || g.ws.path, path: g.ws.path, list: g.list });
        }
        // 未分组始终排在最后。
        if (ungrouped.length > 0) out.push({ id: '__ungrouped__', title: t('page.ungrouped'), path: '', list: ungrouped });
        return out;
      }, [items, workspaces, t]);

      function toggleAll() {
        if (!items) return;
        if (allSelected) { setSel({}); return; }
        var next = {};
        items.forEach(function (s) { next[s.sessionId] = true; });
        setSel(next);
      }
      function toggleOne(id) {
        setSel(function (prev) {
          var next = Object.assign({}, prev);
          next[id] = !prev[id];
          return next;
        });
      }
      // 组级全选/取消：组内全选时点击 → 清空该组；否则 → 全选该组。
      function toggleGroup(list) {
        var allOn = list.every(function (s) { return sel[s.sessionId]; });
        setSel(function (prev) {
          var next = Object.assign({}, prev);
          for (var i = 0; i < list.length; i++) next[list[i].sessionId] = !allOn;
          return next;
        });
      }

      async function doBatchDelete() {
        setBusy(true); setStatus(null);
        try {
          var out = await apiDelete(selectedIds);
          var okIds = new Set();
          var failures = [];
          var warned = 0;
          var liveCount = 0;
          var subCount = 0;
          (out.results || []).forEach(function (r) {
            if (r.ok) {
              okIds.add(r.sessionId);
              if (r.warnings && r.warnings.length) warned++;
              // 原本是 live（在浏览器里打开过）的会话：宿主内存仍持有它，
              // 平台下次列会话会把它并回列表（刷新即可看到），如实统计。
              if (r.wasLive) liveCount++;
              // 连带删掉的子智能体会话数（它们本就不显示为列表行，但占磁盘）。
              if (r.subagents) subCount += r.subagents;
            } else failures.push(codeText(t, r.error));
          });
          setItems(function (prev) { return (prev || []).filter(function (s) { return !okIds.has(s.sessionId); }); });
          setSel({}); setConfirming(false);
          var freed = out.deletedBytes ? formatBytes(out.deletedBytes) : '';
          // 孤儿记录没有磁盘内容可删，单独说明，免得用户以为「删了但没释放空间」。
          var cleaned = out.cleaned || 0;
          var parts = [t('res.deleted', { n: okIds.size })];
          if (freed) parts.push(t('res.released', { size: freed }));
          // 子智能体会话一并删除（平台的删除是会话级的、不会级联；子智能体又从不
          // 作为列表行显示，用户没有别的入口清理它们）。
          if (subCount > 0) parts.push(t('res.subagents', { n: subCount }));
          if (cleaned > 0) parts.push(t('res.cleanedOnly', { n: cleaned }));
          // 关于 live 会话的如实告知。
          // 平台会把「本进程内存中仍存活的会话」并入列表（sessionQuery.listSessions
          // 用 ctx.sessions.list() 覆盖合并），所以只删磁盘文件、不驱逐内存态，
          // 刷新页面它仍会被列出来。宿主侧现在会**先驱逐内存态**
          // （evictLiveSession → session/disposed），正常情况当场就干净了。
          // 若某次驱逐失败，该条目会进 pendingRestart，可用面板的「重试驱逐」清掉。
          if (liveCount > 0) parts.push(t('res.evicted', { n: liveCount }));
          if (warned > 0) parts.push(t('res.warned', { n: warned }));
          setStatus(failures.length === 0
            // live 不再是「错误」：宿主的驱逐已保证它不会污染侧栏。
            // 用 info 呈现（此前用 err 红字，会让用户以为删失败了）。
            ? { kind: 'info', text: parts.join(' · ') }
            : { kind: 'err', text: t('res.partialFail', { ok: okIds.size, fail: failures.length, reason: failures[0] }) });
          // 有 live 会话被删时，同步刷新「待驱逐」清单，让那条如实的状态提示
          // 当场出现（而不是等用户手动刷新，误以为删了没反应）。
          if (liveCount > 0) refreshPendingRestart();
        } catch (e) {
          setStatus({ kind: 'err', text: t('err.batchDelete', { msg: String(e && e.message || e) }) });
        } finally {
          setBusy(false);
        }
      }

      async function doBatchUnarchive() {
        setBusy(true); setStatus(null);
        var done = 0, failed = 0;
        for (var i = 0; i < selectedIds.length; i++) {
          try {
            // 平台官方 Remote：workspaces.unarchiveSession（与「取消归档」菜单同一通路）。
            await window.__dsh_archive_manager_unarchive(selectedIds[i]);
            done++;
          } catch { failed++; }
        }
        setItems(function (prev) { return (prev || []).filter(function (s) { return selectedIds.indexOf(s.sessionId) === -1; }); });
        setSel({});
        setStatus(failed === 0
          ? { kind: 'info', text: t('res.unarchived', { n: done }) }
          : { kind: 'err', text: t('res.unarchivePartial', { ok: done, fail: failed }) });
        setBusy(false);
      }

      async function doCleanupGhosts() {
        setBusy(true); setStatus(null);
        try {
          var out = await apiCleanupGhosts();
          setStatus({ kind: 'info', text: t('res.cleaned', { n: out.removed || 0 }) });
          // 重新拉取，让界面与平台状态一致。
          // ⚠️ 必须 keepStatus：否则上面的成功文案会被 load() 开头的 setStatus(null) 清掉。
          load({ keepStatus: true });
        } catch (e) {
          setStatus({ kind: 'err', text: t('err.cleanup', { msg: String((e && e.message) || e) }) });
        } finally {
          setBusy(false);
        }
      }

      /**
       * 对「已删除但当时驱逐失败」的条目重试驱逐。
       * 宿主侧只做驱逐与记账清理（磁盘记录早已删除），成功则该条目从本清单消失。
       */
      async function doEvictPending() {
        if (!pendingRestart || pendingRestart.length === 0) return;
        setBusy(true); setStatus(null);
        try {
          var ids = pendingRestart.map(function (x) { return x.sessionId; });
          var out = await apiEvict(ids);
          var evicted = (out && out.evicted) || 0;
          var fails = ((out && out.results) || []).filter(function (r) { return r && r.ok === false; });
          setStatus(fails.length === 0
            ? { kind: 'info', text: evicted > 0 ? t('res.evictedOne', { n: evicted }) : t('res.evictedNone') }
            : { kind: 'err', text: t('res.evictPartial', { n: evicted, fail: fails.length, reason: codeText(t, fails[0].error) }) });
          // 刷新清单（成功的条目会从 pendingRestart 里消失）。
          refreshPendingRestart();
        } catch (e) {
          setStatus({ kind: 'err', text: t('err.evict', { msg: String((e && e.message) || e) }) });
        } finally {
          setBusy(false);
        }
      }

      /**
       * 执行「摘除误记账的子智能体」。只改记账归属，**不删任何磁盘文件**
       * （子智能体的会话文件本就该留在磁盘上，只是不该占用用户工作区的归属槽位）。
       */
      async function doDetachSubagents() {
        setDetaching(true); setStatus(null);
        try {
          var out = await apiDetachSubagents(false);
          var removed = (out && out.detached) || 0;
          // 有失败项时如实并列，不谎报全成功。
          var fails = ((out && out.results) || []).filter(function (r) { return r && r.ok === false; });
          setStatus(fails.length === 0
            ? { kind: 'info', text: t('res.detached', { n: removed }) }
            : { kind: 'err', text: t('res.detachPartial', { n: removed, fail: fails.length, reason: codeText(t, fails[0].error) }) });
          // 记账变了 → 重拉面板与预览。⚠️ keepStatus：保住上面的结果文案。
          load({ keepStatus: true });
          previewSubagents();
        } catch (e) {
          setStatus({ kind: 'err', text: t('err.detach', { msg: String((e && e.message) || e) }) });
        } finally {
          setDetaching(false);
        }
      }

      /**
       * 删除磁盘遗留空会话。**这是真删磁盘目录**（不可恢复），
       * 所以走两步确认（emptiesConfirm），且宿主会二次校验「确实没有 user/message」——
       * 有内容的会话一律拒删，前端传来的 id 不被信任。
       */
      async function doDeleteEmpties() {
        setEmptiesBusy(true); setStatus(null);
        try {
          var out = await apiEmptySessions(false);
          var deleted = (out && out.deleted) || 0;
          var freed = (out && out.freedBytes) ? formatBytes(out.freedBytes) : '';
          var fails = ((out && out.results) || []).filter(function (r) { return r && r.ok === false; });
          var parts = [t('res.empties', { n: deleted })];
          if (freed) parts.push(t('res.released', { size: freed }));
          if (fails.length > 0) parts.push(t('res.emptiesSkipped', { n: fails.length, reason: codeText(t, fails[0].error) }));
          setStatus({ kind: fails.length === 0 ? 'info' : 'err', text: parts.join(' · ') });
          setEmptiesConfirm(false);
          // ⚠️ keepStatus：保住上面的删除结果文案（同 doCleanupGhosts 的理由）。
          load({ keepStatus: true }); previewEmpties();
        } catch (e) {
          setStatus({ kind: 'err', text: t('err.empties', { msg: String((e && e.message) || e) }) });
        } finally {
          setEmptiesBusy(false);
        }
      }

      /**
       * 执行归位。与「清理幽灵记账」的关键区别：这一步**只写记账、不删任何文件**
       * （宿主侧靠 attachSession 把会话挂到 cwd 对应的工作区上）。
       */
      async function doRepair() {
        setRepairing(true); setRepairMsg(null);
        try {
          var out = await apiRepair(false);
          var results = (out && out.results) || [];
          var okCount = 0;
          var errors = [];
          for (var i = 0; i < results.length; i++) {
            var r = results[i] || {};
            if (r.ok) okCount++; else if (r.error) errors.push(codeText(t, r.error));
          }
          var created = (out && out.createdWorkspaces) || 0;
          // attached 是宿主侧「真正挂上的数量」，比 results 更权威；缺字段时退回 okCount。
          var attached = out && out.attached !== undefined && out.attached !== null ? out.attached : okCount;
          if (errors.length > 0) {
            // 如实汇报：部分成功要同时给出成功数、失败数与第一条原因。
            setRepairMsg({ kind: 'err', text: t('res.repaired', { n: okCount, fail: errors.length, reason: errors[0] }) });
          } else {
            var parts = [t('res.repairedAll', { n: attached })];
            if (created > 0) parts.push(t('res.newWorkspaces', { n: created }));
            setRepairMsg({ kind: 'info', text: parts.join(' · ') });
          }
          // 刷新面板状态：/list 里的未分组分组会随之变化，
          // 同时重新预览（正常情况下列表清空，提示条自动消失）。
          load();
          previewRepair();
        } catch (e) {
          setRepairMsg({ kind: 'err', text: t('err.repair', { msg: String((e && e.message) || e) }) });
        } finally {
          setRepairing(false);
        }
      }


      // 只有**正在执行任务**（running）的会话禁止勾选：宿主会拒绝（session-running）。
      // 注意区分 live 与 running：被打开过的会话会常驻为 live agent 但通常处于
      // idle（没在跑任务），那种情况是可以安全删除的（实测反馈：live 一概拒绝
      // 会让「我明明没在用它却删不掉」）。
      function sessionRow(s) {
        return h('label', {
          key: s.sessionId,
          className: 'asm-item' + (s.running ? ' asm-item-disabled' : ''),
          title: s.running ? t('err.sessionRunning') : '',
        },
          h('input', {
            type: 'checkbox',
            checked: !!sel[s.sessionId],
            disabled: !!s.running,
            onChange: function () { toggleOne(s.sessionId); },
          }),
          h('span', { className: 'asm-item-main' },
            h('span', { className: 'asm-item-title' }, s.title || t('page.untitled')),
            h('span', { className: 'asm-item-meta' },
              formatTime(s.createdAt, t('time.locale'))
              // 磁盘已删的条目（非 live）说清真实状态，避免用户看到「0 B」的普通行
              // 以为"删了又回来了"（实测踩到）。
              // 注意：磁盘已删 **且 live** 的条目已不在本列表里 —— 宿主把它们归到
              // pendingRestart 单列（那条路径才是删除后的正常终态）。
              + (s.orphan ? t('page.orphan') : ''))),
          h('span', { className: 'asm-item-bytes' }, s.orphan ? '—' : formatBytes(s.sizeBytes)));
      }

      var body;
      if (items === null) {
        body = h('div', { className: 'asm-empty' }, t('page.loading'));
      } else if (items.length === 0) {
        body = h('div', { className: 'asm-empty' }, t('page.empty'));
      } else {
        body = h('div', { className: 'asm-list' },
          (groups || []).map(function (g) {
            var groupBytes = g.list.reduce(function (a, s) { return a + (s.sizeBytes || 0); }, 0);
            var groupSel = g.list.filter(function (s) { return sel[s.sessionId]; }).length;
            return h('div', { key: g.id, className: 'asm-group' },
              h('div', { className: 'asm-group-head' },
                h('label', { className: 'asm-group-title-wrap' },
                  h('input', {
                    type: 'checkbox',
                    // 组全选：非全选状态按下即全选该组（不处理半选的三态）。
                    checked: groupSel === g.list.length,
                    onChange: function () { toggleGroup(g.list); },
                  }),
                  h('span', { className: 'asm-group-title' }, g.title || t('workspace.defaultName')),
                  h('span', { className: 'asm-group-count' }, groupSel + '/' + g.list.length)),
                h('span', { className: 'asm-group-path' }, g.path || ''),
                h('span', { className: 'asm-item-bytes' }, formatBytes(groupBytes))),
              g.list.map(sessionRow));
          }));
      }

      // 设置页正文：不用浮层外壳，直接铺在设置面板里。
      return h('div', { className: 'asm-section' },
        h('p', { className: 'asm-desc' }, t('page.desc')),
        // 幽灵记账提示：磁盘已无、但工作区仍记着的会话，会以空会话形式出现在
        // 侧栏列表里且无法点开，用户无法自行清除 —— 因此在这里提供一键清理。
        (ghosts && ghosts.length > 0)
          ? h('div', { className: 'asm-notice' },
              h('span', null, t('notice.ghosts', { n: ghosts.reduce(function (a, g) { return a + g.sessionIds.length; }, 0) })),
              h('button', { type: 'button', className: 'asm-btn', onClick: doCleanupGhosts, disabled: busy },
                busy ? t('notice.cleaning') : t('notice.cleanup')))
          : null,
        // 归位提示：磁盘上有、但不在任何工作区记账里的会话 —— 平台侧栏只能把它们
        // 显示在「未分组」里，用户无法自行归位。这一块只新增面板内容，绝不改动
        // 归档列表本身的渲染（列表在 /list 里可能并不包含这些会话）。
        repairable.length > 0
          ? h('div', { className: 'asm-notice' },
              h('span', { className: 'asm-notice-main' },
                t('notice.repair', { n: repairable.length })
                + (repairCreates > 0 ? ' ' + t('notice.repairNewWs', { n: repairCreates }) : '')
                + (repairTargetText ? ' → ' + repairTargetText : ''),
                h('span', { className: 'asm-notice-detail' }, t('notice.repairHint'))),
              h('span', { className: 'asm-notice-actions' },
                h('button', { type: 'button', className: 'asm-btn', onClick: previewRepair, disabled: repairing }, t('notice.previewAgain')),
                h('button', { type: 'button', className: 'asm-btn asm-btn-primary', onClick: doRepair, disabled: repairing },
                  repairing ? t('notice.repairing') : t('notice.repairBtn'))))
          : null,
        // 删除已执行、但当时驱逐失败的条目（罕见兜底）。
        // ⚠️ 这一条必须与「归档会话列表」严格分开：若把它当普通归档会话列在上面，
        //    用户点「删除」→ 那一行原地不动 → 观感就是「删了又回来」（实测）。
        //    宿主侧会尝试驱逐内存态（evictLiveSession）；驱逐成功的条目根本不会
        //    出现在这里。剩下的说明平台当时拒绝驱逐，给出「重试」入口。
        (pendingRestart && pendingRestart.length > 0)
          ? h('div', { className: 'asm-notice' },
              h('span', { className: 'asm-notice-main' },
                t('notice.evict', { n: pendingRestart.length }),
                h('span', { className: 'asm-notice-detail' }, t('notice.evictHint'))),
              h('span', { className: 'asm-notice-actions' },
                h('button', { type: 'button', className: 'asm-btn', disabled: busy,
                  onClick: doEvictPending }, busy ? t('notice.evicting') : t('notice.evictBtn'))))
          : null,
        // 磁盘遗留空会话：建了却从未用过（无任何 user/message）。
        // ⚠️ 这是唯一会**真正删除磁盘文件**的维护项 —— 语气必须与上面几个
        //    「只改记账」的提示区分开，并走两步确认。
        // ⚠️ 也是唯一**需要全库扫描**的项（要读每个会话日志才知道有没有对话），
        //    因此不自动预览：未扫描时只给一个「开始扫描」按钮。
        !emptiesScanned
          ? h('div', { className: 'asm-notice asm-notice-optional' },
              h('span', { className: 'asm-notice-main' },
                t('notice.emptiesTitle'),
                h('span', { className: 'asm-notice-detail' }, t('notice.emptiesHint'))),
              h('span', { className: 'asm-notice-actions' },
                h('button', { type: 'button', className: 'asm-btn', disabled: emptiesBusy,
                  onClick: function () { setEmptiesBusy(true); previewEmpties().finally(function () { setEmptiesBusy(false); }); } },
                  emptiesBusy ? t('notice.emptiesScanning') : t('notice.emptiesScan'))))
          : null,
        (emptiesScanned && empties && empties.length > 0)
          ? h('div', { className: 'asm-notice' },
              h('span', { className: 'asm-notice-main' },
                t('notice.emptiesFound', { n: empties.length, size: formatBytes(empties.reduce(function (a, s) { return a + (s.sizeBytes || 0); }, 0)) }),
                h('span', { className: 'asm-notice-detail' },
                  emptiesConfirm ? t('notice.emptiesConfirm') : t('notice.emptiesWarn'))),
              h('span', { className: 'asm-notice-actions' },
                emptiesConfirm
                  ? h(React.Fragment, null,
                      h('button', { type: 'button', className: 'asm-btn', disabled: emptiesBusy,
                        onClick: function () { setEmptiesConfirm(false); } }, t('notice.back')),
                      h('button', { type: 'button', className: 'asm-btn asm-btn-danger', disabled: emptiesBusy,
                        onClick: doDeleteEmpties }, emptiesBusy ? t('notice.emptiesDeleting') : t('notice.emptiesDeleteConfirm')))
                  : h('button', { type: 'button', className: 'asm-btn',
                      disabled: emptiesBusy, onClick: function () { setEmptiesConfirm(true); } }, t('notice.emptiesDelete'))))
          : null,
        (emptiesScanned && empties && empties.length === 0 && !emptiesError)
          ? h('p', { className: 'asm-status' }, t('notice.emptiesNone'))
          : null,
        emptiesError
          ? h('p', { className: 'asm-status asm-status-err' },
              t('err.routeDown', { what: t('what.empties'), route: 'empty-sessions', msg: emptiesError }))
          : null,
        // 子智能体污染提示：子智能体不该占用用户工作区的归属记账槽位
        // （侧栏也不把它们显示为列表行，只在父会话上以计数徽标出现）。
        // 本插件的 /repair 早期版本曾误把它们挂入，这里提供清理入口。
        // 采用与「归位」相同的「无害修复」语气：只改记账，绝不删文件。
        (subs && subs.total > 0)
          ? h('div', { className: 'asm-notice' },
              h('span', { className: 'asm-notice-main' },
                t('notice.subs', { n: subs.total }),
                h('span', { className: 'asm-notice-detail' }, t('notice.subsHint'))),
              h('span', { className: 'asm-notice-actions' },
                h('button', { type: 'button', className: 'asm-btn', onClick: previewSubagents, disabled: detaching }, t('notice.previewAgain')),
                h('button', { type: 'button', className: 'asm-btn asm-btn-primary', onClick: doDetachSubagents, disabled: detaching },
                  detaching ? t('notice.detaching') : t('notice.detachBtn'))))
          : null,
        subagentError
          ? h('p', { className: 'asm-status asm-status-err' },
              t('err.routeDown', { what: t('what.subagents'), route: 'detach-subagents', msg: subagentError }))
          : null,
        // repair 路由不可用（旧宿主/路由未注册）时如实说明，不假装「没有待归位项」。
        // 用 asm-status 而非 asm-notice：它不是可操作的提示，只是信息缺失的告知。
        repairError
          ? h('p', { className: 'asm-status asm-status-err' },
              t('err.routeDown', { what: t('what.repair'), route: 'repair', msg: repairError }))
          : null,
        repairMsg
          ? h('p', { className: 'asm-status' + (repairMsg.kind === 'err' ? ' asm-status-err' : '') }, repairMsg.text)
          : null,
        h('div', { className: 'asm-toolbar' },
          h('label', { className: 'asm-item', style: { padding: '4px 0' } },
            h('input', { type: 'checkbox', checked: !!allSelected, onChange: toggleAll, disabled: !items || items.length === 0 }),
            h('span', { className: 'asm-toolbar-label' }, t('page.selectAll', { n: selectedIds.length, total: items ? items.length : 0 }))),
          h('button', { type: 'button', className: 'asm-btn', onClick: function () { load(); }, disabled: busy }, t('page.refresh'))),
        body,
        status ? h('p', { className: 'asm-status' + (status.kind === 'err' ? ' asm-status-err' : '') }, status.text) : null,
        confirming
          ? h('p', { className: 'asm-desc asm-warn' },
              t('page.batchConfirm', { n: selectedIds.length }))
          : null,
        h('div', { className: 'asm-footer' },
          h('span', { className: 'asm-status' },
            items && items.length > 0
              ? (t('page.summary', { n: items.length }) + ' · ' + formatBytes(items.reduce(function (a, s) { return a + (s.sizeBytes || 0); }, 0))
                 + (orphans > 0 ? ' · ' + t('page.orphans', { n: orphans }) : ''))
              : ''),
          h('div', { className: 'asm-row-actions' },
            h('button', {
              type: 'button', className: 'asm-btn',
              disabled: busy || selectedIds.length === 0,
              onClick: doBatchUnarchive,
            }, t('page.unarchive')),
            confirming
              ? h(React.Fragment, null,
                  h('button', { type: 'button', className: 'asm-btn', disabled: busy, onClick: function () { setConfirming(false); } }, t('notice.back')),
                  h('button', { type: 'button', className: 'asm-btn asm-btn-danger', disabled: busy, onClick: doBatchDelete },
                    busy ? t('dlg.deleting') : t('page.confirmDelete')))
              : h('button', {
                  type: 'button', className: 'asm-btn asm-btn-danger',
                  disabled: busy || selectedIds.length === 0,
                  onClick: function () { setConfirming(true); },
                }, t('page.batchDelete')))));
    }

    // 批量「取消归档」的通路：官方客户端服务 workspaces.unarchiveSession 是
    // ctx 注入的 Remote 调用，面板组件拿不到该 ctx（槽位渲染只给 ownerProps），
    // 所以 apply 里把它挂到 window 桥接给面板用。
    return {
      inject: ['slots', 'workspaces', 'locale'],
      apply(ctx) {
        // 注册中英字典（官方 locale 服务）。
        //
        // ⚠️ 运行时的 register **不检查**「两种语言是否都给全」——那只是 TS 侧对
        //    LocaleNamespaceMap 声明命名空间的**编译期**约束，纯 JS bundle 拿不到。
        //    漏一种语言不会报错，只会在该语言下回落到 `common` 或直接显示 key。
        //    所以两份字典的键必须由我们自己保证一致（见文件末尾的键一致性检查）。
        //
        // 用 ctx.effect 包住：卸载时自动撤销该命名空间，HMR 重载不会撞
        // 「namespace 已有该 locale」的重复注册错误。
        // 键一致性自查：漏键不会抛错、只会在该语言下显示 key 名（很难被发现），
        // 因此在这里主动比一次并告警。只在开发/出错时可见，不影响功能。
        try {
          var zhKeys = Object.keys(zh), enKeys = Object.keys(en);
          var missingEn = zhKeys.filter(function (k) { return !(k in en); });
          var missingZh = enKeys.filter(function (k) { return !(k in zh); });
          if (missingEn.length || missingZh.length) {
            console.warn('[dsh-archive-session-manager] dictionary keys mismatch',
              { missingEn: missingEn, missingZh: missingZh });
          }
        } catch (e) { /* 自查本身绝不能影响注册 */ }

        ctx.effect(function () {
          return ctx.locale.register(NS, { zh: zh, en: en });
        }, 'dsh-archive-session-manager: dictionaries');
        // 绑定本命名空间的翻译函数。bind 返回的引用按命名空间稳定，
        // 可以安全地经 inject 座位传进组件（不会破坏 memoization）。
        var t = ctx.locale.bind(NS);

        // 桥接官方 unarchive Remote（走平台同一通路，含 registry 写入与列表刷新）。
        window.__dsh_archive_manager_unarchive = function (id) {
          return ctx.workspaces.unarchiveSession(id);
        };
        ctx.effect(function () {
          return function () { delete window.__dsh_archive_manager_unarchive; };
        }, 'dsh-archive-session-manager: unarchive bridge');

        // 1) 会话「···」菜单：删除会话（order 500，排在官方 archive(400) 之后）。
        try {
          ctx.slots.inject('sidebar.workspaces.session.menu.item', function () {
            return ctx.slots.register({
              name: 'sidebar.workspaces.session.menu.item',
              id: 'dsh-archive-session-manager/delete',
              order: 500,
              locale: NS,
            }, DeleteSessionMenuItem);
          });
        } catch (e) { console.warn('[dsh-archive-session-manager] menu item register failed:', e); }

        // 2) 设置页：归档会话管理（独立一页，与「插件」等页并列）。
        //    放在设置里而不是侧栏：这是低频批量维护，不是会话内日常动作。
        //
        //    ⚠️ id 为什么是 'archived-sessions' 而不是包名（实证，勿"顺手改回来"）：
        //    settings.section 的注册选项只有 id/order/label，**没有 icon 字段**
        //    （契约见 cordis_inspect_query client/Slots root=settings.section；
        //     实现见 dsh-client-ui-settings-general 的 navIcon(id) —— 它按 id
        //     硬编码 account/models/agent-presets/plugins/archived-sessions 五个图标，
        //     其余 id 一律兜底齿轮）。所以想拿到档案盒图标而不是齿轮，只能借用这个
        //     官方预留的 id。全安装树扫描：该字符串仅出现在 navIcon 那一处，**无人注册**
        //     （官方没有归档设置页），故此 id 当前空缺，语义又与「归档会话」恰好吻合。
        //    代价：list 槽同 id 是**替换而非并列**，若官方将来真出了归档页会互相顶掉，
        //     届时改回包名即可（纯登记信息，不影响菜单/路由/批量删除等任何功能）。
        try {
          ctx.slots.inject('settings.section', function () {
            return ctx.slots.register({
              name: 'settings.section',
              id: 'archived-sessions',
              order: 65,
              // ⚠️ label 用**函数**而非字符串：SlotLabel 允许 string | (() => string)，
              //    设置页导航行会在每次读取时求值，因此语言切换后这一格会跟着变，
              //    不需要重新注册。（写成固定字符串的话，切换语言后导航仍是旧语言。）
              label: function () { return t('menu.navLabel'); },
              locale: NS,
            }, ArchiveManagerSection);
          });
        } catch (e) { console.warn('[dsh-archive-session-manager] settings section register failed:', e); }

        // 3) 全屏浮层：只留「单个会话删除」的确认对话框。
        try {
          ctx.slots.inject('shell.overlay', function () {
            return ctx.slots.register({
              name: 'shell.overlay',
              id: 'dsh-archive-session-manager/confirm',
              locale: NS,
            }, ConfirmDeleteDialog);
          });
        } catch (e) { console.warn('[dsh-archive-session-manager] overlay register failed:', e); }
      },
    };
  },
});
