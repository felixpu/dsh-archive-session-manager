# 重启后验证清单（归位功能）

代码已 push 并装进 profile，但**当前宿主进程仍是旧模块**（10:57 启动，代码 11:10 才更新），
所以 `/repair` 路由尚未生效。重启后按下面 4 步验证即可。

## 第 1 步：确认路由已加载

重启 DSH（3080）后执行：

```sh
# 对照：既有路由返回 200，说明服务在跑
curl -s -o /dev/null -w "list  -> %{http_code}\n" \
  http://127.0.0.1:3080/api/dsh-archive-session-manager/list
```

`list` 返回 `200` 即宿主已加载本插件；若返回 404，说明插件行没装载（查 profile bundles）。

## 第 2 步：只用浏览器，别用 curl

`/repair` 是 POST，需要会话鉴权 —— 命令行 curl 只会拿到 `401 unauthorized`，
**这不能说明路由不存在**（本次实测：不存在的路由同样返回 401，无法区分）。

正确做法：在浏览器里打开 **设置 → 归档会话**。

预期看到一条黄色提示条，内容形如：

> 检测到 37 个会话不在任何工作区记账里（会显示在侧栏「未分组」），可一键归位。
> 其中 3 个需要新建工作区。归入：ant_link、dsh-plugins、felix
> 归位只修复列表归属（把这些会话挂到其工作目录对应的工作区），不删除任何文件；预览是只读的。

命令行等价结果（我用「已安装包 + 真实记账 + 真实磁盘」离线跑出，供你对照）：

| 项目 | 数值 |
|---|---|
| 扫描到的会话目录 | 69 |
| 待归位 | 37 |
| 需新建工作区 | 3 |
| attach → ant_link | 16 |
| attach → dsh-plugins | 14 |
| attach → felix | 4 |
| 新建 → 活动策划 | 2 |
| 新建 → tmp | 1 |

⚠️ 数字会随你继续用 DSH 而增长（每新建一个会话就多一个未记账项），不必与上表完全一致，
**量级相符即可**。

## 第 3 步：点「一键归位」，然后看侧栏

点完之后：
1. 提示条应显示「已归位 37 个会话」并**自动消失**（清单已清空）；
2. 展开左侧栏，**「未分组」分组应该消失**（或数量显著减少）；
3. 这些会话应回到 `ant_link` / `dsh-plugins` / `felix` 各自分组下。

若侧栏没立刻更新：先刷新页面再看。`connection/reset` 是平台标准的「请重拉数据」事件，
但侧栏是否因此重拉列表属于运行期行为，静态验证无法覆盖 —— 这一点如实告知。

## 第 4 步：确认没有误删

归位**只写记账、不删任何文件**。可选校验：

```sh
ls ~/.dsh/sessions/*/ | wc -l          # 目录数应与归位前一致
```

## 出问题时怎么回滚

```sh
cd ~/.dsh/profiles/web && pnpm update dsh-archive-session-manager
```

备份（本次改动前的已安装副本与 profile 配置）在：

- `~/.dsh/backups/asm-lib-index.js.before-repair-20261012-111006`
- `~/.dsh/backups/asm-profile-package.json.before-repair-20261012-111006`

## 如果归位报错（预案）

host-dev 曾提出一个风险：平台 `attachSession` 内部会调 `host.readSessionHeader(id)`，
而该方法按 cwd 推导目录名 —— 对「裸 UUID 目录名」的遗留会话可能读不到 header 从而抛错，
导致 `mutate` 被中断、`rememberSessionPath` 白写。**我已实测排除了这个风险**：

- 平台 `listSessionDirs` 是 `readdir` **全量枚举**目录（不是按 id 拼名去找）；
- `encodeSegment` 对裸 UUID 原样保留；
- 我按平台算法复刻 `sessionDir(root, cwd, id)` 拼出路径，磁盘上确实存在；
- 实测全部 **49 个**会话目录的「目录名 === header.id」**全部相等**（0 个不等）。

所以 `readSessionHeader` 能正常拿到 header，`attachSession` 不会因找不到会话而失败。
万一真出现失败，接口会在 `results[].ok=false` 里带上原文错误，按错误信息再定位。
