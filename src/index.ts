/** 包入口:默认导出 `WorldDefinition`,加载器按 `cortico.kind === 'world'` 认它。 */
import { AGENDA } from './definition.ts';

export default AGENDA;
export { AGENDA };
export type { AgendaConfigSection, AgendaEntry } from './config.ts';
