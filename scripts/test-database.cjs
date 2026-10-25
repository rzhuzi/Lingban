/* Real SQLite tests. Transpile our platform-neutral TypeScript without loading React Native. */
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

require.extensions['.ts'] = (module, filename) => {
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    fileName: filename,
  });
  module._compile(output.outputText, filename);
};

const { createDefaultData } = require('../src/features/companion/defaults.ts');
const { createSqlRepository } = require('../src/lib/db/sql-repository.ts');
const { createWebRepository, WEB_STORAGE_KEY } = require('../src/lib/db/web-repository.ts');
const { migrateDatabase } = require('../src/lib/db/schema.ts');
const { LEGACY_STORAGE_KEY, LEGACY_IMPORT_MARKER } = require('../src/lib/db/legacy.ts');
const { createModelThinkingConfig } = require('../src/features/companion/thinking-config.ts');
const copy = (value) => JSON.parse(JSON.stringify(value));

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  let failWrites = false;
  return {
    values,
    fail(value) { failWrites = value; },
    async getItem(key) { return values.get(key) ?? null; },
    async setItem(key, value) { if (failWrites) throw new Error('storage unavailable'); values.set(key, value); },
  };
}

function adapter(sqlite) {
  return {
    execSync: (sql) => sqlite.exec(sql),
    runSync: (sql, params = []) => sqlite.prepare(sql).run(...params),
    getAllSync: (sql, params = []) => sqlite.prepare(sql).all(...params).map((row) => ({ ...row })),
    getFirstSync: (sql, params = []) => {
      const row = sqlite.prepare(sql).get(...params);
      return row ? { ...row } : null;
    },
  };
}

function setup(t, storage = memoryStorage()) {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  const db = adapter(sqlite);
  const repository = createSqlRepository(() => db, storage);
  return { sqlite, db, repository, storage };
}

function authoredCompanion() {
  const data = createDefaultData();
  data.profile = {
    name: "可自定义 ' 名字", description: '你好\n任意介绍🙂', coverUri: 'file:///covers/我的图.jpg',
    avatarUri: 'file:///avatar.png', traits: ['倾听', '理性'],
  };
  data.memories = [
    { id: 'memory-b', text: '保留用户原文\nO\'Brien', icon: 'cafe', createdAt: '2026-01-02T00:00:00Z', updatedAt: '2026-02-02T00:00:00Z' },
    { id: 'memory-a', text: '第二项', icon: 'moon', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-03T00:00:00Z' },
  ];
  data.interests = ['咖啡', '旅行'];
  data.thinking.mode = 'persona';
  data.thinking.prompt = '未绑定模板的编辑草稿 {persona} {custom}';
  data.thinking.nativeParameters = '{"thinking":{"type":"enabled"}}';
  data.thinking.templates[0].name = '任意模板';
  data.thinking.templates[0].description = '我的描述';
  data.thinking.templates[0].prompt = '{persona}\n自定义模板';
  data.thinking.selectedTemplateId = 'template-rational';
  data.thinking.variables = [
    { id: 'custom-var', name: 'custom', value: '🌙 自定义值' },
    { id: 'user-var', name: 'user_name', value: '晓明' },
  ];
  return data;
}

const now = '2026-10-20T01:00:00.000Z';
function model(id = 'model-1', overrides = {}) {
  return { id, name: "'); DROP TABLE personas; --", provider: 'custom', baseUrl: 'https://example.test/v1',
    apiModel: 'custom-chat', apiKeyAlias: `model_${id}`, isDefault: true, cotMode: 'off', thinkingConfig: createModelThinkingConfig(),
    cotPresetId: 'template-warm', createdAt: now, updatedAt: now, ...overrides };
}
function session(id = 'session-1', overrides = {}) {
  return { id, title: "标题 O'Brien\n换行", modelId: 'model-1', personaId: 'persona-default',
    pinned: true, createdAt: now, updatedAt: now, ...overrides };
}
function message(id = 'message-1', overrides = {}) {
  return { id, sessionId: 'session-1', role: 'assistant', content: "正文 ' 🙂", reasoning: '思考内容\n第二行',
    status: 'done', error: null, cotMode: 'prefill', thinkingMode: null, cotPresetId: 'template-warm', modelId: 'model-1',
    createdAt: now, ...overrides };
}

test('fresh initialization creates all seven tables, seed data, settings, FKs; repeat is idempotent', async (t) => {
  const { db, repository, storage } = setup(t);
  const first = await repository.initialize();
  assert.deepEqual(first.companion, createDefaultData());
  assert.deepEqual(first.settings, { theme: 'system', userName: '你', contextWindow: 20, streamOutput: true });
  assert.deepEqual(first.models, []);
  assert.equal(db.getFirstSync('PRAGMA user_version').user_version, 5);
  assert.equal(db.getFirstSync('PRAGMA foreign_keys').foreign_keys, 1);
  const tables = db.getAllSync("SELECT name FROM sqlite_master WHERE type = 'table'").map((row) => row.name).sort();
  assert.deepEqual(tables, ['cot_presets', 'memories', 'messages', 'models', 'personas', 'sessions', 'settings']);
  assert.deepEqual(await repository.initialize(), first);
  assert.deepEqual(await createSqlRepository(() => db, storage).initialize(), first);
  assert.ok(db.getFirstSync('SELECT value FROM settings WHERE key = ?', [LEGACY_IMPORT_MARKER]));
});

test('legacy import round-trips every user field, ID, URI, draft, order and variables exactly once', async (t) => {
  const data = authoredCompanion();
  const raw = JSON.stringify(data);
  const storage = memoryStorage({ [LEGACY_STORAGE_KEY]: raw });
  const { db, repository } = setup(t, storage);
  const imported = await repository.initialize();
  assert.deepEqual(imported.companion, data);
  assert.equal(imported.settings.userName, '晓明');
  assert.equal(storage.values.get(LEGACY_STORAGE_KEY), raw);
  const changed = copy(data);
  changed.profile.name = '新名字';
  changed.thinking.variables[1].value = '新昵称';
  await repository.saveCompanion(changed);
  const restarted = await createSqlRepository(() => db, storage).initialize();
  assert.deepEqual(restarted.companion, changed);
  assert.equal(restarted.settings.userName, '新昵称');
  assert.equal(storage.values.get(LEGACY_STORAGE_KEY), raw);
});

test('explicitly deleted templates and variables stay empty after import and restart', async (t) => {
  const data = authoredCompanion();
  data.thinking.templates = [];
  data.thinking.variables = [];
  data.thinking.selectedTemplateId = null;
  const storage = memoryStorage({ [LEGACY_STORAGE_KEY]: JSON.stringify(data) });
  const { db, repository } = setup(t, storage);
  assert.deepEqual((await repository.initialize()).companion, data);
  assert.equal((await repository.initialize()).settings.userName, '你');
  assert.deepEqual((await createSqlRepository(() => db, storage).initialize()).companion.thinking.templates, []);
  await repository.saveSettings({ theme: 'dark', userName: '后续昵称', contextWindow: 9, streamOutput: false });
  assert.deepEqual((await repository.initialize()).companion.thinking.variables, []);
  data.profile.name = '仅编辑头像资料';
  await repository.saveCompanion(data);
  assert.equal((await repository.initialize()).settings.userName, '后续昵称');
});

test('malformed legacy data is backed up before repaired import and never overwrites original', async (t) => {
  const raw = '{"profile":{"name":"能恢复的名字"},"memories":["记得这条"],"thinking":{"templates":[]}}';
  const storage = memoryStorage({ [LEGACY_STORAGE_KEY]: raw });
  const { db, repository } = setup(t, storage);
  const result = await repository.initialize();
  assert.equal(result.companion.profile.name, '能恢复的名字');
  assert.equal(result.companion.memories[0].text, '记得这条');
  assert.deepEqual(result.companion.thinking.templates, []);
  assert.ok(result.notice);
  const backups = [...storage.values].filter(([key]) => key.startsWith(`${LEGACY_STORAGE_KEY}/recovery/`));
  assert.equal(backups.length, 1);
  assert.equal(backups[0][1], raw);
  assert.equal(storage.values.get(LEGACY_STORAGE_KEY), raw);
  await createSqlRepository(() => db, storage).initialize();
  assert.equal([...storage.values.keys()].filter((key) => key.includes('/recovery/')).length, 1);
});

test('backup storage failure leaves import unmarked and retry succeeds', async (t) => {
  const storage = memoryStorage({ [LEGACY_STORAGE_KEY]: 'broken JSON' });
  storage.fail(true);
  const { db, repository } = setup(t, storage);
  await assert.rejects(repository.initialize(), /storage unavailable/);
  assert.equal(db.getFirstSync('SELECT value FROM settings WHERE key = ?', [LEGACY_IMPORT_MARKER]), null);
  assert.equal(db.getFirstSync('SELECT COUNT(*) AS count FROM personas').count, 0);
  storage.fail(false);
  assert.ok((await repository.initialize()).notice);
  assert.ok(db.getFirstSync('SELECT value FROM settings WHERE key = ?', [LEGACY_IMPORT_MARKER]));
});

test('future legacy schema rejects without backup or replacing its data; same instance can retry', async (t) => {
  const raw = JSON.stringify({ schemaVersion: 99, profile: { name: '未来数据' } });
  const storage = memoryStorage({ [LEGACY_STORAGE_KEY]: raw });
  const { db, repository } = setup(t, storage);
  await assert.rejects(repository.initialize(), /较新版本/);
  assert.equal(storage.values.get(LEGACY_STORAGE_KEY), raw);
  assert.equal(storage.values.size, 1);
  assert.equal(db.getFirstSync('SELECT COUNT(*) AS count FROM settings').count, 0);
  storage.values.set(LEGACY_STORAGE_KEY, JSON.stringify(createDefaultData()));
  assert.equal((await repository.initialize()).companion.profile.name, '小零');
});

test('failed import transaction rolls back every imported row with the marker; retry is safe', async (t) => {
  const data = authoredCompanion();
  const storage = memoryStorage({ [LEGACY_STORAGE_KEY]: JSON.stringify(data) });
  const { db } = setup(t, storage);
  let failMarker = true;
  const faulty = { ...db, runSync(sql, params = []) {
    if (failMarker && params[0] === LEGACY_IMPORT_MARKER) throw new Error('simulated marker failure');
    return db.runSync(sql, params);
  } };
  const repository = createSqlRepository(() => faulty, storage);
  await assert.rejects(repository.initialize(), /simulated marker failure/);
  for (const table of ['settings', 'personas', 'memories', 'cot_presets']) {
    assert.equal(db.getFirstSync(`SELECT COUNT(*) AS count FROM ${table}`).count, 0);
  }
  assert.equal(db.getFirstSync('PRAGMA user_version').user_version, 5);
  failMarker = false;
  assert.deepEqual((await repository.initialize()).companion, data);
  assert.equal(db.getFirstSync('SELECT COUNT(*) AS count FROM personas').count, 1);
});

test('future database version is rejected without destructive migration', (t) => {
  const { db } = setup(t);
  db.execSync("CREATE TABLE future_data (value TEXT); INSERT INTO future_data VALUES ('保留'); PRAGMA user_version = 7;");
  assert.throws(() => migrateDatabase(db), /较新版本/);
  assert.equal(db.getFirstSync('PRAGMA user_version').user_version, 7);
  assert.equal(db.getFirstSync('SELECT value FROM future_data').value, '保留');
});

test('failed DDL migration rolls back schema and user_version; rerun can succeed', (t) => {
  const { db } = setup(t);
  const faulty = { ...db, execSync(sql) {
    if (sql.includes('CREATE TABLE models')) {
      db.execSync('CREATE TABLE partial_table (id TEXT)');
      throw new Error('simulated DDL failure');
    }
    db.execSync(sql);
  } };
  assert.throws(() => migrateDatabase(faulty), /simulated DDL failure/);
  assert.equal(db.getFirstSync('PRAGMA user_version').user_version, 0);
  assert.deepEqual(db.getAllSync("SELECT name FROM sqlite_master WHERE type = 'table'"), []);
  migrateDatabase(db);
  assert.equal(db.getFirstSync('PRAGMA user_version').user_version, 5);
});

test('v1 to v4 audit/persona/thinking migration preserves all existing rows and retries a failed ALTER atomically', async (t) => {
  const { db, repository, storage } = setup(t);
  await repository.initialize();
  await repository.saveCompanion(authoredCompanion());
  await repository.saveModel(model());
  await repository.saveSession(session());
  await repository.saveMessage(message());
  const original = await repository.initialize();
  // Build the actual previous messages layout with existing rows, not an empty upgrade fixture.
  db.execSync(`ALTER TABLE messages DROP COLUMN cot_audit; ALTER TABLE messages DROP COLUMN thinking_mode;
    ALTER TABLE models DROP COLUMN thinking_mode; ALTER TABLE models DROP COLUMN thinking_config;
    ALTER TABLE cot_presets DROP COLUMN kind; ALTER TABLE personas DROP COLUMN role_config; DROP INDEX personas_one_active; PRAGMA user_version = 1;`);
  const faulty = { ...db, execSync(sql) {
    if (sql.includes('ADD COLUMN cot_audit')) { db.execSync(sql); throw new Error('simulated ALTER failure'); }
    db.execSync(sql);
  } };
  assert.throws(() => migrateDatabase(faulty), /simulated ALTER failure/);
  assert.equal(db.getFirstSync('PRAGMA user_version').user_version, 1);
  assert.ok(!db.getAllSync('PRAGMA table_info(messages)').some((column) => column.name === 'cot_audit'));
  const reopened = createSqlRepository(() => db, storage);
  const migrated = await reopened.initialize();
  assert.deepEqual(migrated.messages, original.messages);
  assert.deepEqual(migrated.sessions, original.sessions);
  assert.deepEqual(migrated.personas.map(({ configuration, ...item }) => item), original.personas.map(({ configuration, ...item }) => item));
  assert.equal(migrated.companion.thinking.prompt, original.companion.thinking.prompt);
  assert.equal(db.getFirstSync('PRAGMA user_version').user_version, 5);
  assert.ok(db.getAllSync('PRAGMA table_info(messages)').some((column) => column.name === 'cot_audit'));
});

test('v2 persona migration selects the previous companion marker without deleting other identities or memories', async (t) => {
  const { db, repository, storage } = setup(t);
  await repository.initialize();
  db.execSync(`ALTER TABLE messages DROP COLUMN thinking_mode; ALTER TABLE models DROP COLUMN thinking_mode;
    ALTER TABLE models DROP COLUMN thinking_config; ALTER TABLE cot_presets DROP COLUMN kind; ALTER TABLE personas DROP COLUMN role_config;
    DROP INDEX personas_one_active; PRAGMA user_version = 2;`);
  db.runSync('INSERT INTO personas (id, name, content, is_active) VALUES (?, ?, ?, ?)', ['second-legacy', '保留旧人设', '保留旧介绍', 1]);
  db.runSync('INSERT INTO memories (id, persona_id, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ['second-legacy-memory', 'second-legacy', '保留旧记忆', now, now]);
  const migrated = await createSqlRepository(() => db, storage).initialize();
  assert.equal(db.getFirstSync('PRAGMA user_version').user_version, 5);
  assert.equal(migrated.personas.length, 2);
  assert.equal(migrated.personas.find((item) => item.isActive).id, 'persona-default');
  assert.equal(migrated.personas.find((item) => item.id === 'second-legacy').profile.description, '保留旧介绍');
  assert.equal(migrated.personas.find((item) => item.id === 'second-legacy').memories[0].text, '保留旧记忆');
  assert.throws(() => db.runSync('UPDATE personas SET is_active = 1 WHERE id = ?', ['second-legacy']), /UNIQUE/);
});

const audit = {
  version: 1, requestedMode: 'persona', effectiveMode: 'persona', templateId: 'template-warm', templateName: '当时模板',
  renderedPrefix: '以 {literal} 和晓明对话🙂', warnings: ['未知变量保留：{unknown}'], nativeParameters: null,
  modelName: '当时模型', provider: 'custom', apiModel: 'test-model', baseUrl: 'https://example.test/v1',
};

for (const web of [false, true]) {
  test(`${web ? 'web' : 'SQLite'} preserves historical rendered audit after template/model deletion and retains disabled templates`, async (t) => {
    const local = setup(t);
    const repository = web ? createWebRepository(local.storage) : local.repository;
    const data = (await repository.initialize()).companion;
    data.thinking.templates[0].enabled = false;
    await repository.saveCompanion(data);
    await repository.saveModel(model());
    await repository.saveSession(session());
    const row = message('audit-message', { cotAudit: audit });
    await repository.saveMessage(row);
    await assert.rejects(repository.saveMessage({ ...row, cotAudit: { version: 1 } }), /配置快照/);
    const reopened = () => web ? createWebRepository(local.storage) : createSqlRepository(() => local.db, local.storage);
    const saved = await reopened().initialize();
    assert.equal(saved.companion.thinking.templates[0].enabled, false);
    assert.deepEqual(saved.messages, [row]);
    data.thinking.templates = [];
    data.thinking.selectedTemplateId = null;
    await repository.saveCompanion(data);
    await repository.deleteModel('model-1');
    assert.deepEqual((await reopened().initialize()).messages[0].cotAudit, audit);
    assert.equal((await repository.getMessages('session-1'))[0].cotPresetId, 'template-warm');
  });
}

test('web recovers only damaged audit details, persists the notice, and never rewrites the damaged snapshot', async () => {
  const storage = memoryStorage();
  const repository = createWebRepository(storage);
  await repository.initialize();
  await repository.saveModel(model());
  await repository.saveSession(session());
  await repository.saveMessage(message());
  assert.deepEqual((await createWebRepository(storage).initialize()).messages, [message()]);
  const document = JSON.parse(storage.values.get(WEB_STORAGE_KEY));
  document.snapshot.messages[0].cotAudit = { version: 99, renderedPrefix: '保留损坏原文' };
  const damaged = JSON.stringify(document);
  storage.values.set(WEB_STORAGE_KEY, damaged);
  const reopened = createWebRepository(storage);
  const recovered = await reopened.initialize();
  assert.deepEqual(recovered.messages, [message()]);
  assert.deepEqual(recovered.sessions, [session()]);
  assert.match(recovered.notice, /配置快照已忽略/);
  assert.equal(JSON.parse(storage.values.get(WEB_STORAGE_KEY)).snapshot.messages[0].cotAudit, undefined);
  await reopened.saveSettings({ ...recovered.settings, theme: 'dark' });
  assert.deepEqual((await createWebRepository(storage).initialize()).messages, [message()]);
  assert.equal((await createWebRepository(storage).initialize()).notice, recovered.notice);
});

test('SQLite startup clears invalid audit JSON and invalid audit shape while keeping messages, sessions, and valid audits', async (t) => {
  const { db, repository, storage } = setup(t);
  await repository.initialize();
  await repository.saveModel(model());
  await repository.saveSession(session());
  const rows = [message('broken-json'), message('broken-shape'), message('valid-audit', { cotAudit: audit }), message('old-message')];
  for (const row of rows) await repository.saveMessage(row);
  db.runSync('UPDATE messages SET cot_audit = ? WHERE id = ?', ['{broken JSON', 'broken-json']);
  db.runSync('UPDATE messages SET cot_audit = ? WHERE id = ?', [JSON.stringify({ version: 1 }), 'broken-shape']);
  db.runSync('INSERT INTO settings (key, value) VALUES (?, ?)', ['_recovery_notice', JSON.stringify('已有恢复提醒。')]);
  const reopened = createSqlRepository(() => db, storage);
  const recovered = await reopened.initialize();
  assert.deepEqual(recovered.messages, rows);
  assert.deepEqual(recovered.sessions, [session()]);
  assert.match(recovered.notice, /已有恢复提醒/);
  assert.match(recovered.notice, /配置快照已忽略/);
  assert.equal(db.getFirstSync('SELECT cot_audit FROM messages WHERE id = ?', ['broken-json']).cot_audit, null);
  assert.equal(db.getFirstSync('SELECT cot_audit FROM messages WHERE id = ?', ['broken-shape']).cot_audit, null);
  await reopened.saveMessage(recovered.messages[0]);
  assert.deepEqual((await createSqlRepository(() => db, storage).initialize()).messages, rows);
  assert.equal((await reopened.initialize()).notice, recovered.notice);
});

test('SQLite session reads recover damaged audits transactionally and propagate real write failures', async (t) => {
  const { db, repository } = setup(t);
  await repository.initialize();
  await repository.saveModel(model());
  await repository.saveSession(session());
  for (const id of ['first', 'second']) await repository.saveMessage(message(id));
  let fail = false;
  const faulty = { ...db, runSync(sql, params = []) {
    if (fail && sql.startsWith('UPDATE messages SET cot_audit') && params.includes('second')) throw new Error('simulated disk failure');
    return db.runSync(sql, params);
  } };
  const reopened = createSqlRepository(() => faulty, memoryStorage());
  await reopened.initialize();
  for (const id of ['first', 'second']) db.runSync('UPDATE messages SET cot_audit = ? WHERE id = ?', ['{broken', id]);
  fail = true;
  await assert.rejects(reopened.getMessages('session-1'), /simulated disk failure/);
  assert.equal(db.getFirstSync('SELECT cot_audit FROM messages WHERE id = ?', ['first']).cot_audit, '{broken');
  assert.equal(db.getFirstSync("SELECT value FROM settings WHERE key = '_recovery_notice'"), null);
  fail = false;
  assert.deepEqual(await reopened.getMessages('session-1'), [message('first'), message('second')]);
});

test('SQLite audit recovery does not hide query errors or invalid app settings', async (t) => {
  const { db, repository, storage } = setup(t);
  await repository.initialize();
  await repository.saveModel(model());
  await repository.saveSession(session());
  await repository.saveMessage(message());
  db.runSync('UPDATE messages SET cot_audit = ?', ['{broken']);
  const faulty = { ...db, getAllSync(sql, params = []) {
    if (sql.includes('FROM messages')) throw new Error('simulated query failure');
    return db.getAllSync(sql, params);
  } };
  await assert.rejects(createSqlRepository(() => faulty, storage).initialize(), /simulated query failure/);
  db.runSync('UPDATE settings SET value = ? WHERE key = ?', ['"unsupported"', 'theme']);
  await assert.rejects(createSqlRepository(() => db, storage).initialize(), /设置/);
  assert.equal(db.getFirstSync('SELECT cot_audit FROM messages').cot_audit, '{broken');
});

test('web audit recovery retries failed persistence and refuses unrelated record corruption', async () => {
  const storage = memoryStorage();
  const repository = createWebRepository(storage);
  await repository.initialize();
  await repository.saveModel(model());
  await repository.saveSession(session());
  await repository.saveMessage(message());
  const document = JSON.parse(storage.values.get(WEB_STORAGE_KEY));
  document.snapshot.messages[0].cotAudit = '{broken';
  const damaged = JSON.stringify(document);
  storage.values.set(WEB_STORAGE_KEY, damaged);
  storage.fail(true);
  const reopened = createWebRepository(storage);
  await assert.rejects(reopened.initialize(), /storage unavailable/);
  assert.equal(storage.values.get(WEB_STORAGE_KEY), damaged);
  storage.fail(false);
  assert.deepEqual((await reopened.initialize()).messages, [message()]);
  document.snapshot.messages[0].status = 'invalid-status';
  const unrelated = JSON.stringify(document);
  storage.values.set(WEB_STORAGE_KEY, unrelated);
  await assert.rejects(createWebRepository(storage).initialize(), /记录格式异常/);
  assert.equal(storage.values.get(WEB_STORAGE_KEY), unrelated);
});

test('parameterized DAO writes retain full records, quotes and audit snapshots; failed model save rolls back default flag', async (t) => {
  const { db, repository } = setup(t);
  await repository.initialize();
  await repository.saveModel(model());
  await repository.saveSession(session());
  await repository.saveMessage(message());
  const snapshot = await repository.initialize();
  assert.deepEqual(snapshot.models, [model()]);
  assert.deepEqual(snapshot.sessions, [session()]);
  assert.deepEqual(snapshot.messages, [message()]);
  assert.deepEqual(await repository.getMessages('session-1'), [message()]);
  await assert.rejects(repository.saveModel(model('invalid-model', { cotPresetId: 'missing-preset' })), /FOREIGN KEY/);
  assert.equal((await repository.initialize()).models[0].isDefault, true);
  const columns = db.getAllSync('PRAGMA table_info(models)').map((column) => column.name);
  assert.ok(columns.includes('api_key_alias'));
  assert.ok(!columns.includes('api_key'));
});

test('editing companion preserves other personas, retained model bindings and sessions; deletion FKs retain message audit', async (t) => {
  const { db, repository } = setup(t);
  const original = (await repository.initialize()).companion;
  await repository.saveModel(model());
  await repository.saveSession(session());
  await repository.saveMessage(message());
  db.runSync('INSERT INTO personas (id, name, content) VALUES (?, ?, ?)', ['other-persona', '另一个人设', '不能改变']);
  db.runSync('INSERT INTO memories (id, persona_id, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ['other-memory', 'other-persona', '另一个记忆', now, now]);
  const changed = copy(original);
  changed.profile.name = '编辑原人设';
  changed.thinking.templates = changed.thinking.templates.filter((item) => item.id !== 'template-rational');
  await repository.saveCompanion(changed);
  assert.equal((await repository.initialize()).models[0].cotPresetId, 'template-warm');
  assert.equal((await repository.initialize()).sessions[0].personaId, 'persona-default');
  assert.equal(db.getFirstSync('SELECT content FROM personas WHERE id = ?', ['other-persona']).content, '不能改变');
  assert.equal(db.getFirstSync('SELECT content FROM memories WHERE id = ?', ['other-memory']).content, '另一个记忆');
  changed.thinking.templates = [];
  changed.thinking.selectedTemplateId = null;
  await repository.saveCompanion(changed);
  assert.equal((await repository.initialize()).models[0].cotPresetId, null);
  assert.equal((await repository.getMessages('session-1'))[0].cotPresetId, 'template-warm');
  await repository.deleteModel('model-1');
  assert.equal((await repository.initialize()).sessions[0].modelId, null);
  assert.equal((await repository.getMessages('session-1'))[0].modelId, 'model-1');
  db.runSync('DELETE FROM personas WHERE id = ?', ['persona-default']);
  assert.equal(db.getFirstSync('SELECT persona_id FROM sessions WHERE id = ?', ['session-1']).persona_id, null);
  await repository.deleteSession('session-1');
  assert.deepEqual(await repository.getMessages('session-1'), []);
});

test('memory ID collision with unrelated persona rejects and rolls back the entire companion save', async (t) => {
  const { db, repository } = setup(t);
  const original = (await repository.initialize()).companion;
  db.runSync('INSERT INTO personas (id, name) VALUES (?, ?)', ['other-persona', '其他']);
  db.runSync('INSERT INTO memories (id, persona_id, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ['collision', 'other-persona', '保留', now, now]);
  const changed = copy(original);
  changed.profile.name = '不应写入';
  changed.memories = [{ id: 'collision', text: '冲突', icon: 'heart', createdAt: now, updatedAt: now }];
  await assert.rejects(repository.saveCompanion(changed), /其他人设冲突/);
  assert.deepEqual((await repository.initialize()).companion, original);
  assert.equal(db.getFirstSync('SELECT content FROM memories WHERE id = ?', ['collision']).content, '保留');
});

test('concurrent store calls serialize; settings and existing user_name variable stay synchronized', async (t) => {
  const { repository } = setup(t);
  const data = (await repository.initialize()).companion;
  data.thinking.variables[0].value = '从人设编辑';
  const darkSettings = { theme: 'dark', userName: '从设置编辑', contextWindow: 35, streamOutput: false };
  await Promise.all([repository.saveCompanion(data), repository.saveSettings(darkSettings)]);
  const snapshot = await repository.initialize();
  assert.deepEqual(snapshot.settings, darkSettings);
  assert.equal(snapshot.companion.thinking.variables[0].value, '从设置编辑');
  await repository.saveModel(model());
  await repository.saveModel(model('model-2'));
  assert.equal((await repository.initialize()).models.filter((item) => item.isDefault).length, 1);
});

test('SQLite file survives closing and reopening the connection, using WAL mode', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lingban-db-test-'));
  const filename = path.join(directory, 'test.db');
  t.after(() => {
    for (const suffix of ['', '-wal', '-shm']) { if (fs.existsSync(filename + suffix)) fs.unlinkSync(filename + suffix); }
    fs.rmdirSync(directory);
  });
  const storage = memoryStorage();
  const first = new DatabaseSync(filename);
  const repo = createSqlRepository(() => adapter(first), storage);
  const data = authoredCompanion();
  await repo.initialize();
  await repo.saveCompanion(data);
  assert.equal(adapter(first).getFirstSync('PRAGMA journal_mode').journal_mode, 'wal');
  first.close();
  const second = new DatabaseSync(filename);
  try {
    const snapshot = await createSqlRepository(() => adapter(second), storage).initialize();
    assert.deepEqual(snapshot.companion, data);
  } finally { second.close(); }
});

test('web fallback imports once, persists separately and applies the same FK deletion semantics', async () => {
  const data = authoredCompanion();
  const raw = JSON.stringify(data);
  const storage = memoryStorage({ [LEGACY_STORAGE_KEY]: raw });
  const repository = createWebRepository(storage);
  assert.deepEqual((await repository.initialize()).companion, data);
  await repository.saveModel(model());
  await repository.saveSession(session());
  await repository.saveMessage(message());
  const next = copy(data);
  next.profile.name = '网页修改';
  next.thinking.templates = [];
  next.thinking.selectedTemplateId = null;
  await repository.saveCompanion(next);
  await repository.deleteModel('model-1');
  const restarted = await createWebRepository(storage).initialize();
  assert.deepEqual(restarted.companion, next);
  assert.equal(restarted.sessions[0].modelId, null);
  assert.equal(restarted.messages[0].modelId, 'model-1');
  assert.equal(restarted.messages[0].cotPresetId, 'template-warm');
  assert.equal(storage.values.get(LEGACY_STORAGE_KEY), raw);
  assert.ok(storage.values.has(WEB_STORAGE_KEY));
  await repository.deleteSession('session-1');
  assert.deepEqual(await repository.getMessages('session-1'), []);
});

test('failed web save retains prior durable state and retry does not overwrite with stale legacy data', async () => {
  const storage = memoryStorage();
  const repository = createWebRepository(storage);
  const original = await repository.initialize();
  const changed = copy(original.companion);
  changed.profile.name = '修改名字';
  storage.fail(true);
  await assert.rejects(repository.saveCompanion(changed), /storage unavailable/);
  assert.deepEqual((await repository.initialize()).companion, original.companion);
  storage.fail(false);
  await repository.saveCompanion(changed);
  assert.deepEqual((await createWebRepository(storage).initialize()).companion, changed);
});

test('malformed or future web documents reject without replacing existing key', async () => {
  for (const raw of ['broken JSON', JSON.stringify({ schemaVersion: 5 }), JSON.stringify({ schemaVersion: 1, snapshot: {} })]) {
    const storage = memoryStorage({ [WEB_STORAGE_KEY]: raw });
    await assert.rejects(createWebRepository(storage).initialize());
    assert.equal(storage.values.get(WEB_STORAGE_KEY), raw);
    assert.equal(storage.values.size, 1);
  }
  const storage = memoryStorage();
  await createWebRepository(storage).initialize();
  const document = JSON.parse(storage.values.get(WEB_STORAGE_KEY));
  document.snapshot.models.push({ id: 'broken-model' });
  const malformedRecords = JSON.stringify(document);
  storage.values.set(WEB_STORAGE_KEY, malformedRecords);
  await assert.rejects(createWebRepository(storage).initialize(), /记录格式异常/);
  assert.equal(storage.values.get(WEB_STORAGE_KEY), malformedRecords);
});

test('web model defaults promote atomically and a failed promotion document keeps the original model and references', async () => {
  const storage = memoryStorage();
  const repository = createWebRepository(storage);
  await repository.initialize();
  await repository.saveModel(model('model-1', { isDefault: false }));
  await repository.saveModel(model('model-2', { isDefault: false }));
  await repository.saveSession(session());
  assert.equal((await repository.initialize()).models.find((item) => item.id === 'model-1').isDefault, true);
  storage.fail(true);
  await assert.rejects(repository.deleteModel('model-1'), /storage unavailable/);
  const unchanged = await repository.initialize();
  assert.equal(unchanged.models.length, 2);
  assert.equal(unchanged.models.find((item) => item.id === 'model-1').isDefault, true);
  assert.equal(unchanged.sessions[0].modelId, 'model-1');
  storage.fail(false);
  await repository.deleteModel('model-1');
  const result = await createWebRepository(storage).initialize();
  assert.equal(result.models.length, 1);
  assert.equal(result.models[0].id, 'model-2');
  assert.equal(result.models[0].isDefault, true);
  assert.equal(result.sessions[0].modelId, null);
});

function extraPersona(id = 'persona-2', active = true) {
  return { id, profile: { traits: ['理性'], avatarUri: null, name: id, coverUri: null, description: '另一个独立人设' },
    memories: [{ id: `${id}-memory`, text: `${id}的记忆`, icon: 'moon', createdAt: now, updatedAt: now }], interests: ['旅行'], isActive: active };
}

for (const web of [false, true]) {
  test(`${web ? 'web' : 'SQLite'} persona selection and captured companion drafts preserve identity, global thinking and session ownership`, async (t) => {
    const local = setup(t);
    const repository = web ? createWebRepository(local.storage) : local.repository;
    const initial = await repository.initialize();
    assert.equal(initial.personas.length, 1);
    assert.equal(initial.personas[0].isActive, true);
    const draft = copy(initial.companion);
    draft.profile.name = '旧人设排队草稿';
    draft.thinking.prompt = '所有人设共享提示词';
    draft.thinking.variables.find((item) => item.name === 'user_name').value = '共享昵称';
    // Deliberately enqueue switching first, then the earlier persona's captured draft.
    await Promise.all([repository.savePersona(extraPersona()), repository.saveCompanion(draft, 'persona-default')]);
    const switched = await repository.initialize();
    assert.equal(switched.companion.profile.name, 'persona-2');
    assert.equal(switched.companion.thinking.prompt, '所有人设共享提示词');
    assert.equal(switched.settings.userName, '共享昵称');
    assert.equal(switched.personas.find((item) => item.id === 'persona-default').profile.name, '旧人设排队草稿');
    assert.equal(switched.personas.filter((item) => item.isActive).length, 1);
    await repository.saveModel(model());
    await repository.saveChatTurn(session('captured-owner', { personaId: 'persona-default' }),
      [message('captured-message', { sessionId: 'captured-owner' })]);
    assert.equal((await repository.initialize()).sessions[0].personaId, 'persona-default');
    const back = await repository.setActivePersona('persona-default');
    assert.equal(back.companion.profile.name, '旧人设排队草稿');
    assert.equal(back.companion.memories.length, 0);
    const removed = await repository.deletePersona('persona-default');
    assert.equal(removed.companion.profile.name, 'persona-2');
    assert.equal(removed.sessions[0].personaId, null);
    assert.equal(removed.messages[0].content, message().content);
    await assert.rejects(repository.saveCompanion(draft, 'persona-default'), /已不存在/);
    await assert.rejects(repository.saveChatTurn(session('missing-owner', { personaId: 'persona-default' }), []), /人设已不存在/);
    await assert.rejects(repository.deletePersona('persona-2'), /至少/);
    await assert.rejects(repository.setActivePersona('missing-persona'), /已不存在/);
    const reopened = web ? createWebRepository(local.storage) : createSqlRepository(() => local.db, local.storage);
    assert.deepEqual(await reopened.initialize(), removed);
  });

  test(`${web ? 'web' : 'SQLite'} persona memory collisions and failed writes retain every old identity and active selection`, async (t) => {
    const local = setup(t);
    const repository = web ? createWebRepository(local.storage) : local.repository;
    await repository.initialize();
    await repository.savePersona(extraPersona());
    const before = await repository.initialize();
    await assert.rejects(repository.savePersona({ ...extraPersona('third'), memories: extraPersona().memories }), /其他人设冲突/);
    assert.deepEqual(await repository.initialize(), before);
    if (web) local.storage.fail(true);
    else local.db.execSync("CREATE TRIGGER fail_new_persona BEFORE INSERT ON personas WHEN NEW.id = 'third' BEGIN SELECT RAISE(ABORT, 'injected failure'); END");
    await assert.rejects(repository.savePersona(extraPersona('third')));
    if (web) local.storage.fail(false);
    assert.deepEqual(await repository.initialize(), before);
    if (!web) assert.throws(() => local.db.runSync('UPDATE personas SET is_active = 1 WHERE id = ?', ['persona-default']), /UNIQUE/);
  });

  test(`${web ? 'web' : 'SQLite'} reset is atomic, idempotent and never reimports the original legacy profile`, async (t) => {
    const legacy = authoredCompanion();
    const storage = memoryStorage({ [LEGACY_STORAGE_KEY]: JSON.stringify(legacy) });
    const local = setup(t, storage);
    const repository = web ? createWebRepository(storage) : local.repository;
    await repository.initialize();
    await repository.savePersona(extraPersona());
    await repository.saveModel(model());
    await repository.saveSession(session());
    await repository.saveMessage(message());
    const before = await repository.initialize();
    if (web) storage.fail(true);
    else local.db.execSync("CREATE TRIGGER fail_reset BEFORE DELETE ON settings BEGIN SELECT RAISE(ABORT, 'injected reset failure'); END");
    await assert.rejects(repository.resetData('reset-1'));
    if (web) storage.fail(false);
    else local.db.execSync('DROP TRIGGER fail_reset');
    assert.deepEqual(await repository.initialize(), before);
    assert.equal(await repository.hasDataReset('reset-1'), false);
    const cleared = await repository.resetData('reset-1');
    assert.deepEqual(cleared.companion, createDefaultData());
    assert.deepEqual(cleared.settings, { theme: 'system', userName: '你', contextWindow: 20, streamOutput: true });
    assert.equal(cleared.personas.length, 1);
    assert.deepEqual(cleared.models, []);
    assert.deepEqual(cleared.sessions, []);
    assert.deepEqual(cleared.messages, []);
    assert.equal(await repository.hasDataReset('reset-1'), true);
    await repository.savePersona(extraPersona());
    assert.equal((await repository.resetData('reset-1')).personas.length, 2);
    const reopened = web ? createWebRepository(storage) : createSqlRepository(() => local.db, storage);
    assert.equal(await reopened.hasDataReset('reset-1'), true);
    assert.equal((await reopened.initialize()).companion.profile.name, 'persona-2');
    assert.equal(storage.values.get(LEGACY_STORAGE_KEY), JSON.stringify(legacy));
  });

  test(`${web ? 'web' : 'SQLite'} settings validation rejects invalid writes and damaged stored values without replacing them`, async (t) => {
    const local = setup(t);
    const repository = web ? createWebRepository(local.storage) : local.repository;
    const initial = await repository.initialize();
    for (const patch of [{ contextWindow: 0 }, { contextWindow: 101 }, { contextWindow: 1.5 }, { contextWindow: NaN },
      { userName: ' ' }, { userName: 'x'.repeat(101) }, { theme: 'unknown' }, { streamOutput: 1 }]) {
      await assert.rejects(repository.saveSettings({ ...initial.settings, ...patch }), /设置格式/);
      assert.deepEqual(await repository.initialize(), initial);
    }
    if (web) {
      const doc = JSON.parse(local.storage.values.get(WEB_STORAGE_KEY));
      doc.snapshot.settings.contextWindow = 2.5;
      const damaged = JSON.stringify(doc);
      local.storage.values.set(WEB_STORAGE_KEY, damaged);
      await assert.rejects(createWebRepository(local.storage).initialize(), /设置格式/);
      assert.equal(local.storage.values.get(WEB_STORAGE_KEY), damaged);
    } else {
      local.db.runSync('UPDATE settings SET value = ? WHERE key = ?', [JSON.stringify(2.5), 'context_window']);
      await assert.rejects(createSqlRepository(() => local.db, local.storage).initialize(), /设置格式/);
      assert.equal(local.db.getFirstSync('SELECT value FROM settings WHERE key = ?', ['context_window']).value, '2.5');
    }
  });
}

test('old web documents derive their existing persona without changing user fields and persist it on the next write', async () => {
  const storage = memoryStorage();
  const first = createWebRepository(storage);
  const original = await first.initialize();
  const old = JSON.parse(storage.values.get(WEB_STORAGE_KEY));
  delete old.snapshot.personas; old.schemaVersion = 2;
  const raw = JSON.stringify(old);
  storage.values.set(WEB_STORAGE_KEY, raw);
  const reopened = createWebRepository(storage);
  const upgraded = await reopened.initialize();
  assert.deepEqual(upgraded.companion, original.companion);
  assert.equal(upgraded.personas[0].id, 'persona-default');
  assert.equal(JSON.parse(storage.values.get(WEB_STORAGE_KEY)).schemaVersion, 3);
  await reopened.saveSettings(upgraded.settings);
  assert.equal(JSON.parse(storage.values.get(WEB_STORAGE_KEY)).snapshot.personas.length, 1);
});
