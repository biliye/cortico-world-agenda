/**
 * 5 字段 cron(分 时 日 月 周)的解析、匹配与下次触发时间。
 *
 * 只做标准子集:`* , - /` 与纯数字,周字段 0 与 7 都算周日;不支持名称(MON)与 L W ? 扩展。
 * 匹配按本机时区的 Date 直算——中国无 DST,不做时区换算;面板(二期)也只生成这个子集。
 * 标准 cron 的日/周双限语义:两者都写了具体值时,命中其一即触发。
 */

export interface ParsedCron {
  minute: boolean[];
  hour: boolean[];
  dom: boolean[];
  month: boolean[];
  dow: boolean[];
  /** 日/周字段是否写的是具体限制(而非单独 `*`),用于双限语义。 */
  domRestricted: boolean;
  dowRestricted: boolean;
  /** 归一化回的 5 字段表达式,供回执展示。 */
  normalized: string;
}

const FIELD_SPECS = [
  { name: '分钟', min: 0, max: 59 },
  { name: '小时', min: 0, max: 23 },
  { name: '日', min: 1, max: 31 },
  { name: '月', min: 1, max: 12 },
  { name: '周', min: 0, max: 7 },
] as const;

function parseField(spec: (typeof FIELD_SPECS)[number], raw: string): { table: boolean[]; restricted: boolean } {
  const table = new Array<boolean>(spec.max + 1).fill(false);
  for (const term of raw.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(term.trim());
    if (!m) throw new Error(`cron ${spec.name}字段的「${term}」看不懂:只认 数字、区间(a-b)、*(以及后面的 /步长)`);
    const [, rangePart, stepPart] = m;
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) throw new Error(`cron ${spec.name}字段的步长「/${stepPart}」得是正整数`);
    let lo: number;
    let hi: number;
    if (rangePart === '*') {
      lo = spec.min;
      hi = spec.max;
    } else if (rangePart!.includes('-')) {
      const [a, b] = rangePart!.split('-').map(Number);
      lo = a!;
      hi = b!;
    } else {
      lo = Number(rangePart);
      hi = stepPart === undefined ? lo : spec.max;
    }
    if (lo < spec.min || hi > spec.max || lo > hi) {
      throw new Error(`cron ${spec.name}字段的范围「${rangePart}」越界:合法是 ${spec.min}-${spec.max}`);
    }
    for (let v = lo; v <= hi; v += step) table[v] = true;
  }
  const restricted = raw.trim() !== '*';
  return { table, restricted };
}

export function parseCron(expr: string): ParsedCron {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`cron 要 5 个字段(分 时 日 月 周),「${expr.trim()}」是 ${fields.length} 个`);
  }
  const [minF, hourF, domF, monF, dowF] = fields as [string, string, string, string, string];
  const minute = parseField(FIELD_SPECS[0]!, minF);
  const hour = parseField(FIELD_SPECS[1]!, hourF);
  const dom = parseField(FIELD_SPECS[2]!, domF);
  const month = parseField(FIELD_SPECS[3]!, monF);
  const dow = parseField(FIELD_SPECS[4]!, dowF);
  // 周 7 归到 0(周日),标准写法两者等价。
  if (dow.table[7]) dow.table[0] = true;
  const join = (f: { table: boolean[] }, min: number, max: number): string => {
    const vals: number[] = [];
    for (let v = min; v <= max; v++) if (f.table[v]) vals.push(v);
    return vals.length === max - min + 1 ? '*' : vals.join(',');
  };
  return {
    minute: minute.table,
    hour: hour.table,
    dom: dom.table,
    month: month.table,
    dow: dow.table,
    domRestricted: dom.restricted,
    dowRestricted: dow.restricted,
    normalized: [
      join(minute, 0, 59),
      join(hour, 0, 23),
      join(dom, 1, 31),
      join(month, 1, 12),
      join(dow, 0, 6),
    ].join(' '),
  };
}

/** 某一时刻(只看年月日时分)是否命中。 */
export function cronMatches(p: ParsedCron, at: Date): boolean {
  if (!p.month[at.getMonth() + 1]) return false;
  // 日与周都写了具体值时按标准语义取「或」;只写其一就只看那个。
  const dayOk = p.dom[at.getDate()];
  const dowOk = p.dow[at.getDay()];
  if (p.domRestricted && p.dowRestricted) {
    if (!dayOk && !dowOk) return false;
  } else if (p.domRestricted) {
    if (!dayOk) return false;
  } else if (p.dowRestricted) {
    if (!dowOk) return false;
  }
  return p.hour[at.getHours()] && p.minute[at.getMinutes()];
}

/**
 * 严格晚于 from 的下次触发;到不了(如 2 月 30 日)返回 null。
 * 不逐分钟扫:月不对跳月、日不对跳日,命中的那天之内才逐分钟。
 */
export function nextFire(p: ParsedCron, from: Date, horizonYears = 5): Date | null {
  const t = new Date(from.getTime());
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);
  const dayLimit = Math.ceil(horizonYears * 366) * 2;
  for (let day = 0; day < dayLimit; day++) {
    if (!p.month[t.getMonth() + 1]) {
      t.setDate(1);
      t.setHours(0, 0, 0, 0);
      t.setMonth(t.getMonth() + 1);
      continue;
    }
    const dayOk = p.dom[t.getDate()];
    const dowOk = p.dow[t.getDay()];
    const hit =
      p.domRestricted && p.dowRestricted ? dayOk || dowOk : p.domRestricted ? dayOk : p.dowRestricted ? dowOk : true;
    if (!hit) {
      t.setDate(t.getDate() + 1);
      t.setHours(0, 0, 0, 0);
      continue;
    }
    for (let h = t.getHours(); h < 24; h++) {
      if (!p.hour[h]) continue;
      for (let m = h === t.getHours() ? t.getMinutes() : 0; m < 60; m++) {
        if (p.minute[m]) return new Date(t.getFullYear(), t.getMonth(), t.getDate(), h, m);
      }
    }
    t.setDate(t.getDate() + 1);
    t.setHours(0, 0, 0, 0);
  }
  return null;
}

/** 一次性条目的本地时间格式:YYYY-MM-DDTHH:mm。 */
const AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

export function parseAt(raw: string): Date {
  if (!AT_PATTERN.test(raw)) {
    throw new Error(`at 要「YYYY-MM-DDTHH:mm」的本地时间,例如 2026-09-19T21:30,收到「${raw}」`);
  }
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) throw new Error(`at 的「${raw}」不是一个真实存在的时间`);
  return d;
}

export function formatAt(d: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
