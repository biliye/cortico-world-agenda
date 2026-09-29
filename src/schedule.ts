/**
 * 排班:一条周期条目「下一拍在什么时候」「已经错过几拍」,以及间隔写法(every)的校验与文案。
 *
 * 锚点(anchor)是上一次响过的那一拍,也是「你改完节律、从现在起算」的那一刻;cron 与 every 都
 * 从它往后算。进程没在跑时锚点会落在过去,于是能算出错过几拍——投不投、补几次由 World 定,
 * 这里只给数。一次性条目不走这里。
 *
 * 刻意不把间隔写成 cron:那样只能写成「星号 斜杠 40」的步长形式,而它落在每小时的 0 分与
 * 40 分,实际是 40 分、20 分交替,90 分钟、2 小时这类也写不出来——那样的「闹钟」不是开发者
 * 要的东西。
 */
import type { AgendaEntry } from './config.ts';
import { nextFire, parseCron, type ParsedCron } from './cron.ts';

/** 间隔下限的缺省:config 里没有 `worlds.agenda.minIntervalMinutes` 时用它。每响一次是一轮模型调用。 */
export const MIN_INTERVAL_DEFAULT = 5;
/** 间隔上限 30 天;与下限同一层:防手滑多敲一位的机械护栏。 */
export const MAX_INTERVAL_MINUTES = 43_200;
/** 数错过几拍时 cron 最多往后推这么多拍;再多只报「N 拍以上」,不为一个提示词跑几百次计算。 */
const MISSED_CAP = 500;

/** 排班一律按整分:锚点落在哪一分钟,下一拍就落在哪一分钟,存下来再读回去不丢也不漂。 */
export function floorToMinute(d: Date): Date {
  const t = new Date(d.getTime());
  t.setSeconds(0, 0);
  return t;
}

/** 读一个时间戳字符串;读不出返回 null——配置被手改坏时跳过这条,不连累整张表。 */
function parseTs(raw: string | undefined): Date | null {
  if (raw === undefined) return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : new Date(t);
}

/** 排班锚点:显式的 anchorAt → 上次响过的时刻 → 条目创建时刻。三者都读不出返回 null。 */
export function anchorOf(e: AgendaEntry): Date | null {
  const raw = parseTs(e.anchorAt) ?? parseTs(e.lastFiredAt) ?? parseTs(e.createdAt);
  return raw === null ? null : floorToMinute(raw);
}

const cronCache = new Map<string, ParsedCron | Error>();

/** 带缓存的 cron 解析:cron 表达式在配置里,每次对表都解析一遍是白费。 */
export function parsedCron(expr: string): ParsedCron | Error {
  let p = cronCache.get(expr);
  if (p === undefined) {
    try {
      p = parseCron(expr);
    } catch (err) {
      p = err instanceof Error ? err : new Error(String(err));
    }
    cronCache.set(expr, p);
  }
  return p;
}

/** every 条目的下一拍:锚点 + 间隔(整数分钟)。 */
export function nextEvery(anchor: Date, minutes: number): Date {
  return new Date(anchor.getTime() + minutes * 60_000);
}

/**
 * 从锚点起算的下一拍;算不出返回 null——cron 在可见的未来永不命中、表达式或锚点读不出。
 * cron 严格晚于锚点(与 nextFire 同口径);every 是锚点 + 间隔。
 */
export function nextScheduled(e: AgendaEntry, anchor: Date): Date | null {
  if (e.kind === 'every') {
    const min = e.everyMinutes;
    if (typeof min !== 'number' || !Number.isInteger(min) || min < 1) return null;
    return nextEvery(anchor, min);
  }
  if (e.cron === undefined) return null;
  const p = parsedCron(e.cron);
  return p instanceof Error ? null : nextFire(p, anchor);
}

/** 锚点之后、now 之前(含)本该响几拍;调用方只在「下一拍已过期」时问,所以至少 1。 */
export interface MissedSlots {
  count: number;
  /** cron 推到了 MISSED_CAP 还没追上 now:count 只是下限。 */
  capped: boolean;
}

export function missedSlots(e: AgendaEntry, anchor: Date, now: Date): MissedSlots {
  if (e.kind === 'every') {
    const min = e.everyMinutes ?? 0;
    if (min < 1) return { count: 1, capped: false };
    return { count: Math.max(1, Math.floor((now.getTime() - anchor.getTime()) / (min * 60_000))), capped: false };
  }
  if (e.cron === undefined) return { count: 1, capped: false };
  const p = parsedCron(e.cron);
  if (p instanceof Error) return { count: 1, capped: false };
  let from = anchor;
  let count = 0;
  while (count < MISSED_CAP) {
    const next = nextFire(p, from);
    if (next === null || next.getTime() > now.getTime()) break;
    from = next;
    count += 1;
  }
  return { count: Math.max(1, count), capped: count >= MISSED_CAP };
}

/** 间隔的人话:「每 40 分钟」「每 1 小时 30 分」「每 2 小时」「每 2 天」。 */
export function intervalText(minutes: number): string {
  if (minutes % 1440 === 0) return `每 ${minutes / 1440} 天`;
  if (minutes < 60) return `每 ${minutes} 分钟`;
  if (minutes % 60 === 0) return `每 ${minutes / 60} 小时`;
  return `每 ${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

/** 这个间隔一天最多响几次;比一天还疏就直说不到一次。改间隔的回执里报给她看代价。 */
export function cadenceText(minutes: number): string {
  const perDay = 1440 / minutes;
  return perDay >= 1 ? `一天最多 ${Math.floor(perDay)} 次` : '一天不到一次';
}

/** 校验一个间隔值(工具收数字、面板收输入框里的字符串);不合格返回给人看的一句话。 */
export function checkEveryMinutes(
  value: unknown,
  minMinutes: number,
): { ok: true; minutes: number } | { ok: false; error: string } {
  const n = typeof value === 'string' ? Number(value.trim()) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || !Number.isInteger(n)) {
    return { ok: false, error: 'everyMinutes 要一个整数分钟数(40 = 每 40 分钟,120 = 每 2 小时)。' };
  }
  if (n > MAX_INTERVAL_MINUTES) {
    return { ok: false, error: `间隔最多 ${MAX_INTERVAL_MINUTES} 分钟(30 天),收到 ${n};要更疏就用 cron 表达式。` };
  }
  if (n < minMinutes) {
    return {
      ok: false,
      error: `间隔至少 ${minMinutes} 分钟(收到 ${n})——每响一次就是一轮模型调用;要更密得开发者调小 worlds.agenda.minIntervalMinutes。`,
    };
  }
  return { ok: true, minutes: n };
}

/** 节律的短文案。cron 读不懂时 verbose 带上原因(面板要,给她的正文不要)。 */
export function scheduleText(e: AgendaEntry, verbose = false): string {
  if (e.kind === 'once') return `一次性 ${e.at ?? '?'}`;
  if (e.kind === 'every') return e.everyMinutes === undefined ? '每 ? 分钟' : intervalText(e.everyMinutes);
  const p = parsedCron(e.cron ?? '');
  return p instanceof Error ? `节律 ${e.cron ?? '?'}(看不懂${verbose ? `:${p.message}` : ''})` : `节律 ${p.normalized}`;
}
