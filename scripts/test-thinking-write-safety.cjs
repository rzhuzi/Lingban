/* Real stores, credential compensation, write queue and SQLite; only platform boundaries are injected. */
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const clone = (value) => structuredClone(value);
const settled = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
async function harness(t) {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  const db = {
    execSync: (sql) => sqlite.exec(sql),
    runSync: (sql, params = []) => sqlite.prepare(sql).run(...params),
    getAllSync: (sql, params = []) => sqlite.prepare(sql).all(...params).map((row) => ({ ...row })),
    getFirstSync: (sql, params = []) => { const row = sqlite.prepare(sql).get(...params); return row ? { ...row } : null; },
  };
  const values = new Map(), credentials = new Map(), cache = new Map();
  const storage = { getItem: async (key) => values.get(key) ?? null, setItem: async (key, value) => { values.set(key, value); } };
  const secure = { get: async (key) => credentials.get(key) ?? null,
    set: async (key, value) => { credentials.set(key, value); }, remove: async (key) => { credentials.delete(key); } };
  let repository;
  function load(file) {
    const absolute = path.resolve(root, file);
    if (cache.has(absolute)) return cache.get(absolute).exports;
    const source = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: absolute,
    }).outputText;
    const module = { exports: {} }; cache.set(absolute, module);
    const localRequire = (name) => {
      if (name === '@/lib/db/repository') return { repository };
      if (name === '@/lib/secure') return { credentialStorage: secure };
      if (name === '@/lib/data/reset-service') return { localDataReset: { recover: async () => {} } };
      if (name.startsWith('@/')) return load(`src/${name.slice(2)}.ts`);
      if (name.startsWith('.')) return load(path.relative(root, path.resolve(path.dirname(absolute), `${name}.ts`)));
      return require(name);
    };
    vm.runInThisContext(`(function(require,module,exports){${source}\n})`, { filename: absolute })(localRequire, module, module.exports);
    return module.exports;
  }
  repository = load('src/lib/db/sql-repository.ts').createSqlRepository(() => db, storage);
  const app = load('src/stores/app-stores.ts');
  await app.initializeStores();
  return { ...app, repository, credentials, secure,
    thinking: load('src/features/companion/thinking-config.ts'), editor: load('src/stores/thinking-editor-store.ts').useThinkingEditorStore,
    modelCredentials: load('src/features/models/model-credentials.ts').modelCredentials,
    snapshot: () => repository.initialize(),
  };
}
function modelRecord(config) {
  return { id: 'write-safety-model', name: '本地测试模型', provider: 'custom', baseUrl: 'https://old.example.invalid/v1',
    apiModel: 'fixture', apiKeyAlias: null, isDefault: true, cotMode: 'off', cotPresetId: null,
    createdAt: '2026-10-21T00:00:00.000Z', updatedAt: '2026-10-21T00:00:00.000Z', thinkingConfig: config };
}
async function seedModel(app, model) {
  await app.repository.saveModel(model);
  app.applyAppSnapshot(await app.snapshot());
}
function instructionConfig(app, text) {
  const config = app.thinking.createModelThinkingConfig();
  config.instruction.draft.text = text;
  config.instruction.applied = clone(config.instruction.draft);
  return config;
}

test('Apply recovers a committed credential transaction before changing its revision', async (t) => {
  const app = await harness(t);
  await app.useModelStore.getState().saveModelConfiguration(modelRecord(app.thinking.createModelThinkingConfig()), 'fixture-old-key');
  const previous = clone(app.useModelStore.getState().models[0]);
  const remove = app.secure.remove;
  let failCleanup = true;
  app.secure.remove = async (key) => { if (key === 'lingban_model_pending' && failCleanup) throw new Error('cleanup unavailable'); return remove(key); };
  await app.useModelStore.getState().saveModelConfiguration({ ...previous, baseUrl: 'https://new.example.invalid/v1' }, 'fixture-new-key');
  assert.equal(app.useModelStore.getState().credentialCleanupPending, true);
  assert.equal(app.credentials.has('lingban_model_pending'), true);
  failCleanup = false;
  await app.useModelStore.getState().saveThinkingConfiguration(previous.id, instructionConfig(app, 'new instruction'), 'instruction', 'instruction');
  const current = app.useModelStore.getState().models[0];
  assert.equal(await app.modelCredentials.getApiKey(current.apiKeyAlias), 'fixture-new-key');
  assert.equal(current.baseUrl, 'https://new.example.invalid/v1');
  assert.equal(current.cotMode, 'instruction');
  assert.equal(app.credentials.has('lingban_model_pending'), false);
  assert.equal(app.useModelStore.getState().credentialCleanupPending, false);
  assert.doesNotMatch(JSON.stringify(app.useModelStore.getState()), /fixture-(?:old|new)-key/);
});

test('Apply cannot rewrite a model while credential recovery remains unavailable', async (t) => {
  const app = await harness(t);
  await app.useModelStore.getState().saveModelConfiguration(modelRecord(app.thinking.createModelThinkingConfig()), 'fixture-old-key');
  const remove = app.secure.remove;
  app.secure.remove = async (key) => { if (key === 'lingban_model_pending') throw new Error('cleanup unavailable'); return remove(key); };
  await app.useModelStore.getState().saveModelConfiguration({ ...app.useModelStore.getState().models[0], baseUrl: 'https://new.example.invalid/v1' }, 'fixture-new-key');
  const before = clone((await app.snapshot()).models[0]);
  await assert.rejects(app.useModelStore.getState().saveThinkingConfiguration(before.id, instructionConfig(app, 'must not apply'), 'instruction', 'instruction'));
  assert.deepEqual((await app.snapshot()).models[0], before);
  assert.equal(app.credentials.get(before.apiKeyAlias), 'fixture-new-key');
});

test('template reconciliation uses committed kinds even when the newer kind edit fails to persist', async (t) => {
  const app = await harness(t);
  const template = (await app.snapshot()).companion.thinking.templates[0];
  const config = app.thinking.createModelThinkingConfig();
  config.persona.applied = { ...config.persona.draft, templateId: template.id };
  const model = { ...modelRecord(config), cotMode: 'persona', cotPresetId: template.id };
  await seedModel(app, model);
  const started = deferred(), release = deferred(), secondAttempt = deferred();
  const saveCompanion = app.repository.saveCompanion;
  let saves = 0;
  app.repository.saveCompanion = async (...args) => {
    saves++;
    if (saves === 1) { started.resolve(); await release.promise; return saveCompanion(...args); }
    secondAttempt.resolve(); throw new Error('new kind cannot be saved');
  };
  app.useCotStore.getState().updateThinking({ prompt: 'first committed snapshot' });
  await started.promise;
  const templates = clone(app.useCotStore.getState().thinking.templates);
  templates[0].kind = 'instruction';
  app.useCotStore.getState().updateThinking({ templates });
  release.resolve(); await secondAttempt.promise; await settled(); await settled();
  assert.equal((await app.snapshot()).models[0].thinkingConfig.persona.applied.templateId, template.id);
  assert.equal(app.useModelStore.getState().models[0].thinkingConfig.persona.applied?.templateId, template.id,
    'an uncommitted template kind must not erase the applied model binding');
  assert.match(app.useCotStore.getState().saveError, /保存失败/);
});

test('variable rename locks concurrent settings, companion and temporary editor writes until all tokens agree', async (t) => {
  const app = await harness(t);
  const snapshot = await app.snapshot();
  snapshot.companion.thinking.variables.push({ id: 'tone-variable', name: 'tone', value: '温和' });
  snapshot.companion.thinking.prompt = 'global {tone}';
  await app.repository.saveCompanion(snapshot.companion, 'persona-default');
  const config = app.thinking.createModelThinkingConfig();
  config.persona.draft.text = 'draft {tone}'; config.persona.applied = { ...config.persona.draft, text: 'applied {tone}' };
  const model = { ...modelRecord(config), cotMode: 'persona' };
  await seedModel(app, model);
  const editorId = app.editor.getState().begin(model);
  const started = deferred(), release = deferred();
  const rename = app.repository.renameThinkingVariable;
  app.repository.renameThinkingVariable = async (...args) => { started.resolve(); await release.promise; return rename(...args); };
  const variables = app.useCotStore.getState().thinking.variables.map((variable) => variable.name === 'tone' ? { ...variable, name: 'voice' } : variable);
  const renaming = app.useCotStore.getState().renameThinkingVariable('tone', 'voice', variables);
  await started.promise;
  try {
    app.useCotStore.getState().updateThinking({ prompt: 'concurrent old {tone}' });
    app.useSettingsStore.getState().updateSettings({ userName: 'concurrent old setting' });
    const staleEditor = clone(config); staleEditor.persona.draft.text = 'concurrent old editor {tone}';
    // Either refusing or ignoring an edit while locked is safe; accepting it is not.
    try { app.editor.getState().update(editorId, { thinkingConfig: staleEditor }); } catch {}
  } finally { release.resolve(); }
  await renaming;
  await app.runAppMaintenance(async () => {});
  const saved = await app.snapshot();
  assert.ok(saved.companion.thinking.variables.some((variable) => variable.name === 'voice'));
  assert.ok(!saved.companion.thinking.variables.some((variable) => variable.name === 'tone'));
  assert.match(saved.companion.thinking.prompt, /\{voice\}/); assert.doesNotMatch(saved.companion.thinking.prompt, /\{tone\}/);
  assert.equal(saved.models[0].thinkingConfig.persona.applied.text, 'applied {voice}');
  assert.equal(app.editor.getState().sessions[editorId].model.thinkingConfig.persona.draft.text, 'draft {voice}');
  assert.deepEqual(app.useCotStore.getState().thinking, saved.companion.thinking);
  assert.deepEqual(app.useSettingsStore.getState().settings, saved.settings);
  assert.equal(app.useAppMaintenanceStore.getState().active, false);
  assert.equal(app.editor.getState().locked, false);
});

for (const operation of ['draft', 'Apply']) {
  test(`a stale metadata/key save preserves a newer thinking ${operation} without an explicit baseline`, async (t) => {
    const app = await harness(t);
    await app.useModelStore.getState().saveModelConfiguration(modelRecord(app.thinking.createModelThinkingConfig()), 'fixture-old-key');
    const stale = clone(app.useModelStore.getState().models[0]);
    const updated = instructionConfig(app, 'new thinking content');
    await app.useModelStore.getState().saveThinkingConfiguration(stale.id, updated, operation === 'Apply' ? 'instruction' : undefined, 'instruction');
    const committed = clone(app.useModelStore.getState().models[0]);
    if (operation === 'draft') assert.equal(committed.updatedAt, stale.updatedAt, 'draft writes must not invalidate an in-flight send');
    await app.useModelStore.getState().saveModelConfiguration({ ...stale, name: 'renamed metadata' }, 'fixture-new-key');
    const saved = app.useModelStore.getState().models[0];
    assert.equal(saved.name, 'renamed metadata');
    assert.equal(saved.cotMode, committed.cotMode); assert.deepEqual(saved.thinkingConfig, committed.thinkingConfig);
    assert.equal(await app.modelCredentials.getApiKey(saved.apiKeyAlias), 'fixture-new-key');
  });

  test(`an explicit stale thinking baseline rejects a conflicting ${operation} before changing credentials`, async (t) => {
    const app = await harness(t);
    await app.useModelStore.getState().saveModelConfiguration(modelRecord(app.thinking.createModelThinkingConfig()), 'fixture-old-key');
    const stale = clone(app.useModelStore.getState().models[0]);
    const baseline = { cotMode: stale.cotMode, thinkingConfig: clone(stale.thinkingConfig) };
    await app.useModelStore.getState().saveThinkingConfiguration(stale.id, instructionConfig(app, 'new thinking content'), operation === 'Apply' ? 'instruction' : undefined, 'instruction');
    const committed = clone((await app.snapshot()).models[0]);
    await assert.rejects(app.useModelStore.getState().saveModelConfiguration({ ...stale, name: 'must not overwrite' }, 'fixture-new-key', baseline));
    assert.deepEqual((await app.snapshot()).models[0], committed);
    assert.equal(await app.modelCredentials.getApiKey(committed.apiKeyAlias), 'fixture-old-key');
  });
}

test('a matching explicit baseline can save intended thinking changes together with the model key', async (t) => {
  const app = await harness(t);
  await app.useModelStore.getState().saveModelConfiguration(modelRecord(app.thinking.createModelThinkingConfig()), 'fixture-old-key');
  const current = clone(app.useModelStore.getState().models[0]);
  const baseline = { cotMode: current.cotMode, thinkingConfig: clone(current.thinkingConfig) };
  await app.useModelStore.getState().saveModelConfiguration({ ...current, cotMode: 'instruction',
    thinkingConfig: instructionConfig(app, 'intentionally applied') }, 'fixture-new-key', baseline);
  const saved = app.useModelStore.getState().models[0];
  assert.equal(saved.cotMode, 'instruction');
  assert.equal(saved.thinkingConfig.instruction.applied.text, 'intentionally applied');
  assert.equal(await app.modelCredentials.getApiKey(saved.apiKeyAlias), 'fixture-new-key');
});

test('rename prevalidates temporary editors and releases its lock without partially committing on failure', async (t) => {
  const app = await harness(t);
  const before = await app.snapshot();
  before.companion.thinking.variables.push({ id: 'short-variable', name: 'a', value: 'kept' });
  await app.repository.saveCompanion(before.companion, 'persona-default');
  app.applyAppSnapshot(await app.snapshot());
  const config = app.thinking.createModelThinkingConfig(); config.persona.draft.text = '{a}'.repeat(5000);
  const id = app.editor.getState().begin(modelRecord(config));
  let renames = 0;
  const rename = app.repository.renameThinkingVariable;
  app.repository.renameThinkingVariable = async (...args) => { renames++; return rename(...args); };
  const variables = app.useCotStore.getState().thinking.variables.map((variable) => variable.name === 'a' ? { ...variable, name: 'muchLongerName' } : variable);
  await assert.rejects(app.useCotStore.getState().renameThinkingVariable('a', 'muchLongerName', variables), /字符上限/);
  assert.equal(renames, 0, 'temporary editor failures must be discovered before a database rename');
  assert.ok((await app.snapshot()).companion.thinking.variables.some((variable) => variable.name === 'a'));
  assert.equal(app.editor.getState().sessions[id].model.thinkingConfig.persona.draft.text, config.persona.draft.text);
  assert.equal(app.editor.getState().locked, false); assert.equal(app.useAppMaintenanceStore.getState().active, false);
});
