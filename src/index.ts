/** 包入口:默认导出 `WorldDefinition`,加载器按 `cortico.kind === 'world'` 认它。 */
import { AGENDA } from './definition.ts';

export default AGENDA;
export { AGENDA };
export { AGENDA_CONFIG_GROUP, DEFAULT_MAX_NOTES } from './config.ts';
export type { AgendaConfigSection, AgendaEntry, NoteEntry } from './config.ts';
