/**
 * Agenda World 的浏览器扩展 —— 两个面板页签:「日程条目」与「便签」。
 *
 * 与外界的依赖只有一条:`client-panel.ts` 里的**类型**。数据一律走 `ctx.invoke`
 * (增删改查与投递的服务端实现在 world.ts 的 invokePanel),DOM 一律用 `ctx.ui` 的原语,
 * 定时一律走 `ctx.interval`——所以没有任何自定义 CSS,面板跟着控制台的浅深主题走。
 */

import type {
  ConsoleClientBundle,
  ConsolePanelContext,
  ConsoleTable,
} from 'cortico/web/shared/client-panel.ts';

/** 服务端 entryView 的形状。 */
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
  schedule: string;
  next: string;
}

/** 服务端 noteView 的形状。 */
interface NoteView {
  id: string;
  text: string;
  author: 'deployer' | 'agent';
  authorLabel: string;
  /** MM-DD HH:mm。 */
  writtenAt: string;
  /** 改过的时刻;没改过就是空串。 */
  editedAt: string;
}

interface ListResult {
  entries: EntryView[];
}

interface NoteListResult {
  notes: NoteView[];
  maxNotes: number;
  maxChars: number;
  /** World 没在跑就投不了,「现在投给她」据此置灰。 */
  deliverable: boolean;
}

interface MutResult {
  ok: boolean;
  message?: string;
  error?: string;
}

export default {
  panels: {
    entries: { mount: (ctx) => void mountEntries(ctx) },
    notes: { mount: (ctx) => void mountNotes(ctx) },
  },
} satisfies ConsoleClientBundle;

/** 周期表单的四档:每天 / 每周几 / 每隔 N 分钟 / 直接写表达式。表单的职责就是生成节律。 */
type ScheduleMode = 'daily' | 'weekly' | 'every' | 'custom';

const WEEKDAYS: readonly { value: string; label: string }[] = [
  { value: '1', label: '周一' },
  { value: '2', label: '周二' },
  { value: '3', label: '周三' },
  { value: '4', label: '周四' },
  { value: '5', label: '周五' },
  { value: '6', label: '周六' },
  { value: '0', label: '周日' },
];

async function mountEntries(ctx: ConsolePanelContext): Promise<void> {
  const ui = ctx.ui;
  let editingId: string | null = null;
  let kindValue: 'cron' | 'once' = 'cron';
  let modeValue: ScheduleMode = 'daily';

  // --- 条目表 ---

  const sheet = ui.sheet({
    title: '日程条目',
    desc: '到点投一条 agenda.due 叫醒她。在这里加的条目记在开发者名下;她自己也有一条同样的工具路。',
  });
  ctx.root.append(sheet.el);

  const msg = ui.msgline();
  const rowbar = ui.rowbar();
  const table: ConsoleTable = ui.table({
    head: ['状态', '节律', '下次触发', '提示词', '谁要的', '操作'],
    maxHeight: 'calc(100vh - 430px)',
  });
  rowbar.append(
    ui.button('新增条目', {
      variant: 'primary',
      size: 'sm',
      onClick: () => {
        resetForm();
        msgline('', false);
      },
    }),
    ui.button('刷新', { size: 'sm', onClick: () => void refresh() }),
  );
  sheet.body.append(rowbar, msg, table.el);

  // --- 表单卡 ---

  const formSheet = ui.sheet({
    title: '新增 / 编辑条目',
    desc: '周期条目的节律由表单生成;「每隔」填整数分钟,从上次响过那一刻起算。更复杂的节律选「自定义表达式」(分 时 日 月 周,只认 * , - / 和数字)。',
  });
  ctx.root.append(formSheet.el);

  const kindSeg = ui.segmented(
    [
      { value: 'cron', label: '周期' },
      { value: 'once', label: '一次性' },
    ],
    { value: 'cron', onSelect: (v) => { kindValue = v === 'once' ? 'once' : 'cron'; renderKindRows(); } },
  );
  const modeSeg = ui.segmented(
    [
      { value: 'daily', label: '每天' },
      { value: 'weekly', label: '每周' },
      { value: 'every', label: '每隔' },
      { value: 'custom', label: '自定义表达式' },
    ],
    { value: 'daily', onSelect: (v) => { modeValue = v as ScheduleMode; renderModeRows(); } },
  );

  const dailyTime = ui.h('input', 'field') as HTMLInputElement;
  dailyTime.type = 'time';
  dailyTime.value = '21:30';
  const weeklyTime = ui.h('input', 'field') as HTMLInputElement;
  weeklyTime.type = 'time';
  weeklyTime.value = '21:30';
  const dowSel = ui.select({ options: WEEKDAYS });
  const everyInput = ui.input({ placeholder: '40', cls: 'mono' });
  const cronInput = ui.input({ placeholder: '30 21 * * *', cls: 'mono' });
  const atInput = ui.h('input', 'field') as HTMLInputElement;
  atInput.type = 'datetime-local';
  const promptArea = ui.textarea({ rows: 3, placeholder: '到点投给她的提示词;醒来时这一轮只有这句话,要自包含。' });

  const dailyRow = ui.field('每天几点', dailyTime);
  const weeklyRow = ui.h('div', null, null);
  weeklyRow.style.display = 'flex';
  weeklyRow.style.gap = '12px';
  weeklyRow.append(ui.field('每周几', dowSel), ui.field('几点', weeklyTime));
  const everyRow = ui.field('每隔多少分钟', everyInput);
  const cronRow = ui.field('cron 表达式', cronInput);
  const atRow = ui.field('哪天哪点(本地时间)', atInput);

  const saveBtn = ui.button('新增', {
    variant: 'primary',
    size: 'sm',
    onClick: () => void save(),
  });
  const cancelBtn = ui.button('取消编辑', {
    size: 'sm',
    onClick: () => resetForm(),
  });
  const formRow = ui.rowbar();
  formRow.append(saveBtn, cancelBtn);
  formSheet.body.append(kindSeg.el, modeSeg.el, dailyRow, weeklyRow, everyRow, cronRow, atRow, promptArea, formRow);
  cancelBtn.style.display = 'none';

  renderKindRows();
  renderModeRows();
  void refresh();
  ctx.interval(() => void refresh(), 15_000);

  // --- 行为 ---

  function renderKindRows(): void {
    const cron = kindValue === 'cron';
    everyRow.style.display = cron && modeValue === 'every' ? '' : 'none';
    atRow.style.display = cron ? 'none' : '';
    modeSeg.el.style.display = cron ? '' : 'none';
    renderModeRows();
  }

  function renderModeRows(): void {
    const cron = kindValue === 'cron';
    dailyRow.style.display = cron && modeValue === 'daily' ? '' : 'none';
    weeklyRow.style.display = cron && modeValue === 'weekly' ? '' : 'none';
    everyRow.style.display = cron && modeValue === 'every' ? '' : 'none';
    cronRow.style.display = cron && modeValue === 'custom' ? '' : 'none';
  }

  /** 表单 → 服务端载荷;节律由表单档位生成,返回 null 表示前端就能看出填错了。 */
  function buildPayload(): { prompt: string; cron?: string; at?: string; everyMinutes?: number } | null {
    const prompt = promptArea.value.trim();
    if (prompt.length === 0) {
      msgline('提示词不能为空:写下到点要让她干什么。', true);
      return null;
    }
    if (kindValue === 'once') {
      if (atInput.value === '') {
        msgline('选一个未来的日期与时间。', true);
        return null;
      }
      return { prompt, at: atInput.value };
    }
    if (modeValue === 'every') {
      const minutes = Number(everyInput.value.trim());
      if (!Number.isInteger(minutes) || minutes <= 0) {
        msgline('「每隔」填一个整数分钟数,比如 40。', true);
        return null;
      }
      return { prompt, everyMinutes: minutes };
    }
    if (modeValue === 'daily' || modeValue === 'weekly') {
      const raw = (modeValue === 'daily' ? dailyTime : weeklyTime).value;
      const [hh, mi] = raw.split(':').map(Number);
      if (!Number.isInteger(hh) || !Number.isInteger(mi)) {
        msgline('选一个几点几分。', true);
        return null;
      }
      const expr = modeValue === 'daily' ? `${mi} ${hh} * * *` : `${mi} ${hh} * * ${dowSel.value}`;
      return { prompt, cron: expr };
    }
    const expr = cronInput.value.trim();
    if (expr === '') {
      msgline('写一条 cron 表达式,或切回「每天/每周/每隔」让表单生成。', true);
      return null;
    }
    return { prompt, cron: expr };
  }

  async function save(): Promise<void> {
    const payload = buildPayload();
    if (payload === null) return;
    const busy = ui.busy('提交中');
    try {
      const res = editingId
        ? await ctx.invoke<MutResult>('edit', [{ id: editingId, ...payload }])
        : await ctx.invoke<MutResult>('add', [payload]);
      if (!res.ok) {
        msgline(res.error ?? '提交被拒。', true);
        return;
      }
      toast(res.message ?? '已保存');
      resetForm();
      await refresh();
    } catch (err) {
      msgline(errText(err), true);
    } finally {
      busy.dispose();
    }
  }

  async function toggle(e: EntryView): Promise<void> {
    try {
      const res = await ctx.invoke<MutResult>('edit', [{ id: e.id, enabled: !e.enabled }]);
      if (!res.ok) {
        msgline(res.error ?? '提交被拒。', true);
        return;
      }
      toast(res.message ?? '已保存');
      await refresh();
    } catch (err) {
      msgline(errText(err), true);
    }
  }

  async function del(e: EntryView): Promise<void> {
    const ok = await ui.confirm({
      title: `删除 ${e.id}?`,
      body: e.prompt.length > 60 ? `${e.prompt.slice(0, 60)}…` : e.prompt,
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await ctx.invoke<MutResult>('remove', [{ id: e.id }]);
      if (!res.ok) {
        msgline(res.error ?? '提交被拒。', true);
        return;
      }
      if (editingId === e.id) resetForm();
      toast(res.message ?? '已删');
      await refresh();
    } catch (err) {
      msgline(errText(err), true);
    }
  }

  async function refresh(): Promise<void> {
    try {
      const res = await ctx.invoke<ListResult>('list');
      table.clear();
      if (res.entries.length === 0) {
        table.clear('日程表是空的——用下面的表单加一条,或在聊天里让她自己加。');
        return;
      }
      for (const e of res.entries) renderRow(e);
    } catch (err) {
      msgline(errText(err), true);
    }
  }

  function renderRow(e: EntryView): void {
    const ops = ui.h('div', null, null);
    ops.style.display = 'flex';
    ops.style.gap = '6px';
    ops.append(
      ui.button(e.enabled ? '停用' : '启用', { size: 'sm', onClick: () => void toggle(e) }),
      ui.button('编辑', { size: 'sm', onClick: () => fillForm(e) }),
      ui.button('删除', { size: 'sm', variant: 'danger', onClick: () => void del(e) }),
    );
    table.addRow([
      ui.pill(e.enabled ? '启用' : '停用', e.enabled ? 'on' : 'off'),
      { text: e.schedule, cls: 'mono' },
      e.next || '—',
      { text: e.prompt, cls: 'txt' },
      e.ownerLabel,
      ops,
    ]);
  }

  /** 把一条填进表单进入编辑态;cron 尽量反推回「每天/每周」档,推不回就用自定义表达式。 */
  function fillForm(e: EntryView): void {
    editingId = e.id;
    promptArea.value = e.prompt;
    saveBtn.textContent = '保存修改';
    cancelBtn.style.display = '';
    if (e.kind === 'once') {
      kindValue = 'once';
      kindSeg.setValue('once');
      atInput.value = e.at ?? '';
    } else if (e.kind === 'every') {
      kindValue = 'cron';
      kindSeg.setValue('cron');
      modeValue = 'every';
      modeSeg.setValue('every');
      everyInput.value = e.everyMinutes === undefined ? '' : String(e.everyMinutes);
    } else {
      kindValue = 'cron';
      kindSeg.setValue('cron');
      const daily = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(e.cron ?? '');
      const weekly = /^(\d{1,2}) (\d{1,2}) \* \* (\d)$/.exec(e.cron ?? '');
      if (daily) {
        modeValue = 'daily';
        modeSeg.setValue('daily');
        dailyTime.value = `${pad(daily[2])}:${pad(daily[1])}`;
      } else if (weekly) {
        modeValue = 'weekly';
        modeSeg.setValue('weekly');
        dowSel.value = weekly[3] ?? '1';
        weeklyTime.value = `${pad(weekly[2])}:${pad(weekly[1])}`;
      } else {
        modeValue = 'custom';
        modeSeg.setValue('custom');
        cronInput.value = e.cron ?? '';
      }
    }
    renderKindRows();
    renderModeRows();
    msgline(`正在编辑 ${e.id};改完点「保存修改」,或「取消编辑」放弃。`, false);
  }

  function resetForm(): void {
    editingId = null;
    promptArea.value = '';
    cronInput.value = '';
    everyInput.value = '';
    saveBtn.textContent = '新增';
    cancelBtn.style.display = 'none';
    msgline('', false);
  }


  function msgline(text: string, bad: boolean): void {
    msg.textContent = text;
    msg.classList.toggle('bad', bad);
  }

  function toast(text: string): void {
    ui.toast(text, 'ok');
  }
}

async function mountNotes(ctx: ConsolePanelContext): Promise<void> {
  const ui = ctx.ui;
  let editingId: string | null = null;
  let maxChars = 2000;

  // --- 纸条表 ---

  const sheet = ui.sheet({
    title: '便签',
    desc: '你与她共写的小纸条。她在聊天里写、你在这儿写,都是同一册;每次这个 World 启动,整册会自动投给她一次。',
  });
  ctx.root.append(sheet.el);

  const msg = ui.msgline();
  const rowbar = ui.rowbar();
  const table: ConsoleTable = ui.table({
    head: ['谁写的', '正文', '写下', '改过', '操作'],
    maxHeight: 'calc(100vh - 430px)',
  });
  const deliverBtn = ui.button('现在投给她', {
    variant: 'primary',
    size: 'sm',
    onClick: () => void deliver(),
  });
  rowbar.append(
    ui.button('写一张', {
      size: 'sm',
      onClick: () => {
        resetForm();
        editorArea.focus();
      },
    }),
    deliverBtn,
    ui.button('刷新', { size: 'sm', onClick: () => void refresh() }),
  );
  sheet.body.append(rowbar, msg, table.el);

  // --- 写 / 改 ---

  const editor = ui.sheet({
    title: '写一张 / 改一张',
    desc: '在这儿写下的纸条记在你名下;她写的也在同一册里,你能改也能删。',
  });
  ctx.root.append(editor.el);

  const editorArea = ui.textarea({ rows: 5, placeholder: '纸条正文;换行会原样留在上面。' });
  const saveBtn = ui.button('写下', { variant: 'primary', size: 'sm', onClick: () => void save() });
  const cancelBtn = ui.button('取消编辑', { size: 'sm', onClick: () => resetForm() });
  const editorRow = ui.rowbar();
  editorRow.append(saveBtn, cancelBtn);
  editor.body.append(editorArea, editorRow);
  cancelBtn.style.display = 'none';

  void refresh();
  ctx.interval(() => void refresh(), 15_000);

  // --- 行为 ---

  async function save(): Promise<void> {
    const text = editorArea.value.trim();
    if (text.length === 0) {
      msgline('纸条不能是空的。', true);
      return;
    }
    if (text.length > maxChars) {
      msgline(`纸条超过 ${maxChars} 字(现在 ${text.length})。`, true);
      return;
    }
    const busy = ui.busy('提交中');
    try {
      const res = editingId
        ? await ctx.invoke<MutResult>('edit', [{ id: editingId, text }])
        : await ctx.invoke<MutResult>('add', [{ text }]);
      if (!res.ok) {
        msgline(res.error ?? '提交被拒。', true);
        return;
      }
      toast(res.message ?? '已保存');
      resetForm();
      await refresh();
    } catch (err) {
      msgline(errText(err), true);
    } finally {
      busy.dispose();
    }
  }

  async function del(n: NoteView): Promise<void> {
    const ok = await ui.confirm({
      title: `删掉 ${n.id}?`,
      body: n.text.length > 80 ? `${n.text.slice(0, 80)}…` : n.text,
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await ctx.invoke<MutResult>('remove', [{ id: n.id }]);
      if (!res.ok) {
        msgline(res.error ?? '提交被拒。', true);
        return;
      }
      if (editingId === n.id) resetForm();
      toast(res.message ?? '已删');
      await refresh();
    } catch (err) {
      msgline(errText(err), true);
    }
  }

  async function deliver(): Promise<void> {
    try {
      const res = await ctx.invoke<MutResult>('deliver');
      if (!res.ok) {
        msgline(res.error ?? '投递被拒。', true);
        return;
      }
      toast(res.message ?? '已投给她');
    } catch (err) {
      msgline(errText(err), true);
    }
  }

  async function refresh(): Promise<void> {
    try {
      const res = await ctx.invoke<NoteListResult>('list');
      maxChars = res.maxChars;
      table.clear();
      deliverBtn.disabled = !res.deliverable;
      deliverBtn.title = res.deliverable ? '' : '这个 World 没在跑,投不了';
      if (res.notes.length === 0) {
        table.clear('便签还是空的——在上面写第一张,或让她在聊天里写。');
        return;
      }
      for (const n of res.notes) renderRow(n);
    } catch (err) {
      msgline(errText(err), true);
    }
  }

  function renderRow(n: NoteView): void {
    const ops = ui.h('div', null, null);
    ops.style.display = 'flex';
    ops.style.gap = '6px';
    ops.append(
      ui.button('编辑', { size: 'sm', onClick: () => fillForm(n) }),
      ui.button('删除', { size: 'sm', variant: 'danger', onClick: () => void del(n) }),
    );
    table.addRow([
      ui.pill(n.authorLabel, n.author === 'deployer' ? 'plain' : 'on'),
      { text: n.text, cls: 'txt' },
      { text: n.writtenAt, cls: 'mono' },
      { text: n.editedAt || '—', cls: 'mono' },
      ops,
    ]);
  }

  function fillForm(n: NoteView): void {
    editingId = n.id;
    editorArea.value = n.text;
    saveBtn.textContent = '保存修改';
    cancelBtn.style.display = '';
    msgline(`正在改 ${n.id}(${n.authorLabel}写于 ${n.writtenAt});改完点「保存修改」。`, false);
  }

  function resetForm(): void {
    editingId = null;
    editorArea.value = '';
    saveBtn.textContent = '写下';
    cancelBtn.style.display = 'none';
    msgline('', false);
  }

  function msgline(text: string, bad: boolean): void {
    msg.textContent = text;
    msg.classList.toggle('bad', bad);
  }

  function toast(text: string): void {
    ui.toast(text, 'ok');
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function pad(n: string | number | undefined): string {
  return String(n ?? 0).padStart(2, '0');
}
