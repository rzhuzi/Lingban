import type { CompanionData, MemoryItem, ModelThinkingConfig, PromptTemplate, ThinkingConfig } from '../../features/companion/types';
import { isCotAudit } from '../cot/types';
import { assertModelThinkingConfig, assertThinkingTemplateBindings, copyModelThinkingConfig, createModelThinkingConfig, reconcileThinkingTemplates } from '../../features/companion/thinking-config';
import { createRoleConfiguration } from '../../features/companion/role-config';

import { withAuditRecoveryNotice } from './recovery';
import { THINKING_MIGRATION_NOTICE, THINKING_NOTICE_SETTING } from './thinking-migration';
import { assertMessageTransition } from './message-transition';
import type { SqlDatabase, SqlValue } from './sql';
import { assertAppSettings, assertPersonaRecord, DEFAULT_SETTINGS } from './types';
import type { AppSettings, AppSnapshot, MessageRecord, ModelRecord, PersonaRecord, SessionRecord } from './types';

const PERSONA_SETTING = '_companion_persona_id';
const DEFAULT_PERSONA_ID = 'persona-default';
const THINKING_SETTING = 'thinking';

function modelThinkingConfig(raw: string | null): ModelThinkingConfig {
  if (raw === null) throw new Error('模型思维配置缺失，已有内容尚未覆盖。');
  const config: unknown = JSON.parse(raw);
  assertModelThinkingConfig(config);
  return copyModelThinkingConfig(config);
}

export function readSetting<T>(db: SqlDatabase, key: string): T | null {
  const row = db.getFirstSync<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key]);
  return row ? JSON.parse(row.value) as T : null;
}

export function writeSetting(db: SqlDatabase, key: string, value: unknown) {
  db.runSync('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    [key, JSON.stringify(value)]);
}

export function companionPersonaId(db: SqlDatabase) {
  return readSetting<string>(db, PERSONA_SETTING)
    ?? db.getFirstSync<{ id: string }>('SELECT id FROM personas ORDER BY is_active DESC, rowid LIMIT 1')?.id
    ?? DEFAULT_PERSONA_ID;
}

function removeMissing(db: SqlDatabase, table: 'cot_presets' | 'memories', ids: string[], personaId?: string) {
  // Table names are a fixed union; all user values remain bound parameters, including IDs.
  const params: SqlValue[] = personaId === undefined ? [] : [personaId];
  const scope = personaId === undefined ? '' : 'persona_id = ?';
  const excluded = ids.length ? `id NOT IN (${ids.map(() => '?').join(',')})` : '';
  const conditions = [scope, excluded].filter(Boolean);
  db.runSync(`DELETE FROM ${table}${conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''}`,
    [...params, ...ids]);
}

/** Upsert identity and its own memory rows without changing the selected persona. */
export function writePersona(db: SqlDatabase, persona: PersonaRecord) {
  assertPersonaRecord(persona);
  const personaId = persona.id;
  const profile = persona.profile;
  const existing = db.getFirstSync<{ configuration: string | null }>('SELECT role_config AS configuration FROM personas WHERE id = ?', [personaId]);
  const configuration = persona.configuration ?? (existing?.configuration ? JSON.parse(existing.configuration) : initialRoleConfiguration(db));
  db.runSync(`INSERT INTO personas (id, name, content, is_active, cover_uri, avatar_uri, traits, interests, role_config)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, content = excluded.content,
      cover_uri = excluded.cover_uri, avatar_uri = excluded.avatar_uri,
      traits = excluded.traits, interests = excluded.interests, role_config = excluded.role_config`,
  [personaId, profile.name, profile.description, Number(persona.isActive), profile.coverUri, profile.avatarUri,
    JSON.stringify(profile.traits), JSON.stringify(persona.interests), JSON.stringify(configuration)]);

  // Delete only removed memories owned by this persona. Other personas remain untouched.
  removeMissing(db, 'memories', persona.memories.map((item) => item.id), personaId);
  persona.memories.forEach((item, position) => {
    const owner = db.getFirstSync<{ persona_id: string }>('SELECT persona_id FROM memories WHERE id = ?', [item.id]);
    if (owner && owner.persona_id !== personaId) throw new Error('记忆标识与其他人设冲突，已有内容尚未覆盖。');
    db.runSync(`INSERT INTO memories (id, persona_id, content, source, icon, created_at, updated_at, position)
      VALUES (?, ?, ?, 'manual', ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET content = excluded.content, icon = excluded.icon,
        created_at = excluded.created_at, updated_at = excluded.updated_at, position = excluded.position`,
    [item.id, personaId, item.text, item.icon, item.createdAt, item.updatedAt, position]);
  });
}

export function activatePersona(db: SqlDatabase, id: string) {
  if (!db.getFirstSync('SELECT id FROM personas WHERE id = ?', [id])) throw new Error('选择的人设已不存在。');
  db.runSync('UPDATE personas SET is_active = 0 WHERE is_active = 1');
  db.runSync('UPDATE personas SET is_active = 1 WHERE id = ?', [id]);
  writeSetting(db, PERSONA_SETTING, id);
}

/** An explicit owner prevents a queued draft from switching into another persona. */
export function writeCompanion(db: SqlDatabase, data: CompanionData, ownerId?: string) {
  if (data.schemaVersion !== 2 || !['off', 'official', 'instruction', 'persona'].includes(data.thinking.mode)) {
    throw new Error('思维配置版本或模式无效。');
  }
  const personaId = ownerId ?? companionPersonaId(db);
  const existing = db.getFirstSync<{ is_active: number; configuration: string | null }>('SELECT is_active, role_config AS configuration FROM personas WHERE id = ?', [personaId]);
  if (ownerId !== undefined && !existing) throw new Error('保存的人设已不存在，草稿未写入其他人设。');
  writePersona(db, { id: personaId, profile: data.profile, memories: data.memories, interests: data.interests,
    isActive: existing ? Boolean(existing.is_active) : true,
    configuration: existing?.configuration ? JSON.parse(existing.configuration) : createRoleConfiguration({
      contextWindow: readSetting<number>(db, 'context_window') ?? 20,
      streamOutput: readSetting<boolean>(db, 'stream_output') ?? true }, data.thinking.variables) });
  if (!existing) writeSetting(db, PERSONA_SETTING, personaId);

  // Removed presets null live model bindings via FK; historical messages deliberately retain audit IDs.
  removeMissing(db, 'cot_presets', data.thinking.templates.map((item) => item.id));
  data.thinking.templates.forEach((item, position) => {
    db.runSync(`INSERT INTO cot_presets (id, name, prefix, enabled, is_default, description, icon, position, kind)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, prefix = excluded.prefix,
        enabled = excluded.enabled, is_default = excluded.is_default, description = excluded.description,
        icon = excluded.icon, position = excluded.position, kind = excluded.kind`,
    [item.id, item.name, item.prompt, Number(item.enabled !== false), Number(item.id === data.thinking.selectedTemplateId),
      item.description, item.icon, position, item.kind ?? 'persona']);
  });
  for (const model of db.getAllSync<{ id: string; config: string | null }>('SELECT id, thinking_config AS config FROM models')) {
    const config = modelThinkingConfig(model.config);
    const reconciled = reconcileThinkingTemplates(config, data.thinking.templates);
    db.runSync('UPDATE models SET thinking_config = ? WHERE id = ?', [JSON.stringify(reconciled), model.id]);
  }
  const { templates: ignoredTemplates, ...config } = data.thinking;
  void ignoredTemplates;
  writeSetting(db, THINKING_SETTING, config);
  const userName = data.thinking.variables.find((variable) => variable.name === 'user_name');
  if (userName) {
    assertAppSettings({ ...DEFAULT_SETTINGS, userName: userName.value });
    writeSetting(db, 'user_name', userName.value);
  }
}

export function writeAppSettings(db: SqlDatabase, settings: AppSettings) {
  assertAppSettings(settings);
  writeSetting(db, 'theme', settings.theme);
  writeSetting(db, 'user_name', settings.userName);
  writeSetting(db, 'context_window', settings.contextWindow);
  writeSetting(db, 'stream_output', settings.streamOutput);
  const thinking = readSetting<Omit<ThinkingConfig, 'templates'>>(db, THINKING_SETTING);
  if (thinking) {
    writeSetting(db, THINKING_SETTING, {
      ...thinking,
      variables: thinking.variables.map((variable) => variable.name === 'user_name'
        ? { ...variable, value: settings.userName } : variable),
    });
  }
}

export function seedSettings(db: SqlDatabase) {
  writeAppSettings(db, DEFAULT_SETTINGS);
}

function initialRoleConfiguration(db: SqlDatabase) {
  const thinking = readSetting<ThinkingConfig>(db, THINKING_SETTING);
  return createRoleConfiguration({ contextWindow: readSetting<number>(db, 'context_window') ?? 20,
    streamOutput: readSetting<boolean>(db, 'stream_output') ?? true }, thinking?.variables ?? []);
}

export function readPersonas(db: SqlDatabase): PersonaRecord[] {
  return db.getAllSync<{
    id: string; name: string; description: string; coverUri: string | null; avatarUri: string | null;
    traits: string; interests: string; isActive: number; configuration: string | null;
  }>(`SELECT id, name, content AS description, cover_uri AS coverUri, avatar_uri AS avatarUri, traits, interests,
    is_active AS isActive, role_config AS configuration FROM personas ORDER BY rowid`).map((row) => {
    const persona: PersonaRecord = {
      id: row.id, profile: { name: row.name, description: row.description, coverUri: row.coverUri, avatarUri: row.avatarUri,
        traits: JSON.parse(row.traits) }, interests: JSON.parse(row.interests), isActive: Boolean(row.isActive),
      memories: db.getAllSync<MemoryItem>(`SELECT id, content AS text, icon, created_at AS createdAt,
        updated_at AS updatedAt FROM memories WHERE persona_id = ? ORDER BY position, rowid`, [row.id]),
      configuration: row.configuration === null ? initialRoleConfiguration(db) : JSON.parse(row.configuration),
    };
    assertPersonaRecord(persona);
    if (row.configuration === null) db.runSync('UPDATE personas SET role_config = ? WHERE id = ?', [JSON.stringify(persona.configuration), row.id]);
    return persona;
  });
}

function readCompanion(db: SqlDatabase, personas: PersonaRecord[]): CompanionData {
  const personaId = companionPersonaId(db);
  const persona = personas.find((item) => item.id === personaId && item.isActive);
  const thinking = readSetting<Omit<ThinkingConfig, 'templates'>>(db, THINKING_SETTING);
  if (!persona || personas.filter((item) => item.isActive).length !== 1 || !thinking) throw new Error('本地配置不完整，已有数据尚未覆盖。请重试或恢复备份。');
  return {
    schemaVersion: 2,
    profile: persona.profile, interests: persona.interests, memories: persona.memories,
    thinking: { ...thinking, templates: db.getAllSync<Omit<PromptTemplate, 'enabled'> & { enabled: number }>(
      'SELECT id, name, description, prefix AS prompt, icon, enabled, kind FROM cot_presets ORDER BY position, rowid')
      .map(({ enabled, ...template }) => ({ ...template, ...(enabled === 0 ? { enabled: false } : {}) })) },
  };
}

const MODEL_SELECT = `SELECT id, name, provider, base_url AS baseUrl, api_model AS apiModel,
  api_key_alias AS apiKeyAlias, is_default AS isDefault, thinking_mode AS cotMode, thinking_config AS thinkingConfig,
  cot_preset_id AS cotPresetId, created_at AS createdAt, updated_at AS updatedAt FROM models`;
const SESSION_SELECT = `SELECT id, title, model_id AS modelId, persona_id AS personaId,
  pinned, created_at AS createdAt, updated_at AS updatedAt FROM sessions`;
const MESSAGE_SELECT = `SELECT id, session_id AS sessionId, role, content, reasoning, status, error,
  cot_mode AS cotMode, thinking_mode AS thinkingMode, cot_preset_id AS cotPresetId, model_id AS modelId, created_at AS createdAt, cot_audit AS cotAudit FROM messages`;

/** Repository callers own the transaction, including any audit recovery writes. */
export function readMessages(db: SqlDatabase, sessionId?: string): MessageRecord[] {
  let recovered = false;
  const messages = db.getAllSync<Omit<MessageRecord, 'cotAudit'> & { cotAudit: string | null }>(`${MESSAGE_SELECT}${sessionId === undefined ? '' : ' WHERE session_id = ?'} ORDER BY created_at, rowid`,
    sessionId === undefined ? [] : [sessionId]).map(({ cotAudit, ...message }) => {
    if (cotAudit === null) return message;
    let audit: unknown;
    try {
      audit = JSON.parse(cotAudit);
    } catch { /* Only a malformed optional audit is recoverable; database failures below still propagate. */ }
    if (isCotAudit(audit)) return { ...message, cotAudit: audit };
    db.runSync('UPDATE messages SET cot_audit = NULL WHERE id = ?', [message.id]);
    recovered = true;
    return message;
  });
  if (recovered) writeSetting(db, '_recovery_notice', withAuditRecoveryNotice(readSetting<string>(db, '_recovery_notice')));
  return messages;
}

export function readSession(db: SqlDatabase, id: string): SessionRecord | null {
  const row = db.getFirstSync<Omit<SessionRecord, 'pinned'> & { pinned: number }>(`${SESSION_SELECT} WHERE id = ?`, [id]);
  return row ? { ...row, pinned: Boolean(row.pinned) } : null;
}

export function searchSessions(db: SqlDatabase, query: string): SessionRecord[] {
  // Escape LIKE metacharacters so search always treats the user's input literally.
  const pattern = `%${query.trim().replace(/[\\%_]/g, '\\$&')}%`;
  return db.getAllSync<Omit<SessionRecord, 'pinned'> & { pinned: number }>(`${SESSION_SELECT}
    WHERE title LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM messages
      WHERE messages.session_id = sessions.id AND messages.content LIKE ? ESCAPE '\\')
    ORDER BY updated_at DESC, rowid DESC`, [pattern, pattern]).map((row) => ({ ...row, pinned: Boolean(row.pinned) }));
}

export function recoverInterruptedMessages(db: SqlDatabase) {
  db.runSync(`UPDATE messages SET status = 'aborted', error = ?
    WHERE role = 'assistant' AND status IN ('pending', 'streaming')`, ['上次生成已中断，可重试。']);
}

export function readSnapshot(db: SqlDatabase): AppSnapshot {
  const personas = readPersonas(db);
  const settings = {
    theme: readSetting<AppSettings['theme']>(db, 'theme'), userName: readSetting<string>(db, 'user_name'),
    contextWindow: readSetting<number>(db, 'context_window'), streamOutput: readSetting<boolean>(db, 'stream_output'),
  } as AppSettings;
  assertAppSettings(settings);
  return {
    companion: readCompanion(db, personas), personas, settings,
    models: db.getAllSync<Omit<ModelRecord, 'isDefault' | 'thinkingConfig'> & { isDefault: number; thinkingConfig: string | null }>(`${MODEL_SELECT} ORDER BY is_default DESC, created_at, id`)
      .map((model) => {
        const thinkingConfig = modelThinkingConfig(model.thinkingConfig);
        return { ...model, thinkingConfig, isDefault: Boolean(model.isDefault) };
      }),
    sessions: db.getAllSync<Omit<SessionRecord, 'pinned'> & { pinned: number }>(`${SESSION_SELECT} ORDER BY updated_at DESC, rowid DESC`)
      .map((session) => ({ ...session, pinned: Boolean(session.pinned) })),
    messages: readMessages(db),
    notice: readSetting<string>(db, '_recovery_notice'),
    migrationNotice: readSetting(db, THINKING_NOTICE_SETTING) === true ? THINKING_MIGRATION_NOTICE : null,
  };
}

export function writeModel(db: SqlDatabase, item: ModelRecord) {
  if (!['off', 'official', 'instruction', 'persona'].includes(item.cotMode)) throw new Error('思维链模式无效，请重新选择。');
  const existing = db.getFirstSync<{ config: string | null }>('SELECT thinking_config AS config FROM models WHERE id = ?', [item.id]);
  const thinkingConfig: ModelThinkingConfig = item.thinkingConfig ?? (existing ? modelThinkingConfig(existing.config) : createModelThinkingConfig());
  const templates = db.getAllSync<PromptTemplate>('SELECT id, name, description, prefix AS prompt, icon, kind FROM cot_presets');
  assertThinkingTemplateBindings(thinkingConfig, templates);
  const isDefault = item.isDefault || !db.getFirstSync<{ id: string }>(
    'SELECT id FROM models WHERE is_default = 1 AND id <> ? LIMIT 1', [item.id]);
  if (isDefault) db.runSync('UPDATE models SET is_default = 0 WHERE is_default = 1');
  db.runSync(`INSERT INTO models (id, name, provider, base_url, api_model, api_key_alias, is_default,
    cot_mode, cot_preset_id, created_at, updated_at, thinking_mode, thinking_config) VALUES (?, ?, ?, ?, ?, ?, ?, 'off', ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, provider = excluded.provider, base_url = excluded.base_url,
      api_model = excluded.api_model, api_key_alias = excluded.api_key_alias, is_default = excluded.is_default,
      thinking_mode = excluded.thinking_mode, thinking_config = excluded.thinking_config, cot_preset_id = excluded.cot_preset_id,
      created_at = excluded.created_at, updated_at = excluded.updated_at`,
  [item.id, item.name, item.provider, item.baseUrl, item.apiModel, item.apiKeyAlias, Number(isDefault),
    item.cotPresetId, item.createdAt, item.updatedAt, item.cotMode, JSON.stringify(copyModelThinkingConfig(thinkingConfig))]);
}

export function deleteModel(db: SqlDatabase, id: string) {
  const owners = readPersonas(db).filter((persona) => persona.configuration?.currentModelId === id);
  if (owners.length) throw new Error(`此模型正由 ${owners.map((persona) => persona.profile.name).join('、')} 使用，请先为这些角色选择其他模型。`);
  db.runSync('DELETE FROM models WHERE id = ?', [id]);
  if (!db.getFirstSync('SELECT id FROM models WHERE is_default = 1 LIMIT 1')) {
    const successor = db.getFirstSync<{ id: string }>('SELECT id FROM models ORDER BY created_at, id LIMIT 1');
    if (successor) db.runSync('UPDATE models SET is_default = 1 WHERE id = ?', [successor.id]);
  }
}

export function writeSession(db: SqlDatabase, item: SessionRecord) {
  db.runSync(`INSERT INTO sessions (id, title, model_id, persona_id, pinned, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title = excluded.title,
      model_id = excluded.model_id, persona_id = excluded.persona_id, pinned = excluded.pinned,
      created_at = excluded.created_at, updated_at = excluded.updated_at`,
  [item.id, item.title, item.modelId, item.personaId, Number(item.pinned), item.createdAt, item.updatedAt]);
}

export function writeMessage(db: SqlDatabase, item: MessageRecord) {
  if (item.cotAudit != null && !isCotAudit(item.cotAudit)) throw new Error('消息配置快照格式异常。');
  const row = db.getFirstSync<Omit<MessageRecord, 'cotAudit'> & { cotAudit: string | null }>(`${MESSAGE_SELECT} WHERE id = ?`, [item.id]);
  const previous = row ? { ...row, cotAudit: row.cotAudit === null ? null : JSON.parse(row.cotAudit) } : null;
  assertMessageTransition(previous, item);
  db.runSync(`INSERT INTO messages (id, session_id, role, content, reasoning, status, error, cot_mode,
    cot_preset_id, model_id, created_at, cot_audit, thinking_mode) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET session_id = excluded.session_id, role = excluded.role,
      content = excluded.content, reasoning = excluded.reasoning, status = excluded.status,
      error = excluded.error, thinking_mode = excluded.thinking_mode, cot_preset_id = excluded.cot_preset_id,
      model_id = excluded.model_id, created_at = excluded.created_at, cot_audit = excluded.cot_audit`,
  [item.id, item.sessionId, item.role, item.content, item.reasoning, item.status, item.error,
    previous?.cotMode ?? item.cotMode, item.cotPresetId, item.modelId, item.createdAt,
    item.cotAudit == null ? null : JSON.stringify(item.cotAudit), item.thinkingMode ?? null]);
}
