const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '..');
const clone = (value) => structuredClone(value);
const settled = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Exercise the real stores in Node without importing native SQLite modules.
function harness() {
  const cache = new Map();
  const calls = [];
  const credentials = new Map();
  const reset = { recover: async () => {} };
  let stored;
  const ensurePersonas = () => {
    stored.personas ??= [{ id: 'persona-default', profile: clone(stored.companion.profile),
      memories: clone(stored.companion.memories), interests: clone(stored.companion.interests), isActive: true }];
    return stored.personas;
  };
  const syncActive = () => {
    const active = stored.personas.find((item) => item.isActive);
    stored.companion = { ...stored.companion, profile: clone(active.profile), memories: clone(active.memories), interests: clone(active.interests) };
  };
  const repository = {
    initialize: async () => clone(stored),
    saveCompanion: async (value, ownerId) => {
      calls.push(['companion', clone(value), ownerId]);
      if (stored.personas) {
        const owner = stored.personas.find((item) => item.id === ownerId);
        if (!owner) throw new Error('missing owner');
        Object.assign(owner, { profile: clone(value.profile), memories: clone(value.memories), interests: clone(value.interests) });
        stored.companion.thinking = clone(value.thinking);
        syncActive();
      } else stored.companion = clone(value);
      const templateIds = new Set(value.thinking.templates.map((template) => template.id));
      stored.models = stored.models.map((model) => model.cotPresetId !== null && !templateIds.has(model.cotPresetId)
        ? { ...model, cotPresetId: null } : model);
      const userNameVariable = value.thinking.variables.find((item) => item.name === 'user_name');
      if (userNameVariable) stored.settings.userName = userNameVariable.value;
    },
    saveSettings: async (value) => {
      calls.push(['settings', clone(value)]);
      stored.settings = clone(value);
      stored.companion.thinking.variables = stored.companion.thinking.variables.map((item) =>
        item.name === 'user_name' ? { ...item, value: value.userName } : item);
    },
    saveModel: async (value) => {
      assert.ok(value.cotPresetId === null || stored.companion.thinking.templates.some((template) =>
        template.id === value.cotPresetId), 'model binding must reference a committed template');
      calls.push(['model', clone(value)]);
      stored.models = [...stored.models.filter((model) => model.id !== value.id)
        .map((model) => value.isDefault ? { ...model, isDefault: false } : model), clone(value)];
    },
    savePersona: async (value) => {
      ensurePersonas();
      calls.push(['persona', clone(value)]);
      stored.personas = [...stored.personas.filter((item) => item.id !== value.id)
        .map((item) => value.isActive ? { ...item, isActive: false } : item), clone(value)];
      syncActive();
      return clone(stored);
    },
    setActivePersona: async (id) => {
      const personas = ensurePersonas();
      if (!personas.some((item) => item.id === id)) throw new Error('missing owner');
      calls.push(['switch', id]);
      stored.personas = personas.map((item) => ({ ...item, isActive: item.id === id }));
      syncActive();
      return clone(stored);
    },
    deletePersona: async (id) => {
      const personas = ensurePersonas();
      if (personas.length < 2) throw new Error('at least one');
      calls.push(['delete-persona', id]);
      stored.personas = personas.filter((item) => item.id !== id);
      if (!stored.personas.some((item) => item.isActive)) stored.personas[0].isActive = true;
      stored.sessions = stored.sessions.map((session) => session.personaId === id ? { ...session, personaId: null } : session);
      syncActive();
      return clone(stored);
    },
  };
  function load(file) {
    const absolute = path.resolve(root, file);
    if (cache.has(absolute)) return cache.get(absolute).exports;
    const source = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const module = { exports: {} };
    cache.set(absolute, module);
    const scopedRequire = (name) => {
      if (name === '@/lib/db/repository') return { repository };
      if (name === '@/lib/data/reset-service') return { localDataReset: reset };
      if (name === '@/lib/secure') return { credentialStorage: {
        get: async (key) => credentials.get(key) ?? null,
        set: async (key, value) => { credentials.set(key, value); },
        remove: async (key) => { credentials.delete(key); },
      } };
      if (name.startsWith('@/')) return load(`src/${name.slice(2)}.ts`);
      if (name.startsWith('.')) return load(path.relative(root, path.resolve(path.dirname(absolute), `${name}.ts`)));
      return require(name);
    };
    vm.runInThisContext(`(function(require,module,exports){${source}\n})`, { filename: absolute })(scopedRequire, module, module.exports);
    return module.exports;
  }
  const { createDefaultData } = load('src/features/companion/defaults.ts');
  const { DEFAULT_SETTINGS } = load('src/lib/db/types.ts');
  stored = { companion: createDefaultData(), settings: clone(DEFAULT_SETTINGS), models: [], sessions: [], messages: [], notice: null };
  const stores = load('src/stores/app-stores.ts');
  return { ...stores, repository, calls, credentials, reset, runtime: load('src/lib/chat/runtime.ts'),
    thinking: load('src/features/companion/thinking-config.ts'), editor: load('src/stores/thinking-editor-store.ts'), stored: () => stored };
}

function modelRecord() {
  return {
    id: 'model-test', name: '自定义模型', provider: 'custom', baseUrl: 'https://example.com/v1',
    apiModel: 'test', apiKeyAlias: null, isDefault: false, cotMode: 'prefill', cotPresetId: 'template-warm',
    createdAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-20T00:00:00.000Z',
  };
}

test('thinking draft writes around Apply preserve the latest committed applied snapshot', async () => {
  const app = harness();
  const config = app.thinking.createModelThinkingConfig();
  const model = { ...modelRecord(), cotMode: 'off', cotPresetId: null, thinkingConfig: config };
  app.stored().models = [clone(model)];
  await app.initializeStores();
  const firstDraft = clone(config);
  firstDraft.instruction.draft.text = 'applied instruction';
  const first = app.useModelStore.getState().saveThinkingConfiguration(model.id, firstDraft, undefined, 'instruction');
  const toApply = clone(firstDraft);
  toApply.instruction.applied = clone(toApply.instruction.draft);
  const apply = app.useModelStore.getState().saveThinkingConfiguration(model.id, toApply, 'instruction', 'instruction');
  const staleLaterDraft = clone(firstDraft); // Carries the old null applied value.
  staleLaterDraft.instruction.draft.text = 'new unapplied draft';
  const later = app.useModelStore.getState().saveThinkingConfiguration(model.id, staleLaterDraft, undefined, 'instruction');
  await Promise.all([first, apply, later]);
  const saved = app.useModelStore.getState().models[0];
  assert.equal(saved.cotMode, 'instruction');
  assert.equal(saved.thinkingConfig.instruction.applied.text, 'applied instruction');
  assert.equal(saved.thinkingConfig.instruction.draft.text, 'new unapplied draft');
  assert.equal(app.credentials.size, 0);
});

test('thinking writes preserve latest other model fields and other mode slots', async () => {
  const app = harness();
  const config = app.thinking.createModelThinkingConfig();
  const model = { ...modelRecord(), cotMode: 'off', cotPresetId: null, thinkingConfig: config };
  app.stored().models = [clone(model), { ...clone(model), id: 'other-model' }];
  await app.initializeStores();
  const officialDraft = clone(config);
  officialDraft.official.draft.text = 'official draft';
  const instructionDraft = clone(config);
  instructionDraft.instruction.draft.text = 'independent instruction';
  await Promise.all([
    app.useModelStore.getState().saveThinkingConfiguration(model.id, officialDraft, undefined, 'official'),
    app.useModelStore.getState().saveThinkingConfiguration(model.id, instructionDraft, undefined, 'instruction'),
  ]);
  const saved = app.useModelStore.getState().models.find((item) => item.id === model.id);
  assert.equal(saved.thinkingConfig.official.draft.text, 'official draft');
  assert.equal(saved.thinkingConfig.instruction.draft.text, 'independent instruction');
  assert.equal(saved.baseUrl, model.baseUrl);
  assert.equal(app.useModelStore.getState().models.find((item) => item.id === 'other-model').thinkingConfig.instruction.draft.text, '');
});

test('temporary thinking editor whitelists model metadata and never takes ownership of API keys', () => {
  const app = harness();
  const store = app.editor.useThinkingEditorStore;
  const id = store.getState().begin({ ...modelRecord(), cotMode: 'off', apiKey: 'SECRET_SHOULD_NOT_ENTER_STATE', password: 'SECRET_PASSWORD' });
  assert.doesNotMatch(JSON.stringify(store.getState().sessions), /SECRET_|apiKey"|password/);
  const config = app.thinking.createModelThinkingConfig();
  config.instruction.draft.text = 'local only';
  store.getState().update(id, { thinkingConfig: config });
  config.instruction.draft.text = 'mutated after update';
  assert.equal(store.getState().sessions[id].model.thinkingConfig.instruction.draft.text, 'local only');
  store.getState().remove(id);
  assert.equal(store.getState().sessions[id], undefined);
  assert.equal(app.calls.length, 0);
});

test('migration notice dismissal is durable and a failed write keeps the notice retryable', async () => {
  const app = harness();
  app.stored().migrationNotice = { id: 'thinking-v2', message: '旧模式已停用' };
  await app.initializeStores();
  let fail = true;
  app.repository.dismissMigrationNotice = async () => {
    if (fail) throw new Error('disk failure');
    app.stored().migrationNotice = null;
  };
  await app.useAppRecoveryStore.getState().dismissMigrationNotice();
  assert.ok(app.useAppRecoveryStore.getState().migrationNotice);
  assert.match(app.useAppRecoveryStore.getState().migrationError, /保存失败/);
  fail = false;
  await app.useAppRecoveryStore.getState().dismissMigrationNotice();
  assert.equal(app.useAppRecoveryStore.getState().migrationNotice, null);
  assert.equal(app.stored().migrationNotice, null);
});

test('startup recovery notices are available independently of write errors and can be dismissed', async () => {
  const app = harness();
  app.stored().notice = '个别历史消息的配置快照已忽略，聊天正文和会话已保留。';
  await app.initializeStores();
  assert.equal(app.useAppRecoveryStore.getState().notice, app.stored().notice);
  assert.equal(app.usePersonaStore.getState().saveError, null);
  assert.equal(app.useCotStore.getState().saveError, null);
  app.useAppRecoveryStore.getState().dismissNotice();
  assert.equal(app.useAppRecoveryStore.getState().notice, null);
  assert.equal(app.calls.length, 0);
  app.applyAppSnapshot({ ...clone(app.stored()), notice: null });
  assert.equal(app.useAppRecoveryStore.getState().notice, null);
});

test('startup is shared, rejects safely, and can retry without writing unhydrated defaults', async () => {
  const app = harness();
  let attempts = 0;
  const initialize = app.repository.initialize;
  app.repository.initialize = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('database unavailable');
    return initialize();
  };
  app.usePersonaStore.getState().updateProfile({ name: 'must not persist' });
  app.useSettingsStore.getState().updateSettings({ theme: 'dark' });
  const first = app.initializeStores();
  assert.equal(app.initializeStores(), first);
  await assert.rejects(first, /database unavailable/);
  assert.equal(app.usePersonaStore.getState().ready, false);
  assert.equal(app.calls.length, 0);
  await app.initializeStores();
  assert.equal(attempts, 2);
  for (const key of ['usePersonaStore', 'useCotStore', 'useModelStore', 'useChatStore', 'useSettingsStore']) {
    assert.equal(app[key].getState().ready, true);
  }
  assert.equal(app.usePersonaStore.getState().profile.name, '小零');
});

test('autosave keeps the latest draft after an in-flight write fails, then retries it', async () => {
  const app = harness();
  await app.initializeStores();
  const firstWrite = deferred();
  const save = app.repository.saveCompanion;
  let writes = 0;
  app.repository.saveCompanion = async (value) => {
    writes += 1;
    if (writes === 1) await firstWrite.promise;
    return save(value);
  };
  app.usePersonaStore.getState().updateProfile({ name: '第一版' });
  await settled();
  app.usePersonaStore.getState().updateProfile({ name: '最新名字', coverUri: 'file:///custom-cover.jpg' });
  app.useCotStore.getState().updateThinking({ prompt: '自定义提示词' });
  firstWrite.reject(new Error('disk full'));
  await settled();
  assert.equal(app.usePersonaStore.getState().profile.name, '最新名字');
  assert.equal(app.useCotStore.getState().thinking.prompt, '自定义提示词');
  assert.match(app.usePersonaStore.getState().saveError, /保存失败/);
  app.usePersonaStore.getState().retrySave();
  await settled();
  assert.equal(app.stored().companion.profile.name, '最新名字');
  assert.equal(app.stored().companion.profile.coverUri, 'file:///custom-cover.jpg');
  assert.equal(app.stored().companion.thinking.prompt, '自定义提示词');
  assert.equal(app.usePersonaStore.getState().saveError, null);
  assert.equal(writes, 2);
});

test('coalescing moves a newer snapshot behind cross-channel writes sharing user_name', async () => {
  const app = harness();
  await app.initializeStores();
  app.useSettingsStore.getState().updateSettings({ userName: '旧名字' });
  app.useCotStore.getState().updateThinking({ variables: [{ id: 'name', name: 'user_name', value: '新名字' }] });
  app.useSettingsStore.getState().updateSettings({ theme: 'dark' });
  await settled();
  assert.deepEqual(app.calls.map(([kind]) => kind), ['companion', 'settings']);
  assert.equal(app.stored().settings.userName, '新名字');
  assert.equal(app.stored().settings.theme, 'dark');
  assert.equal(app.stored().companion.thinking.variables[0].value, '新名字');
  assert.equal(app.useSettingsStore.getState().settings.userName, '新名字');
});

test('failed settings save cannot overwrite a later prompt-variable edit after retry', async () => {
  const app = harness();
  await app.initializeStores();
  const pending = deferred();
  const save = app.repository.saveSettings;
  let writes = 0;
  app.repository.saveSettings = async (value) => {
    writes += 1;
    if (writes === 1) await pending.promise;
    return save(value);
  };
  app.useSettingsStore.getState().updateSettings({ userName: '设置名字', theme: 'dark' });
  await settled();
  app.useCotStore.getState().updateThinking({ variables: [{ id: 'name', name: 'user_name', value: '变量名字' }] });
  pending.reject(new Error('temporarily unavailable'));
  await settled();
  assert.match(app.useSettingsStore.getState().saveError, /保存失败/);
  app.useSettingsStore.getState().retrySave();
  await settled();
  assert.equal(app.stored().settings.userName, '变量名字');
  assert.equal(app.stored().companion.thinking.variables[0].value, '变量名字');
  assert.equal(app.stored().settings.theme, 'dark');
  assert.equal(app.useSettingsStore.getState().saveError, null);
});

test('changing settings never recreates a deliberately deleted user_name variable', async () => {
  const app = harness();
  await app.initializeStores();
  app.useCotStore.getState().updateThinking({ variables: [] });
  app.useSettingsStore.getState().updateSettings({ userName: 'new name' });
  await settled();
  assert.equal(app.useCotStore.getState().thinking.variables.length, 0);
  assert.equal(app.stored().companion.thinking.variables.length, 0);
  app.usePersonaStore.getState().updateProfile({ description: '仍然自定义' });
  await settled();
  assert.equal(app.stored().settings.userName, 'new name');
  assert.equal(app.useSettingsStore.getState().settings.userName, app.stored().settings.userName);
  assert.equal(app.useCotStore.getState().thinking.variables.length, 0);
});

test('snapshot failure rejects every blocked operation and retains snapshots for an explicit retry', { timeout: 2000 }, async () => {
  const app = harness();
  await app.initializeStores();
  const pending = deferred();
  const save = app.repository.saveCompanion;
  app.repository.saveCompanion = async (value) => { await pending.promise; return save(value); };
  app.usePersonaStore.getState().updateProfile({ name: '保留最新修改' });
  await settled();
  const modelRejected = assert.rejects(app.useModelStore.getState().saveModel(modelRecord()), /本地配置尚未保存/);
  app.useSettingsStore.getState().updateSettings({ theme: 'dark' });
  await settled();
  const maintenanceRejected = assert.rejects(app.runAppMaintenance(async () => {
    throw new Error('maintenance must remain blocked by the failed snapshot');
  }), /本地配置尚未保存/);
  await settled();
  pending.reject(new Error('disk unavailable'));
  await Promise.all([modelRejected, maintenanceRejected]);
  assert.equal(app.calls.length, 0);
  assert.equal(app.usePersonaStore.getState().profile.name, '保留最新修改');
  app.repository.saveCompanion = save;
  app.usePersonaStore.getState().retrySave();
  await settled();
  assert.equal(app.stored().companion.profile.name, '保留最新修改');
  assert.equal(app.stored().settings.theme, 'dark');
  assert.equal(app.stored().models.length, 0);
  assert.equal(app.stored().sessions.length, 0);
  await app.useModelStore.getState().saveModel(modelRecord());
  assert.equal(app.stored().models.length, 1);
});

test('committed template deletion clears model bindings, including stale model editor values', async () => {
  const app = harness();
  const original = modelRecord();
  app.stored().models.push(original);
  await app.initializeStores();
  app.useCotStore.getState().updateThinking({
    templates: app.useCotStore.getState().thinking.templates.filter((template) => template.id !== original.cotPresetId),
    selectedTemplateId: null,
  });
  assert.equal(app.useModelStore.getState().models[0].cotPresetId, original.cotPresetId);
  await settled();
  assert.equal(app.stored().models[0].cotPresetId, null);
  assert.equal(app.useModelStore.getState().models[0].cotPresetId, null);
  await app.useModelStore.getState().saveModel({ ...original, name: '编辑旧草稿' });
  assert.equal(app.stored().models[0].cotPresetId, null);
  assert.equal(app.useModelStore.getState().models[0].cotPresetId, null);
  assert.equal(app.stored().models[0].name, '编辑旧草稿');
});

test('model save queued behind a template deletion uses the committed template set at execution', { timeout: 2000 }, async () => {
  const app = harness();
  const original = modelRecord();
  app.stored().models.push(original);
  await app.initializeStores();
  const pending = deferred();
  const save = app.repository.saveCompanion;
  app.repository.saveCompanion = async (value) => { await pending.promise; return save(value); };
  app.useCotStore.getState().updateThinking({ templates: [], selectedTemplateId: null });
  await settled();
  const modelSaved = app.useModelStore.getState().saveModel({ ...original, name: '等待中的修改' });
  await settled();
  pending.resolve();
  await modelSaved;
  assert.equal(app.stored().models[0].cotPresetId, null);
  assert.equal(app.useModelStore.getState().models[0].cotPresetId, null);
  assert.equal(app.stored().models[0].name, '等待中的修改');
});

test('an older committed snapshot does not clear bindings merely absent from a newer unsaved draft', { timeout: 2000 }, async () => {
  const app = harness();
  const original = modelRecord();
  app.stored().models.push(original);
  await app.initializeStores();
  const first = deferred();
  const second = deferred();
  const save = app.repository.saveCompanion;
  let attempt = 0;
  app.repository.saveCompanion = async (value) => {
    attempt += 1;
    await (attempt === 1 ? first.promise : second.promise);
    return save(value);
  };
  app.usePersonaStore.getState().updateProfile({ description: '不删除模板的旧快照' });
  await settled();
  app.useCotStore.getState().updateThinking({ templates: [], selectedTemplateId: null });
  first.resolve();
  await settled();
  assert.equal(app.stored().models[0].cotPresetId, original.cotPresetId);
  assert.equal(app.useModelStore.getState().models[0].cotPresetId, original.cotPresetId);
  second.resolve();
  await settled();
  assert.equal(app.stored().models[0].cotPresetId, null);
  assert.equal(app.useModelStore.getState().models[0].cotPresetId, null);
});

test('credential recovery completes before stores are ready, and an unavailable recovery can retry', async () => {
  const app = harness();
  app.credentials.set('lingban_model_pending', '{bad-json');
  await assert.rejects(app.initializeStores(), /安全操作恢复失败/);
  for (const key of ['usePersonaStore', 'useCotStore', 'useModelStore', 'useChatStore', 'useSettingsStore']) {
    assert.equal(app[key].getState().ready, false);
  }
  app.credentials.delete('lingban_model_pending');
  await app.initializeStores();
  assert.equal(app.useModelStore.getState().ready, true);
});

test('model writes share the store queue while cleartext keys never enter public state', async () => {
  const app = harness();
  await app.initializeStores();
  const secret = 'store-test-secret-1234';
  const pending = deferred();
  const save = app.repository.saveCompanion;
  app.repository.saveCompanion = async (value) => { await pending.promise; return save(value); };
  app.usePersonaStore.getState().updateProfile({ name: 'before model' });
  await settled();
  const modelSaved = app.useModelStore.getState().saveModelConfiguration({ ...modelRecord(), apiKey: secret }, secret);
  await settled();
  assert.equal(app.credentials.has('model_model-test'), false);
  pending.resolve();
  await modelSaved;
  assert.deepEqual(app.calls.map(([kind]) => kind), ['companion', 'model']);
  assert.equal(app.credentials.get('model_model-test'), secret);
  assert.ok(!JSON.stringify(app.useModelStore.getState()).includes(secret));
  assert.ok(!JSON.stringify(app.stored()).includes(secret));
  assert.equal(app.useModelStore.getState().credentialCleanupPending, false);
});

test('committed credential cleanup failure has an explicit retry flag, and retry never clears an ordinary save error', { timeout: 2000 }, async () => {
  const app = harness();
  await app.initializeStores();
  const remove = app.credentials.delete.bind(app.credentials);
  app.credentials.delete = (key) => {
    if (key === 'lingban_model_pending') throw new Error('secure cleanup unavailable');
    return remove(key);
  };
  await app.useModelStore.getState().saveModelConfiguration(modelRecord(), 'temporary-test-key');
  assert.equal(app.useModelStore.getState().models.length, 1);
  assert.equal(app.useModelStore.getState().credentialCleanupPending, true);
  assert.match(app.useModelStore.getState().saveError, /安全记录清理失败/);
  await assert.rejects(app.useModelStore.getState().retryCredentialCleanup(), /安全记录清理失败/);
  assert.equal(app.useModelStore.getState().credentialCleanupPending, true);
  app.credentials.delete = remove;
  await app.useModelStore.getState().retryCredentialCleanup();
  assert.equal(app.useModelStore.getState().credentialCleanupPending, false);
  assert.equal(app.useModelStore.getState().saveError, null);
  await assert.rejects(app.useModelStore.getState().saveModelConfiguration({ ...modelRecord(), provider: 'deepseek' }, ''), /填写 API Key/);
  assert.match(app.useModelStore.getState().saveError, /模型配置保存失败/);
  await app.useModelStore.getState().retryCredentialCleanup();
  assert.match(app.useModelStore.getState().saveError, /模型配置保存失败/);
});

test('persona snapshots include latest local edits; creation and switching isolate memories while thinking stays global', async () => {
  const app = harness();
  await app.initializeStores();
  assert.equal(app.getCompanionForPersona().personaId, 'persona-default');
  app.usePersonaStore.getState().updateProfile({ name: 'A' });
  app.usePersonaStore.getState().addMemory({ text: 'A private memory', icon: 'heart' });
  app.usePersonaStore.getState().setInterests(['A interest']);
  app.useCotStore.getState().updateThinking({ prompt: 'global prompt' });
  assert.equal(app.getCompanionForPersona('persona-default').data.memories[0].text, 'A private memory');
  await app.usePersonaStore.getState().createPersona('B');
  const b = app.usePersonaStore.getState().activePersonaId;
  assert.notEqual(b, 'persona-default');
  assert.equal(app.usePersonaStore.getState().profile.name, 'B');
  assert.deepEqual(app.usePersonaStore.getState().memories, []);
  assert.deepEqual(app.usePersonaStore.getState().interests, []);
  assert.equal(app.useCotStore.getState().thinking.prompt, 'global prompt');
  app.usePersonaStore.getState().addMemory({ text: 'B private memory', icon: 'moon' });
  await app.usePersonaStore.getState().switchPersona('persona-default');
  assert.equal(app.usePersonaStore.getState().profile.name, 'A');
  assert.equal(app.usePersonaStore.getState().memories[0].text, 'A private memory');
  assert.equal(app.getCompanionForPersona(b).data.memories[0].text, 'B private memory');
  assert.ok(app.calls.filter(([kind]) => kind === 'companion').every((call) => typeof call[2] === 'string'));
  await app.usePersonaStore.getState().renamePersona(b, 'B renamed');
  assert.equal(app.usePersonaStore.getState().activePersonaId, 'persona-default');
  assert.equal(app.getCompanionForPersona(b).data.profile.name, 'B renamed');
});

test('persona actions wait for queued autosave and busy prevents any cross-owner editing', async () => {
  const app = harness();
  await app.initializeStores();
  const pending = deferred();
  const save = app.repository.saveCompanion;
  app.repository.saveCompanion = async (...args) => { await pending.promise; return save(...args); };
  app.usePersonaStore.getState().updateProfile({ name: 'A latest' });
  await settled();
  const creating = app.usePersonaStore.getState().createPersona('B');
  assert.equal(app.usePersonaStore.getState().busy, true);
  app.usePersonaStore.getState().updateProfile({ name: 'MUST IGNORE' });
  app.usePersonaStore.getState().addMemory({ text: 'MUST IGNORE', icon: 'heart' });
  app.useCotStore.getState().updateThinking({ prompt: 'MUST IGNORE' });
  await assert.rejects(app.usePersonaStore.getState().createPersona('C'), /切换/);
  pending.resolve();
  await creating;
  assert.deepEqual(app.calls.map(([kind]) => kind), ['companion', 'persona']);
  assert.equal(app.getCompanionForPersona('persona-default').data.profile.name, 'A latest');
  assert.equal(app.usePersonaStore.getState().profile.name, 'B');
  assert.equal(app.usePersonaStore.getState().busy, false);
});

test('failed owner autosave rejects queued switch, retains the original owner and retries its newest draft', async () => {
  const app = harness();
  await app.initializeStores();
  await app.usePersonaStore.getState().createPersona('B');
  const b = app.usePersonaStore.getState().activePersonaId;
  const pending = deferred();
  const save = app.repository.saveCompanion;
  app.repository.saveCompanion = async (...args) => { await pending.promise; return save(...args); };
  app.usePersonaStore.getState().updateProfile({ name: 'B kept' });
  await settled();
  const switching = assert.rejects(app.usePersonaStore.getState().switchPersona('persona-default'), /切换人设失败/);
  pending.reject(new Error('disk unavailable'));
  await switching;
  assert.equal(app.usePersonaStore.getState().activePersonaId, b);
  assert.equal(app.usePersonaStore.getState().profile.name, 'B kept');
  assert.equal(app.calls.filter(([kind]) => kind === 'switch').length, 0);
  app.repository.saveCompanion = save;
  app.usePersonaStore.getState().retrySave();
  await settled();
  await app.usePersonaStore.getState().switchPersona('persona-default');
  assert.equal(app.stored().personas.find((persona) => persona.id === b).profile.name, 'B kept');
});

test('switching does not overwrite newer global settings drafts and deletion retains at least one persona', async () => {
  const app = harness();
  await app.initializeStores();
  await app.usePersonaStore.getState().createPersona('B');
  const b = app.usePersonaStore.getState().activePersonaId;
  const pending = deferred();
  const change = app.repository.setActivePersona;
  app.repository.setActivePersona = async (id) => { const result = await change(id); await pending.promise; return result; };
  const switching = app.usePersonaStore.getState().switchPersona('persona-default');
  await settled();
  app.useSettingsStore.getState().updateSettings({ userName: 'new global name', theme: 'dark' });
  pending.resolve();
  await switching;
  await settled();
  assert.equal(app.useSettingsStore.getState().settings.theme, 'dark');
  assert.equal(app.useCotStore.getState().thinking.variables[0].value, 'new global name');
  assert.equal(app.stored().settings.userName, 'new global name');
  app.runtime.useChatRuntimeStore.setState({ isSending: true });
  await assert.rejects(app.usePersonaStore.getState().deletePersona(b), /停止生成/);
  app.runtime.useChatRuntimeStore.setState({ isSending: false });
  await app.usePersonaStore.getState().deletePersona(b);
  assert.throws(() => app.getCompanionForPersona(b), /人设已删除/);
  await assert.rejects(app.usePersonaStore.getState().deletePersona('persona-default'), /至少保留/);
});

test('maintenance locks immediately, waits behind autosave, blocks all new store writes and hydrates a reset snapshot', async () => {
  const app = harness();
  await app.initializeStores();
  const pending = deferred();
  const save = app.repository.saveCompanion;
  app.repository.saveCompanion = async (...args) => { await pending.promise; return save(...args); };
  app.usePersonaStore.getState().updateProfile({ name: 'before reset' });
  await settled();
  let executed = false;
  const maintenance = app.runAppMaintenance(async () => {
    executed = true;
    assert.equal(app.stored().companion.profile.name, 'before reset');
    app.applyAppSnapshot({ ...clone(app.stored()), models: [], sessions: [], messages: [] });
    return 'result';
  });
  assert.equal(app.isAppMaintenanceActive(), true);
  app.usePersonaStore.getState().updateProfile({ name: 'MUST IGNORE' });
  app.useCotStore.getState().updateThinking({ prompt: 'MUST IGNORE' });
  app.useSettingsStore.getState().updateSettings({ theme: 'dark' });
  await assert.rejects(app.useModelStore.getState().saveModel(modelRecord()), /处理本地数据/);
  await assert.rejects(app.usePersonaStore.getState().createPersona('MUST IGNORE'), /处理本地数据/);
  await assert.rejects(app.useChatStore.getState().searchSessions('MUST IGNORE'), /处理本地数据/);
  assert.equal(executed, false);
  pending.resolve();
  assert.equal(await maintenance, 'result');
  assert.equal(app.isAppMaintenanceActive(), false);
  assert.equal(app.usePersonaStore.getState().profile.name, 'before reset');
  assert.equal(app.useSettingsStore.getState().settings.theme, 'system');
  app.usePersonaStore.getState().updateProfile({ name: 'after reset' });
  await settled();
  assert.equal(app.usePersonaStore.getState().profile.name, 'after reset');
});

test('failed autosave prevents maintenance from overtaking unsaved edits, then retry can succeed', async () => {
  const app = harness();
  await app.initializeStores();
  const pending = deferred();
  const save = app.repository.saveCompanion;
  app.repository.saveCompanion = async () => { await pending.promise; };
  app.usePersonaStore.getState().updateProfile({ name: 'keep draft' });
  await settled();
  let workCalls = 0;
  const maintenance = assert.rejects(app.runAppMaintenance(async () => { workCalls += 1; }), /本地配置尚未保存/);
  pending.reject(new Error('disk full'));
  await maintenance;
  assert.equal(app.isAppMaintenanceActive(), false);
  assert.equal(workCalls, 0);
  assert.equal(app.usePersonaStore.getState().profile.name, 'keep draft');
  app.repository.saveCompanion = save;
  app.usePersonaStore.getState().retrySave();
  await settled();
  await app.runAppMaintenance(async () => { workCalls += 1; });
  assert.equal(workCalls, 1);
});

test('reset recovery completes before any database hydration and failure stays retryable', async () => {
  const app = harness();
  const order = [];
  const initialize = app.repository.initialize;
  app.repository.initialize = async () => { order.push('hydrate'); return initialize(); };
  app.reset.recover = async () => { order.push('recover'); throw new Error('reset recovery pending'); };
  await assert.rejects(app.initializeStores(), /reset recovery pending/);
  assert.deepEqual(order, ['recover']);
  assert.equal(app.usePersonaStore.getState().ready, false);
  app.reset.recover = async () => { order.push('recover retry'); };
  await app.initializeStores();
  assert.deepEqual(order.slice(0, 3), ['recover', 'recover retry', 'hydrate']);
  assert.equal(app.usePersonaStore.getState().ready, true);
});

test('role save captures queued role/model/key drafts together and preserves the open chat', async () => {
  const app = harness(); await app.initializeStores();
  const baseline = clone(app.usePersonaStore.getState().personas[0]);
  app.stored().personas = [clone(baseline)];
  const gate = deferred(); const saveSettings = app.repository.saveSettings;
  app.repository.saveSettings = async (value) => { await gate.promise; return saveSettings(value); };
  app.useSettingsStore.getState().updateSettings({ theme: 'dark' }); await settled();
  app.useChatStore.setState({ activeSessionId: 'keep-current-session' });
  let captured;
  app.repository.saveRole = async (persona, previous, model) => {
    captured = { persona: clone(persona), previous: clone(previous), model: clone(model) };
    app.stored().personas = [clone(persona)]; app.stored().models = [clone(model)];
    app.stored().companion.profile = clone(persona.profile); return clone(app.stored());
  };
  const role = clone(baseline); role.profile.name = 'captured role';
  role.configuration.confirmed = true; role.configuration.currentModelId = 'model-test';
  role.configuration.models['model-test'] = { mode: 'off', thinking: app.thinking.createModelThinkingConfig() };
  const pending = { model: { ...modelRecord(), cotMode: 'off', cotPresetId: null }, apiKey: 'private-original' };
  const saving = app.usePersonaStore.getState().saveRole(role, baseline, pending);
  role.profile.name = 'mutated while waiting'; pending.model.baseUrl = 'https://different.example/v1'; pending.apiKey = 'private-mutated';
  gate.resolve(); await saving;
  assert.equal(captured.persona.profile.name, 'captured role'); assert.equal(captured.model.baseUrl, 'https://example.com/v1');
  assert.equal(app.credentials.get('model_model-test'), 'private-original');
  assert.equal(app.useChatStore.getState().activeSessionId, 'keep-current-session');
  assert.equal(JSON.stringify(app.usePersonaStore.getState()).includes('private-original'), false);
  assert.equal(app.useSettingsStore.getState().settings.theme, 'dark');
});
