import { createDefaultData } from '../../features/companion/defaults';
import { renameCompanionThinkingVariable, renameModelThinkingVariable } from '../../features/companion/thinking-variables';
import { activatePersona, companionPersonaId, deleteModel, readMessages, readSession, readSetting, readSnapshot, recoverInterruptedMessages, searchSessions, seedSettings, writeAppSettings, writeCompanion,
  writeMessage, writeModel, writePersona, writeSession, writeSetting } from './dao';
import { LEGACY_IMPORT_MARKER, readLegacyCompanion } from './legacy';
import { migrateDatabase } from './schema';
import { createSerialQueue, transaction } from './sql';
import type { KeyValueStorage, SqlDatabase } from './sql';
import type { AppRepository } from './types';
import { assertResetRevision } from './types';
import { THINKING_NOTICE_SETTING } from './thinking-migration';
import { assertRoleBaseline, validateRoleForSave } from '../../features/companion/role-config';

/** One private connection and queue protect SQL transactions from interleaving across stores. */
export function createSqlRepository(open: () => SqlDatabase, storage: KeyValueStorage): AppRepository {
  let database: SqlDatabase | null = null;
  let initialized = false;
  const enqueue = createSerialQueue();

  async function prepare() {
    const db = database ?? (database = open());
    if (initialized) return db;
    migrateDatabase(db);
    if (!readSetting(db, LEGACY_IMPORT_MARKER)) {
      const legacy = await readLegacyCompanion(storage);
      transaction(db, () => {
        seedSettings(db);
        writeCompanion(db, legacy.data);
        if (legacy.notice) writeSetting(db, '_recovery_notice', legacy.notice);
        if (legacy.migrationNotice) writeSetting(db, THINKING_NOTICE_SETTING, true);
        // Commit the import marker with every imported row, never before or afterwards.
        writeSetting(db, LEGACY_IMPORT_MARKER, { source: legacy.source, importedAt: new Date().toISOString() });
      });
    }
    transaction(db, () => recoverInterruptedMessages(db));
    initialized = true;
    return db;
  }

  const mutate = (work: (db: SqlDatabase) => void) => enqueue(async () => {
    const db = await prepare();
    transaction(db, () => work(db));
  });
  const mutateSnapshot = (work: (db: SqlDatabase) => void) => enqueue(async () => {
    const db = await prepare();
    return transaction(db, () => { work(db); return readSnapshot(db); });
  });

  return {
    renameThinkingVariable: (oldName, newName, variables) => mutateSnapshot((db) => {
      const snapshot = readSnapshot(db);
      writeCompanion(db, renameCompanionThinkingVariable(snapshot.companion, oldName, newName, variables));
      for (const model of snapshot.models) writeModel(db, { ...model,
        thinkingConfig: renameModelThinkingVariable(model.thinkingConfig!, oldName, newName) });
    }),
    dismissMigrationNotice: (id) => mutate((db) => {
      if (id !== 'thinking-v2') throw new Error('迁移通知标识无效。');
      writeSetting(db, THINKING_NOTICE_SETTING, false);
    }),
    initialize: () => enqueue(async () => {
      const db = await prepare();
      return transaction(db, () => readSnapshot(db));
    }),
    saveCompanion: (data, personaId) => mutate((db) => writeCompanion(db, data, personaId)),
    savePersona: (persona) => mutateSnapshot((db) => {
      if (persona.isActive) db.runSync('UPDATE personas SET is_active = 0 WHERE is_active = 1');
      writePersona(db, persona);
      if (persona.isActive) activatePersona(db, persona.id);
    }),
    saveRole: (persona, baseline, model) => mutateSnapshot((db) => {
      const before = readSnapshot(db);
      assertRoleBaseline(before.personas.find((item) => item.id === persona.id), baseline);
      if (model && persona.configuration?.currentModelId !== model.id) throw new Error('新增模型与角色选择不一致，请重新选择模型。');
      if (model) writeModel(db, model);
      const models = model ? [...before.models.filter((item) => item.id !== model.id), model] : before.models;
      validateRoleForSave(persona, models, before.companion.thinking, before.settings);
      if (persona.isActive) db.runSync('UPDATE personas SET is_active = 0 WHERE is_active = 1');
      writePersona(db, persona);
      if (persona.isActive) activatePersona(db, persona.id);
    }),
    setActivePersona: (id) => mutateSnapshot((db) => activatePersona(db, id)),
    deletePersona: (id) => mutateSnapshot((db) => {
      if (!db.getFirstSync('SELECT id FROM personas WHERE id = ?', [id])) throw new Error('选择的人设已不存在。');
      if ((db.getFirstSync<{ count: number }>('SELECT COUNT(*) AS count FROM personas')?.count ?? 0) <= 1) throw new Error('至少需要保留一个人设。');
      const active = companionPersonaId(db) === id;
      db.runSync('DELETE FROM personas WHERE id = ?', [id]);
      if (active) activatePersona(db, db.getFirstSync<{ id: string }>('SELECT id FROM personas ORDER BY rowid LIMIT 1')!.id);
    }),
    resetData: (revision) => mutateSnapshot((db) => {
      assertResetRevision(revision);
      if (readSetting(db, '_data_reset_revision') === revision) return;
      for (const table of ['messages', 'sessions', 'models', 'memories', 'personas', 'cot_presets', 'settings']) db.runSync(`DELETE FROM ${table}`);
      seedSettings(db);
      writeCompanion(db, createDefaultData());
      writeSetting(db, LEGACY_IMPORT_MARKER, { source: 'reset', revision });
      writeSetting(db, '_data_reset_revision', revision);
    }),
    hasDataReset: (revision) => enqueue(async () => {
      assertResetRevision(revision);
      return readSetting(await prepare(), '_data_reset_revision') === revision;
    }),
    saveSettings: (settings) => mutate((db) => writeAppSettings(db, settings)),
    saveModel: (model) => mutate((db) => writeModel(db, model)),
    deleteModel: (id) => mutate((db) => deleteModel(db, id)),
    saveSession: (session) => mutate((db) => writeSession(db, session)),
    deleteSession: (id) => mutate((db) => { db.runSync('DELETE FROM sessions WHERE id = ?', [id]); }),
    saveMessage: (message) => mutate((db) => writeMessage(db, message)),
    getMessages: (sessionId) => enqueue(async () => {
      const db = await prepare();
      return transaction(db, () => readMessages(db, sessionId));
    }),
    saveChatTurn: (session, messages) => enqueue(async () => {
      const db = await prepare();
      return transaction(db, () => {
        const existing = readSession(db, session.id);
        // A model may be deleted after the engine captures its request configuration.
        // Null the live FK while leaving each message's historical modelId untouched.
        const modelId = session.modelId && db.getFirstSync('SELECT id FROM models WHERE id = ?', [session.modelId])
          ? session.modelId : null;
        const persisted = existing ? { ...existing, modelId, updatedAt: session.updatedAt }
          : { ...session, modelId, personaId: session.personaId ?? companionPersonaId(db) };
        if (!existing && persisted.personaId && !db.getFirstSync('SELECT id FROM personas WHERE id = ?', [persisted.personaId])) {
          throw new Error('发送时的人设已不存在，会话未写入其他人设。');
        }
        writeSession(db, persisted);
        for (const message of messages) {
          if (message.sessionId !== session.id) throw new Error('消息所属会话不一致。');
          writeMessage(db, message);
        }
        return persisted;
      });
    }),
    finishChatTurn: (sessionId, message, updatedAt) => enqueue(async () => {
      const db = await prepare();
      return transaction(db, () => {
        const session = readSession(db, sessionId);
        if (!session || message.sessionId !== sessionId) throw new Error('所属会话已不存在。');
        writeMessage(db, message);
        db.runSync('UPDATE sessions SET updated_at = ? WHERE id = ?', [updatedAt, sessionId]);
        return { ...session, updatedAt };
      });
    }),
    searchSessions: (query) => enqueue(async () => searchSessions(await prepare(), query)),
  };
}
