/** Agenda World:一张共用的日程表,到点投 agenda.due 当场叫醒她;增删改查走四个工具与控制台面板。 */
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

/** 增/改的核心结果:error 是给人看的一句话,工具加「未添加/未改」前缀,面板原样显示。 */
type CoreOk<E> = { ok: true; entry: E };
type CoreErr = { ok: false; notFound?: boolean; error: string };

/** 面板 list 的一行:条目本体加上算好的展示字段,前端不做 cron 计算。 */
interface EntryView {
  id: string;
  kind: 'cron' | 'once';
  cron?: string;
  at?: string;
  prompt: string;
  owner: 'deployer' | 'agent';
  ownerLabel: string;
  enabled: boolean;
  createdAt: string;
  lastFiredAt?: string;
  schedule: string;
  next: string;
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
      panels: [
        {
          id: 'entries',
          title: '日程条目',
          description: '一张共用的日程表:表格化增删改,表单生成 cron;在这里加的条目记在开发者名下。',
        },
      ],
      invoke: (panel, method, args) => this.invokePanel(panel, method, args),
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

  // ---------------------------------------------------------------------------
  // 增删改查核心:工具与控制台面板共用的唯一实现,规则只此一份。
  // ---------------------------------------------------------------------------

  private addCore(input: {
    prompt: string;
    cron?: string;
    at?: string;
    owner: AgendaEntry['owner'];
  }): CoreOk<AgendaEntry> | CoreErr {
    const prompt = input.prompt.trim();
    if (prompt.length === 0) return { ok: false, error: 'prompt 不能为空。' };
    if (prompt.length > MAX_PROMPT_CHARS) {
      return { ok: false, error: `prompt 超过 ${MAX_PROMPT_CHARS} 字符(现在 ${prompt.length})。` };
    }
    const all = this.entries();
    if (all.length >= this.opts.cfg.maxEntries) {
      return {
        ok: false,
        error: `日程表已满(${all.length}/${this.opts.cfg.maxEntries})。先删掉不用的条目,或让开发者调大 worlds.agenda.maxEntries。`,
      };
    }
    const hasCron = input.cron !== undefined && input.cron !== '';
    const hasAt = input.at !== undefined && input.at !== '';
    if (hasCron === hasAt) {
      return {
        ok: false,
        error: 'cron 与 at 必须二选一——周期性的写 cron(如 30 21 * * *),一次性的写 at(如 2026-09-19T21:30)。',
      };
    }
    const common = {
      id: `ag-${randomBytes(3).toString('hex')}`,
      prompt,
      owner: input.owner,
      enabled: true,
      createdAt: new Date().toISOString(),
    };
    if (hasCron) {
      try {
        const p = parseCron(input.cron!.trim());
        const entry: AgendaEntry = { kind: 'cron', cron: p.normalized, ...common };
        this.commit([...all, entry]);
        return { ok: true, entry };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
    try {
      const at = parseAt(input.at!.trim());
      if (at.getTime() <= (this.opts.now?.() ?? new Date()).getTime()) {
        return { ok: false, error: 'at 是过去的时间——错过不补,要一次性提醒就给未来的时刻。' };
      }
      const entry: AgendaEntry = { kind: 'once', at: formatAt(at), ...common };
      this.commit([...all, entry]);
      return { ok: true, entry };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private editCore(
    id: string,
    patch: { prompt?: string; cron?: string; at?: string; enabled?: boolean },
  ): CoreOk<AgendaEntry> | CoreErr {
    const e = this.entries().find((x) => x.id === id);
    if (!e) return { ok: false, notFound: true, error: `没有 ${id || '(空 id)'} 这条;用 agenda_list 看现有条目。` };
    const hasCron = patch.cron !== undefined && patch.cron !== '';
    const hasAt = patch.at !== undefined && patch.at !== '';
    if (hasCron && hasAt) return { ok: false, error: 'cron 与 at 只能给一个。' };
    const next: AgendaEntry = { ...e };
    if (patch.prompt !== undefined) {
      const prompt = patch.prompt.trim();
      if (prompt.length === 0) return { ok: false, error: 'prompt 不能为空。' };
      if (prompt.length > MAX_PROMPT_CHARS) {
        return { ok: false, error: `prompt 超过 ${MAX_PROMPT_CHARS} 字符(现在 ${prompt.length})。` };
      }
      next.prompt = prompt;
    }
    if (hasCron) {
      try {
        const p = parseCron(patch.cron!.trim());
        next.kind = 'cron';
        next.cron = p.normalized;
        delete next.at;
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    } else if (hasAt) {
      try {
        const at = parseAt(patch.at!.trim());
        if (at.getTime() <= (this.opts.now?.() ?? new Date()).getTime()) {
          return { ok: false, error: 'at 是过去的时间——错过不补,要一次性提醒就给未来的时刻。' };
        }
        next.kind = 'once';
        next.at = formatAt(at);
        delete next.cron;
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
    if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
    this.commit(this.entries().map((x) => (x.id === id ? next : x)));
    return { ok: true, entry: next };
  }

  private removeCore(id: string): { ok: true; removed: AgendaEntry } | CoreErr {
    const e = this.entries().find((x) => x.id === id);
    if (!e) return { ok: false, notFound: true, error: `没有 ${id || '(空 id)'} 这条;用 agenda_list 看现有条目。` };
    this.commit(this.entries().filter((x) => x.id !== id));
    return { ok: true, removed: e };
  }

  private entryView(e: AgendaEntry): EntryView {
    const now = this.opts.now?.() ?? new Date();
    let expired = false;
    if (e.kind === 'once' && e.at) {
      const at = parseAtQuiet(e.at);
      expired = at !== null && at.getTime() <= now.getTime();
    }
    return {
      id: e.id,
      kind: e.kind,
      cron: e.cron,
      at: e.at,
      prompt: e.prompt,
      owner: e.owner,
      ownerLabel: e.owner === 'deployer' ? '开发者' : this.opts.botName,
      enabled: e.enabled,
      createdAt: e.createdAt,
      lastFiredAt: e.lastFiredAt,
      schedule: this.scheduleText(e),
      next: expired ? '已过期(错过不投)' : this.nextText(e),
    };
  }

  /** 面板调用按 (panel, method, args) 透传;args 取第一个元素当 JSON 载荷。 */
  private async invokePanel(panel: string, method: string, args: unknown[]): Promise<unknown> {
    if (panel !== 'entries') throw new Error(`未知面板: ${panel}`);
    const payload = (args[0] ?? {}) as Record<string, unknown>;
    const str = (v: unknown): string => (typeof v === 'string' ? v : '');
    const optStr = (v: unknown): string | undefined =>
      typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
    switch (method) {
      case 'list':
        return { entries: this.entries().map((e) => this.entryView(e)) };
      case 'add': {
        const res = this.addCore({
          prompt: str(payload.prompt),
          cron: optStr(payload.cron),
          at: optStr(payload.at),
          owner: 'deployer',
        });
        return res.ok ? { ok: true, message: `已加 ${res.entry.id}`, entry: this.entryView(res.entry) } : { ok: false, error: res.error };
      }
      case 'edit': {
        const res = this.editCore(str(payload.id), {
          prompt: payload.prompt === undefined ? undefined : str(payload.prompt),
          cron: optStr(payload.cron),
          at: optStr(payload.at),
          enabled: typeof payload.enabled === 'boolean' ? payload.enabled : undefined,
        });
        return res.ok
          ? { ok: true, message: `已改 ${res.entry.id}`, entry: this.entryView(res.entry) }
          : { ok: false, notFound: res.notFound, error: res.error };
      }
      case 'remove': {
        const res = this.removeCore(str(payload.id));
        return res.ok ? { ok: true, message: `已删 ${res.removed.id}` } : { ok: false, error: res.error };
      }
      default:
        throw new Error(`未知方法: ${method}`);
    }
  }

  // ---------------------------------------------------------------------------
  // 展示
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // 工具:核心结果的模型话术包装
  // ---------------------------------------------------------------------------

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
      handler: async (args) => {
        const res = this.addCore({
          prompt: typeof args.prompt === 'string' ? args.prompt : '',
          cron: typeof args.cron === 'string' && args.cron.trim() !== '' ? args.cron.trim() : undefined,
          at: typeof args.at === 'string' && args.at.trim() !== '' ? args.at.trim() : undefined,
          owner: args.requestedBy === 'deployer' ? 'deployer' : 'agent',
        });
        if (!res.ok) return `未添加:${res.error}`;
        return `已加:${res.entry.id} · ${this.scheduleText(res.entry)} · ${this.nextText(res.entry)} · 「${res.entry.prompt}」`;
      },
    };
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
      handler: async (args) => {
        const res = this.editCore(typeof args.id === 'string' ? args.id.trim() : '', {
          prompt: typeof args.prompt === 'string' ? args.prompt : undefined,
          cron: typeof args.cron === 'string' && args.cron.trim() !== '' ? args.cron.trim() : undefined,
          at: typeof args.at === 'string' && args.at.trim() !== '' ? args.at.trim() : undefined,
          enabled: typeof args.enabled === 'boolean' ? args.enabled : undefined,
        });
        if (!res.ok) return res.notFound ? res.error : `未改:${res.error}`;
        return `已改:${res.entry.id} · ${this.scheduleText(res.entry)} · ${this.nextText(res.entry)} · 「${res.entry.prompt}」`;
      },
    };
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
        const res = this.removeCore(typeof args.id === 'string' ? args.id.trim() : '');
        if (!res.ok) return res.error;
        return `已删:${res.removed.id} · 「${res.removed.prompt}」`;
      },
    };
  }
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
