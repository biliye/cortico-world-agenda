import { describe, expect, it } from 'vitest';
import { cronMatches, formatAt, nextFire, parseAt, parseCron } from '../src/cron.ts';

/** 本地时刻的便捷构造。 */
const at = (y: number, mo: number, d: number, h: number, mi: number): Date => new Date(y, mo - 1, d, h, mi);

describe('parseCron + cronMatches', () => {
  it('星号匹配任意分钟', () => {
    const p = parseCron('* * * * *');
    expect(cronMatches(p, at(2030, 5, 10, 21, 30))).toBe(true);
    expect(cronMatches(p, at(2030, 1, 1, 0, 0))).toBe(true);
  });

  it('指定时刻只在该分钟命中', () => {
    const p = parseCron('30 21 * * *');
    expect(cronMatches(p, at(2030, 5, 10, 21, 30))).toBe(true);
    expect(cronMatches(p, at(2030, 5, 10, 21, 31))).toBe(false);
    expect(cronMatches(p, at(2030, 5, 10, 20, 30))).toBe(false);
  });

  it('列表与区间:0 9,18 * * 1-5 只在工作日 9 点与 18 点', () => {
    const p = parseCron('0 9,18 * * 1-5');
    expect(cronMatches(p, at(2030, 5, 10, 9, 0))).toBe(true); // 2030-05-10 是周五
    expect(cronMatches(p, at(2030, 5, 10, 18, 0))).toBe(true);
    expect(cronMatches(p, at(2030, 5, 11, 9, 0))).toBe(false); // 周六
    expect(cronMatches(p, at(2030, 5, 10, 12, 0))).toBe(false);
  });

  it('步长:*/15 每刻钟', () => {
    const p = parseCron('*/15 * * * *');
    expect(cronMatches(p, at(2030, 5, 10, 21, 0))).toBe(true);
    expect(cronMatches(p, at(2030, 5, 10, 21, 45))).toBe(true);
    expect(cronMatches(p, at(2030, 5, 10, 21, 14))).toBe(false);
  });

  it('周字段 7 与 0 都是周日', () => {
    const sun = at(2030, 5, 12, 8, 0); // 周日
    expect(cronMatches(parseCron('0 8 * * 0'), sun)).toBe(true);
    expect(cronMatches(parseCron('0 8 * * 7'), sun)).toBe(true);
    expect(cronMatches(parseCron('0 8 * * 1'), sun)).toBe(false);
  });

  it('日与周都写了具体值时取「或」(标准 cron 语义)', () => {
    // 2030-05-13 是周一,13 号;2030-05-10 周五非 13 号;2030-05-14 周二非 13 号。
    const p = parseCron('0 12 13 * 1');
    expect(cronMatches(p, at(2030, 5, 13, 12, 0))).toBe(true); // 13 号本身
    expect(cronMatches(p, at(2030, 5, 13, 12, 0))).toBe(true); // 也是周一
    expect(cronMatches(p, at(2030, 5, 20, 12, 0))).toBe(true); // 周一但非 13 号
    expect(cronMatches(p, at(2030, 5, 14, 12, 0))).toBe(false); // 非周一非 13 号
  });

  it('只写日、周为星号时只看日', () => {
    const p = parseCron('0 0 13 * *');
    expect(cronMatches(p, at(2030, 5, 13, 0, 0))).toBe(true);
    expect(cronMatches(p, at(2030, 5, 20, 0, 0))).toBe(false);
  });

  it('月字段生效', () => {
    const p = parseCron('0 0 1 3 *');
    expect(cronMatches(p, at(2030, 3, 1, 0, 0))).toBe(true);
    expect(cronMatches(p, at(2030, 4, 1, 0, 0))).toBe(false);
  });

  it('归一化回标准形', () => {
    expect(parseCron('30 21 * * 7').normalized).toBe('30 21 * * 0');
    expect(parseCron('*/15 9 * * *').normalized).toBe('0,15,30,45 9 * * *');
  });
});

describe('parseCron 报错', () => {
  it('字段数不对', () => {
    expect(() => parseCron('30 21 * *')).toThrow(/5 个字段/);
    expect(() => parseCron('30 21 * * * *')).toThrow(/5 个字段/);
  });

  it('越界', () => {
    expect(() => parseCron('60 21 * * *')).toThrow(/分钟/);
    expect(() => parseCron('30 24 * * *')).toThrow(/小时/);
    expect(() => parseCron('30 21 32 * *')).toThrow(/日/);
    expect(() => parseCron('30 21 * 13 *')).toThrow(/月/);
    expect(() => parseCron('30 21 * * 8')).toThrow(/周/);
  });

  it('看不懂的词与坏步长', () => {
    expect(() => parseCron('MON 21 * * *')).toThrow(/看不懂/);
    expect(() => parseCron('30 21 * * */0')).toThrow(/步长/);
    expect(() => parseCron('9-3 21 * * *')).toThrow(/越界/);
  });
});

describe('nextFire', () => {
  it('严格晚于 from:当天还有下一拍就是它', () => {
    const p = parseCron('30 21 * * *');
    expect(nextFire(p, at(2030, 5, 10, 21, 29))).toEqual(at(2030, 5, 10, 21, 30));
  });

  it('当天已过就到明天', () => {
    const p = parseCron('30 21 * * *');
    expect(nextFire(p, at(2030, 5, 10, 21, 31))).toEqual(at(2030, 5, 11, 21, 30));
  });

  it('月跳转:3 月 1 日的拍子,1 月看是下个月', () => {
    const p = parseCron('0 0 1 3 *');
    expect(nextFire(p, at(2030, 1, 15, 12, 0))).toEqual(at(2030, 3, 1, 0, 0));
  });

  it('日/周「或」语义下的下一拍', () => {
    // 周一或 13 号;2030-05-10 周五 → 下一拍是 5-12(周日?不,周一 5-13 既是周一也是 13 号)
    const p = parseCron('0 12 13 * 1');
    expect(nextFire(p, at(2030, 5, 10, 12, 0))).toEqual(at(2030, 5, 13, 12, 0));
  });

  it('永不到达的表达式返回 null(2 月 30 日)', () => {
    const p = parseCron('0 0 30 2 *');
    expect(nextFire(p, at(2030, 1, 1, 0, 0))).toBeNull();
  });

  it('from 的秒数被抹掉,不重复投本分钟', () => {
    const p = parseCron('*/15 * * * *');
    expect(nextFire(p, new Date(2030, 4, 10, 21, 0, 30))).toEqual(at(2030, 5, 10, 21, 15));
  });
});

describe('at(一次性时刻)', () => {
  it('解析与回写往返', () => {
    const d = parseAt('2030-05-10T21:30');
    expect(formatAt(d)).toBe('2030-05-10T21:30');
  });

  it('格式不对与不存在的时刻都报错', () => {
    expect(() => parseAt('2030/05/10 21:30')).toThrow(/YYYY-MM-DDTHH:mm/);
    expect(() => parseAt('2030-13-10T21:30')).toThrow(/真实存在/);
    expect(() => parseAt('明天晚上')).toThrow(/YYYY-MM-DDTHH:mm/);
  });
});
