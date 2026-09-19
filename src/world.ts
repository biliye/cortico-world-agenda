/** Agenda World:一张共用的日程表,到点投 agenda.due 当场叫醒她;增删改查走四个工具。 */
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { ToolDef, World, WorldConsoleDecl, WorldHost } from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import { AGENDA_CONFIG_GROUP, type AgendaConfigSection, type AgendaEntry } from './config.ts';
import { cronMatches, formatAt, nextFire, parseAt, parseCron, type ParsedCron } from './cron.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

/** 调度循环的检查间隔;条目是分钟级粒度,15 秒内必然查到,不值得多一个旋钮。 */
const CHECK_MS = 15_000;
const MAX_PROMPT_CHARS = 2000;

export interface AgendaWorldOptions {
  /** `worlds.agenda` 的活引用。 */
  cfg: AgendaConfigSection;
  /** 契约内的配置写回(ctx.persist):备份+换名,活对象与 config.json 同步。 */
  persist: (patch: { entries: AgendaEntry[] }) => void;
  timezone: string;
  botName: string;
  /** 可注入时钟;测试钉死时刻用,默认真实时间。 */
  now?: () => Date;
}

const parsedCache = new Map<string, ParsedCron | Error>();

function parsedOf(expr: string): ParsedCron | Error {
  let p = parsedCache.get(expr);
  if (p === undefined) {
    try {
      p = parseCron(expr);
    } catch (err) {
      p = err instanceof Error ? err : new Error(String(err));
    }
    parsedCache.set(expr, p);
  }
  return p;
}

export class AgendaWorld implements World {
  readonly id = 'agenda';

  private host: WorldHost | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** 上次处理过的分钟桶;错过不补靠它:桶与当前不同时只看「当前这一分钟」。 */
  private lastBucket = -1;
  private checking = false;

  constructor(private readonly opts: AgendaWorldOptions) {}

  private entries(): AgendaEntry[] {
    return this.opts.cfg.entries ?? [];
  }

  /** 条目变动唯一出口:先更新活引用再走契约写回。 */
  private commit(next: AgendaEntry[]): void {
    this.opts.cfg.entries = next;
    this.opts.persist({ entries: next });
  }

  /** 只报值;前缀文本一律来自 ENV_PROMPT.md 模板。 */
  envPromptVars(): Record<string, string> {
    const all = this.entries();
    const off = all.filter((e) => !e.enabled).length;
    return {
      'agenda.summary': all.length === 0 ? '是空的' : `共 ${all.length} 条${off > 0 ? `(${off} 条停用)` : ''}`,
      'agenda.maxEntries': String(this.opts.cfg.maxEntries),
    };
  }

  tools(): ToolDef[] {
    return [this.listTool(), this.addTool(), this.editTool(), this.removeTool()];
  }

  console(): WorldConsoleDecl {
    return {
      config: [AGENDA_CONFIG_GROUP],
      promptDocs: [
        {
          key: 'worlds.agenda.envPrompt',
          title: 'Agenda · 环境提示词',
          description: 'Agenda World 进 system 前缀的那一段。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          vars: [
            { name: 'agenda.summary', description: '日程表现状一句话。' },
            { name: 'agenda.maxEntries', description: '条目上限,此刻的值。' },
          ],
        },
      ],
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    await host.pushEvent({
      type: 'agenda.started',
      ts: nowIso(this.opts.timezone),
      source: this.id,
      origin: 'internal',
      senderKey: this.id,
      text: `日程表已挂载:共 ${this.entries().length} 条,agenda_list / agenda_add / agenda_edit / agenda_remove 可用。`,
    });
    // 启动那一刻就是「当前分钟」:进程关着时到点的拍子天然不会补投。
    this.lastBucket = this.bucket(this.opts.now?.() ?? new Date());
    this.timer = setInterval(() => void this.tick(), CHECK_MS);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.host = null;
  }

  /** 调度循环的一次对表;公开是为让测试注入时钟直接驱动。 */
  async tick(): Promise<void> {
    if (!this.host || this.checking) return;
    const now = this.opts.now?.() ?? new Date();
    const bucket = this.bucket(now);
    if (bucket === this.lastBucket) return;
    this.lastBucket = bucket;
    this.checking = true;
    try {
      const due = this.entries().filter((e) => e.enabled && this.isDue(e, now));
      if (due.length === 0) return;
      let cronTouched = false;
      for (const e of due) {
        try {
          await this.host!.pushEvent(this.dueEvent(e), { trigger: 'flush' });
        } catch (err) {
          this.host!.log.warn(`agenda.due 投递失败(${e.id}):${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
        if (e.kind === 'once') {
          this.commit(this.entries().filter((x) => x.id !== e.id));
        } else {
          e.lastFiredAt = nowIso(this.opts.timezone, now);
          cronTouched = true;
        }
      }
      // cron 条目只记 lastFiredAt:同一次提交收账,不逐条写盘。
      if (cronTouched) this.commit([...this.entries()]);
    } finally {
      this.checking = false;
    }
  }

  private bucket(d: Date): number {
    return Math.floor(d.getTime() / 60_000);
  }

  private isDue(e: AgendaEntry, now: Date): boolean {
    if (e.kind === 'once') {
      return e.at !== undefined && e.at === formatAt(now);
    }
    if (e.cron === undefined) return false;
    const p = parsedOf(e.cron);
    return !(p instanceof Error) && cronMatches(p, now);
  }

  private dueEvent(e: AgendaEntry): Parameters<WorldHost['pushEvent']>[0] {
    const who = e.owner === 'deployer' ? '开发者' : this.opts.botName;
    return {
      type: 'agenda.due',
      ts: nowIso(this.opts.timezone),
      source: this.id,
      origin: 'internal',
      senderKey: this.id,
      text: `${e.prompt}\n—— 条目 ${e.id} · ${scheduleDesc(e)} · 由 ${who} 添加`,
    };
  }

  private scheduleText(e: AgendaEntry): string {
    if (e.kind === 'once') return `一次性 ${e.at ?? '?'}`;
    const p = parsedOf(e.cron ?? '');
    return p instanceof Error ? `节律看不懂(${(p as Error).message})` : `节律 ${p.normalized}`;
  }

  private nextText(e: AgendaEntry): string {
    if (e.kind === 'once') {
      if (!e.at) return '';
      const at = parseAtQuiet(e.at);
      if (!at) return '';
      return at.getTime() <= (this.opts.now?.() ?? new Date()).getTime() ? '已过期' : `将于 ${e.at}`;
    }
    const p = parsedOf(e.cron ?? '');
    if (p instanceof Error) return '';
    const next = nextFire(p, this.opts.now?.() ?? new Date());
    return next ? `下次 ${formatAt(next)}` : '没有下次(表达式在可见的未来永不命中)';
  }

  private find(id: string): AgendaEntry | undefined {
    return this.entries().find((e) => e.id === id);
  }

  private listTool(): ToolDef {
    return {
      name: 'agenda_list',
      description:
        'List every entry in the shared schedule: id, schedule, prompt, who asked for it, enabled flag, ' +
        'and next fire time (cron) or expiry note (one-shot). An empty table returns usage hints.',
      tags: ['read'],
      parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
      handler: async () => this.renderList(),
    };
  }

  private renderList(): string {
    const all = this.entries();
    if (all.length === 0) {
      return '日程表是空的。用 agenda_add 加条目:prompt 必填,cron(如 30 21 * * *)与 at(如 2026-09-19T21:30)二选一。';
    }
    const lines = all.map((e, i) => {
      const state = e.enabled ? '启用' : '停用';
      const who = e.owner === 'deployer' ? '开发者' : this.opts.botName;
      return `${i + 1}. ${e.id} [${state}] ${this.scheduleText(e)} · ${this.nextText(e)} · 由 ${who} 添加\n   「${e.prompt}」`;
    });
    const cap = this.opts.cfg.maxEntries;
    return `共 ${all.length} 条(上限 ${cap}):\n${lines.join('\n')}`;
  }

  private addTool(): ToolDef {
    return {
      name: 'agenda_add',
      description:
        'Add a schedule entry. Supply exactly one of "cron" (5-field expr: minute hour day-of-month month day-of-week, ' +
        'e.g. "30 21 * * *" = daily 21:30) or "at" ("YYYY-MM-DDTHH:mm" local time; fires once, then the entry is removed). ' +
        '"prompt" is the verbatim instruction delivered to you when it fires — make it self-contained. ' +
        'Set requestedBy to "deployer" when the developer asked for this entry (default "agent").',
      tags: ['write'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          prompt: { type: 'string', description: 'Verbatim instruction delivered at fire time (max 2000 chars).' },
          cron: { type: 'string', description: '5-field cron expr, mutually exclusive with at.' },
          at: { type: 'string', description: 'One-shot local time YYYY-MM-DDTHH:mm, mutually exclusive with cron.' },
          requestedBy: { type: 'string', enum: ['deployer', 'agent'], description: 'Who asked for this entry.' },
        },
        required: ['prompt'],
      },
      handler: async (args) => this.addEntry(args),
    };
  }

  private addEntry(args: Record<string, unknown>): string {
    const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
    if (prompt.length === 0) return '未添加:prompt 不能为空。';
    if (prompt.length > MAX_PROMPT_CHARS) return `未添加:prompt 超过 ${MAX_PROMPT_CHARS} 字符(现在 ${prompt.length})。`;
    const all = this.entries();
    if (all.length >= this.opts.cfg.maxEntries) {
      return `未添加:日程表已满(${all.length}/${this.opts.cfg.maxEntries})。先删掉不用的条目,或让开发者调大 worlds.agenda.maxEntries。`;
    }
    const hasCron = typeof args.cron === 'string' && args.cron.trim() !== '';
    const hasAt = typeof args.at === 'string' && args.at.trim() !== '';
    if (hasCron === hasAt) {
      return '未添加:cron 与 at 必须二选一——周期性的写 cron(如 30 21 * * *),一次性的写 at(如 2026-09-19T21:30)。';
    }
    let entry: AgendaEntry;
    if (hasCron) {
      const expr = String(args.cron).trim();
      try {
        const p = parseCron(expr);
        entry = { kind: 'cron', cron: p.normalized, ...base(prompt, args) };
      } catch (err) {
        return `未添加:${err instanceof Error ? err.message : String(err)}`;
      }
    } else {
      try {
        const at = parseAt(String(args.at));
        if (at.getTime() <= (this.opts.now?.() ?? new Date()).getTime()) {
          return '未添加:at 是过去的时间——错过不补,要一次性提醒就给未来的时刻。';
        }
        entry = { kind: 'once', at: formatAt(at), ...base(prompt, args) };
      } catch (err) {
        return `未添加:${err instanceof Error ? err.message : String(err)}`;
      }
    }
    this.commit([...all, entry]);
    return `已加:${entry.id} · ${this.scheduleText(entry)} · ${this.nextText(entry)} · 「${prompt}」`;
  }

  private editTool(): ToolDef {
    return {
      name: 'agenda_edit',
      description:
        'Edit an entry by id: change its prompt, reschedule it (supply exactly one of cron or at; that switches its kind), ' +
        'or toggle enabled. Any entry can be edited, including ones the deployer added.',
      tags: ['write'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: 'Entry id from agenda_list, e.g. ag-3f9c2a.' },
          prompt: { type: 'string', description: 'New verbatim instruction (max 2000 chars).' },
          cron: { type: 'string', description: 'New 5-field cron expr; mutually exclusive with at.' },
          at: { type: 'string', description: 'New one-shot local time; mutually exclusive with cron.' },
          enabled: { type: 'boolean', description: 'Enable or disable without deleting.' },
        },
        required: ['id'],
      },
      handler: async (args) => this.editEntry(args),
    };
  }

  private editEntry(args: Record<string, unknown>): string {
    const id = typeof args.id === 'string' ? args.id.trim() : '';
    const e = this.find(id);
    if (!e) return `没有 ${id || '(空 id)'} 这条;用 agenda_list 看现有条目。`;
    const hasCron = typeof args.cron === 'string' && args.cron.trim() !== '';
    const hasAt = typeof args.at === 'string' && args.at.trim() !== '';
    if (hasCron && hasAt) return '未改:cron 与 at 只能给一个。';
    const next: AgendaEntry = { ...e };
    if (typeof args.prompt === 'string') {
      const prompt = args.prompt.trim();
      if (prompt.length === 0) return '未改:prompt 不能为空。';
      if (prompt.length > MAX_PROMPT_CHARS) return `未改:prompt 超过 ${MAX_PROMPT_CHARS} 字符。`;
      next.prompt = prompt;
    }
    if (hasCron) {
      try {
        const p = parseCron(String(args.cron).trim());
        next.kind = 'cron';
        next.cron = p.normalized;
        delete next.at;
      } catch (err) {
        return `未改:${err instanceof Error ? err.message : String(err)}`;
      }
    } else if (hasAt) {
      try {
        const at = parseAt(String(args.at).trim());
        if (at.getTime() <= (this.opts.now?.() ?? new Date()).getTime()) {
          return '未改:at 是过去的时间——错过不补,要一次性提醒就给未来的时刻。';
        }
        next.kind = 'once';
        next.at = formatAt(at);
        delete next.cron;
      } catch (err) {
        return `未改:${err instanceof Error ? err.message : String(err)}`;
      }
    }
    if (typeof args.enabled === 'boolean') next.enabled = args.enabled;
    this.commit(this.entries().map((x) => (x.id === id ? next : x)));
    return `已改:${next.id} · ${this.scheduleText(next)} · ${this.nextText(next)} · 「${next.prompt}」`;
  }

  private removeTool(): ToolDef {
    return {
      name: 'agenda_remove',
      description:
        'Remove an entry by id. Any entry can be removed, including ones the deployer added. ' +
        'One-shot entries are removed automatically after firing.',
      tags: ['write'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: 'Entry id from agenda_list, e.g. ag-3f9c2a.' },
        },
        required: ['id'],
      },
      handler: async (args) => {
        const id = typeof args.id === 'string' ? args.id.trim() : '';
        const e = this.find(id);
        if (!e) return `没有 ${id || '(空 id)'} 这条;用 agenda_list 看现有条目。`;
        this.commit(this.entries().filter((x) => x.id !== id));
        return `已删:${e.id} · 「${e.prompt}」`;
      },
    };
  }
}

function base(prompt: string, args: Record<string, unknown>): Pick<AgendaEntry, 'id' | 'prompt' | 'owner' | 'enabled' | 'createdAt'> {
  return {
    id: `ag-${randomBytes(3).toString('hex')}`,
    prompt,
    owner: args.requestedBy === 'deployer' ? 'deployer' : 'agent',
    enabled: true,
    createdAt: new Date().toISOString(),
  };
}

function scheduleDesc(e: AgendaEntry): string {
  if (e.kind === 'once') return `一次性 ${e.at ?? '?'}`;
  const p = parsedOf(e.cron ?? '');
  return p instanceof Error ? `节律 ${e.cron}(看不懂)` : `节律 ${p.normalized}`;
}

function parseAtQuiet(raw: string): Date | null {
  try {
    return parseAt(raw);
  } catch {
    return null;
  }
}
