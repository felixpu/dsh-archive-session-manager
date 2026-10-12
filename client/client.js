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
// 2) 批量管理入口 = `sidebar.footer.action` 槽（侧栏底部，紧挨设置）。
//
// 3) 确认对话框 + 批量管理面板 = `shell.overlay` 槽（全屏浮层，click-through，
//    条目需自行 opt-in pointer events）。
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

    async function apiList() {
      var res = await fetch(API + '/list', { credentials: 'same-origin' });
      if (!res.ok) throw new Error('list http ' + res.status);
      return res.json();
    }
    /** 清理幽灵记账（不删磁盘内容——那些文件早已不存在）。 */
    async function apiCleanupGhosts() {
      var res = await fetch(API + '/cleanup-ghosts', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error('cleanup http ' + res.status);
      return res.json();
    }
    /**
     * 清理「被误记账的子智能体」：把子智能体从工作区归属记账里摘掉。
     * 子智能体不该占用用户工作区的归属槽位（侧栏也不把它们显示为列表行），
     * 本插件的 /repair 早期版本曾误挂入，这里提供清理入口。
     * 只改记账、不动磁盘文件；dryRun=true 为只读预览。
     */
    async function apiDetachSubagents(dryRun) {
      var res = await fetch(API + '/detach-subagents', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(dryRun ? { dryRun: true } : {}),
      });
      if (!res.ok) throw new Error('detach-subagents http ' + res.status);
      return res.json();
    }
    /**
     * 磁盘遗留空会话：建了却从未用过（无任何 user/message）的会话目录。
     * 与 /repair、/detach-subagents 不同，这个接口**真删磁盘目录**，
     * 因此只由用户显式点击触发，且宿主会二次校验（有内容的会话一律拒删）。
     */
    async function apiEmptySessions(dryRun, sessionIds) {
      var body = dryRun ? { dryRun: true } : (sessionIds ? { sessionIds: sessionIds } : {});
      var res = await fetch(API + '/empty-sessions', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error('empty-sessions http ' + res.status);
      return res.json();
    }
    async function apiDelete(sessionIds) {
      var res = await fetch(API + '/delete', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionIds: sessionIds }),
      });
      if (!res.ok) throw new Error('delete http ' + res.status);
      return res.json();
    }
    /**
     * 归位：把「磁盘上有、但不在任何工作区记账里」的会话挂回它 cwd 对应的工作区。
     * 这类会话没有归属，平台侧栏只能把它们统统塞进「未分组」。
     * dryRun=true 是**只读预览**，宿主不写任何状态（按钮上也要向用户说清这一点）。
     */
    async function apiRepair(dryRun) {
      var res = await fetch(API + '/repair', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(dryRun ? { dryRun: true } : {}),
      });
      if (!res.ok) throw new Error('repair http ' + res.status);
      return res.json();
    }

    function formatBytes(n) {
      if (n === null || n === undefined) return '';
      if (n < 1024) return n + ' B';
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
      return (n / 1024 / 1024).toFixed(1) + ' MB';
    }
    function formatTime(ms) {
      if (!ms) return '';
      try {
        return new Date(ms).toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      } catch { return ''; }
    }

    // ---- 1) 菜单行：删除会话（仅归档行可见）----
    // props：ownerProps { sessionId, displayTitle } + slotInject { useMenuOpenState }
    //        + standardProps { useWorkspaces }
    function DeleteSessionMenuItem(props) {
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
      }, '删除会话');
    }

    // ---- 2) 单个删除确认对话框 ----
    function ConfirmDeleteDialog() {
      useCss();
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
            setErr('删除失败：' + ((r && r.error) || '未知错误'));
          }
        } catch (e) {
          setErr('删除失败：' + String(e && e.message || e));
        } finally {
          setBusy(false);
        }
      }

      return h('div', { className: 'asm-veil', onClick: close },
        h('div', { className: 'asm-card asm-card-confirm', onClick: function (e) { e.stopPropagation(); } },
          h('p', { className: 'asm-title' }, '删除归档会话'),
          h('p', { className: 'asm-desc' },
            '将永久删除会话 ',
            h('strong', null, '「' + pending.displayTitle + '」'),
            ' 的全部记录（磁盘上的会话日志），此操作不可恢复。'),
          err ? h('p', { className: 'asm-desc asm-warn' }, err) : null,
          h('div', { className: 'asm-row-actions' },
            h('button', { type: 'button', className: 'asm-btn', onClick: close, disabled: busy }, '取消'),
            h('button', { type: 'button', className: 'asm-btn asm-btn-danger', onClick: doDelete, disabled: busy },
              busy ? '删除中…' : '永久删除'))));
    }

    // ---- 3) 设置页：归档会话管理（settings.section，正文即管理页）----
    //
    // 为什么是设置页而不是侧栏按钮/浮层：这是一项**低频的批量维护**操作，
    // 不是会话内的日常动作。设置页（settings.section，kind=list，scope=root）
    // 是平台给「一个独立设置页面」的标准座位，与「插件」页并列；
    // 侧栏底部是「日常快捷动作」的位置，放管理入口语义不符。
    // ownerProps 只有 { close }，数据由本插件自己的宿主路由提供。
    function ArchiveManagerSection() {
      useCss();
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
      // 本次进程内已删除、但内存态仍被平台持有（磁盘已无）的会话。
      // 它们**不是**归档会话，只等重启回收 —— 单列出来，绝不允许混进归档列表
      // （混进去会让用户点删除后那一行原地不动，观感就是「删了又回来」）。
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
       */
      function previewEmpties() {
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
       * 只刷新「已删除待重启」清单，不碰面板其余状态。
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

      function load() {
        setItems(null); setSel({}); setStatus(null); setConfirming(false); setGhosts(null); setPendingRestart([]);
        apiList().then(function (out) {
          setItems(out.sessions || []);
          setWorkspaces(out.workspaces || []);
          setGhosts(out.ghosts || []);
          setPendingRestart(((out && out.pendingRestart) || []).filter(function (x) { return !!x; }));
          // 宿主拿不到数据时如实告知，而不是静默显示成「没有数据」——
          // 之前正是静默吞异常让「工作区为空 → 全部未分组」极难定位。
          var errs = [];
          if (out.metaError) errs.push('会话元数据：' + out.metaError);
          if (out.workspaceError) errs.push('工作区列表：' + out.workspaceError);
          if (errs.length > 0) setStatus({ kind: 'err', text: '部分数据获取失败 → ' + errs.join('；') });
        }).catch(function (e) {
          setItems([]); setWorkspaces([]); setGhosts(null);
          setStatus({ kind: 'err', text: '列表加载失败：' + String((e && e.message) || e) });
        });
      }
      // 打开设置页即拉取（依赖为空 → 只在挂载时跑一次）。
      React.useEffect(load, []);
      // 挂载时并行预览「待归位会话」：与 load() 的 /list 互不等待、互不影响
      // （失败只体现在 repairError 上，面板其余部分照常可用）。
      React.useEffect(function () { previewRepair(); }, []);
      // 同理并行预览「被误记账的子智能体」（独立路由，失败不连坐）。
      React.useEffect(function () { previewSubagents(); }, []);
      // 同理并行预览「磁盘遗留空会话」（唯一会真删文件的项，需二次确认）。
      React.useEffect(function () { previewEmpties(); }, []);

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
      var repairTargetText = repairTargets.slice(0, 3).join('、') + (repairTargets.length > 3 ? ' 等' : '');

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
        if (ungrouped.length > 0) out.push({ id: '__ungrouped__', title: '未分组', path: '', list: ungrouped });
        return out;
      }, [items, workspaces]);

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
          (out.results || []).forEach(function (r) {
            if (r.ok) {
              okIds.add(r.sessionId);
              if (r.warnings && r.warnings.length) warned++;
              // 原本是 live（在浏览器里打开过）的会话：宿主内存仍持有它，
              // 平台下次列会话会把它并回列表（刷新即可看到），如实统计。
              if (r.wasLive) liveCount++;
            } else failures.push(r.error);
          });
          setItems(function (prev) { return (prev || []).filter(function (s) { return !okIds.has(s.sessionId); }); });
          setSel({}); setConfirming(false);
          var freed = out.deletedBytes ? formatBytes(out.deletedBytes) : '';
          // 孤儿记录没有磁盘内容可删，单独说明，免得用户以为「删了但没释放空间」。
          var cleaned = out.cleaned || 0;
          var parts = ['已删除 ' + okIds.size + ' 个会话'];
          if (freed) parts.push('释放 ' + freed);
          if (cleaned > 0) parts.push('其中 ' + cleaned + ' 个仅清理了归档记录（磁盘已无文件）');
          // 关于 live 会话的如实告知（2026-10-12 修正）。
          // 平台会把「本进程内存中仍存活的会话」并入列表（sessionQuery.listSessions
          // 用 ctx.sessions.list() 覆盖合并），所以磁盘文件删掉后，只要它还 live，
          // 刷新页面仍会被列出来。宿主侧现在对这类会话**保留归档标记且不摘记账**，
          // 于是它被归档过滤器隐藏、且不会掉进「未分组」——侧栏观感是干净的。
          // 但「删除」对它而言要到重启 DSH 后才彻底生效，必须如实说清。
          if (liveCount > 0) parts.push('其中 ' + liveCount + ' 个会话在本进程内仍被平台持有：磁盘记录已删除、它们不会出现在侧栏（已保持在归档隐藏状态），重启 DSH 后彻底消失');
          if (warned > 0) parts.push(warned + ' 个的列表记账未能立即清理，重启 DSH 后自动收敛');
          setStatus(failures.length === 0
            // live 不再是「错误」：宿主的处理已保证它不会污染侧栏，只是延迟到重启
            // 才彻底消失。用 info 呈现（此前用 err 红字，会让用户以为删失败了）。
            ? { kind: 'info', text: parts.join('，') }
            : { kind: 'err', text: '已删除 ' + okIds.size + ' 个，失败 ' + failures.length + ' 个：' + failures[0] });
          // 有 live 会话被删时，同步刷新「已删除待重启」清单，让那条如实的状态提示
          // 当场出现（而不是等用户手动刷新，误以为删了没反应）。
          if (liveCount > 0) refreshPendingRestart();
        } catch (e) {
          setStatus({ kind: 'err', text: '批量删除失败：' + String(e && e.message || e) });
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
          ? { kind: 'info', text: '已取消归档 ' + done + ' 个会话' }
          : { kind: 'err', text: '完成 ' + done + ' 个，失败 ' + failed + ' 个' });
        setBusy(false);
      }

      async function doCleanupGhosts() {
        setBusy(true); setStatus(null);
        try {
          var out = await apiCleanupGhosts();
          setStatus({ kind: 'info', text: '已清理 ' + (out.removed || 0) + ' 个失效的列表记账' });
          // 重新拉取，让界面与平台状态一致。
          load();
        } catch (e) {
          setStatus({ kind: 'err', text: '清理失败：' + String((e && e.message) || e) });
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
            ? { kind: 'info', text: '已从工作区记账中摘除 ' + removed + ' 个子智能体（会话文件未动）' }
            : { kind: 'err', text: '已摘除 ' + removed + ' 个，失败 ' + fails.length + ' 个：' + (fails[0].error || '未知错误') });
          // 记账变了 → 重拉面板与预览。
          load();
          previewSubagents();
        } catch (e) {
          setStatus({ kind: 'err', text: '摘除失败：' + String((e && e.message) || e) });
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
          var parts = ['已删除 ' + deleted + ' 个遗留空会话'];
          if (freed) parts.push('释放 ' + freed);
          if (fails.length > 0) parts.push('跳过 ' + fails.length + ' 个（' + (fails[0].error || '') + '）');
          setStatus(fails.length === 0
            ? { kind: 'info', text: parts.join('，') }
            : { kind: 'err', text: parts.join('，') });
          setEmptiesConfirm(false);
          load(); previewEmpties();
        } catch (e) {
          setStatus({ kind: 'err', text: '删除空会话失败：' + String((e && e.message) || e) });
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
            if (r.ok) okCount++; else if (r.error) errors.push(r.error);
          }
          var created = (out && out.createdWorkspaces) || 0;
          // attached 是宿主侧「真正挂上的数量」，比 results 更权威；缺字段时退回 okCount。
          var attached = out && out.attached !== undefined && out.attached !== null ? out.attached : okCount;
          if (errors.length > 0) {
            // 如实汇报：部分成功要同时给出成功数、失败数与第一条原因。
            setRepairMsg({ kind: 'err', text: '已归位 ' + okCount + ' 个，失败 ' + errors.length + ' 个：' + errors[0] });
          } else {
            var parts = ['已归位 ' + attached + ' 个会话'];
            if (created > 0) parts.push('新建 ' + created + ' 个工作区');
            setRepairMsg({ kind: 'info', text: parts.join('，') });
          }
          // 刷新面板状态：/list 里的未分组分组会随之变化，
          // 同时重新预览（正常情况下列表清空，提示条自动消失）。
          load();
          previewRepair();
        } catch (e) {
          setRepairMsg({ kind: 'err', text: '归位失败：' + String((e && e.message) || e) });
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
          title: s.running ? '该会话正在执行任务，无法删除；请先停止它' : '',
        },
          h('input', {
            type: 'checkbox',
            checked: !!sel[s.sessionId],
            disabled: !!s.running,
            onChange: function () { toggleOne(s.sessionId); },
          }),
          h('span', { className: 'asm-item-main' },
            h('span', { className: 'asm-item-title' }, s.title || '（无标题会话）'),
            h('span', { className: 'asm-item-meta' },
              formatTime(s.createdAt)
              // 磁盘已删的条目（非 live）说清真实状态，避免用户看到「0 B」的普通行
              // 以为"删了又回来了"（实测踩到）。
              // 注意：磁盘已删 **且 live** 的条目已不在本列表里 —— 宿主把它们归到
              // pendingRestart 单列（那条路径才是删除后的正常终态）。
              + (s.orphan ? ' · 磁盘上已不存在（仅清理归档记录）' : ''))),
          h('span', { className: 'asm-item-bytes' }, s.orphan ? '—' : formatBytes(s.sizeBytes)));
      }

      var body;
      if (items === null) {
        body = h('div', { className: 'asm-empty' }, '加载中…');
      } else if (items.length === 0) {
        body = h('div', { className: 'asm-empty' }, '没有已归档的会话');
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
                  h('span', { className: 'asm-group-title' }, g.title || '未命名工作区'),
                  h('span', { className: 'asm-group-count' }, groupSel + '/' + g.list.length)),
                h('span', { className: 'asm-group-path' }, g.path || ''),
                h('span', { className: 'asm-item-bytes' }, formatBytes(groupBytes))),
              g.list.map(sessionRow));
          }));
      }

      // 设置页正文：不用浮层外壳，直接铺在设置面板里。
      return h('div', { className: 'asm-section' },
        h('p', { className: 'asm-desc' },
          '这里列出全部已归档会话。可多选后批量删除（永久删除磁盘记录）或批量取消归档。'),
        // 幽灵记账提示：磁盘已无、但工作区仍记着的会话，会以空会话形式出现在
        // 侧栏列表里且无法点开，用户无法自行清除 —— 因此在这里提供一键清理。
        (ghosts && ghosts.length > 0)
          ? h('div', { className: 'asm-notice' },
              h('span', null,
                '检测到 ' + ghosts.reduce(function (a, g) { return a + g.sessionIds.length; }, 0)
                + ' 个失效的列表记账（会话文件已不在磁盘上，多为历史手工删除遗留），'
                + '它们会在侧栏显示为空会话。'),
              h('button', { type: 'button', className: 'asm-btn', onClick: doCleanupGhosts, disabled: busy },
                busy ? '清理中…' : '清理'))
          : null,
        // 归位提示：磁盘上有、但不在任何工作区记账里的会话 —— 平台侧栏只能把它们
        // 显示在「未分组」里，用户无法自行归位。这一块只新增面板内容，绝不改动
        // 归档列表本身的渲染（列表在 /list 里可能并不包含这些会话）。
        repairable.length > 0
          ? h('div', { className: 'asm-notice' },
              h('span', { className: 'asm-notice-main' },
                '检测到 ' + repairable.length + ' 个会话不在任何工作区记账里（会显示在侧栏「未分组」），可一键归位。'
                + (repairCreates > 0 ? '其中 ' + repairCreates + ' 个需要新建工作区。' : '')
                + (repairTargetText ? '归入：' + repairTargetText : ''),
                h('span', { className: 'asm-notice-detail' },
                  '归位只修复列表归属（把这些会话挂到其工作目录对应的工作区），不删除任何文件；预览是只读的。')),
              h('span', { className: 'asm-notice-actions' },
                h('button', { type: 'button', className: 'asm-btn', onClick: previewRepair, disabled: repairing }, '重新预览'),
                h('button', { type: 'button', className: 'asm-btn asm-btn-primary', onClick: doRepair, disabled: repairing },
                  repairing ? '归位中…' : '一键归位')))
          : null,
        // 「已删除，等待重启回收」的条目。
        // ⚠️ 这一条必须与「归档会话列表」严格分开：平台**没有删除会话的 API**，
        //    对仍 live 的会话我们只能保留归档标记来让侧栏隐藏它（否则它会掉进
        //    「未分组」）。代价是该标记要等重启才能清掉。若把它当普通归档会话列在
        //    上面，用户点「删除」→ 那一行原地不动 → 观感就是「删了又回来」（实测）。
        (pendingRestart && pendingRestart.length > 0)
          ? h('div', { className: 'asm-notice' },
              h('span', { className: 'asm-notice-main' },
                '有 ' + pendingRestart.length + ' 个会话已删除：磁盘记录已移除，它们也不会出现在侧栏。',
                h('span', { className: 'asm-notice-detail' },
                  '平台的会话对象在本进程内仍被持有（平台未提供删除会话的 API），'
                  + '所以这个归档标记要等「重启 DSH」后才能清掉。这不是未完成的操作，无需重复删除。')))
          : null,
        // 磁盘遗留空会话：建了却从未用过（无任何 user/message）。
        // ⚠️ 这是唯一会**真正删除磁盘文件**的维护项 —— 语气必须与上面几个
        //    「只改记账」的提示区分开，并走两步确认。
        (empties && empties.length > 0)
          ? h('div', { className: 'asm-notice' },
              h('span', { className: 'asm-notice-main' },
                '检测到 ' + empties.length + ' 个遗留空会话（建了但从未有过对话，共 '
                + formatBytes(empties.reduce(function (a, s) { return a + (s.sizeBytes || 0); }, 0)) + '）。',
                h('span', { className: 'asm-notice-detail' },
                  emptiesConfirm
                    ? '确认永久删除这些磁盘记录？不可恢复。'
                    : '删除会永久移除它们的磁盘记录（不可恢复）；宿主会拒绝删除任何有对话内容的会话。')),
              h('span', { className: 'asm-notice-actions' },
                emptiesConfirm
                  ? h(React.Fragment, null,
                      h('button', { type: 'button', className: 'asm-btn', disabled: emptiesBusy,
                        onClick: function () { setEmptiesConfirm(false); } }, '再想想'),
                      h('button', { type: 'button', className: 'asm-btn asm-btn-danger', disabled: emptiesBusy,
                        onClick: doDeleteEmpties }, emptiesBusy ? '删除中…' : '确认删除'))
                  : h('button', { type: 'button', className: 'asm-btn',
                      disabled: emptiesBusy, onClick: function () { setEmptiesConfirm(true); } }, '清理空会话')))
          : null,
        emptiesError
          ? h('p', { className: 'asm-status asm-status-err' },
              '空会话预览不可用（宿主 /empty-sessions 路由无响应）：' + emptiesError)
          : null,
        // 子智能体污染提示：子智能体不该占用用户工作区的归属记账槽位
        // （侧栏也不把它们显示为列表行，只在父会话上以计数徽标出现）。
        // 本插件的 /repair 早期版本曾误把它们挂入，这里提供清理入口。
        // 采用与「归位」相同的「无害修复」语气：只改记账，绝不删文件。
        (subs && subs.total > 0)
          ? h('div', { className: 'asm-notice' },
              h('span', { className: 'asm-notice-main' },
                '检测到 ' + subs.total + ' 个子智能体被记在了工作区归属里（它们本不该占用工作区的会话槽位）。',
                h('span', { className: 'asm-notice-detail' },
                  '摘除只修改列表归属记账，不删除任何会话文件；子智能体仍属于其父会话。')),
              h('span', { className: 'asm-notice-actions' },
                h('button', { type: 'button', className: 'asm-btn', onClick: previewSubagents, disabled: detaching }, '重新预览'),
                h('button', { type: 'button', className: 'asm-btn asm-btn-primary', onClick: doDetachSubagents, disabled: detaching },
                  detaching ? '摘除中…' : '一键摘除')))
          : null,
        subagentError
          ? h('p', { className: 'asm-status asm-status-err' },
              '子智能体预览不可用（宿主 /detach-subagents 路由无响应）：' + subagentError)
          : null,
        // repair 路由不可用（旧宿主/路由未注册）时如实说明，不假装「没有待归位项」。
        // 用 asm-status 而非 asm-notice：它不是可操作的提示，只是信息缺失的告知。
        repairError
          ? h('p', { className: 'asm-status asm-status-err' },
              '归位预览不可用（宿主 /repair 路由无响应）：' + repairError)
          : null,
        repairMsg
          ? h('p', { className: 'asm-status' + (repairMsg.kind === 'err' ? ' asm-status-err' : '') }, repairMsg.text)
          : null,
        h('div', { className: 'asm-toolbar' },
          h('label', { className: 'asm-item', style: { padding: '4px 0' } },
            h('input', { type: 'checkbox', checked: !!allSelected, onChange: toggleAll, disabled: !items || items.length === 0 }),
            h('span', { className: 'asm-toolbar-label' }, '全选（' + selectedIds.length + '/' + (items ? items.length : 0) + '）')),
          h('button', { type: 'button', className: 'asm-btn', onClick: load, disabled: busy }, '刷新')),
        body,
        status ? h('p', { className: 'asm-status' + (status.kind === 'err' ? ' asm-status-err' : '') }, status.text) : null,
        confirming
          ? h('p', { className: 'asm-desc asm-warn' },
              '确认永久删除选中的 ' + selectedIds.length + ' 个会话？磁盘记录不可恢复。')
          : null,
        h('div', { className: 'asm-footer' },
          h('span', { className: 'asm-status' },
            items && items.length > 0
              ? ('共 ' + items.length + ' 个归档会话 · ' + formatBytes(items.reduce(function (a, s) { return a + (s.sizeBytes || 0); }, 0))
                 + (orphans > 0 ? ' · ' + orphans + ' 个磁盘已不存在' : ''))
              : ''),
          h('div', { className: 'asm-row-actions' },
            h('button', {
              type: 'button', className: 'asm-btn',
              disabled: busy || selectedIds.length === 0,
              onClick: doBatchUnarchive,
            }, '取消归档'),
            confirming
              ? h(React.Fragment, null,
                  h('button', { type: 'button', className: 'asm-btn', disabled: busy, onClick: function () { setConfirming(false); } }, '再想想'),
                  h('button', { type: 'button', className: 'asm-btn asm-btn-danger', disabled: busy, onClick: doBatchDelete },
                    busy ? '删除中…' : '确认删除'))
              : h('button', {
                  type: 'button', className: 'asm-btn asm-btn-danger',
                  disabled: busy || selectedIds.length === 0,
                  onClick: function () { setConfirming(true); },
                }, '批量删除'))));
    }

    // 批量「取消归档」的通路：官方客户端服务 workspaces.unarchiveSession 是
    // ctx 注入的 Remote 调用，面板组件拿不到该 ctx（槽位渲染只给 ownerProps），
    // 所以 apply 里把它挂到 window 桥接给面板用。
    return {
      inject: ['slots', 'workspaces'],
      apply(ctx) {
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
            }, DeleteSessionMenuItem);
          });
        } catch (e) { console.warn('[dsh-archive-session-manager] menu item register failed:', e); }

        // 2) 设置页：归档会话管理（独立一页，与「插件」等页并列）。
        //    放在设置里而不是侧栏：这是低频批量维护，不是会话内日常动作。
        try {
          ctx.slots.inject('settings.section', function () {
            return ctx.slots.register({
              name: 'settings.section',
              id: 'dsh-archive-session-manager',
              order: 65,
              label: '归档会话',
            }, ArchiveManagerSection);
          });
        } catch (e) { console.warn('[dsh-archive-session-manager] settings section register failed:', e); }

        // 3) 全屏浮层：只留「单个会话删除」的确认对话框。
        try {
          ctx.slots.inject('shell.overlay', function () {
            return ctx.slots.register({ name: 'shell.overlay', id: 'dsh-archive-session-manager/confirm' }, ConfirmDeleteDialog);
          });
        } catch (e) { console.warn('[dsh-archive-session-manager] overlay register failed:', e); }
      },
    };
  },
});
