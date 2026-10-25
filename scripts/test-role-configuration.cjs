const assert = require('node:assert/strict');
const { test } = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: filename,
}).outputText, filename);

const { createSqlRepository } = require('../src/lib/db/sql-repository.ts');
const { createWebRepository, WEB_STORAGE_KEY } = require('../src/lib/db/web-repository.ts');
const { migrateDatabase } = require('../src/lib/db/schema.ts');
const { createRoleConfiguration, createRoleModelConfiguration, getRoleModelConfiguration, resolveRoleRuntime } = require('../src/features/companion/role-config.ts');
const { createModelThinkingConfig } = require('../src/features/companion/thinking-config.ts');
const clone = (value) => JSON.parse(JSON.stringify(value));
const now = '2026-10-22T08:00:00.000Z';
const model = (id = 'shared') => ({ id, name: id, provider: 'custom', baseUrl: 'https://example.test/v1', apiModel: id,
  apiKeyAlias: `model_${id}`, isDefault: true, cotMode: 'off', cotPresetId: null, thinkingConfig: createModelThinkingConfig(), createdAt: now, updatedAt: now });
const storage = () => { const values = new Map(); return { values, failed: false,
  async getItem(key) { return values.get(key) ?? null; }, async setItem(key, value) { if (this.failed) throw new Error('write failed'); values.set(key, value); } }; };
function setup(t, web) {
  const kv = storage();
  if (web) return { kv, repo: createWebRepository(kv), reopen: () => createWebRepository(kv) };
  const sql = new DatabaseSync(':memory:'); t.after(() => sql.close());
  const db = { execSync: (query) => sql.exec(query), runSync: (query, args = []) => sql.prepare(query).run(...args),
    getAllSync: (query, args = []) => sql.prepare(query).all(...args).map((row) => ({ ...row })),
    getFirstSync: (query, args = []) => { const row = sql.prepare(query).get(...args); return row ? { ...row } : null; } };
  return { kv, db, repo: createSqlRepository(() => db, kv), reopen: () => createSqlRepository(() => db, kv) };
}
function role(id, source, text, modelId = 'shared') {
  const result = clone(source); result.id = id; result.isActive = id === source.id; result.profile.name = id; result.memories = [];
  const configuration = createRoleConfiguration(); configuration.confirmed = true; configuration.currentModelId = modelId;
  const thinking = createModelThinkingConfig();
  thinking.instruction.draft.text = text; thinking.instruction.applied = clone(thinking.instruction.draft);
  configuration.models[modelId] = { mode: 'instruction', thinking }; result.configuration = configuration;
  return result;
}

for (const web of [false, true]) {
  const platform = web ? 'web' : 'SQLite';
  test(`${platform} roles share a model but own independent prompts, variables and chat settings after restart`, async (t) => {
    const app = setup(t, web); const first = await app.repo.initialize(); const shared = model();
    const a = role(first.personas[0].id, first.personas[0], 'A {word}');
    a.configuration.variables = [{ id: 'a-var', name: 'word', value: '甲' }]; a.configuration.chatSettings.contextWindow = 7;
    await app.repo.saveRole(a, first.personas[0], shared);
    const b = role('role-b', first.personas[0], 'B {word}'); b.configuration.variables = [{ id: 'b-var', name: 'word', value: '乙' }];
    b.configuration.chatSettings.streamOutput = false; await app.repo.saveRole(b, null);
    const snapshot = await app.reopen().initialize(); assert.equal(snapshot.models.length, 1);
    const runtimeA = resolveRoleRuntime(snapshot.personas[0], snapshot.models, snapshot.companion.thinking, snapshot.settings);
    const runtimeB = resolveRoleRuntime(snapshot.personas[1], snapshot.models, snapshot.companion.thinking, snapshot.settings);
    assert.equal(runtimeA.model.thinkingConfig.instruction.applied.text, 'A {word}');
    assert.equal(runtimeB.model.thinkingConfig.instruction.applied.text, 'B {word}');
    assert.equal(runtimeA.data.thinking.variables.find((item) => item.name === 'word').value, '甲');
    assert.equal(runtimeB.data.thinking.variables.find((item) => item.name === 'word').value, '乙');
    assert.equal(runtimeA.settings.contextWindow, 7); assert.equal(runtimeB.settings.streamOutput, false);
    runtimeA.model.thinkingConfig.instruction.applied.text = 'changed snapshot';
    assert.equal(snapshot.personas[0].configuration.models.shared.thinking.instruction.applied.text, 'A {word}');
  });

  test(`${platform} stale role save with a pending model rolls back both records and cannot resurrect a deleted role`, async (t) => {
    const app = setup(t, web); const first = await app.repo.initialize();
    const a = role(first.personas[0].id, first.personas[0], 'first'); await app.repo.saveRole(a, first.personas[0], model());
    const baseline = (await app.repo.initialize()).personas[0];
    await app.repo.saveRole({ ...clone(baseline), profile: { ...baseline.profile, description: 'newer' } }, baseline);
    const stale = clone(baseline); stale.configuration.currentModelId = 'new-model';
    stale.configuration.models['new-model'] = getRoleModelConfiguration(stale.configuration, 'new-model');
    await assert.rejects(app.repo.saveRole(stale, baseline, model('new-model')), /其他页面更新/);
    const after = await app.repo.initialize(); assert.equal(after.models.length, 1); assert.equal(after.personas[0].profile.description, 'newer');
    const b = role('role-b', first.personas[0], 'second'); await app.repo.saveRole(b, null); await app.repo.deletePersona('role-b');
    await assert.rejects(app.repo.saveRole(b, b), /已删除/);
  });

  test(`${platform} invalid combined save never leaves a new model or changes the previous role`, async (t) => {
    const app = setup(t, web); const first = await app.repo.initialize(); const invalid = role(first.personas[0].id, first.personas[0], '');
    await assert.rejects(app.repo.saveRole(invalid, first.personas[0], model()), /不能为空/);
    assert.deepEqual(await app.repo.initialize(), first);
    const valid = role(first.personas[0].id, first.personas[0], 'valid text');
    await assert.rejects(app.repo.saveRole(valid, first.personas[0], model('unrelated-model')), /选择不一致/);
    assert.deepEqual(await app.repo.initialize(), first);
  });

  test(`${platform} deleting an in-use model is blocked while profile edits preserve the full role configuration`, async (t) => {
    const app = setup(t, web); const first = await app.repo.initialize(); const a = role(first.personas[0].id, first.personas[0], 'independent');
    await app.repo.saveRole(a, first.personas[0], model()); await assert.rejects(app.repo.deleteModel('shared'), /正由/);
    const current = await app.repo.initialize(); const data = clone(current.companion); data.profile.description = 'edited';
    await app.repo.saveCompanion(data, a.id);
    const after = await app.reopen().initialize(); assert.deepEqual(after.personas[0].configuration, a.configuration);
    assert.equal(after.personas[0].profile.description, 'edited');
  });

  test(`${platform} copied template survives library changes without changing the role or the old model archive`, async (t) => {
    const app = setup(t, web); const first = await app.repo.initialize(); const old = model(); old.cotMode = 'persona';
    const template = first.companion.thinking.templates[0];
    old.thinkingConfig.persona.applied = { ...old.thinkingConfig.persona.draft, text: 'stale inline text', templateId: template.id };
    await app.repo.saveModel(old); const a = clone(first.personas[0]); a.configuration.confirmed = true;
    a.configuration.currentModelId = old.id; a.configuration.models[old.id] = createRoleModelConfiguration(old, first.companion.thinking);
    await app.repo.saveRole(a, first.personas[0]); const data = clone((await app.repo.initialize()).companion); data.thinking.templates = []; data.thinking.selectedTemplateId = null;
    await app.repo.saveCompanion(data); const after = await app.reopen().initialize();
    assert.equal(after.personas[0].configuration.models.shared.thinking.persona.applied.text, template.prompt);
    assert.equal(after.personas[0].configuration.models.shared.thinking.persona.applied.templateId, null);
    assert.equal(resolveRoleRuntime(after.personas[0], after.models, after.companion.thinking, after.settings).model.cotMode, 'persona');
  });

  test(`${platform} explicit off preserves a blocked archive and switching its mode back remains blocked`, async (t) => {
    const app = setup(t, web); const first = await app.repo.initialize(); const a = role(first.personas[0].id, first.personas[0], 'retained old text');
    a.configuration.models.shared.blockedReason = '旧模板已失效，请明确检查内容';
    a.configuration.models.shared.mode = 'off'; await app.repo.saveRole(a, first.personas[0], model());
    const saved = await app.reopen().initialize(); const savedRole = saved.personas[0];
    assert.equal(savedRole.configuration.models.shared.blockedReason, '旧模板已失效，请明确检查内容');
    assert.equal(savedRole.configuration.models.shared.thinking.instruction.applied.text, 'retained old text');
    assert.equal(resolveRoleRuntime(savedRole, saved.models, saved.companion.thinking, saved.settings).model.cotMode, 'off');
    const enabled = clone(savedRole); enabled.configuration.models.shared.mode = 'instruction';
    assert.throws(() => resolveRoleRuntime(enabled, saved.models, saved.companion.thinking, saved.settings), /旧模板已失效/);
    await assert.rejects(app.repo.saveRole(enabled, savedRole), /旧模板已失效/);
    assert.equal((await app.repo.initialize()).personas[0].configuration.models.shared.mode, 'off');
  });
}

test('v4 SQLite migration preserves model archive and copies old settings/variables without guessing a binding', async (t) => {
  const app = setup(t, false); const first = await app.repo.initialize();
  await app.repo.saveSettings({ ...first.settings, contextWindow: 41, streamOutput: false });
  const data = clone(first.companion); data.thinking.variables.push({ id: 'old-var', name: 'nickname', value: '旧变量' });
  await app.repo.saveCompanion(data); await app.repo.saveModel(model());
  const oldModel = (await app.repo.initialize()).models[0];
  app.db.execSync('ALTER TABLE personas DROP COLUMN role_config; PRAGMA user_version = 4;');
  const upgraded = await app.reopen().initialize(); const config = upgraded.personas[0].configuration;
  assert.equal(app.db.getFirstSync('PRAGMA user_version').user_version, 5);
  assert.equal(config.confirmed, false); assert.equal(config.currentModelId, null); assert.deepEqual(config.models, {});
  assert.equal(config.chatSettings.contextWindow, 41); assert.equal(config.chatSettings.streamOutput, false);
  assert.equal(config.variables.find((item) => item.name === 'nickname').value, '旧变量'); assert.deepEqual(upgraded.models[0], oldModel);
  assert.throws(() => resolveRoleRuntime(upgraded.personas[0], upgraded.models, upgraded.companion.thinking, upgraded.settings), /确认模型/);
  assert.deepEqual(await app.reopen().initialize(), upgraded);
});

test('v5 SQLite DDL failure rolls back role column and version, then succeeds on retry', async (t) => {
  const app = setup(t, false); await app.repo.initialize(); app.db.execSync('ALTER TABLE personas DROP COLUMN role_config; PRAGMA user_version = 4;');
  const faulty = { ...app.db, execSync(query) { app.db.execSync(query); if (query.includes('ADD COLUMN role_config')) throw new Error('DDL failure'); } };
  assert.throws(() => migrateDatabase(faulty), /DDL failure/); assert.equal(app.db.getFirstSync('PRAGMA user_version').user_version, 4);
  assert.equal(app.db.getAllSync('PRAGMA table_info(personas)').some((item) => item.name === 'role_config'), false);
  migrateDatabase(app.db); assert.equal(app.db.getFirstSync('PRAGMA user_version').user_version, 5);
});

test('web v2 migration persists copied role settings atomically and retries failed migration', async (t) => {
  const app = setup(t, true); const snapshot = await app.repo.initialize(); const old = { schemaVersion: 2, snapshot: clone(snapshot) };
  delete old.snapshot.personas[0].configuration; old.snapshot.settings.contextWindow = 37;
  const raw = JSON.stringify(old); app.kv.values.set(WEB_STORAGE_KEY, raw); app.kv.failed = true;
  await assert.rejects(app.reopen().initialize(), /write failed/); assert.equal(app.kv.values.get(WEB_STORAGE_KEY), raw);
  app.kv.failed = false; const after = await app.reopen().initialize();
  assert.equal(after.personas[0].configuration.chatSettings.contextWindow, 37); assert.equal(after.personas[0].configuration.confirmed, false);
  assert.equal(JSON.parse(app.kv.values.get(WEB_STORAGE_KEY)).schemaVersion, 3); assert.deepEqual(await app.reopen().initialize(), after);
});

test('invalid old template bindings retain a blocked state instead of silently executing stale text', () => {
  const old = model(); old.cotMode = 'instruction'; old.thinkingConfig.instruction.applied = { ...old.thinkingConfig.instruction.draft,
    text: 'stale', templateId: 'missing' };
  const migrated = createRoleModelConfiguration(old, { templates: [] });
  assert.equal(migrated.mode, 'instruction'); assert.match(migrated.blockedReason, /模板/);
  assert.equal(migrated.thinking.instruction.applied.text, 'stale');
});
