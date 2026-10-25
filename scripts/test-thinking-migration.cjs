/* Independent in-memory SQLite and key-value fixtures. Never opens a device/user database. */
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const test = require('node:test');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: filename,
}).outputText, filename);
const { createDefaultData } = require('../src/features/companion/defaults.ts');
const { createModelThinkingConfig } = require('../src/features/companion/thinking-config.ts');
const { createSqlRepository } = require('../src/lib/db/sql-repository.ts');
const { createWebRepository, WEB_STORAGE_KEY } = require('../src/lib/db/web-repository.ts');
const { LEGACY_STORAGE_KEY } = require('../src/lib/db/legacy.ts');
const { migrateDatabase } = require('../src/lib/db/schema.ts');
const { captureCotAttempt } = require('../src/lib/cot/types.ts');
const clone = (value) => JSON.parse(JSON.stringify(value));
const now = '2026-10-21T00:00:00.000Z';
function storage() {
  const values = new Map(); let failed = false;
  return { values, fail(value) { failed = value; }, async getItem(key) { return values.get(key) ?? null; },
    async setItem(key, value) { if (failed) throw new Error('fixture storage failure'); values.set(key, value); } };
}
function setup(t, web = false) {
  const sqlite = new DatabaseSync(':memory:'); t.after(() => sqlite.close()); const kv = storage();
  const db = { execSync: (sql) => sqlite.exec(sql), runSync: (sql, params = []) => sqlite.prepare(sql).run(...params),
    getAllSync: (sql, params = []) => sqlite.prepare(sql).all(...params).map((row) => ({ ...row })),
    getFirstSync: (sql, params = []) => { const row = sqlite.prepare(sql).get(...params); return row ? { ...row } : null; } };
  const reopen = (adapter = db) => web ? createWebRepository(kv) : createSqlRepository(() => adapter, kv);
  return { db, kv, reopen, repository: reopen() };
}
const model = (id = 'model') => ({ id, name: id, provider: 'custom', baseUrl: 'https://example.test/v1', apiModel: id,
  apiKeyAlias: null, isDefault: true, cotMode: 'off', cotPresetId: null, thinkingConfig: createModelThinkingConfig(), createdAt: now, updatedAt: now });
const session = { id: 'session', title: '原始标题', modelId: 'model', personaId: 'persona-default', pinned: false, createdAt: now, updatedAt: now };
const auditV1 = { version: 1, requestedMode: 'prefill', effectiveMode: 'prefill', templateId: 'template-warm', templateName: '历史模板',
  renderedPrefix: '原正文前缀', warnings: [], nativeParameters: null, modelName: '旧模型', provider: 'custom', apiModel: 'old', baseUrl: 'https://example.test/v1' };
const message = { id: 'reply', sessionId: 'session', role: 'assistant', content: '旧正文', reasoning: '旧思考', status: 'error', error: '旧错误',
  cotMode: 'prefill', thinkingMode: null, cotPresetId: 'template-warm', modelId: 'model', createdAt: now, cotAudit: auditV1 };
function asLegacy(companion, mode = 'prefill') {
  const result = clone(companion); result.schemaVersion = 1; result.thinking.mode = mode;
  delete result.thinking.drafts; delete result.thinking.legacyMode;
  result.thinking.nativeParameters = '{\n  "legacy_parameter": true\n}';
  result.thinking.templates.forEach((template) => { delete template.kind; });
  return result;
}
async function oldDatabase(t) {
  const app = setup(t); await app.repository.initialize();
  for (const id of ['model', 'native', 'prefill', 'persona-bound', 'persona-inline']) await app.repository.saveModel(model(id));
  await app.repository.saveSession(session); await app.repository.saveMessage(message);
  const old = asLegacy((await app.repository.initialize()).companion);
  const { templates, ...thinking } = old.thinking;
  app.db.runSync('UPDATE settings SET value = ? WHERE key = ?', [JSON.stringify(thinking), 'thinking']);
  app.db.runSync("UPDATE models SET cot_mode = CASE WHEN id IN ('persona-bound','persona-inline') THEN 'persona' WHEN id='native' THEN 'native' WHEN id='prefill' THEN 'prefill' ELSE 'off' END");
  app.db.runSync('UPDATE models SET cot_preset_id = ? WHERE id = ?', ['template-warm', 'persona-bound']);
  app.db.execSync(`ALTER TABLE models DROP COLUMN thinking_mode; ALTER TABLE models DROP COLUMN thinking_config;
    ALTER TABLE messages DROP COLUMN thinking_mode; ALTER TABLE cot_presets DROP COLUMN kind; ALTER TABLE personas DROP COLUMN role_config; PRAGMA user_version = 3;`);
  return { ...app, old };
}

test('v3 to v4 adds current modes without changing IDs, FKs, legacy audit bytes, or archived text', async (t) => {
  const app = await oldDatabase(t); const auditRaw = app.db.getFirstSync('SELECT cot_audit FROM messages').cot_audit;
  const migrated = await app.reopen().initialize();
  assert.equal(app.db.getFirstSync('PRAGMA user_version').user_version, 5);
  assert.deepEqual(app.db.getAllSync('PRAGMA foreign_key_check'), []);
  assert.deepEqual(migrated.sessions, [session]); assert.deepEqual(migrated.messages, [message]);
  assert.equal(app.db.getFirstSync('SELECT cot_audit FROM messages').cot_audit, auditRaw);
  assert.equal(migrated.companion.thinking.mode, 'off'); assert.equal(migrated.companion.thinking.legacyMode, 'prefill');
  assert.equal(migrated.companion.thinking.nativeParameters, app.old.thinking.nativeParameters);
  assert.deepEqual(migrated.models.filter((item) => ['native', 'prefill'].includes(item.id)).map((item) => item.cotMode), ['off', 'off']);
  const bound = migrated.models.find((item) => item.id === 'persona-bound');
  assert.equal(bound.cotMode, 'persona'); assert.equal(bound.thinkingConfig.persona.applied.templateId, 'template-warm');
  const inline = migrated.models.find((item) => item.id === 'persona-inline');
  assert.equal(inline.thinkingConfig.persona.applied.text, app.old.thinking.prompt);
  assert.equal(inline.thinkingConfig.persona.applied.templateId, null);
  assert.deepEqual(migrated.migrationNotice.id, 'thinking-v2');
  await app.reopen().dismissMigrationNotice('thinking-v2');
  assert.equal((await app.reopen().initialize()).migrationNotice, null);
  assert.equal(app.db.getFirstSync("SELECT cot_mode FROM models WHERE id='native'").cot_mode, 'native');
});

test('v4 DDL/data failure rolls back columns, modes, notification and version, then retries safely', async (t) => {
  const app = await oldDatabase(t); let fail = true;
  const faulty = { ...app.db, runSync(sql, params = []) {
    if (fail && sql.startsWith('UPDATE models SET thinking_mode') && params.includes('prefill')) throw new Error('fixture migration failure');
    return app.db.runSync(sql, params);
  } };
  assert.throws(() => migrateDatabase(faulty), /fixture migration failure/);
  assert.equal(app.db.getFirstSync('PRAGMA user_version').user_version, 3);
  assert.equal(app.db.getAllSync('PRAGMA table_info(models)').some((item) => item.name === 'thinking_mode'), false);
  assert.equal(JSON.parse(app.db.getFirstSync("SELECT value FROM settings WHERE key='thinking'").value).mode, 'prefill');
  fail = false; assert.equal((await app.reopen(faulty).initialize()).migrationNotice.id, 'thinking-v2');
});

test('damaged v3 thinking settings are refused without committing new schema or changing chat records', async (t) => {
  const app = await oldDatabase(t);
  app.db.runSync('UPDATE settings SET value = ? WHERE key = ?', ['{broken JSON', 'thinking']);
  await assert.rejects(app.reopen().initialize());
  assert.equal(app.db.getFirstSync('PRAGMA user_version').user_version, 3);
  assert.equal(app.db.getFirstSync('SELECT content FROM messages').content, message.content);
  app.db.runSync('DELETE FROM settings WHERE key = ?', ['thinking']);
  await assert.rejects(app.reopen().initialize(), /思维配置缺失/);
  assert.equal(app.db.getFirstSync('PRAGMA user_version').user_version, 3);
});

for (const web of [false, true]) {
  test(`${web ? 'web' : 'SQLite'} initial legacy import disables executable modes and confirms its independent notice once`, async (t) => {
    const app = setup(t, web); const raw = JSON.stringify(asLegacy(createDefaultData(), 'native'));
    app.kv.values.set(LEGACY_STORAGE_KEY, raw);
    const loaded = await app.repository.initialize();
    assert.equal(loaded.companion.thinking.mode, 'off'); assert.equal(loaded.companion.thinking.legacyMode, 'native');
    assert.equal(loaded.notice, null); assert.equal(loaded.migrationNotice.id, 'thinking-v2');
    assert.equal(app.kv.values.get(LEGACY_STORAGE_KEY), raw);
    await app.repository.dismissMigrationNotice('thinking-v2');
    assert.equal((await app.reopen().initialize()).migrationNotice, null);
    if (web) assert.equal(JSON.parse(app.kv.values.get(WEB_STORAGE_KEY)).schemaVersion, 3);
  });

  test(`${web ? 'web' : 'SQLite'} a failed notice acknowledgement remains pending and can be retried`, async (t) => {
    const app = setup(t, web); app.kv.values.set(LEGACY_STORAGE_KEY, JSON.stringify(asLegacy(createDefaultData())));
    await app.repository.initialize();
    let fail = true;
    const faulty = { ...app.db, runSync(sql, params = []) {
      if (fail && params[0] === '_thinking_v2_notice_pending' && params[1] === 'false') throw new Error('fixture acknowledgement failure');
      return app.db.runSync(sql, params);
    } };
    const repo = web ? app.repository : app.reopen(faulty); app.kv.fail(web);
    await assert.rejects(repo.dismissMigrationNotice('thinking-v2'), /fixture/);
    assert.equal((await app.repository.initialize()).migrationNotice.id, 'thinking-v2');
    fail = false; app.kv.fail(false); await repo.dismissMigrationNotice('thinking-v2');
    assert.equal((await app.reopen().initialize()).migrationNotice, null);
  });

  test(`${web ? 'web' : 'SQLite'} all mode bindings clear atomically on deletion and stale queued editors cannot resurrect them`, async (t) => {
    const app = setup(t, web); const data = (await app.repository.initialize()).companion;
    const config = createModelThinkingConfig();
    for (const mode of ['official', 'instruction', 'persona']) {
      data.thinking.templates.push({ id: `t-${mode}`, name: mode, description: '', prompt: `${mode} 文本`, icon: 'sparkles', kind: mode });
      config[mode].draft = { ...config[mode].draft, text: `${mode} 文本`, templateId: `t-${mode}` };
      config[mode].applied = clone(config[mode].draft);
    }
    await app.repository.saveCompanion(data); const record = { ...model(), thinkingConfig: config };
    await app.repository.saveModel(record);
    data.thinking.templates = data.thinking.templates.filter((item) => !item.id.startsWith('t-'));
    await app.repository.saveCompanion(data);
    const cleaned = (await app.repository.initialize()).models[0];
    for (const mode of ['official', 'instruction', 'persona']) {
      assert.equal(cleaned.thinkingConfig[mode].applied, null);
      assert.equal(cleaned.thinkingConfig[mode].draft.templateId, null);
      assert.equal(cleaned.thinkingConfig[mode].draft.text, `${mode} 文本`);
    }
    await assert.rejects(app.repository.saveModel(record), /绑定模板/);
    assert.deepEqual((await app.repository.initialize()).models[0], cleaned);
  });

  test(`${web ? 'web' : 'SQLite'} first legacy retry captures the immutable old audit through further attempts and disk saves`, async (t) => {
    const app = setup(t, web); await app.repository.initialize(); await app.repository.saveModel(model());
    await app.repository.saveSession(session); await app.repository.saveMessage(message);
    const snapshot = { cotMode: message.cotMode, cotPresetId: message.cotPresetId, modelId: message.modelId, audit: auditV1 };
    const audit = { ...auditV1, version: 2, requestedMode: 'official', effectiveMode: 'official', target: 'reasoning_content' };
    const retry = { ...message, thinkingMode: 'official', status: 'pending', cotAudit: audit };
    await assert.rejects(app.repository.saveChatTurn(session, [retry]), /原始历史/);
    retry.cotAudit.legacySnapshot = clone(snapshot);
    await app.repository.saveChatTurn(session, [retry]);
    const final = { ...retry, status: 'done', content: '新回复' };
    await assert.rejects(app.repository.finishChatTurn(session.id, { ...final, cotAudit: { ...audit, legacySnapshot: null } }, now), /原始历史/);
    await app.repository.finishChatTurn(session.id, final, now);
    await app.repository.finishChatTurn(session.id, final, now);
    const next = { ...final, thinkingMode: 'instruction', cotAudit: { ...final.cotAudit,
      requestedMode: 'instruction', effectiveMode: 'instruction', target: 'system-start', originalAttempt: captureCotAttempt(final.cotAudit, final.modelId) } };
    await app.repository.saveChatTurn(session, [next]);
    const saved = (await app.reopen().initialize()).messages[0];
    assert.equal(saved.cotMode, 'prefill'); assert.equal(saved.thinkingMode, 'instruction');
    assert.deepEqual(saved.cotAudit.legacySnapshot, snapshot);
    await assert.rejects(app.repository.saveMessage({ ...next, cotAudit: { ...next.cotAudit,
      legacySnapshot: { ...snapshot, modelId: 'wrong' } } }), /原始历史/);
  });

  test(`${web ? 'web' : 'SQLite'} variable rename covers all model texts atomically and keeps escaped tokens`, async (t) => {
    const app = setup(t, web); const data = (await app.repository.initialize()).companion;
    data.thinking.variables.push({ id: 'x', name: 'x', value: '值' });
    data.thinking.prompt = '{x} {{x}} \\{x}'; await app.repository.saveCompanion(data);
    const config = createModelThinkingConfig();
    for (const mode of ['official', 'instruction', 'persona']) {
      config[mode].draft.text = '{x} {{x}} \\{x}'; config[mode].applied = clone(config[mode].draft);
    }
    await app.repository.saveModel({ ...model(), thinkingConfig: config });
    const variables = data.thinking.variables.map((item) => item.id === 'x' ? { ...item, name: 'renamed' } : item);
    const changed = await app.repository.renameThinkingVariable('x', 'renamed', variables);
    assert.equal(changed.companion.thinking.prompt, '{renamed} {{x}} \\{x}');
    for (const mode of ['official', 'instruction', 'persona']) {
      assert.equal(changed.models[0].thinkingConfig[mode].draft.text, '{renamed} {{x}} \\{x}');
      assert.equal(changed.models[0].thinkingConfig[mode].applied.text, '{renamed} {{x}} \\{x}');
    }
  });

  test(`${web ? 'web' : 'SQLite'} failed template cleanup and variable rename keep every prior binding and text`, async (t) => {
    const app = setup(t, web); const data = (await app.repository.initialize()).companion;
    data.thinking.prompt = '{before}'; data.thinking.variables.push({ id: 'var', name: 'before', value: '原值' });
    await app.repository.saveCompanion(data);
    const config = createModelThinkingConfig(); config.persona.draft = { ...config.persona.draft, text: '{before}', templateId: 'template-warm' };
    config.persona.applied = clone(config.persona.draft); await app.repository.saveModel({ ...model(), thinkingConfig: config });
    const original = await app.repository.initialize();
    let failCleanup = true, failRename = false;
    const faulty = { ...app.db, runSync(sql, params = []) {
      if ((failCleanup && sql.startsWith('UPDATE models SET thinking_config')) ||
        (failRename && sql.startsWith('INSERT INTO models'))) throw new Error('fixture atomic failure');
      return app.db.runSync(sql, params);
    } };
    const repo = web ? app.repository : app.reopen(faulty);
    app.kv.fail(web);
    const removed = clone(data); removed.thinking.templates = [];
    await assert.rejects(repo.saveCompanion(removed), /fixture/);
    assert.deepEqual(await app.repository.initialize(), original);
    failCleanup = false; failRename = true;
    const variables = data.thinking.variables.map((item) => item.id === 'var' ? { ...item, name: 'after' } : item);
    await assert.rejects(repo.renameThinkingVariable('before', 'after', variables), /fixture/);
    assert.deepEqual(await app.repository.initialize(), original);
    failRename = false; app.kv.fail(false);
    assert.equal((await repo.renameThinkingVariable('before', 'after', variables)).models[0].thinkingConfig.persona.applied.text, '{after}');
  });

  test(`${web ? 'web' : 'SQLite'} template purpose changes invalidate applied mode without losing draft text`, async (t) => {
    const app = setup(t, web); const data = (await app.repository.initialize()).companion;
    const config = createModelThinkingConfig(); config.persona.draft = { ...config.persona.draft, templateId: 'template-warm', text: '保留文本' };
    config.persona.applied = clone(config.persona.draft); await app.repository.saveModel({ ...model(), thinkingConfig: config });
    data.thinking.templates[0].kind = 'instruction'; await app.repository.saveCompanion(data);
    const saved = (await app.repository.initialize()).models[0];
    assert.equal(saved.thinkingConfig.persona.applied, null);
    assert.equal(saved.thinkingConfig.persona.draft.text, '保留文本');
    await assert.rejects(app.repository.saveModel({ ...model(), thinkingConfig: config }), /用途不匹配/);
  });
}

test('web envelope v1 migration preserves reset revision and old messages; failed write does not cache or replace source', async (t) => {
  const app = setup(t, true); const data = (await app.repository.initialize()).companion;
  const old = { schemaVersion: 1, resetRevision: 'old-reset', snapshot: { companion: asLegacy(data), settings: { theme: 'system', userName: '你', contextWindow: 20, streamOutput: true },
    models: [{ ...model(), cotMode: 'prefill', thinkingConfig: undefined }], sessions: [session], messages: [message], notice: null } };
  const raw = JSON.stringify(old); app.kv.values.set(WEB_STORAGE_KEY, raw); app.kv.fail(true);
  const repo = app.reopen(); await assert.rejects(repo.initialize(), /fixture storage failure/);
  assert.equal(app.kv.values.get(WEB_STORAGE_KEY), raw);
  app.kv.fail(false); const migrated = await repo.initialize();
  assert.equal(migrated.models[0].cotMode, 'off'); assert.deepEqual(migrated.messages, [message]);
  assert.equal(JSON.parse(app.kv.values.get(WEB_STORAGE_KEY)).schemaVersion, 3);
  assert.equal(await repo.hasDataReset('old-reset'), true);
  await repo.dismissMigrationNotice('thinking-v2'); assert.equal((await app.reopen().initialize()).migrationNotice, null);
});
