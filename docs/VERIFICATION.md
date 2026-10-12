# 升级后验证清单

面向维护者。机制说明见 [DEVELOPMENT.md](DEVELOPMENT.md)，用户文档见 [../README.md](../README.md)。

## 为什么必须重启

宿主半身与客户端 bundle 都在进程启动时装载。改完代码后：

- ⚠️ **`plugin_manager` 的 `set_bundle` 开关不能替代重启** —— disable→enable 返回
  `application: applied`，但 Node 模块缓存让旧代码继续复用；
- ⚠️ **客户端 bundle 不会自动重载** —— 本 profile 未装 `dsh-client-hmr`，没有文件监视。

```sh
# 查宿主 PID 与启动时间
# ⚠️ 不要用 ps -o ... -p $(pgrep -f "dsh/lib/bin.js web")：本机 pgrep -f 匹配单个
#    argv，而该模式含空格、跨参数，实测无输出 → ps 报 "option requires an argument"。
ps ax -o pid=,lstart=,command= | grep "lib/bin.js web" | grep -v grep
```

## 第 1 步：确认新代码已加载

判据必须是「**只有新版本才有**」的特征。`curl .../list | grep -q pendingRestart`
**无效** —— 该字段旧版本就有，旧模块照样返回 `"pendingRestart":[]`，探测恒为「✓」。

用新增的 `/evict` 路由判断：

```sh
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  -H 'content-type: application/json' -d '{}' \
  http://127.0.0.1:3080/api/dsh-archive-session-manager/evict
# 400 = 路由已注册（新代码）   401 = 路由不存在（旧代码）
```

⚠️ **已注册的 POST 路由可以直接用 curl 验证**：实测 `/delete` 400、`/repair` 200、
`/cleanup-ghosts` 200、`/evict` 400、`/detach-subagents` 200、`/empty-sessions` 200；
只有**未注册**路径回 401。

## 第 2 步：清理历史残留

历史上被删过、但因旧版本行为而残留在归档集合里的 id，由 `pruneDeadArchived()`
在启动后首次打开面板时自动清掉。确认方式：

```sh
curl -s http://127.0.0.1:3080/api/dsh-archive-session-manager/list | head -c 200
```

`pruneDeadArchived()` 扫描失败时**不会**清（清归档集合是破坏性动作，信息不全时宁可留着）。

## 第 3 步：关键验收（删一个被打开过的归档会话）

1. 新建一个会话，**新建后就在浏览器里打开它**（让它成为 live —— 这是触发 pending
   通路的条件）；
2. 归档它；
3. 用「···」菜单里的「删除会话」删掉；
4. **刷新页面**。

**预期（全部满足才算通过）**：

- 侧栏**不再出现**该会话（前提：视图筛选是「隐藏已归档」）；
- 「设置 → 归档会话」里也**没有**它，且**不出现**「待重启」提示；
- 磁盘上它的目录已删除。

若侧栏仍出现、或管理页出现「待重启」条目，点「**重试驱逐**」一般即可清掉。

### ⚠️ 一个独立的干扰项：侧栏归档筛选档位

侧栏视图菜单有三档「已归档」筛选（`dsh-client-ui-workspace/lib/client.js:2903-2905`）：
**隐藏已归档（默认）** / **显示已归档** / **仅已归档**。

如果选的是「显示已归档」，归档会话本来就会显示在侧栏其工作区分组下 —— 这是平台预期设计，
不是插件的 bug。验收前请确认档位是「隐藏已归档」。

## 第 4 步：确认没有误删

```sh
find ~/.dsh/sessions -mindepth 2 -maxdepth 2 -type d | wc -l   # 与操作前对比
```

## 回滚

```sh
cd ~/.dsh/profiles/web && pnpm update dsh-archive-session-manager
```

历史备份（可删）：`~/.dsh/backups/asm-lib-index.js.before-repair-*`、
`~/.dsh/backups/asm-profile-package.json.before-repair-*`。

## 如实告知的局限

- 平台的**公开 Service 契约里没有**会话级删除 API。本插件的删除始终是
  「驱逐内存态 + 删磁盘 + 清记账 + 清归档」的组合。
- 驱逐用的是平台**内部 teardown 原语**（`detachEntered` / `liveEntryFor`）。
  它们在 `.d.ts` 里标 `private`，但**运行时可达**（不是 ES `#` 私有字段）。
  若官方改内部结构，这里需要跟着调整 —— 已用 try/catch 兜底，失败会如实回报并降级为
  「提示重启 + 可重试驱逐」，不会静默坏掉。
- 「重启后收敛」永远是最后兜底：pending 表与内存态都随进程重建。
