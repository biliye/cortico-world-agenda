# cortico-world-agenda

Owner: `src/definition.ts`

一个 World,两张 bot 与开发者**共用**的清单:

- **日程**:到点投一条 `agenda.due` 事件、当场叫醒 bot,正文是条目里写好的提示词原文。两个人都能加
  条目(工具归 bot 调,每条记着「谁要的」,只是事实不是权限)。
- **便签**:一册两人共写的小纸条,关机再开还在。每次这个 World 起来,整册随一条 `agenda.noteStarted`
  交到 bot 手上;他在控制台里也能看、能写、能改、能删,并有一颗「现在投给她」。

两张清单各有一套四个工具,各占控制台 `world:agenda` 页上的一个页签(「日程条目」/「便签」)。
合成一个 World 是因为它们除触发方式外是同一件东西:住配置里的一段清单 + 一套增删改查 + 一块面板。

## 它做什么

### 日程

- **事件**:`agenda.started`(挂载)、`agenda.due`(到点,`origin: internal` → 框架默认 flush,
  立即投递并叫醒 bot;正文 = 提示词原文 + 一行元信息;补投时多一行「补投:原定 X,错过了 N 拍」)。
- **工具**:`agenda_list` / `agenda_add` / `agenda_edit` / `agenda_remove`。
- **时间写法**(三选一):**每隔 N 分钟**(`everyMinutes`,如 40 = 每 40 分钟、120 = 每 2 小时;
  从锚点起算,不落整点;下限 `minIntervalMinutes`,默认 5)、cron 5 字段
  (`30 21 * * *` = 每天 21:30;只认 `* , - /` 和数字)或一次性 `at`
  (`YYYY-MM-DDTHH:mm` 本地时间,触发后自动删除)。都按**本机时区**解释。
- **循环条目**响过之后留在表里,到下一拍再响(这就是「提醒后不消失」);要停就改 `enabled` 或删掉。
- **错过只补一次**:周期条目(隔多久 / cron)下一拍已过期就投一条,补投正文标注原定时刻与错过几拍,
  锚点随即挪到当时那一分钟——关机三天也只摞成一条,不逐拍追投。一次性 `at` **不补**(过期即跳过)。
  她改节律、或把停用的条目重新启用,则**从现在起算**,不补那一拍。
- 条目住 `worlds.agenda.entries`,增删改经 `ctx.persist()` 写回部署 config.json(备份+换名
  的安全路);上限 `worlds.agenda.maxEntries`(默认 100),prompt ≤ 2000 字符。

### 便签

- **事件**:`agenda.noteStarted`(挂载,正文是全部纸条;空册也投,那是「你有一册便签、此刻手上是空的」
  的锚点)、`agenda.noteSent`(他在面板上按「现在投给她」,正文同上,`trigger: 'flush'`)。
  两条都是 `origin: 'internal'`,与其它 World 的挂载报备同档,不额外开一轮;`senderKey` 是
  `agenda.note`,与日程那条分开。
- **工具**:`agenda_note_list` / `agenda_note_add` / `agenda_note_edit` / `agenda_note_remove`。
- 纸条住 `worlds.agenda.notes`,写回同上;上限 `worlds.agenda.maxNotes`(默认 50),单张 ≤ 2000 字。
- **作者是事实标注,不是权限**:工具写的一律记 bot,面板写的一律记开发者;两边都能改、都能删。
  工具上没有 `author` 参数——那会让模型替开发者「说」他没说过的话。
- 面板改便签**不会**顺手投给她:配置写回不触发 World 重启,所以「改」与「投」是两件事。

| 文件 | 内容 |
|---|---|
| `src/definition.ts` | `WorldDefinition`:id、`label`(「日程与便签」)、默认配置段、`create()` |
| `src/config.ts` | 两张清单的类型、默认值、控制台配置组 |
| `src/cron.ts` | cron 解析/匹配/下次触发,纯函数 |
| `src/schedule.ts` | 排班:锚点、`every` 的间隔校验与文案、错过几拍,纯函数 |
| `src/world.ts` | `World` 实现:调度循环、两条通道的事件与八个工具、两个面板的数据面(`invoke`) |
| `src/webui/client.ts` | 「日程条目」与「便签」两个面板前端;esbuild 打成 `dist/webui.js` |
| `src/ENV_PROMPT.md` | 环境提示词(两条通道共用一份);`{{agenda.*}}` 由 `envPromptVars()` 报值 |
| `tests/` | cron 与排班的纯函数单测 + 注入时钟驱动的调度/工具/面板用例;`helpers/fake-host.ts` 记录推送口径 |

## 怎么装

要求 **Cortico 0.2.0 及以上**（扩展契约 `world` 6；0.1.x 不认识这个版本号，装载时直接拒绝）。

- **扩展市场**：控制台「扩展 → 扩展市场」搜 `cortico-world-agenda`，点安装，然后重启进程。
  npm 上的包已经带好 `dist/webui.js`，不用自己构建。
- **手动**：在部署目录里 `corepack pnpm add --ignore-workspace cortico-world-agenda --registry=https://registry.npmjs.org/`
  （本机默认源常是只读镜像，要显式指官方源），或在控制台里安装本包目录。

启用 `worlds.agenda`（控制台 World 总览的开关，或部署 config.json），时间线应出现
`agenda.started` 与 `agenda.noteStarted`；Agenda 详情页出现「日程条目」与「便签」两个页签。

## 从源码构建

1. `corepack pnpm install && corepack pnpm build:webui`——面板产物 `dist/webui.js`
   必须先打出来；`dist/` 不进包的 git，从仓库克隆后要自己 build（npm 包里已带好）；
2. 装进部署，重启进程，再按上一节启用。

**从「agenda + note 两个 World」搬过来**：先停实例，把 `worlds.note.notes` 里每张纸条按
`{ id, text, author, createdAt }` 的形状抄进 `worlds.agenda.notes`（id 用 `nt-` 加 6 位十六进制），
卸掉 `cortico-world-note` 包，删掉 `worlds.note` 那一段，再装本包并重启。留着旧的 note 包会多出
一册各写各的便签。

## 第三级目击清单

**日程(一至三期,已目击通过)**:

1. 聊天里让她「加一条两分钟后的一次性提醒」→ 到点时间线出现 `agenda.due`、她开口、
   `agenda_list` 里该条已自动删除;
2. 让她加一条 `* * * * *` 试两拍再删,看逐分钟到点;
3. 让她加一条「每隔 40 分钟提醒我看挡位」→ 回执里有「每 40 分钟 · 下次 X · 一天最多 36 次」;
   到点响一次、条目**还在表里**,再过 40 分钟再响一次(提醒后不消失);
4. 让她把间隔改成 90 → 回执变「每 1 小时 30 分」,下一次从改的这一刻重新起算;
5. 关掉进程跨过某条的触发时刻再启动:起来时收到**一条**补投,正文第二行写着
   「补投:原定 X,错过了 N 拍」;一次性 `at` 那类不补,留在表里标过期;
6. 让她把一条 `enabled` 改 false,确认到点不再投;重新启用后从现在起算,不补那一拍;
7. 面板:Agenda 详情页「日程条目」页签里加一条「每天几点」→ 表格出现、到点她真的被叫醒;
   表单切「每隔」填 40 → 节律列是「每 40 分钟」;编辑(反推回每天/每周/每隔档)、
   停用/启用、删除(带确认)各走一遍;聊天里让她加一条,15 秒内面板自己刷出来。

**便签(合并后需重走一遍)**:

1. Agenda 详情页出现「便签」页签:空册显示一句占位;
2. 在面板里写一张 → 表格出现,「谁写的」是开发者;点「现在投给她」→ 时间线出现 `agenda.noteSent`,
   正文是这张纸条;
3. 聊天里让她「在便签上写一句……」→ `agenda_note_add` 回执带 id,15 秒内面板自己刷出来;
4. 让她改一张、删一张,面板与 `agenda_note_list` 两边一致;
5. 关掉进程再启动:起来时收到一条 `agenda.noteStarted`,正文是当前的整册;
6. 在 World 总览里点一次「重启 World」:同样再投一条整册;
7. 旧的 `note_*` 工具与 `note.started` 不该再出现;她手上应该只有 `agenda_note_*`。

## 沿革

- **一期(2026-09-19)**:工具 + 事件,部署者在聊天里让 bot 加条目;第三级目击通过。
- **二期(2026-09-19)**:「日程条目」详情页面板(表格化增删改、表单生成 cron)。
- **三期(2026-09-29)**:循环闹钟 `everyMinutes`(锚点制、不落整点)+ 错过只补一次(含开机补投)
  + 配置键 `worlds.agenda.minIntervalMinutes`。改掉的一条旧规矩:「错过不补」变成
  「周期条目错过只补一次,一次性 `at` 仍不补」。
- **四期(2026-10-10)**:并入便签(Note World 的两条事件、四个工具、那块面板与那册数据),
  World 显示名改成「日程与便签」;id 与日程那一路的名字一个字没动。
