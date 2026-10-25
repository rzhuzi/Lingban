import { createDefaultData, createId } from '../../features/companion/defaults';
import { normalizeCompanion } from '../../features/companion/normalize';
import type { CompanionData } from '../../features/companion/types';

import type { KeyValueStorage } from './sql';
import { legacyModeDisabled, THINKING_MIGRATION_NOTICE } from './thinking-migration';

export const LEGACY_STORAGE_KEY = '@lingban/companion/v1';
export const LEGACY_IMPORT_MARKER = '_legacy_companion_import_v1';
export const RECOVERY_NOTICE = '部分本地配置格式异常，已恢复可用内容并保留原始备份。';

export async function readLegacyCompanion(storage: KeyValueStorage): Promise<{
  data: CompanionData; notice: string | null; source: 'legacy' | 'defaults';
  migrationNotice?: typeof THINKING_MIGRATION_NOTICE | null;
}> {
  const raw = await storage.getItem(LEGACY_STORAGE_KEY);
  if (raw === null) return { data: createDefaultData(), notice: null, source: 'defaults' };
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  // normalizeCompanion rejects future versions before allowing an import or write.
  const { data, recovered } = normalizeCompanion(parsed);
  if (recovered) {
    await storage.setItem(`${LEGACY_STORAGE_KEY}/recovery/${createId()}`, raw);
  }
  return { data, notice: recovered ? RECOVERY_NOTICE : null, source: 'legacy',
    migrationNotice: legacyModeDisabled(data.thinking.legacyMode) ? THINKING_MIGRATION_NOTICE : null };
}
