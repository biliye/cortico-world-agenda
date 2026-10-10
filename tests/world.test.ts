import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolCallContext } from 'cortico/core/types.ts';
import {
  AGENDA_CONFIG_GROUP,
  type AgendaConfigSection,
  type AgendaEntry,
  type NoteEntry,
} from '../src/config.ts';
import { AGENDA } from '../src/definition.ts';
import { AgendaWorld } from '../src/world.ts';
import { FakeHost } from './helpers/fake-host.ts';

/** 测试用的钉死时钟:条目时刻都设在 2030-05,与真实时间隔开,避免真实定时器干扰断言。 */
const T = (day: number, h: number, mi: number, s = 0): Date => new Date(2030, 4, day, h, mi, s);

const TEST_CTX = {
  role: 'test',
  log: { child() { return this; }, info() {}, warn() {}, error() {}, debug() {}, trace() {}, emit() {} },
} as unknown as ToolCallContext;

function harness(
  entries: AgendaEntry[] = [],
  maxEntries = 100,
  minIntervalMinutes = 5,
  opts: { notes?: NoteEntry[]; maxNotes?: number } = {},
) {
  let current = T(10, 0, 0);
  const cfg: AgendaConfigSection = {
    enabled: true,
    entries,
    notes: opts.notes ?? [],
    maxEntries,
    minIntervalMinutes,
    maxNotes: opts.maxNotes ?? 50,
  };
  const persisted: AgendaEntry[][] = [];
  const persistedNotes: NoteEntry[][] = [];
  const world = new AgendaWorld({
    cfg,
    persist: (patch) => {
      if ('entries' in patch) {
        persisted.push(patch.entries);
        cfg.entries = patch.entries;
      } else {
        persistedNotes.push(patch.notes);
        cfg.notes = patch.notes;
      }
    },
    timezone: 'Asia/Shanghai',
    botName: '塞斯普瑞',
    now: () => current,
  });
  const host = new FakeHost();
  const setClock = (d: Date): void => {
    current = d;
  };
  /** 取工具并包成「传 args 回字符串」的直接调用,ctx 用测试桩。 */
  const tool = (name: string) => {
    const def = world.tools().find((t) => t.name === name);
    if (!def) throw new Error(`tool ${name} missing`);
    return async (args: Record<string, unknown> = {}): Promise<string> => {
      const out = await def.handler(args, TEST_CTX);
      return typeof out === 'string' ? out : out.text;
    };
  };
  /** 面板的数据面。 */
  const panel = <Res,>(panelId: string, method: string, payload: Record<string, unknown> = {}): Promise<Res> =>
    world.console().invoke!(panelId, method, [payload]) as Promise<Res>;
  const due = () => host.events.filter((e) => e.type === 'agenda.due');
  const noteStarted = () => host.events.filter((e) => e.type === 'agenda.noteStarted');
  const noteSent = () => host.events.filter((e) => e.type === 'agenda.noteSent');
  return {
    world,
    cfg,
    persisted,
    persistedNotes,
    host,
    setClock,
    tool,
    panel,
    due,
    noteStarted,
    noteSent,
  };
}

/** 便签那一路的用法:日程留空,只关心 notes。 */
const noteHarness = (notes: NoteEntry[] = [], maxNotes = 50) => harness([], 100, 5, { notes, maxNotes });

const cronEntry = (cron: string, prompt = '拍子到了', overrides: Partial<AgendaEntry> = {}): AgendaEntry => ({
  id: `ag-${Math.random().toString(16).slice(2, 8)}`,
  kind: 'cron',
  cron,
  prompt,
  owner: 'deployer',
  enabled: true,
  createdAt: '2030-05-10T00:00:00.000Z',
  ...overrides,
});

const onceEntry = (at: string, prompt = '一次性拍子', overrides: Partial<AgendaEntry> = {}): AgendaEntry => ({
  id: `ag-${Math.random().toString(16).slice(2, 8)}`,
  kind: 'once',
  at,
  prompt,
  owner: 'agent',
  enabled: true,
  createdAt: '2030-05-10T00:00:00.000Z',
  ...overrides,
});

/** 循环闹钟条目。锚点用本地时刻的绝对时刻表示,这样测试与机器时区无关。 */
const everyEntry = (everyMinutes: number, prompt = '看一眼挡位', overrides: Partial<AgendaEntry> = {}): AgendaEntry => ({
  id: `ag-${Math.random().toString(16).slice(2, 8)}`,
  kind: 'every',
  everyMinutes,
  prompt,
  owner: 'deployer',
  enabled: true,
  createdAt: '2030-05-10T00:00:00.000Z',
  anchorAt: T(10, 10, 0).toISOString(),
  ...overrides,
});

let h: ReturnType<typeof harness>;

beforeEach(() => {
  h = harness();
});
afterEach(() => {
  void h.world.stop();
});

describe('挂载', () => {
  it('投 agenda.started 与便签的 agenda.noteStarted(internal);启动那一分钟之后的对表才起算', async () => {
    h.setClock(T(10, 21, 29, 30));
    await h.world.start(h.host);
    expect(h.host.events.map((e) => e.type)).toEqual(['agenda.started', 'agenda.noteStarted']);
    expect(h.host.events[0]!.origin).toBe('internal');
    // 便签那一路的挂载报备带 `<id>.<lane>` 的 senderKey,与日程那条分开
    expect(h.host.events[1]!.senderKey).toBe('agenda.note');
    h.setClock(T(10, 21, 30, 10));
    await h.world.tick();
    expect(h.host.events.map((e) => e.type)).toEqual(['agenda.started', 'agenda.noteStarted']);
  });
});

describe('到点投递', () => {
  it('cron 到点:flush 立即投,正文带提示词原文与元信息', async () => {
    h = harness([cronEntry('30 21 * * *', '看看他在干什么')]);
    await h.world.start(h.host);
    h.setClock(T(10, 21, 30, 5));
    await h.world.tick();
    const due = h.host.events.filter((e) => e.type === 'agenda.due');
    expect(due).toHaveLength(1);
    expect(due[0]!.origin).toBe('internal');
    expect(due[0]!.source).toBe('agenda');
    expect(due[0]!.text).toContain('看看他在干什么');
    expect(due[0]!.text).toContain('节律 30 21 * * *');
    expect(due[0]!.text).toContain('由 开发者 添加');
    expect(h.host.pushOpts[h.host.events.findIndex((e) => e.type === 'agenda.due')]).toEqual({ trigger: 'flush' });
  });

  it('同一分钟只投一次,下一分钟没有拍子就不投', async () => {
    h = harness([cronEntry('30 21 * * *')]);
    await h.world.start(h.host);
    h.setClock(T(10, 21, 30, 5));
    await h.world.tick();
    await h.world.tick();
    h.setClock(T(10, 21, 31, 5));
    await h.world.tick();
    expect(h.host.events.filter((e) => e.type === 'agenda.due')).toHaveLength(1);
  });

  it('错过补一次:进程「关着」跨过触发时刻,起来时补投一条并标注', async () => {
    h = harness([cronEntry('30 21 * * *')]);
    await h.world.start(h.host);
    h.setClock(T(11, 9, 0, 0)); // 直接跳过 10 号 21:30
    await h.world.tick();
    expect(h.due()).toHaveLength(1);
    expect(h.due()[0]!.text).toContain('补投:原定 2030-05-10T21:30');
    expect(h.due()[0]!.text).toContain('错过了 1 拍');
    // 同一分钟再对一次表不重复投;锚点已挪到现在,下一拍是今晚 21:30
    await h.world.tick();
    expect(h.due()).toHaveLength(1);
    h.setClock(T(11, 21, 30, 5));
    await h.world.tick();
    expect(h.due()).toHaveLength(2);
    expect(h.due()[1]!.text).not.toContain('补投');
  });

  it('关机三天:错过几拍也只摞成一条,不逐拍追投', async () => {
    h = harness([cronEntry('30 21 * * *')]);
    await h.world.start(h.host);
    h.setClock(T(13, 9, 0, 0)); // 10、11、12 号三天的 21:30 都没赶上
    await h.world.tick();
    expect(h.due()).toHaveLength(1);
    expect(h.due()[0]!.text).toContain('错过了 3 拍');
    // 锚点挪到「现在这一分钟」:补完从这刻起算,不回头追那三拍
    expect(Date.parse(h.cfg.entries[0]!.anchorAt!)).toBe(T(13, 9, 0, 0).getTime());
  });

  it('一次性条目到点投出并自动删除;过期的静默不投', async () => {
    h = harness([onceEntry('2030-05-10T21:30', '提醒他喝水')]);
    await h.world.start(h.host);
    h.setClock(T(10, 21, 29, 59));
    await h.world.tick();
    expect(h.host.events.filter((x) => x.type === 'agenda.due')).toHaveLength(0);
    h.setClock(T(10, 21, 30, 2));
    await h.world.tick();
    expect(h.host.events.filter((x) => x.type === 'agenda.due')).toHaveLength(1);
    expect(h.host.events.find((x) => x.type === 'agenda.due')!.text).toContain('提醒他喝水');
    expect(h.cfg.entries).toHaveLength(0);
    expect(h.persisted.at(-1)).toHaveLength(0);
    // 过期的一次性条目:永远不投,留在表里
    h = harness([onceEntry('2030-05-09T21:30', '迟到的')]);
    await h.world.start(h.host);
    h.setClock(T(10, 21, 30, 2));
    await h.world.tick();
    expect(h.host.events.filter((x) => x.type === 'agenda.due')).toHaveLength(0);
    expect(h.cfg.entries).toHaveLength(1);
  });

  it('停用的条目不投;多条同分钟各自投一条', async () => {
    h = harness([
      cronEntry('30 21 * * *', '甲', { enabled: false }),
      cronEntry('30 21 * * *', '乙'),
      cronEntry('* 21 * * *', '丙', { owner: 'agent' }),
    ]);
    await h.world.start(h.host);
    h.setClock(T(10, 21, 30, 5));
    await h.world.tick();
    const due = h.host.events.filter((e) => e.type === 'agenda.due');
    expect(due).toHaveLength(2);
    expect(due[0]!.text).toContain('乙');
    expect(due[1]!.text).toContain('丙');
    expect(due[1]!.text).toContain('由 塞斯普瑞 添加');
  });

  it('配置里被塞进非法 cron 的条目:跳过不炸', async () => {
    h = harness([cronEntry('99 99 * * *')]);
    await h.world.start(h.host);
    h.setClock(T(10, 21, 30, 5));
    await expect(h.world.tick()).resolves.toBeUndefined();
    expect(h.host.events.filter((e) => e.type === 'agenda.due')).toHaveLength(0);
  });
});

describe('循环闹钟(every)', () => {
  it('到点才响:锚点 + 间隔那一分钟;正文带节律,循环条目响过不消失', async () => {
    h = harness([everyEntry(40, '看一下挡位', { anchorAt: T(10, 10, 0).toISOString() })]);
    await h.world.start(h.host);
    h.setClock(T(10, 10, 39, 59));
    await h.world.tick();
    expect(h.due()).toHaveLength(0);
    h.setClock(T(10, 10, 40, 2));
    await h.world.tick();
    expect(h.due()).toHaveLength(1);
    expect(h.due()[0]!.text).toContain('看一下挡位');
    expect(h.due()[0]!.text).toContain('每 40 分钟');
    expect(h.due()[0]!.text).not.toContain('补投');
    // 条目还在表里,下一拍接着响——这就是「提醒后不消失」
    expect(h.cfg.entries).toHaveLength(1);
    h.setClock(T(10, 11, 20, 1));
    await h.world.tick();
    expect(h.due()).toHaveLength(2);
  });

  it('不落整点:从锚点起算,不管时钟的 0 分与 40 分', async () => {
    h.setClock(T(10, 10, 7, 0));
    const out = await h.tool('agenda_add')({ prompt: '看挡位', everyMinutes: 40 });
    expect(out).toContain('已加:');
    expect(out).toContain('每 40 分钟');
    expect(out).toContain('下次 2030-05-10T10:47');
    expect(out).toContain('一天最多 36 次');
    await h.world.start(h.host);
    h.setClock(T(10, 10, 40, 30)); // 整点的 40 分:不该响
    await h.world.tick();
    expect(h.due()).toHaveLength(0);
    h.setClock(T(10, 10, 47, 5));
    await h.world.tick();
    expect(h.due()).toHaveLength(1);
  });

  it('间隔越界与非整数被拒,不落账:下限看配置,上限 30 天', async () => {
    h.setClock(T(10, 0, 0, 0));
    const low = await h.tool('agenda_add')({ prompt: 'x', everyMinutes: 1 });
    expect(low).toContain('未添加');
    expect(low).toContain('至少 5 分钟');
    expect(await h.tool('agenda_add')({ prompt: 'x', everyMinutes: 40.5 })).toContain('整数');
    expect(await h.tool('agenda_add')({ prompt: 'x', everyMinutes: 99_999 })).toContain('30 天');
    expect(h.cfg.entries).toHaveLength(0);
    expect(h.persisted).toHaveLength(0);
    // 下限是配置键,调小后 1 分钟能加
    h = harness([], 100, 1);
    h.setClock(T(10, 0, 0, 0));
    expect(await h.tool('agenda_add')({ prompt: 'x', everyMinutes: 1 })).toContain('已加:');
  });

  it('节律三选一:every/cron/at 一次只给一样', async () => {
    h.setClock(T(10, 0, 0, 0));
    expect(await h.tool('agenda_add')({ prompt: 'x', everyMinutes: 40, cron: '30 21 * * *' })).toContain('三选一');
    expect(await h.tool('agenda_add')({ prompt: 'x' })).toContain('三选一');
    const added = await h.tool('agenda_add')({ prompt: 'x', everyMinutes: 40 });
    const id = /ag-[0-9a-f]+/.exec(added)![0];
    expect(await h.tool('agenda_edit')({ id, everyMinutes: 40, cron: '30 21 * * *' })).toContain('一次只改一样');
    expect(h.cfg.entries).toHaveLength(1);
  });

  it('改间隔:回执报人话与一天几次,锚点从现在起算', async () => {
    h.setClock(T(10, 10, 0, 0));
    const added = await h.tool('agenda_add')({ prompt: '看挡位', everyMinutes: 40 });
    const id = /ag-[0-9a-f]+/.exec(added)![0];
    h.setClock(T(10, 10, 30, 0));
    const edited = await h.tool('agenda_edit')({ id, everyMinutes: 90 });
    expect(edited).toContain('每 1 小时 30 分');
    expect(edited).toContain('下次 2030-05-10T12:00');
    expect(edited).toContain('一天最多 16 次');
    expect(h.cfg.entries[0]!.everyMinutes).toBe(90);
    // 改完从现在起算:按新间隔还没到点,不立刻补响
    await h.world.start(h.host);
    h.setClock(T(10, 10, 31, 0));
    await h.world.tick();
    expect(h.due()).toHaveLength(0);
  });

  it('停用的条目重新启用从现在起算,不补那一拍', async () => {
    h = harness([everyEntry(40, '看挡位', { enabled: false })]);
    await h.world.start(h.host);
    h.setClock(T(10, 10, 55, 0));
    await h.world.tick();
    expect(h.due()).toHaveLength(0);
    expect(await h.tool('agenda_edit')({ id: h.cfg.entries[0]!.id, enabled: true })).toContain('每 40 分钟');
    h.setClock(T(10, 10, 56, 0));
    await h.world.tick();
    expect(h.due()).toHaveLength(0); // 锚点已挪到 10:55,下一拍 11:35
    h.setClock(T(10, 11, 35, 1));
    await h.world.tick();
    expect(h.due()).toHaveLength(1);
  });

  it('起来时补投一次:错过几拍摞成一条,标注原定时刻与拍数', async () => {
    h = harness([everyEntry(40, '看挡位', { anchorAt: T(10, 10, 0).toISOString() })]);
    h.setClock(T(10, 12, 5, 0)); // 关机跨过 10:40 / 11:20 / 12:00 三拍
    await h.world.start(h.host);
    expect(h.due()).toHaveLength(1);
    expect(h.due()[0]!.text).toContain('补投:原定 2030-05-10T10:40');
    expect(h.due()[0]!.text).toContain('错过了 3 拍');
    // 起来后第二拍从此刻起算,且同一分钟不重复投
    expect(Date.parse(h.cfg.entries[0]!.anchorAt!)).toBe(T(10, 12, 5, 0).getTime());
    await h.world.start(h.host);
    expect(h.due()).toHaveLength(1);
    h.setClock(T(10, 12, 45, 1));
    await h.world.tick();
    expect(h.due()).toHaveLength(2);
  });

  it('一次性 at 不补:关机跨过那一分钟就算了,留在表里标过期', async () => {
    h = harness([
      onceEntry('2030-05-10T10:20', '提醒他喝水'),
      everyEntry(40, '看挡位', { anchorAt: T(10, 10, 0).toISOString() }),
    ]);
    h.setClock(T(10, 12, 0, 0));
    await h.world.start(h.host);
    expect(h.due()).toHaveLength(1); // 只有循环那条补了
    expect(h.due()[0]!.text).toContain('看挡位');
    expect(h.cfg.entries.some((e) => e.kind === 'once')).toBe(true);
  });

  it('配置被手改坏(间隔 0 / 非数 / 锚点读不出)的条目跳过不炸', async () => {
    h = harness([
      everyEntry(0),
      everyEntry(40, '锚点坏的', { anchorAt: '不是时间', lastFiredAt: '也不是', createdAt: '还是不是' }),
      everyEntry(40, '好的', { anchorAt: T(10, 10, 0).toISOString() }),
    ]);
    h.setClock(T(10, 10, 40, 30));
    await expect(h.world.start(h.host)).resolves.toBeUndefined();
    await h.world.tick();
    expect(h.due()).toHaveLength(1);
    expect(h.due()[0]!.text).toContain('好的');
  });
});

describe('工具:增', () => {
  it('cron 条目加成功,回执带归一化表达式与下次触发', async () => {
    h.setClock(T(10, 21, 0, 0));
    const out = await h.tool('agenda_add')({ prompt: '问他今天过得怎么样', cron: '30 21 * * *' });
    expect(out).toContain('已加:');
    expect(out).toContain('节律 30 21 * * *');
    expect(out).toContain('下次 2030-05-10T21:30');
    expect(h.cfg.entries).toHaveLength(1);
    expect(h.cfg.entries[0]!.owner).toBe('agent');
    expect(h.persisted).toHaveLength(1);
  });

  it('一次性条目加成功;过去的 at 被拒', async () => {
    h.setClock(T(10, 21, 0, 0));
    const ok = await h.tool('agenda_add')({ prompt: '看一眼屏幕', at: '2030-05-10T21:45' });
    expect(ok).toContain('已加:');
    expect(ok).toContain('将于 2030-05-10T21:45');
    const past = await h.tool('agenda_add')({ prompt: '太晚了', at: '2030-05-10T20:00' });
    expect(past).toContain('未添加');
    expect(past).toContain('过去');
    expect(h.cfg.entries).toHaveLength(1);
  });

  it('节律三选一:都给/都不给、非法 cron、空 prompt 都被拒且不落账', async () => {
    h.setClock(T(10, 21, 0, 0));
    expect(await h.tool('agenda_add')({ prompt: 'x', cron: '30 21 * * *', at: '2030-05-10T21:30' })).toContain('三选一');
    expect(await h.tool('agenda_add')({ prompt: 'x' })).toContain('三选一');
    const badCron = await h.tool('agenda_add')({ prompt: 'x', cron: '61 21 * * *' });
    expect(badCron).toContain('未添加');
    expect(badCron).toContain('分钟');
    expect(await h.tool('agenda_add')({ cron: '30 21 * * *' })).toContain('prompt 不能为空');
    expect(h.cfg.entries).toHaveLength(0);
    expect(h.persisted).toHaveLength(0);
  });

  it('requestedBy=deployer 记为开发者要的;加满被拒', async () => {
    h.setClock(T(10, 21, 0, 0));
    await h.tool('agenda_add')({ prompt: '他要的', cron: '30 21 * * *', requestedBy: 'deployer' });
    expect(h.cfg.entries[0]!.owner).toBe('deployer');
    h = harness([], 2);
    h.setClock(T(10, 21, 0, 0));
    await h.world.start(h.host);
    await h.tool('agenda_add')({ prompt: '一', at: '2030-05-10T21:45' });
    await h.tool('agenda_add')({ prompt: '二', at: '2030-05-10T21:46' });
    const full = await h.tool('agenda_add')({ prompt: '三', at: '2030-05-10T21:47' });
    expect(full).toContain('已满');
    expect(h.cfg.entries).toHaveLength(2);
  });
});

describe('工具:改/删/查', () => {
  it('改 prompt、改节律(换 kind)、停用与启用', async () => {
    h.setClock(T(10, 21, 0, 0));
    const added = await h.tool('agenda_add')({ prompt: '旧话', cron: '30 21 * * *' });
    const id = /ag-[0-9a-f]+/.exec(added)![0];
    const edited = await h.tool('agenda_edit')({ id, prompt: '新话', enabled: false });
    expect(edited).toContain('新话');
    expect(h.cfg.entries[0]!.enabled).toBe(false);
    const switched = await h.tool('agenda_edit')({ id, at: '2030-05-11T09:00', enabled: true });
    expect(switched).toContain('一次性 2030-05-11T09:00');
    expect(h.cfg.entries[0]!.kind).toBe('once');
    expect(h.cfg.entries[0]!.cron).toBeUndefined();
    const back = await h.tool('agenda_edit')({ id, cron: '0 9 * * 1' });
    expect(back).toContain('节律 0 9 * * 1');
    expect(h.cfg.entries[0]!.kind).toBe('cron');
  });

  it('改不存在的条目、改坏的表达式,都不落账', async () => {
    h.setClock(T(10, 21, 0, 0));
    expect(await h.tool('agenda_edit')({ id: 'ag-none' })).toContain('没有 ag-none');
    await h.tool('agenda_add')({ prompt: 'x', cron: '30 21 * * *' });
    const first = h.cfg.entries[0]!;
    const bad = await h.tool('agenda_edit')({ id: first.id, cron: '随便' });
    expect(bad).toContain('未改');
    expect(first.cron).toBe('30 21 * * *');
  });

  it('删存在与不存在的条目', async () => {
    h.setClock(T(10, 21, 0, 0));
    const added = await h.tool('agenda_add')({ prompt: '要删的', at: '2030-05-10T21:45' });
    const id = /ag-[0-9a-f]+/.exec(added)![0];
    expect(await h.tool('agenda_remove')({ id })).toContain('已删');
    expect(h.cfg.entries).toHaveLength(0);
    expect(await h.tool('agenda_remove')({ id })).toContain('没有');
  });

  it('列表:空表给用法提示,有货时报全四样', async () => {
    expect(await h.tool('agenda_list')()).toContain('日程表是空的');
    h = harness([
      cronEntry('30 21 * * *', '每晚问一声', { owner: 'deployer' }),
      onceEntry('2030-05-09T08:00', '过期的', { enabled: false }),
    ]);
    h.setClock(T(10, 20, 0, 0));
    await h.world.start(h.host);
    const out = await h.tool('agenda_list')();
    expect(out).toContain('共 2 条');
    expect(out).toContain('每晚问一声');
    expect(out).toContain('下次 2030-05-10T21:30');
    expect(out).toContain('已过期');
    expect(out).toContain('[停用]');
    expect(out).toContain('由 开发者 添加');
  });
});

describe('声明面', () => {
  it('环境提示词变量与配置组', async () => {
    h = harness([cronEntry('30 21 * * *'), cronEntry('* 9 * * *', 'x', { enabled: false })]);
    const vars = h.world.envPromptVars();
    expect(vars['agenda.summary']).toBe('共 2 条(1 条停用)');
    expect(vars['agenda.maxEntries']).toBe('100');
    expect(vars['agenda.minInterval']).toBe('5');
    expect(AGENDA_CONFIG_GROUP.id).toBe('world:agenda');
    expect(Object.keys(AGENDA_CONFIG_GROUP.schema.properties ?? {})).toContain('worlds.agenda.minIntervalMinutes');
    // 便签那一路的变量与配置键也在同一段里
    expect(Object.keys(AGENDA_CONFIG_GROUP.schema.properties ?? {})).toContain('worlds.agenda.maxNotes');
    expect(h.world.console().promptDocs?.[0]?.key).toBe('worlds.agenda.envPrompt');
    // 旧部署没有这个键:按缺省 5 分钟判
    h = harness([], 100, undefined as unknown as number);
    expect(h.world.envPromptVars()['agenda.minInterval']).toBe('5');
    expect(await h.tool('agenda_add')({ prompt: 'x', everyMinutes: 3 })).toContain('至少 5 分钟');
  });
});

describe('面板数据面(invoke)', () => {
  it('声明 entries 面板;增删改查与工具同一套核心,面板加的条目记在开发者名下', async () => {
    h.setClock(T(10, 21, 0, 0));
    const decl = h.world.console();
    expect(decl.panels?.map((p) => p.id)).toEqual(['entries', 'notes']);
    const invoke = decl.invoke!;
    expect(await invoke('entries', 'add', [{ prompt: '面板加的', cron: '30 21 * * *' }])).toMatchObject({ ok: true });
    expect(h.cfg.entries[0]!.owner).toBe('deployer');
    const list = (await invoke('entries', 'list', [])) as { entries: Array<Record<string, unknown>> };
    expect(list.entries).toHaveLength(1);
    expect(list.entries[0]).toMatchObject({
      schedule: '节律 30 21 * * *',
      ownerLabel: '开发者',
      next: '下次 2030-05-10T21:30',
    });
    const id = list.entries[0]!.id as string;
    expect(await invoke('entries', 'edit', [{ id, enabled: false }])).toMatchObject({ ok: true });
    expect(h.cfg.entries[0]!.enabled).toBe(false);
    expect(h.persisted.length).toBeGreaterThanOrEqual(2);
    expect(await invoke('entries', 'remove', [{ id }])).toMatchObject({ ok: true });
    expect(h.cfg.entries).toHaveLength(0);
  });

  it('面板也能加/改循环闹钟:间隔从输入框来的是字符串', async () => {
    h.setClock(T(10, 10, 0, 0));
    const invoke = h.world.console().invoke!;
    expect(await invoke('entries', 'add', [{ prompt: '看挡位', everyMinutes: '40' }])).toMatchObject({ ok: true });
    expect(h.cfg.entries[0]!.kind).toBe('every');
    expect(h.cfg.entries[0]!.everyMinutes).toBe(40);
    let list = (await invoke('entries', 'list', [])) as { entries: Array<Record<string, unknown>> };
    expect(list.entries[0]).toMatchObject({ schedule: '每 40 分钟', next: '下次 2030-05-10T10:40', everyMinutes: 40 });
    const id = list.entries[0]!.id as string;
    expect(await invoke('entries', 'edit', [{ id, everyMinutes: '2' }])).toMatchObject({
      ok: false,
      error: expect.stringContaining('至少 5 分钟'),
    });
    expect(await invoke('entries', 'edit', [{ id, everyMinutes: '90' }])).toMatchObject({ ok: true });
    list = (await invoke('entries', 'list', [])) as { entries: Array<Record<string, unknown>> };
    expect(list.entries[0]).toMatchObject({ schedule: '每 1 小时 30 分', everyMinutes: 90 });
  });

  it('非法输入返回 {ok:false, error};未知面板与方法抛错', async () => {
    h.setClock(T(10, 21, 0, 0));
    const invoke = h.world.console().invoke!;
    expect(await invoke('entries', 'add', [{ prompt: 'x' }])).toMatchObject({ ok: false });
    expect(await invoke('entries', 'add', [{ prompt: 'x', cron: '61 * * * *' }])).toMatchObject({
      ok: false,
      error: expect.stringContaining('分钟'),
    });
    expect(await invoke('entries', 'add', [{ prompt: 'x', at: '2030-05-10T20:00' }])).toMatchObject({
      ok: false,
      error: expect.stringContaining('过去'),
    });
    expect(await invoke('entries', 'edit', [{ id: 'ag-none' }])).toMatchObject({ ok: false, notFound: true });
    await expect(invoke('nope', 'list', [])).rejects.toThrow(/未知面板/);
    await expect(invoke('entries', 'nope', [])).rejects.toThrow(/未知方法/);
  });

  it('一次性条目过期的,面板 list 标注已过期', async () => {
    h = harness([onceEntry('2030-05-09T08:00', '迟到的')]);
    h.setClock(T(10, 21, 0, 0));
    const list = (await h.world.console().invoke!('entries', 'list', [])) as {
      entries: Array<{ next: string }>;
    };
    expect(list.entries[0]!.next).toContain('已过期');
  });
});

// ---------------------------------------------------------------------------
// 便签那一通道:与 Note World 原来那套测试同一批行为,名字改挂 agenda_note_*
// ---------------------------------------------------------------------------

const note = (text: string, overrides: Partial<NoteEntry> = {}): NoteEntry => ({
  id: `nt-${Math.random().toString(16).slice(2, 8)}`,
  text,
  author: 'deployer',
  createdAt: '2030-05-09T09:00:00.000+08:00',
  ...overrides,
});

describe('便签:挂载', () => {
  it('投一条 agenda.noteStarted(internal),正文是全部纸条,带作者与条数', async () => {
    h = noteHarness([
      note('明天记得交电费', { id: 'nt-aaa111' }),
      note('她在学吉他', { id: 'nt-bbb222', author: 'agent', createdAt: '2030-05-09T10:00:00.000+08:00' }),
    ]);
    await h.world.start(h.host);
    expect(h.noteStarted()).toHaveLength(1);
    const e = h.noteStarted()[0]!;
    expect(e.origin).toBe('internal');
    expect(e.source).toBe('agenda');
    expect(e.senderKey).toBe('agenda.note');
    // 内部事件走默认投递档(flush),不写 trigger
    expect(h.host.pushOpts[1]).toBeUndefined();
    expect(e.text).toContain('共 2 张');
    expect(e.text).toContain('nt-aaa111 · 开发者写于 05-09 09:00');
    expect(e.text).toContain('nt-bbb222 · 塞斯普瑞写于 05-09 10:00');
    expect(e.text).toContain('明天记得交电费');
    expect(e.text).toContain('她在学吉他');
    expect(e.text).toContain('agenda_note_list');
  });

  it('空册也投一条,正文给工具提示', async () => {
    h = noteHarness();
    await h.world.start(h.host);
    expect(h.noteStarted()).toHaveLength(1);
    expect(h.noteStarted()[0]!.text).toContain('便签还是空的');
    expect(h.noteStarted()[0]!.text).toContain('agenda_note_add');
  });

  it('配置被手改坏(notes 不是数组 / 条目缺字段)不炸', async () => {
    h = noteHarness();
    (h.cfg as unknown as { notes: unknown }).notes = '坏数据';
    await h.world.start(h.host);
    expect(h.noteStarted()[0]!.text).toContain('便签还是空的');
    (h.cfg as unknown as { notes: unknown }).notes = [{ id: 'nt-x' }];
    const list = await h.tool('agenda_note_list')();
    expect(list).toContain('nt-x');
    expect(list).toContain('共 1 张');
  });

  it('重新起来再投一次(World 每次起来都给整册)', async () => {
    h = noteHarness([note('留一句话', { id: 'nt-ccc333' })]);
    await h.world.start(h.host);
    await h.world.stop();
    await h.world.start(h.host);
    expect(h.noteStarted()).toHaveLength(2);
  });
});

describe('便签:工具写', () => {
  it('写一张记在她名下,回执带 id 与正文;正文首尾空白去掉、换行保留', async () => {
    h = noteHarness();
    const out = await h.tool('agenda_note_add')({ text: '  第一行\n第二行  ' });
    expect(out).toContain('已写下:nt-');
    expect(out).toContain('第一行\n第二行');
    expect(h.cfg.notes).toHaveLength(1);
    expect(h.cfg.notes[0]!.author).toBe('agent');
    expect(h.cfg.notes[0]!.text).toBe('第一行\n第二行');
    expect(h.cfg.notes[0]!.createdAt).toBe('2030-05-10T00:00:00.000+08:00');
    expect(h.persistedNotes).toHaveLength(1);
  });

  it('空正文与超长被拒,不落账', async () => {
    h = noteHarness();
    expect(await h.tool('agenda_note_add')({ text: '   ' })).toContain('未写下:纸条不能是空的');
    expect(await h.tool('agenda_note_add')({ text: '字'.repeat(2001) })).toContain('未写下:纸条超过 2000 字');
    expect(h.cfg.notes).toHaveLength(0);
    expect(h.persistedNotes).toHaveLength(0);
  });

  it('加满被拒并指出去处;上限从配置现读', async () => {
    h = noteHarness([], 1);
    await h.tool('agenda_note_add')({ text: '第一张' });
    const out = await h.tool('agenda_note_add')({ text: '第二张' });
    expect(out).toContain('便签满了(1/1)');
    expect(out).toContain('worlds.agenda.maxNotes');
    expect(h.cfg.notes).toHaveLength(1);
  });
});

describe('便签:工具改/删/查', () => {
  it('改正文:author 不变,updatedAt 落上', async () => {
    h = noteHarness([note('旧的', { id: 'nt-ddd444' })]);
    h.setClock(T(11, 8, 5));
    const out = await h.tool('agenda_note_edit')({ id: 'nt-ddd444', text: '新的' });
    expect(out).toContain('已改:nt-ddd444');
    expect(h.cfg.notes[0]!.text).toBe('新的');
    expect(h.cfg.notes[0]!.author).toBe('deployer');
    expect(h.cfg.notes[0]!.updatedAt).toBe('2030-05-11T08:05:00.000+08:00');
    expect(h.cfg.notes[0]!.createdAt).toBe('2030-05-09T09:00:00.000+08:00');
  });

  it('改成一模一样的正文:说没改,不写盘', async () => {
    h = noteHarness([note('原样', { id: 'nt-eee555' })]);
    const out = await h.tool('agenda_note_edit')({ id: 'nt-eee555', text: ' 原样 ' });
    expect(out).toContain('没改');
    expect(h.persistedNotes).toHaveLength(0);
    expect(h.cfg.notes[0]!.updatedAt).toBeUndefined();
  });

  it('改成空的被拒(要拿掉就用 agenda_note_remove)', async () => {
    h = noteHarness([note('留着', { id: 'nt-fff666' })]);
    expect(await h.tool('agenda_note_edit')({ id: 'nt-fff666', text: ' ' })).toContain('未改:纸条不能是空的');
    expect(h.cfg.notes[0]!.text).toBe('留着');
  });

  it('改 / 删不存在的 id 都指路 agenda_note_list', async () => {
    h = noteHarness([note('唯一一张', { id: 'nt-ggg777' })]);
    expect(await h.tool('agenda_note_edit')({ id: 'nt-nope', text: 'x' })).toContain('用 agenda_note_list 看现有纸条');
    expect(await h.tool('agenda_note_remove')({ id: 'nt-nope' })).toContain('用 agenda_note_list 看现有纸条');
    expect(h.cfg.notes).toHaveLength(1);
  });

  it('删掉的那张把正文念回来', async () => {
    h = noteHarness([note('别忘了我', { id: 'nt-hhh888' })]);
    const out = await h.tool('agenda_note_remove')({ id: 'nt-hhh888' });
    expect(out).toContain('已删:nt-hhh888');
    expect(out).toContain('别忘了我');
    expect(h.cfg.notes).toHaveLength(0);
  });

  it('列表:空册给用法提示,有货时报正文与来路', async () => {
    const empty = noteHarness();
    expect(await empty.tool('agenda_note_list')()).toContain('便签是空的');

    h = noteHarness([
      note('他留的', { id: 'nt-iii999' }),
      note('她留的', { id: 'nt-jjj000', author: 'agent' }),
    ]);
    const out = await h.tool('agenda_note_list')();
    expect(out).toContain('共 2 张(上限 50)');
    expect(out).toContain('nt-iii999 · 开发者写于 05-09 09:00');
    expect(out).toContain('nt-jjj000 · 塞斯普瑞写于 05-09 09:00');
    expect(out).toContain('  她留的');
  });
});

describe('便签:面板数据面(invoke)', () => {
  it('list 报条数上限、字数上限与能不能投', async () => {
    h = noteHarness([note('面板里看得见', { id: 'nt-kkk111' })]);
    const res = await h.panel<{
      notes: Array<{ id: string; authorLabel: string; writtenAt: string }>;
      maxNotes: number;
      maxChars: number;
      deliverable: boolean;
    }>('notes', 'list');
    expect(res.maxNotes).toBe(50);
    expect(res.maxChars).toBe(2000);
    expect(res.deliverable).toBe(false); // 还没 start
    expect(res.notes[0]).toMatchObject({ id: 'nt-kkk111', authorLabel: '开发者', writtenAt: '05-09 09:00' });
  });

  it('面板写的记在开发者名下,与工具同一套核心(工具立刻看得见)', async () => {
    h = noteHarness();
    const res = await h.panel<{ ok: boolean; message: string }>('notes', 'add', { text: '他写的' });
    expect(res.ok).toBe(true);
    expect(h.cfg.notes[0]!.author).toBe('deployer');
    expect(await h.tool('agenda_note_list')()).toContain('开发者写于 05-10 00:00');
  });

  it('面板的 edit / remove 与工具同一个池子,非法输入回 {ok:false}', async () => {
    h = noteHarness([note('先有这张', { id: 'nt-lll222' })]);
    const edited = await h.panel<{ ok: boolean; message: string }>('notes', 'edit', { id: 'nt-lll222', text: '改过' });
    expect(edited.message).toContain('已改 nt-lll222');
    expect(h.cfg.notes[0]!.text).toBe('改过');

    const missing = await h.panel<{ ok: boolean; error: string }>('notes', 'edit', { id: 'nt-nope', text: 'x' });
    expect(missing.ok).toBe(false);
    expect(missing.error).toContain('用 agenda_note_list 看现有纸条');

    const bad = await h.panel<{ ok: boolean; error: string }>('notes', 'add', { text: '  ' });
    expect(bad.ok).toBe(false);

    const removed = await h.panel<{ ok: boolean; message: string }>('notes', 'remove', { id: 'nt-lll222' });
    expect(removed.message).toContain('已删 nt-lll222');
    expect(h.cfg.notes).toHaveLength(0);
  });

  it('未知方法抛错;便签核不动日程那张表', async () => {
    h = noteHarness([note('便签那张', { id: 'nt-zzz999' })]);
    await expect(h.panel('notes', 'nope')).rejects.toThrow('未知方法');
    // 同一个 World 的两条通道各管各的:便签的增删改查不改 entries
    await h.tool('agenda_note_remove')({ id: 'nt-zzz999' });
    expect(h.cfg.entries).toHaveLength(0);
    expect(h.persisted).toHaveLength(0);
  });
});

describe('便签:现在投给她', () => {
  it('World 没在跑:回一句话,不抛错,不投事件', async () => {
    h = noteHarness([note('在册', { id: 'nt-mmm333' })]);
    const res = await h.panel<{ ok: boolean; error: string }>('notes', 'deliver');
    expect(res.ok).toBe(false);
    expect(res.error).toContain('没在跑');
    expect(h.host.events).toHaveLength(0);
  });

  it('起来之后:投一条 agenda.noteSent(flush),正文是当前的整册', async () => {
    h = noteHarness([note('第一张', { id: 'nt-nnn444' })]);
    await h.world.start(h.host);
    const res = await h.panel<{ ok: boolean; message: string }>('notes', 'deliver');
    expect(res.ok).toBe(true);
    expect(res.message).toBe('已把 1 张投给她');
    expect(h.noteSent()).toHaveLength(1);
    expect(h.noteSent()[0]!.text).toContain('开发者从控制台把整册便签投给你');
    expect(h.noteSent()[0]!.text).toContain('第一张');
    expect(h.host.pushOpts[h.host.events.length - 1]).toEqual({ trigger: 'flush' });
  });

  it('停掉之后投不了;面板 list 的 deliverable 跟着变', async () => {
    h = noteHarness();
    await h.world.start(h.host);
    expect((await h.panel<{ deliverable: boolean }>('notes', 'list')).deliverable).toBe(true);
    await h.world.stop();
    expect((await h.panel<{ deliverable: boolean }>('notes', 'list')).deliverable).toBe(false);
    expect((await h.panel<{ ok: boolean }>('notes', 'deliver')).ok).toBe(false);
  });

  it('空册按下也算投了(说明是空的)', async () => {
    h = noteHarness();
    await h.world.start(h.host);
    const res = await h.panel<{ ok: boolean; message: string }>('notes', 'deliver');
    expect(res.ok).toBe(true);
    expect(res.message).toContain('便签是空的');
    expect(h.noteSent()[0]!.text).toContain('便签还是空的');
  });
});

describe('便签:声明面', () => {
  it('环境提示词只报条数、上限与字数上限(正文不进前缀)', () => {
    h = noteHarness([note('一'), note('二')], 30);
    expect(h.world.envPromptVars()).toMatchObject({
      'agenda.noteCount': '2',
      'agenda.noteMax': '30',
      'agenda.noteMaxChars': '2000',
    });
  });

  it('定义:默认禁用,id 与标签,缺省段每次新建(两张清单都不共享引用)', () => {
    const a = AGENDA.defaults();
    const b = AGENDA.defaults();
    expect(AGENDA.id).toBe('agenda');
    expect(AGENDA.label).toBe('日程与便签');
    expect(a.enabled).toBe(false);
    expect(a.notes).toEqual([]);
    expect(a.maxNotes).toBe(50);
    expect(a.entries).not.toBe(b.entries);
    expect(a.notes).not.toBe(b.notes);
  });
});
