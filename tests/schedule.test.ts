import { describe, expect, it } from 'vitest';
import type { AgendaEntry } from '../src/config.ts';
import {
  anchorOf,
  cadenceText,
  checkEveryMinutes,
  floorToMinute,
  intervalText,
  MIN_INTERVAL_DEFAULT,
  missedSlots,
  nextScheduled,
  scheduleText,
} from '../src/schedule.ts';

/** 与 world.test.ts 同一套:本地时刻构造,测试与机器时区无关。 */
const T = (day: number, h: number, mi: number, s = 0): Date => new Date(2030, 4, day, h, mi, s);

const entry = (over: Partial<AgendaEntry>): AgendaEntry => ({
  id: 'ag-000001',
  kind: 'every',
  everyMinutes: 40,
  prompt: '看挡位',
  owner: 'agent',
  enabled: true,
  createdAt: T(10, 0, 0).toISOString(),
  ...over,
});

describe('整分与锚点', () => {
  it('floorToMinute 抹掉秒与毫秒,不动分钟', () => {
    const t = floorToMinute(new Date(2030, 4, 10, 21, 37, 42, 500));
    expect([t.getMinutes(), t.getSeconds(), t.getMilliseconds()]).toEqual([37, 0, 0]);
  });

  it('锚点优先 anchorAt,再回落 lastFiredAt / createdAt,并一律取整分', () => {
    expect(anchorOf(entry({ anchorAt: T(11, 9, 30, 15).toISOString() }))!.getTime()).toBe(T(11, 9, 30).getTime());
    expect(anchorOf(entry({ lastFiredAt: T(10, 20, 30).toISOString() }))!.getTime()).toBe(T(10, 20, 30).getTime());
    expect(anchorOf(entry({}))!.getTime()).toBe(T(10, 0, 0).getTime());
    // 三个都读不出:返回 null,调用方跳过这条,不炸
    expect(anchorOf(entry({ anchorAt: '不是时间', lastFiredAt: '也不是', createdAt: '还是不是' }))).toBe(null);
  });
});

describe('下一拍', () => {
  it('every 是锚点 + 间隔,不落整点', () => {
    expect(nextScheduled(entry({}), T(10, 7, 0))!.getTime()).toBe(T(10, 7, 40).getTime());
  });

  it('cron 严格晚于锚点;表达式坏、锚点坏、字段缺失都是 null', () => {
    const cron = entry({ kind: 'cron', cron: '30 21 * * *', everyMinutes: undefined });
    expect(nextScheduled(cron, T(10, 21, 30, 5))!.getTime()).toBe(T(11, 21, 30).getTime());
    expect(nextScheduled(entry({ everyMinutes: 0 }), T(10, 0, 0))).toBe(null);
    expect(nextScheduled(entry({ everyMinutes: 40.5 }), T(10, 0, 0))).toBe(null);
    expect(nextScheduled(entry({ kind: 'cron', everyMinutes: undefined }), T(10, 0, 0))).toBe(null);
    expect(nextScheduled(entry({ kind: 'cron', cron: '随便', everyMinutes: undefined }), T(10, 0, 0))).toBe(null);
  });
});

describe('错过几拍', () => {
  it('every 直接除;不足一拍与恰好一拍都算 1', () => {
    const e = entry({});
    expect(missedSlots(e, T(10, 10, 0), T(10, 10, 50, 1))).toEqual({ count: 1, capped: false });
    expect(missedSlots(e, T(10, 10, 0), T(10, 12, 50))).toEqual({ count: 4, capped: false });
    expect(missedSlots(entry({ everyMinutes: 5 }), T(10, 10, 0), T(10, 10, 50))).toEqual({
      count: 10,
      capped: false,
    });
  });

  it('cron 逐拍推;推不完就报下限并标 capped', () => {
    const daily = entry({ kind: 'cron', cron: '30 21 * * *', everyMinutes: undefined });
    // 锚点 8 点,到 13 号 9 点:10、11、12 号各一拍
    expect(missedSlots(daily, T(10, 8, 0), T(13, 9, 0))).toEqual({ count: 3, capped: false });
    // 锚点在那一刻,后面的拍不再算进去
    expect(missedSlots(daily, T(10, 21, 30), T(13, 9, 0))).toEqual({ count: 2, capped: false });
    // 每分钟一条、锚点在 60 小时前:拍数超过上限,只报 500 并标 capped
    const minutely = entry({ kind: 'cron', cron: '* * * * *', everyMinutes: undefined });
    const slots = missedSlots(minutely, T(10, 0, 0), new Date(T(10, 0, 0).getTime() + 60 * 3600_000));
    expect(slots.capped).toBe(true);
    expect(slots.count).toBe(500);
  });
});

describe('间隔的校验与文案', () => {
  it('人话:分钟 / 小时 / 小时+分 / 天', () => {
    expect(intervalText(5)).toBe('每 5 分钟');
    expect(intervalText(40)).toBe('每 40 分钟');
    expect(intervalText(60)).toBe('每 1 小时');
    expect(intervalText(90)).toBe('每 1 小时 30 分');
    expect(intervalText(120)).toBe('每 2 小时');
    expect(intervalText(1440)).toBe('每 1 天');
    expect(intervalText(2880)).toBe('每 2 天');
  });

  it('一天几次:比一天还疏就直说不到一次', () => {
    expect(cadenceText(5)).toBe('一天最多 288 次');
    expect(cadenceText(40)).toBe('一天最多 36 次');
    expect(cadenceText(1440)).toBe('一天最多 1 次');
    expect(cadenceText(2880)).toBe('一天不到一次');
  });

  it('校验:整数、下限(来自配置)、上限 30 天;数字串也收', () => {
    expect(checkEveryMinutes(40, MIN_INTERVAL_DEFAULT)).toEqual({ ok: true, minutes: 40 });
    expect(checkEveryMinutes('40', MIN_INTERVAL_DEFAULT)).toEqual({ ok: true, minutes: 40 });
    expect(checkEveryMinutes(1, MIN_INTERVAL_DEFAULT)).toMatchObject({ ok: false });
    expect(checkEveryMinutes(4, 4)).toEqual({ ok: true, minutes: 4 });
    expect(checkEveryMinutes(40.5, 5)).toMatchObject({ ok: false, error: expect.stringContaining('整数') });
    expect(checkEveryMinutes('abc', 5)).toMatchObject({ ok: false, error: expect.stringContaining('整数') });
    expect(checkEveryMinutes(undefined, 5)).toMatchObject({ ok: false });
    expect(checkEveryMinutes(43_201, 5)).toMatchObject({ ok: false, error: expect.stringContaining('30 天') });
  });

  it('节律短文案:cron / 一次性 / every;cron 坏掉时 verbose 才带原因', () => {
    expect(scheduleText(entry({ kind: 'cron', cron: '30 21 * * *', everyMinutes: undefined }))).toBe('节律 30 21 * * *');
    expect(scheduleText(entry({ kind: 'once', at: '2030-05-10T21:30', everyMinutes: undefined }))).toBe(
      '一次性 2030-05-10T21:30',
    );
    expect(scheduleText(entry({}))).toBe('每 40 分钟');
    expect(scheduleText(entry({ kind: 'cron', cron: '随便', everyMinutes: undefined }))).toBe('节律 随便(看不懂)');
    expect(scheduleText(entry({ kind: 'cron', cron: '61 21 * * *', everyMinutes: undefined }), true)).toContain(
      '分钟字段',
    );
  });
});
