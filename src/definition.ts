import { describeTools, type WorldDefinition } from 'cortico/world.ts';
import { DEFAULT_MAX_NOTES, type AgendaConfigSection, type AgendaEntry } from './config.ts';
import { MIN_INTERVAL_DEFAULT } from './schedule.ts';
import { AGENDA_TOOL_DECLS, AgendaWorld } from './world.ts';

export const AGENDA: WorldDefinition<AgendaConfigSection> = {
  id: 'agenda',
  label: '日程与便签',
  // 每次返回全新对象:entries 与 notes 都是数组,spread 会共享引用,这里显式重建。
  defaults: () => ({
    enabled: false,
    entries: [] as AgendaEntry[],
    notes: [],
    maxEntries: 100,
    minIntervalMinutes: MIN_INTERVAL_DEFAULT,
    maxNotes: DEFAULT_MAX_NOTES,
  }),
  // `ctx.cfg` 是 `worlds.agenda` 的活引用:热改的键现读即生效;persist 是契约内的配置写回。
  create: (ctx) =>
    new AgendaWorld({
      cfg: ctx.cfg,
      persist: (patch) => ctx.persist(patch),
      timezone: ctx.timezone,
      botName: ctx.botName,
    }),
  // 自描述:可能出现的全部工具与会推出的全部事件,不进提示词。
  describe: {
    tools: describeTools(AGENDA_TOOL_DECLS, {
      agenda_list: {
        zh: '列日程表里的全部条目:节律、提示词、谁加的、启停、下次几点响。',
        en: 'Lists every schedule entry: schedule, prompt, who added it, enabled flag, and next fire time.',
      },
      agenda_add: {
        zh: '加一条日程:提示词必填,节律三选一(everyMinutes / cron / at)。',
        en: 'Adds a schedule entry: prompt plus exactly one of everyMinutes, cron or at.',
      },
      agenda_edit: {
        zh: '按 id 改条目:改提示词、重排节律(三选一换种)、或启停。',
        en: 'Edits an entry by id: change the prompt, reschedule it with one of the three forms, or toggle enabled.',
      },
      agenda_remove: {
        zh: '按 id 删掉一条日程。',
        en: 'Removes one schedule entry by id.',
      },
      agenda_note_list: {
        zh: '列便签册上的全部纸条:正文、谁写的、写的与改的时刻。',
        en: 'Lists every note on the shared pad: text, author, and when it was written and last edited.',
      },
      agenda_note_add: {
        zh: '在共用便签册上写一张新纸条,记在你名下。',
        en: 'Writes a new note on the shared pad, labelled with your name.',
      },
      agenda_note_edit: {
        zh: '按 id 重写一张纸条的正文;作者标仍归最早写它的人。',
        en: 'Rewrites the text of one note by id; the author label stays whoever wrote it first.',
      },
      agenda_note_remove: {
        zh: '按 id 删掉一张纸条;删了就没了。',
        en: 'Removes one note by id; removal is final.',
      },
    }),
    events: [
      {
        type: 'agenda.started',
        description: { zh: 'World 挂载完成,日程表已就位。', en: 'The World was mounted and the schedule is in place.' },
      },
      {
        type: 'agenda.noteStarted',
        description: { zh: '便签那一路的挂载报备;整册便签的正文随它交给你。', en: 'The notepad lane announcing its mount; the whole pad is delivered with it.' },
      },
      {
        type: 'agenda.due',
        description: { zh: '一条日程到点:提示词原样投出,补投时注明原定时刻与错过几拍。', en: 'A schedule entry came due: its prompt is delivered verbatim, with the original time and missed slots when caught up.' },
        trigger: 'flush',
      },
      {
        type: 'agenda.noteSent',
        description: { zh: '开发者从控制台把当下的整册便签投给你。', en: 'The developer pushed the current whole notepad to you from the console.' },
        trigger: 'flush',
      },
    ],
  },
};
