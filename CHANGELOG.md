# 更新日志

市场按版本显示这里的 `## <版本号>` 一段。

## 0.2.0

首次发布。一个 World 同时提供两张 bot 与开发者共用的清单：

- **日程**：到点投一条 `agenda.due` 事件、当场叫醒 bot，正文是条目里写好的提示词原文。
  时间三种写法：每隔 N 分钟（锚点制，不落整点）、cron 5 字段、一次性 `at`。
  循环条目响过之后留在表里；进程关着时错过的周期拍子**只补一次**（正文标注原定时刻与错过几拍），
  一次性条目过期不补。四个工具：`agenda_list` / `agenda_add` / `agenda_edit` / `agenda_remove`。
- **便签**：一册两人共写的小纸条，写到 `worlds.agenda.notes`。每次 World 起来整册随
  `agenda.noteStarted` 交到 bot 手上；开发者在面板上可以看、写、改、删，并按「现在投给她」
  投一条 `agenda.noteSent`。四个工具：`agenda_note_list` / `agenda_note_add` /
  `agenda_note_edit` / `agenda_note_remove`。
- **控制台面板**：`world:agenda` 页两个页签（「日程条目」/「便签」），表格化增删改，
  表单生成 cron，15 秒自动刷新。
- **要求 Cortico 0.2.0 及以上**：扩展契约 `world` 6（`cortico.api: 6`）；0.1.x 不认这个
  版本号，装载时直接拒绝。
- **平台**：纯 Node，无平台依赖；Linux / macOS / Windows 都能跑，时间按本机时区解释。
- 验证：`tsc --noEmit`（Node 与 WebUI 两份）、83 条测试、`pnpm build:webui`、
  `pnpm check:extension` 全过。
