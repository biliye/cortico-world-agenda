import type { ConfigGroup } from 'cortico/core/types.ts';

/** 一条日程:到点投一条 agenda.due,正文以 prompt 原文开头。 */
export interface AgendaEntry {
  /** ag- 加 6 位十六进制。 */
  id: string;
  kind: 'cron' | 'once';
  /** kind=cron:5 字段表达式(分 时 日 月 周)。 */
  cron?: string;
  /** kind=once:本地时间 YYYY-MM-DDTHH:mm,触发后自动删除;过期的错过不投。 */
  at?: string;
  /** 到点投给她的提示词原文;醒来时是孤立的指令,要自包含。 */
  prompt: string;
  /** 谁要的这条:事实标注,不是权限——一个池子,她能改任何条目。 */
  owner: 'deployer' | 'agent';
  enabled: boolean;
  createdAt: string;
  lastFiredAt?: string;
}

/**
 * config.json 的 worlds.agenda 段,默认禁用;bot 或部署可启用。
 *
 * entries 的增删改走 ctx.persist()(契约内的官方写回,备份+换名),控制台配置组
 * 只声明标量旋钮——配置组表单装不下「一列条目」,详情页面板是二期的事。
 */
export interface AgendaConfigSection {
  enabled: boolean;
  entries: AgendaEntry[];
  /** 条目数上限;加满了再 add 会被拒。防失控的机械护栏,不是防她。 */
  maxEntries: number;
}

/** World 配置的 JSON Schema 声明。 */
export const AGENDA_CONFIG_GROUP: ConfigGroup = {
  id: 'world:agenda',
  owner: 'world:agenda',
  schema: {
    type: 'object',
    title: 'Agenda',
    properties: {
      'worlds.agenda.maxEntries': {
        type: 'integer',
        title: '条目上限',
        description: '日程表最多装多少条,加满了 agenda_add 会被拒。默认 100。',
        'x-hot': true,
      },
    },
  },
};
