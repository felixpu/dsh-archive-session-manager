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
      '.asm-item:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.asm-item input{flex:none;accent-color:var(--dsw-alias-brand-primary)}',
      '.asm-item-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}',
      '.asm-item-title{font-size:13px;color:var(--dsw-alias-label-primary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.asm-item-meta{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.asm-item-bytes{flex:none;font-size:11px;color:var(--dsw-alias-label-secondary)}',
      '.asm-toolbar{display:flex;align-items:center;justify-content:space-between;gap:8px}',
      '.asm-toolbar-label{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.asm-empty{padding:32px 0;text-align:center;font-size:13px;color:var(--dsw-alias-label-secondary)}',
      // 提示条（幽灵记账清理）
      '.asm-notice{display:flex;align-items:center;gap:12px;justify-content:space-between;padding:10px 12px;border-radius:10px;',
      'border:.5px solid var(--dsw-alias-state-warn-primary);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 10%,transparent);',
      'font-size:12px;line-height:1.55;color:var(--dsw-alias-label-primary)}',
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

      function load() {
        setItems(null); setSel({}); setStatus(null); setConfirming(false); setGhosts(null);
        apiList().then(function (out) {
          setItems(out.sessions || []);
          setWorkspaces(out.workspaces || []);
          setGhosts(out.ghosts || []);
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
          (out.results || []).forEach(function (r) {
            if (r.ok) { okIds.add(r.sessionId); if (r.warnings && r.warnings.length) warned++; }
            else failures.push(r.error);
          });
          setItems(function (prev) { return (prev || []).filter(function (s) { return !okIds.has(s.sessionId); }); });
          setSel({}); setConfirming(false);
          var freed = out.deletedBytes ? formatBytes(out.deletedBytes) : '';
          // 孤儿记录没有磁盘内容可删，单独说明，免得用户以为「删了但没释放空间」。
          var cleaned = out.cleaned || 0;
          var parts = ['已删除 ' + okIds.size + ' 个会话'];
          if (freed) parts.push('释放 ' + freed);
          if (cleaned > 0) parts.push('其中 ' + cleaned + ' 个仅清理了归档记录（磁盘已无文件）');
          if (warned > 0) parts.push(warned + ' 个的列表记账未能立即清理，重启 DSH 后自动收敛');
          setStatus(failures.length === 0
            ? { kind: 'info', text: parts.join('，') }
            : { kind: 'err', text: '已删除 ' + okIds.size + ' 个，失败 ' + failures.length + ' 个：' + failures[0] });
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

      // 单行会话（组内复用）
      function sessionRow(s) {
        return h('label', { key: s.sessionId, className: 'asm-item' },
          h('input', {
            type: 'checkbox',
            checked: !!sel[s.sessionId],
            onChange: function () { toggleOne(s.sessionId); },
          }),
          h('span', { className: 'asm-item-main' },
            h('span', { className: 'asm-item-title' }, s.title || '（无标题会话）'),
            h('span', { className: 'asm-item-meta' },
              formatTime(s.createdAt)
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
