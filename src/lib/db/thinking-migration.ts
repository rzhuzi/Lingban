import { createDefaultData } from '../../features/companion/defaults';
import { normalizeCompanion } from '../../features/companion/normalize';
import { legacyModelThinkingConfig } from '../../features/companion/thinking-config';
import type { ThinkingConfig } from '../../features/companion/types';
import type { SqlDatabase } from './sql';

export const THINKING_MIGRATION_NOTICE = { id: 'thinking-v2' as const,
  message: '旧原生参数和正文前缀续写模式已停用。原有文本和历史记录已保留，请重新选择配置方式。' };
export const THINKING_NOTICE_SETTING = '_thinking_v2_notice_pending';
export const legacyModeDisabled = (mode: unknown) => mode === 'native' || mode === 'prefill';

/** Called inside the schema transaction; no model table replacement or message rewrite. */
export function migrateThinkingRows(db: SqlDatabase) {
  const row = db.getFirstSync<{ value: string }>("SELECT value FROM settings WHERE key = 'thinking'");
  const models = db.getAllSync<{ id: string; cotMode: string; cotPresetId: string | null }>(
    'SELECT id, cot_mode AS cotMode, cot_preset_id AS cotPresetId FROM models');
  if (!row) {
    if (models.length || db.getFirstSync<{ count: number }>(`SELECT
      (SELECT COUNT(*) FROM settings) + (SELECT COUNT(*) FROM personas) +
      (SELECT COUNT(*) FROM cot_presets) + (SELECT COUNT(*) FROM sessions) +
      (SELECT COUNT(*) FROM messages) AS count`)?.count) throw new Error('本地思维配置缺失，已有内容尚未覆盖。');
    return;
  }
  const oldThinking = JSON.parse(row.value) as ThinkingConfig;
  const templates = db.getAllSync<{ id: string; name: string; description: string; prompt: string; icon: string; enabled: number; kind: string }>(
    'SELECT id, name, description, prefix AS prompt, icon, enabled, kind FROM cot_presets ORDER BY position, rowid')
    .map(({ enabled, ...template }) => ({ ...template, ...(enabled === 0 ? { enabled: false } : {}) }));
  const normalized = normalizeCompanion({ ...createDefaultData(), schemaVersion: 1, thinking: { ...oldThinking, templates } });
  if (normalized.recovered) throw new Error('本地思维配置格式异常，已有内容尚未覆盖。');
  const { templates: ignoredTemplates, ...thinking } = normalized.data.thinking;
  void ignoredTemplates;
  db.runSync('UPDATE settings SET value = ? WHERE key = ?', [JSON.stringify(thinking), 'thinking']);
  for (const model of models) {
    db.runSync('UPDATE models SET thinking_mode = ?, thinking_config = ? WHERE id = ?', [
      model.cotMode === 'persona' ? 'persona' : 'off',
      JSON.stringify(legacyModelThinkingConfig(model.cotMode, model.cotPresetId, normalized.data.thinking)), model.id,
    ]);
  }
  if (legacyModeDisabled(oldThinking.mode) || models.some((model) => legacyModeDisabled(model.cotMode))) {
    db.runSync('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING', [THINKING_NOTICE_SETTING, 'true']);
  }
}
