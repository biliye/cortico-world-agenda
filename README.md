# cortico-world-agenda

Owner: `src/definition.ts`

一张 bot 与开发者**共用**的日程表:到点投一条 `agenda.due` 事件、当场叫醒 bot,正文是条目里
写好的提示词原文。两个人都能加条目(工具归 bot 调,每条记着「谁要的」,只是事实不是权限);
控制台配置组只放标量旋钮,「一列条目」的可视化编辑是二期的详情页面板。

## 它做什么

- **事件**:`agenda.started`(挂载)、`agenda.due`(到点,`origin: internal` → 框架默认 flush,
  立即投递并叫醒 bot;正文 = 提示词原文 + 一行元信息)。
- **工具**:`agenda_list` / `agenda_add` / `agenda_edit` / `agenda_remove`。
- **时间写法**:cron 5 字段(`30 21 * * *` = 每天 21:30;只认 `* , - /` 和数字)或一次性
  `at`(`YYYY-MM-DDTHH:mm` 本地时间,触发后自动删除)。按**本机时区**解释。
- **错过不补**:到点时进程没在跑,这一拍跳过;结构上由「分钟桶」保证,启动那一刻从当前
  分钟起算。进程只是暂停(▶ 前)则事件照常落库排队,不算错过。
- 条目住 `worlds.agenda.entries`,增删改经 `ctx.persist()` 写回部署 config.json(备份+换名
  的安全路);上限 `worlds.agenda.maxEntries`(默认 100),prompt ≤ 2000 字符。

| 文件 | 内容 |
|---|---|
| `src/definition.ts` | `WorldDefinition`:id、默认配置段、`create()` |
| `src/config.ts` | 配置段类型、默认值、控制台配置组 |
| `src/cron.ts` | cron 解析/匹配/下次触发,纯函数 |
| `src/world.ts` | `World` 实现:调度循环、事件、四个工具 |
| `src/ENV_PROMPT.md` | 环境提示词;`{{agenda.summary}}` 等由 `envPromptVars()` 报值 |
| `tests/` | cron 全量单测 + 注入时钟驱动的调度/工具用例;`helpers/fake-host.ts` 记录推送口径 |

## 装进部署(第三级目击的前置)

1. 控制台安装本包目录(或 `corepack pnpm add --ignore-workspace <包路径>`)后重启进程;
2. 启用 `worlds.agenda`(控制台 World 页开关,或部署 config.json);
3. 时间线应出现 `agenda.started`。

## 第三级目击清单

1. 聊天里让她「加一条两分钟后的一次性提醒」→ 到点时间线出现 `agenda.due`、她开口、
   `agenda_list` 里该条已自动删除;
2. 让她加一条 `* * * * *` 试两拍再删,看逐分钟到点;
3. 关掉进程跨过某条的触发时刻再启动:那一拍不补投;
4. 让她把一条 `enabled` 改 false,确认到点不再投。

## 分期

- **一期(本包现状)**:工具 + 事件,部署者在聊天里让 bot 加条目。
- **二期**:World 详情页面板(表格化增删改、表单生成 cron),需引 esbuild 构建链,
  仓内 QQ World 面板是机制先例;条目仍走 `worlds.agenda.entries` + `persist()`。
