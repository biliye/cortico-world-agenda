import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolCallContext } from 'cortico/core/types.ts';
import { AGENDA_CONFIG_GROUP, type AgendaConfigSection, type AgendaEntry } from '../src/config.ts';
import { AgendaWorld } from '../src/world.ts';
import { FakeHost } from './helpers/fake-host.ts';

/** 测试用的钉死时钟:条目时刻都设在 2030-05,与真实时间隔开,避免真实定时器干扰断言。 */
const T = (day: number, h: number, mi: number, s = 0): Date => new Date(2030, 4, day, h, mi, s);

const TEST_CTX = {
  role: 'test',
  log: { child() { return this; }, info() {}, warn() {}, error() {}, debug() {}, trace() {}, emit() {} },
} as unknown as ToolCallContext;

function harness(entries: AgendaEntry[] = [], maxEntries = 100) {
  let current = T(10, 0, 0);
  const cfg: AgendaConfigSection = { enabled: true, entries, maxEntries };
  const persisted: AgendaEntry[][] = [];
  const world = new AgendaWorld({
    cfg,
    persist: (patch) => {
      persisted.push(patch.entries);
      cfg.entries = patch.entries;
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
  return { world, cfg, persisted, host, setClock, tool };
}

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

let h: ReturnType<typeof harness>;

beforeEach(() => {
  h = harness();
});
afterEach(() => {
  void h.world.stop();
});

describe('挂载', () => {
  it('投 agenda.started(internal);启动那一分钟之后的对表才起算', async () => {
    h.setClock(T(10, 21, 29, 30));
    await h.world.start(h.host);
    expect(h.host.events.map((e) => e.type)).toEqual(['agenda.started']);
    expect(h.host.events[0]!.origin).toBe('internal');
    h.setClock(T(10, 21, 30, 10));
    await h.world.tick();
    expect(h.host.events.map((e) => e.type)).toEqual(['agenda.started']);
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

  it('错过不补:进程「关着」跨过触发时刻,那一拍跳过', async () => {
    h = harness([cronEntry('30 21 * * *')]);
    await h.world.start(h.host);
    h.setClock(T(10, 22, 0, 0)); // 直接跳过 21:30
    await h.world.tick();
    expect(h.host.events.filter((e) => e.type === 'agenda.due')).toHaveLength(0);
    h.setClock(T(11, 21, 30, 5)); // 第二天正常到点才投
    await h.world.tick();
    expect(h.host.events.filter((e) => e.type === 'agenda.due')).toHaveLength(1);
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

  it('cron 与 at 都给/都不给、非法 cron、空 prompt 都被拒且不落账', async () => {
    h.setClock(T(10, 21, 0, 0));
    expect(await h.tool('agenda_add')({ prompt: 'x', cron: '30 21 * * *', at: '2030-05-10T21:30' })).toContain('二选一');
    expect(await h.tool('agenda_add')({ prompt: 'x' })).toContain('二选一');
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
    expect(AGENDA_CONFIG_GROUP.id).toBe('world:agenda');
    expect(h.world.console().promptDocs?.[0]?.key).toBe('worlds.agenda.envPrompt');
  });
});

describe('面板数据面(invoke)', () => {
  it('声明 entries 面板;增删改查与工具同一套核心,面板加的条目记在开发者名下', async () => {
    h.setClock(T(10, 21, 0, 0));
    const decl = h.world.console();
    expect(decl.panels?.map((p) => p.id)).toEqual(['entries']);
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
