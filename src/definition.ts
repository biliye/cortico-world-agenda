import type { WorldDefinition } from 'cortico/world.ts';
import type { AgendaConfigSection, AgendaEntry } from './config.ts';
import { AgendaWorld } from './world.ts';

export const AGENDA: WorldDefinition<AgendaConfigSection> = {
  id: 'agenda',
  label: 'Agenda',
  // 每次返回全新对象:entries 是数组,spread 会共享引用,这里显式重建。
  defaults: () => ({ enabled: false, entries: [] as AgendaEntry[], maxEntries: 100 }),
  // `ctx.cfg` 是 `worlds.agenda` 的活引用:热改的键现读即生效;persist 是契约内的配置写回。
  create: (ctx) =>
    new AgendaWorld({
      cfg: ctx.cfg,
      persist: (patch) => ctx.persist(patch),
      timezone: ctx.timezone,
      botName: ctx.botName,
    }),
};
