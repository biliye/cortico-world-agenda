/**
 * Agenda World:两张共用的清单住在一个 World 里——
 *
 * - **日程**(entries):到点投一条 `agenda.due` 当场叫醒她,四个 `agenda_*` 工具 + 「日程条目」面板;
 * - **便签**(notes):两个人都能写的小纸条,每次挂载把整册随 `agenda.noteStarted` 投给她,
 *   四个 `agenda_note_*` 工具 + 「便签」面板。
 *
 * 两条通道各管各的数据与工具,合在一起省掉一张卡、一个开关、一份重复的增删改查与面板机制。
 */
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { ToolDef, World, WorldConsoleDecl, WorldHost } from 'cortico/core/types.ts';
import { nowIso } from 'cortico/core/util.ts';
import {
  AGENDA_CONFIG_GROUP,
  DEFAULT_MAX_NOTES,
  type AgendaConfigSection,
  type AgendaEntry,
  type NoteEntry,
} from './config.ts';
import { formatAt, parseAt, parseCron } from './cron.ts';
import {
  anchorOf,
  cadenceText,
  checkEveryMinutes,
  floorToMinute,
  MIN_INTERVAL_DEFAULT,
  missedSlots,
  nextScheduled,
  scheduleText,
  type MissedSlots,
} from './schedule.ts';

const ENV_PROMPT_FILE = fileURLToPath(new URL('./ENV_PROMPT.md', import.meta.url));

/** 调度循环的检查间隔;条目是分钟级粒度,15 秒内必然查到,不值得多一个旋钮。 */
const CHECK_MS = 15_000;
const MAX_PROMPT_CHARS = 2000;
/** 一张纸条的字数上限;常数不进配置,没有第二个理由要它可调。 */
const MAX_NOTE_CHARS = 2000;
/** 晚到一分钟以上才算「补投」:正常到点是这一分钟内对表时投出,只有错过一拍才会迟到这么久。 */
const CATCHUP_MS = 60_000;
/** 便签这一路的 senderKey:同一个 World 里的第二条通道,用文档给的 `<id>.<lane>` 形状。 */
const NOTE_LANE = 'agenda.note';

export interface AgendaWorldOptions {
  /** `worlds.agenda` 的活引用(日程与便签两段都在这里面)。 */
  cfg: AgendaConfigSection;
  /** 契约内的配置写回(ctx.persist):备份+换名,活对象与 config.json 同步。 */
  persist: (patch: { entries: AgendaEntry[] } | { notes: NoteEntry[] }) => void;
  timezone: string;
  botName: string;
  /** 可注入时钟;测试钉死时刻用,默认真实时间。 */
  now?: () => Date;
}

/** 这一次对表要投的一条:条目本体 + 它该响的那一拍 + 错过几拍。 */
interface DueItem {
  entry: AgendaEntry;
  /** 该响的时刻(补投时是过去那一拍)。 */
  scheduled: Date;
  /** 锚点之后、现在之前本该响几拍;1 表示只有这一拍(正常到点)。 */
  missed: MissedSlots;
  /** 晚出一分钟以上:不是刚到点,是补投。 */
  catchUp: boolean;
}

/** 增/改的核心结果:error 是给人看的一句话,工具加「未添加/未改」前缀,面板原样显示。 */
type CoreOk<E> = { ok: true; entry: E };
type CoreErr = { ok: false; notFound?: boolean; error: string };

/** 面板 list 的一行:条目本体加上算好的展示字段,前端不做 cron 计算。 */
interface EntryView {
  id: string;
  kind: 'cron' | 'once' | 'every';
  cron?: string;
  at?: string;
  everyMinutes?: number;
  prompt: string;
  owner: 'deployer' | 'agent';
  ownerLabel: string;
  enabled: boolean;
  createdAt: string;
  lastFiredAt?: string;
  schedule: string;
  next: string;
}

/** 写下一张、改一张的结果:error 是给人看的一句话,工具加前缀,面板原样显示。 */
type NoteAddOk = { ok: true; note: NoteEntry };
type NoteEditOk = { ok: true; note: NoteEntry; changed: boolean };

/** 便签面板 list 的一行:纸条本体加上算好的展示字段,前端不做时间换算。 */
interface NoteView {
  id: string;
  text: string;
  author: NoteEntry['author'];
  authorLabel: string;
  /** MM-DD HH:mm。 */
  writtenAt: string;
  /** 改过的时刻;没改过就是空串。 */
  editedAt: string;
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

  /** 配置被手改坏(不是数组)时当作空册,不让一次坏数据连累挂载。 */
  private notes(): NoteEntry[] {
    const raw: unknown = this.opts.cfg.notes;
    return Array.isArray(raw) ? raw.filter((n): n is NoteEntry => typeof n === 'object' && n !== null) : [];
  }

  /** 条目变动唯一出口:先更新活引用再走契约写回。 */
  private commitEntries(next: AgendaEntry[]): void {
    this.opts.cfg.entries = next;
    this.opts.persist({ entries: next });
  }

  /** 纸条变动唯一出口:先更新活引用再走契约写回。 */
  private commitNotes(next: NoteEntry[]): void {
    this.opts.cfg.notes = next;
    this.opts.persist({ notes: next });
  }

  /** 间隔下限:配置组没给(旧部署)就用缺省。 */
  private minInterval(): number {
    return this.opts.cfg.minIntervalMinutes ?? MIN_INTERVAL_DEFAULT;
  }

  private maxNotes(): number {
    const cap = this.opts.cfg.maxNotes;
    return typeof cap === 'number' && Number.isFinite(cap) && cap > 0 ? cap : DEFAULT_MAX_NOTES;
  }

  /** 「从现在起算」的那一刻:整分。改节律、重新启用、新建条目都落它。 */
  private anchorStamp(now: Date): string {
    return nowIso(this.opts.timezone, floorToMinute(now));
  }

  /** 落库时刻按部署时区写,自带偏移;展示时截断成 MM-DD HH:mm。 */
  private stamp(): string {
    return nowIso(this.opts.timezone, this.opts.now?.() ?? new Date());
  }

  /** 只报值;前缀文本一律来自 ENV_PROMPT.md 模板。 */
  envPromptVars(): Record<string, string> {
    const all = this.entries();
    const off = all.filter((e) => !e.enabled).length;
    return {
      'agenda.summary': all.length === 0 ? '是空的' : `共 ${all.length} 条${off > 0 ? `(${off} 条停用)` : ''}`,
      'agenda.maxEntries': String(this.opts.cfg.maxEntries),
      'agenda.minInterval': String(this.minInterval()),
      'agenda.noteCount': String(this.notes().length),
      'agenda.noteMax': String(this.maxNotes()),
      'agenda.noteMaxChars': String(MAX_NOTE_CHARS),
    };
  }

  tools(): ToolDef[] {
    return [
      this.listTool(),
      this.addTool(),
      this.editTool(),
      this.removeTool(),
      this.noteListTool(),
      this.noteAddTool(),
      this.noteEditTool(),
      this.noteRemoveTool(),
    ];
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
        {
          id: 'notes',
          title: '便签',
          description: '你与她共写的小纸条:这一页看、写、改、删;「现在投给她」把当前的整册立刻投过去。',
        },
      ],
      invoke: (panel, method, args) => this.invokePanel(panel, method, args),
      promptDocs: [
        {
          key: 'worlds.agenda.envPrompt',
          title: 'Agenda · 环境提示词',
          description: 'Agenda World 进 system 前缀的那一段;日程与便签两条通道共用这一份。',
          path: ENV_PROMPT_FILE,
          role: 'envPrompt',
          vars: [
            { name: 'agenda.summary', description: '日程表现状一句话。' },
            { name: 'agenda.maxEntries', description: '条目上限,此刻的值。' },
            { name: 'agenda.minInterval', description: '循环间隔的下限(分钟),此刻的值。' },
            { name: 'agenda.noteCount', description: '便签现在几张,此刻的值。' },
            { name: 'agenda.noteMax', description: '纸条张数上限,此刻的值。' },
            { name: 'agenda.noteMaxChars', description: '单张纸条的字数上限。' },
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
    // 便签那一路的挂载报备:整册正文随它交给她,之后要翻用 agenda_note_list。
    await host.pushEvent(this.noteEvent('agenda.noteStarted', this.bookText('便签册已挂载')));
    // 起来先对一次表:World 停着或进程关着时错过的那几拍,在这一批里补投一次(与挂载报备同一批,
    // 不多开一轮)。之后每分钟一查由 tick 接着对。
    const now = this.opts.now?.() ?? new Date();
    await this.fireDue(now);
    this.lastBucket = this.bucket(now);
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
      await this.fireDue(now);
    } finally {
      this.checking = false;
    }
  }

  private bucket(d: Date): number {
    return Math.floor(d.getTime() / 60_000);
  }

  /**
   * 把此刻该响的投出去;start() 与 tick() 共用,该不该响的规则只此一份。
   * 投递失败的条目不动它的锚点,下一拍接着试。
   */
  private async fireDue(now: Date): Promise<void> {
    const due: DueItem[] = [];
    for (const e of this.entries()) {
      if (!e.enabled) continue;
      const item = this.dueItem(e, now);
      if (item !== null) due.push(item);
    }
    if (due.length === 0) return;
    let touched = false;
    for (const item of due) {
      try {
        await this.host!.pushEvent(this.dueEvent(item), { trigger: 'flush' });
      } catch (err) {
        this.host!.log.warn(`agenda.due 投递失败(${item.entry.id}):${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (item.entry.kind === 'once') {
        this.commitEntries(this.entries().filter((x) => x.id !== item.entry.id));
      } else {
        // 锚点挪到「现在这一分钟」:补投时也绝不能挪回那一拍——挪回去下一拍还在过去,会连炸。
        item.entry.anchorAt = this.anchorStamp(now);
        item.entry.lastFiredAt = nowIso(this.opts.timezone, now);
        touched = true;
      }
    }
    // 周期条目只记锚点:同一次提交收账,不逐条写盘。
    if (touched) this.commitEntries([...this.entries()]);
  }

  /**
   * 这一条此刻该不该响。一次性条目只在正好那一分钟响(过期即跳过,不补);
   * 周期条目看从锚点算的下一拍是否已到——已到就响,晚出一分钟以上算补投。
   */
  private dueItem(e: AgendaEntry, now: Date): DueItem | null {
    if (e.kind === 'once') {
      if (e.at === undefined || e.at !== formatAt(now)) return null;
      return { entry: e, scheduled: floorToMinute(now), missed: { count: 1, capped: false }, catchUp: false };
    }
    const anchor = anchorOf(e);
    if (anchor === null) return null;
    const scheduled = nextScheduled(e, anchor);
    if (scheduled === null || scheduled.getTime() > now.getTime()) return null;
    return {
      entry: e,
      scheduled,
      missed: missedSlots(e, anchor, now),
      catchUp: now.getTime() - scheduled.getTime() >= CATCHUP_MS,
    };
  }

  private dueEvent(item: DueItem): Parameters<WorldHost['pushEvent']>[0] {
    const e = item.entry;
    const who = e.owner === 'deployer' ? '开发者' : this.opts.botName;
    const lines = [e.prompt, `—— 条目 ${e.id} · ${scheduleText(e)} · 由 ${who} 添加`];
    if (item.catchUp) {
      const n = item.missed.capped ? `${item.missed.count} 拍以上` : `${item.missed.count} 拍`;
      lines.push(`—— 补投:原定 ${formatAt(item.scheduled)},错过了 ${n}`);
    }
    return {
      type: 'agenda.due',
      ts: nowIso(this.opts.timezone),
      source: this.id,
      origin: 'internal',
      senderKey: this.id,
      text: lines.join('\n'),
    };
  }

  // ---------------------------------------------------------------------------
  // 日程:增删改查核心。工具与控制台面板共用的唯一实现,规则只此一份。
  // ---------------------------------------------------------------------------

  private addEntryCore(input: {
    prompt: string;
    cron?: string;
    at?: string;
    everyMinutes?: unknown;
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
    const hasEvery = input.everyMinutes !== undefined && input.everyMinutes !== '';
    const forms = [hasCron, hasAt, hasEvery].filter(Boolean).length;
    if (forms !== 1) {
      return {
        ok: false,
        error:
          '节律三选一:everyMinutes(每隔 N 分钟,如 40)、cron(如 30 21 * * *)、at(如 2026-09-19T21:30)。',
      };
    }
    const now = this.opts.now?.() ?? new Date();
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
        const entry: AgendaEntry = { kind: 'cron', cron: p.normalized, anchorAt: this.anchorStamp(now), ...common };
        this.commitEntries([...all, entry]);
        return { ok: true, entry };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
    if (hasEvery) {
      const checked = checkEveryMinutes(input.everyMinutes, this.minInterval());
      if (!checked.ok) return { ok: false, error: checked.error };
      const entry: AgendaEntry = {
        kind: 'every',
        everyMinutes: checked.minutes,
        anchorAt: this.anchorStamp(now),
        ...common,
      };
      this.commitEntries([...all, entry]);
      return { ok: true, entry };
    }
    try {
      const at = parseAt(input.at!.trim());
      if (at.getTime() <= now.getTime()) {
        return { ok: false, error: 'at 是过去的时间——一次性提醒过期不补,要给未来的时刻。' };
      }
      const entry: AgendaEntry = { kind: 'once', at: formatAt(at), ...common };
      this.commitEntries([...all, entry]);
      return { ok: true, entry };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  private editEntryCore(
    id: string,
    patch: { prompt?: string; cron?: string; at?: string; everyMinutes?: unknown; enabled?: boolean },
  ): CoreOk<AgendaEntry> | CoreErr {
    const e = this.entries().find((x) => x.id === id);
    if (!e) return { ok: false, notFound: true, error: `没有 ${id || '(空 id)'} 这条;用 agenda_list 看现有条目。` };
    const hasCron = patch.cron !== undefined && patch.cron !== '';
    const hasAt = patch.at !== undefined && patch.at !== '';
    const hasEvery = patch.everyMinutes !== undefined && patch.everyMinutes !== '';
    if ([hasCron, hasAt, hasEvery].filter(Boolean).length > 1) {
      return { ok: false, error: '节律一次只改一样:everyMinutes、cron、at 三选一。' };
    }
    const now = this.opts.now?.() ?? new Date();
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
        delete next.everyMinutes;
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    } else if (hasEvery) {
      const checked = checkEveryMinutes(patch.everyMinutes, this.minInterval());
      if (!checked.ok) return { ok: false, error: checked.error };
      next.kind = 'every';
      next.everyMinutes = checked.minutes;
      delete next.cron;
      delete next.at;
    } else if (hasAt) {
      try {
        const at = parseAt(patch.at!.trim());
        if (at.getTime() <= now.getTime()) {
          return { ok: false, error: 'at 是过去的时间——一次性提醒过期不补,要给未来的时刻。' };
        }
        next.kind = 'once';
        next.at = formatAt(at);
        delete next.cron;
        delete next.everyMinutes;
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    }
    // 改了节律、或把停用的重新启用,都从现在起算:锚点挪到这一分钟,不回头补那一拍。
    if ((hasCron || hasAt || hasEvery) && next.kind !== 'once') next.anchorAt = this.anchorStamp(now);
    if (typeof patch.enabled === 'boolean') {
      if (patch.enabled && !e.enabled && next.kind !== 'once') next.anchorAt = this.anchorStamp(now);
      next.enabled = patch.enabled;
    }
    this.commitEntries(this.entries().map((x) => (x.id === id ? next : x)));
    return { ok: true, entry: next };
  }

  private removeEntryCore(id: string): { ok: true; removed: AgendaEntry } | CoreErr {
    const e = this.entries().find((x) => x.id === id);
    if (!e) return { ok: false, notFound: true, error: `没有 ${id || '(空 id)'} 这条;用 agenda_list 看现有条目。` };
    this.commitEntries(this.entries().filter((x) => x.id !== id));
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
      everyMinutes: e.everyMinutes,
      prompt: e.prompt,
      owner: e.owner,
      ownerLabel: e.owner === 'deployer' ? '开发者' : this.opts.botName,
      enabled: e.enabled,
      createdAt: e.createdAt,
      lastFiredAt: e.lastFiredAt,
      schedule: scheduleText(e, true),
      next: expired ? '已过期(错过不投)' : this.nextText(e),
    };
  }

  // ---------------------------------------------------------------------------
  // 便签:增删改查核心。同样只此一份,工具、面板与挂载投递共用。
  // ---------------------------------------------------------------------------

  private addNoteCore(text: string, author: NoteEntry['author']): NoteAddOk | CoreErr {
    const body = text.trim();
    const bad = checkText(body);
    if (bad) return { ok: false, error: bad };
    const all = this.notes();
    if (all.length >= this.maxNotes()) {
      return {
        ok: false,
        error: `便签满了(${all.length}/${this.maxNotes()})。先删掉不用的纸条,或让开发者调大 worlds.agenda.maxNotes。`,
      };
    }
    const note: NoteEntry = {
      id: `nt-${randomBytes(3).toString('hex')}`,
      text: body,
      author,
      createdAt: this.stamp(),
    };
    this.commitNotes([...all, note]);
    return { ok: true, note };
  }

  private editNoteCore(id: string, text: string): NoteEditOk | CoreErr {
    const n = this.notes().find((x) => x.id === id);
    if (!n) return { ok: false, notFound: true, error: `没有 ${id || '(空 id)'} 这张;用 agenda_note_list 看现有纸条。` };
    const body = text.trim();
    if (body === n.text) return { ok: true, note: n, changed: false };
    const bad = checkText(body);
    if (bad) return { ok: false, error: bad };
    const next: NoteEntry = { ...n, text: body, updatedAt: this.stamp() };
    this.commitNotes(this.notes().map((x) => (x.id === id ? next : x)));
    return { ok: true, note: next, changed: true };
  }

  private removeNoteCore(id: string): { ok: true; removed: NoteEntry } | CoreErr {
    const n = this.notes().find((x) => x.id === id);
    if (!n) return { ok: false, notFound: true, error: `没有 ${id || '(空 id)'} 这张;用 agenda_note_list 看现有纸条。` };
    this.commitNotes(this.notes().filter((x) => x.id !== id));
    return { ok: true, removed: n };
  }

  private noteView(n: NoteEntry): NoteView {
    return {
      id: String(n.id ?? ''),
      text: String(n.text ?? ''),
      author: n.author === 'deployer' ? 'deployer' : 'agent',
      authorLabel: this.authorLabel(n),
      writtenAt: stampOf(String(n.createdAt ?? '')),
      editedAt: n.updatedAt ? stampOf(String(n.updatedAt)) : '',
    };
  }

  private authorLabel(n: NoteEntry): string {
    return n.author === 'deployer' ? '开发者' : this.opts.botName;
  }

  // ---------------------------------------------------------------------------
  // 展示
  // ---------------------------------------------------------------------------

  /** 下次触发:周期条目按锚点算;已经过点的说明它欠着一拍(起不来就是补投,起来了就是这一拍)。 */
  private nextText(e: AgendaEntry): string {
    const now = this.opts.now?.() ?? new Date();
    if (e.kind === 'once') {
      if (!e.at) return '';
      const at = parseAtQuiet(e.at);
      if (!at) return '';
      return at.getTime() <= now.getTime() ? '已过期' : `将于 ${e.at}`;
    }
    const anchor = anchorOf(e);
    if (anchor === null) return '';
    const next = nextScheduled(e, anchor);
    if (next === null) return '没有下次(表达式在可见的未来永不命中)';
    return next.getTime() <= now.getTime() ? `已到点(原定 ${formatAt(next)})` : `下次 ${formatAt(next)}`;
  }

  /** 增/改之后念给她听的一句话:节律 · 下次 · 循环条目的一天几次 · 提示词。 */
  private summarize(e: AgendaEntry): string {
    const cadence = e.kind === 'every' && e.everyMinutes !== undefined ? ` · ${cadenceText(e.everyMinutes)}` : '';
    return `${scheduleText(e)} · ${this.nextText(e)}${cadence} · 「${e.prompt}」`;
  }

  /** 便签那一通道的事件;senderKey 用 `<id>.<lane>`。 */
  private noteEvent(type: string, text: string): Parameters<WorldHost['pushEvent']>[0] {
    return {
      type,
      ts: nowIso(this.opts.timezone, this.opts.now?.() ?? new Date()),
      source: this.id,
      origin: 'internal',
      senderKey: NOTE_LANE,
      text,
    };
  }

  /** 整册便签的正文:挂载那条与「现在投给她」那条共用,渲染只此一份。 */
  private bookText(head: string): string {
    const all = this.notes();
    if (all.length === 0) {
      return `${head}:便签还是空的。用 agenda_note_add 写下第一张;他在控制台 Agenda 页的「便签」面板里也能写。`;
    }
    const lines = all.map((n, i) => {
      const who = this.authorLabel(n);
      const edited = n.updatedAt ? `,改于 ${stampOf(String(n.updatedAt))}` : '';
      return `${i + 1}. ${n.id} · ${who}写于 ${stampOf(String(n.createdAt ?? ''))}${edited}\n${indent(String(n.text ?? ''))}`;
    });
    return [
      `${head}:共 ${all.length} 张(上限 ${this.maxNotes()})。`,
      ...lines,
      '—— 用 agenda_note_list / agenda_note_add / agenda_note_edit / agenda_note_remove 读写;他在控制台 Agenda 页的「便签」面板里也能看、能改。',
    ].join('\n');
  }

  // ---------------------------------------------------------------------------
  // 工具:核心结果的模型话术包装
  // ---------------------------------------------------------------------------

  private listTool(): ToolDef {
    return {
      name: 'agenda_list',
      description:
        'List every entry in the shared schedule: id, schedule (cron expr, repeat interval, or one-shot time), ' +
        'prompt, who asked for it, enabled flag, and next fire time (or expiry note for a one-shot). ' +
        'An empty table returns usage hints.',
      tags: ['read'],
      parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
      handler: async () => this.renderList(),
    };
  }

  private renderList(): string {
    const all = this.entries();
    if (all.length === 0) {
      return (
        '日程表是空的。用 agenda_add 加条目:prompt 必填,节律三选一——everyMinutes(每隔 N 分钟,如 40)、' +
        'cron(如 30 21 * * *)、at(如 2026-09-19T21:30)。'
      );
    }
    const lines = all.map((e, i) => {
      const state = e.enabled ? '启用' : '停用';
      const who = e.owner === 'deployer' ? '开发者' : this.opts.botName;
      return `${i + 1}. ${e.id} [${state}] ${scheduleText(e)} · ${this.nextText(e)} · 由 ${who} 添加\n   「${e.prompt}」`;
    });
    const cap = this.opts.cfg.maxEntries;
    return `共 ${all.length} 条(上限 ${cap}):\n${lines.join('\n')}`;
  }

  private addTool(): ToolDef {
    return {
      name: 'agenda_add',
      description:
        'Add a schedule entry. Supply exactly one of "everyMinutes" (repeat every N minutes, e.g. 40; counted from ' +
        'the previous fire, not aligned to the clock), "cron" (5-field expr: minute hour day-of-month month day-of-week, ' +
        'e.g. "30 21 * * *" = daily 21:30) or "at" ("YYYY-MM-DDTHH:mm" local time; fires once, then the entry is removed). ' +
        '"prompt" is the verbatim instruction delivered to you when it fires — make it self-contained. ' +
        'Set requestedBy to "deployer" when the developer asked for this entry (default "agent").',
      tags: ['write'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          prompt: { type: 'string', description: 'Verbatim instruction delivered at fire time (max 2000 chars).' },
          everyMinutes: {
            type: 'integer',
            description:
              'Repeat interval in minutes (40 = every 40 minutes, 120 = every 2 hours); a minimum applies. ' +
              'Mutually exclusive with cron and at.',
          },
          cron: { type: 'string', description: '5-field cron expr, mutually exclusive with everyMinutes and at.' },
          at: {
            type: 'string',
            description: 'One-shot local time YYYY-MM-DDTHH:mm, mutually exclusive with everyMinutes and cron.',
          },
          requestedBy: { type: 'string', enum: ['deployer', 'agent'], description: 'Who asked for this entry.' },
        },
        required: ['prompt'],
      },
      handler: async (args) => {
        const res = this.addEntryCore({
          prompt: typeof args.prompt === 'string' ? args.prompt : '',
          cron: typeof args.cron === 'string' && args.cron.trim() !== '' ? args.cron.trim() : undefined,
          at: typeof args.at === 'string' && args.at.trim() !== '' ? args.at.trim() : undefined,
          everyMinutes: args.everyMinutes,
          owner: args.requestedBy === 'deployer' ? 'deployer' : 'agent',
        });
        if (!res.ok) return `未添加:${res.error}`;
        return `已加:${res.entry.id} · ${this.summarize(res.entry)}`;
      },
    };
  }

  private editTool(): ToolDef {
    return {
      name: 'agenda_edit',
      description:
        'Edit an entry by id: change its prompt, reschedule it (supply exactly one of everyMinutes, cron or at; that ' +
        'switches its kind), or toggle enabled. A schedule change — or switching a disabled entry back on — restarts ' +
        'the countdown from now. Any entry can be edited, including ones the deployer added.',
      tags: ['write'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: 'Entry id from agenda_list, e.g. ag-3f9c2a.' },
          prompt: { type: 'string', description: 'New verbatim instruction (max 2000 chars).' },
          everyMinutes: {
            type: 'integer',
            description:
              'New repeat interval in minutes (40 = every 40 minutes); mutually exclusive with cron and at. ' +
              'Use this to change how often a repeating alarm fires.',
          },
          cron: { type: 'string', description: 'New 5-field cron expr; mutually exclusive with everyMinutes and at.' },
          at: { type: 'string', description: 'New one-shot local time; mutually exclusive with everyMinutes and cron.' },
          enabled: { type: 'boolean', description: 'Enable or disable without deleting.' },
        },
        required: ['id'],
      },
      handler: async (args) => {
        const res = this.editEntryCore(typeof args.id === 'string' ? args.id.trim() : '', {
          prompt: typeof args.prompt === 'string' ? args.prompt : undefined,
          cron: typeof args.cron === 'string' && args.cron.trim() !== '' ? args.cron.trim() : undefined,
          at: typeof args.at === 'string' && args.at.trim() !== '' ? args.at.trim() : undefined,
          everyMinutes: args.everyMinutes,
          enabled: typeof args.enabled === 'boolean' ? args.enabled : undefined,
        });
        if (!res.ok) return res.notFound ? res.error : `未改:${res.error}`;
        return `已改:${res.entry.id} · ${this.summarize(res.entry)}`;
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
        const res = this.removeEntryCore(typeof args.id === 'string' ? args.id.trim() : '');
        if (!res.ok) return res.error;
        return `已删:${res.removed.id} · 「${res.removed.prompt}」`;
      },
    };
  }

  private noteListTool(): ToolDef {
    return {
      name: 'agenda_note_list',
      description:
        'List every note on the shared pad: id, full text, who wrote it, when it was written and last edited. ' +
        'An empty pad returns usage hints. The whole pad is also delivered as an agenda.noteStarted event ' +
        'whenever this World starts.',
      tags: ['read'],
      parameters: { type: 'object', additionalProperties: false, properties: {}, required: [] },
      handler: async () => this.renderNoteList(),
    };
  }

  private renderNoteList(): string {
    const all = this.notes();
    if (all.length === 0) {
      return (
        `便签是空的。用 agenda_note_add 写一张:text 是纸条正文(最多 ${MAX_NOTE_CHARS} 字),记在你名下;` +
        '他在控制台 Agenda 页的「便签」面板里写的记在他名下。'
      );
    }
    const lines = all.map((n, i) => {
      const edited = n.updatedAt ? `,改于 ${stampOf(String(n.updatedAt))}` : '';
      return `${i + 1}. ${n.id} · ${this.authorLabel(n)}写于 ${stampOf(String(n.createdAt ?? ''))}${edited}\n${indent(String(n.text ?? ''))}`;
    });
    return `共 ${all.length} 张(上限 ${this.maxNotes()}):\n${lines.join('\n')}`;
  }

  private noteAddTool(): ToolDef {
    return {
      name: 'agenda_note_add',
      description:
        `Write a new note on the shared pad. "text" is the note body, kept verbatim (max ${MAX_NOTE_CHARS} ` +
        'chars); it is labelled with your name. The developer writes on the same pad from the console, and his ' +
        'notes are labelled with his.',
      tags: ['write'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', description: `Note body (max ${MAX_NOTE_CHARS} chars).` },
        },
        required: ['text'],
      },
      handler: async (args) => {
        const res = this.addNoteCore(typeof args.text === 'string' ? args.text : '', 'agent');
        if (!res.ok) return `未写下:${res.error}`;
        return `已写下:${res.note.id} · 「${res.note.text}」`;
      },
    };
  }

  private noteEditTool(): ToolDef {
    return {
      name: 'agenda_note_edit',
      description:
        'Rewrite the text of one note by id. Any note can be edited, including ones the developer wrote; the ' +
        'author label stays whoever wrote it first. To drop a note use agenda_note_remove.',
      tags: ['write'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: 'Note id from agenda_note_list, e.g. nt-3f9c2a.' },
          text: { type: 'string', description: `New note body, replacing the old one (max ${MAX_NOTE_CHARS} chars).` },
        },
        required: ['id', 'text'],
      },
      handler: async (args) => {
        const res = this.editNoteCore(
          typeof args.id === 'string' ? args.id.trim() : '',
          typeof args.text === 'string' ? args.text : '',
        );
        if (!res.ok) return res.notFound ? res.error : `未改:${res.error}`;
        if (!res.changed) return `没改:${res.note.id} 的正文和原来一样。`;
        return `已改:${res.note.id} · 「${res.note.text}」`;
      },
    };
  }

  private noteRemoveTool(): ToolDef {
    return {
      name: 'agenda_note_remove',
      description:
        'Remove one note by id. Any note can be removed, including ones the developer wrote. Removal is final: ' +
        'the text is gone from the pad.',
      tags: ['write'],
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: 'Note id from agenda_note_list, e.g. nt-3f9c2a.' },
        },
        required: ['id'],
      },
      handler: async (args) => {
        const res = this.removeNoteCore(typeof args.id === 'string' ? args.id.trim() : '');
        if (!res.ok) return res.error;
        return `已删:${res.removed.id} · 「${res.removed.text}」`;
      },
    };
  }

  // ---------------------------------------------------------------------------
  // 面板数据面:两个页签各一套,args 取第一个元素当 JSON 载荷。
  // ---------------------------------------------------------------------------

  private async invokePanel(panel: string, method: string, args: unknown[]): Promise<unknown> {
    if (panel === 'entries') return this.invokeEntries(method, args);
    if (panel === 'notes') return this.invokeNotes(method, args);
    throw new Error(`未知面板: ${panel}`);
  }

  private async invokeEntries(method: string, args: unknown[]): Promise<unknown> {
    const payload = (args[0] ?? {}) as Record<string, unknown>;
    const str = (v: unknown): string => (typeof v === 'string' ? v : '');
    const optStr = (v: unknown): string | undefined =>
      typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
    /** 面板的数字输入:空框当没填,其余原样交给核心校验(与 cron/at 的 optStr 同一套口径)。 */
    const optNum = (v: unknown): string | number | undefined => {
      if (typeof v === 'number') return v;
      return typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;
    };
    switch (method) {
      case 'list':
        return { entries: this.entries().map((e) => this.entryView(e)) };
      case 'add': {
        const res = this.addEntryCore({
          prompt: str(payload.prompt),
          cron: optStr(payload.cron),
          at: optStr(payload.at),
          everyMinutes: optNum(payload.everyMinutes),
          owner: 'deployer',
        });
        return res.ok ? { ok: true, message: `已加 ${res.entry.id}`, entry: this.entryView(res.entry) } : { ok: false, error: res.error };
      }
      case 'edit': {
        const res = this.editEntryCore(str(payload.id), {
          prompt: payload.prompt === undefined ? undefined : str(payload.prompt),
          cron: optStr(payload.cron),
          at: optStr(payload.at),
          everyMinutes: optNum(payload.everyMinutes),
          enabled: typeof payload.enabled === 'boolean' ? payload.enabled : undefined,
        });
        return res.ok
          ? { ok: true, message: `已改 ${res.entry.id}`, entry: this.entryView(res.entry) }
          : { ok: false, notFound: res.notFound, error: res.error };
      }
      case 'remove': {
        const res = this.removeEntryCore(str(payload.id));
        return res.ok ? { ok: true, message: `已删 ${res.removed.id}` } : { ok: false, error: res.error };
      }
      default:
        throw new Error(`未知方法: ${method}`);
    }
  }

  private async invokeNotes(method: string, args: unknown[]): Promise<unknown> {
    const payload = (args[0] ?? {}) as Record<string, unknown>;
    const str = (v: unknown): string => (typeof v === 'string' ? v : '');
    switch (method) {
      case 'list':
        return {
          notes: this.notes().map((n) => this.noteView(n)),
          maxNotes: this.maxNotes(),
          maxChars: MAX_NOTE_CHARS,
          /** World 没在跑就投不了;面板据此把「现在投给她」置灰。 */
          deliverable: this.host !== null,
        };
      case 'add': {
        const res = this.addNoteCore(str(payload.text), 'deployer');
        if (!res.ok) return { ok: false, error: res.error };
        return { ok: true, message: `已写下 ${res.note.id}`, note: this.noteView(res.note) };
      }
      case 'edit': {
        const res = this.editNoteCore(str(payload.id), str(payload.text));
        if (!res.ok) return { ok: false, notFound: res.notFound, error: res.error };
        return {
          ok: true,
          message: res.changed ? `已改 ${res.note.id}` : `${res.note.id} 的正文没变`,
          note: this.noteView(res.note),
        };
      }
      case 'remove': {
        const res = this.removeNoteCore(str(payload.id));
        return res.ok ? { ok: true, message: `已删 ${res.removed.id}` } : { ok: false, error: res.error };
      }
      case 'deliver':
        return this.deliverNotes();
      default:
        throw new Error(`未知方法: ${method}`);
    }
  }

  /** 「现在投给她」:把当前的整册投一条 agenda.noteSent。 */
  private async deliverNotes(): Promise<{ ok: boolean; message?: string; error?: string }> {
    if (this.host === null) return { ok: false, error: '这个 World 没在跑,投不了;先在 World 总览里启用它。' };
    const count = this.notes().length;
    try {
      await this.host.pushEvent(this.noteEvent('agenda.noteSent', this.bookText('开发者从控制台把整册便签投给你')), {
        trigger: 'flush',
      });
    } catch (err) {
      return { ok: false, error: `投递失败:${err instanceof Error ? err.message : String(err)}` };
    }
    return { ok: true, message: count === 0 ? '已投给她(便签是空的)' : `已把 ${count} 张投给她` };
  }
}

function parseAtQuiet(raw: string): Date | null {
  try {
    return parseAt(raw);
  } catch {
    return null;
  }
}

/** 纸条正文的机械校验;返回 null 表示合规。 */
function checkText(body: string): string | null {
  if (body.length === 0) return '纸条不能是空的。';
  if (body.length > MAX_NOTE_CHARS) return `纸条超过 ${MAX_NOTE_CHARS} 字(现在 ${body.length})。`;
  return null;
}

/** 落库时刻(带偏移的 ISO)截成 MM-DD HH:mm;偏移是 nowIso 写下的,不用再按时区换算。 */
function stampOf(iso: string): string {
  return iso.length >= 16 ? `${iso.slice(5, 10)} ${iso.slice(11, 16)}` : iso;
}

/** 纸条正文缩进两格,让它挂在编号下面。 */
function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}
