import type { WorldDefinition } from 'cortico/world.ts';
import { DEFAULT_MAX_NOTES, type AgendaConfigSection, type AgendaEntry } from './config.ts';
import { MIN_INTERVAL_DEFAULT } from './schedule.ts';
import { AgendaWorld } from './world.ts';

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
};
