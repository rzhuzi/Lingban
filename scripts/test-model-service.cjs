const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');
const fs = require('node:fs');
const ts = require('typescript');

require.extensions['.ts'] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: filename,
  }).outputText, filename);
};

const { createSqlRepository } = require('../src/lib/db/sql-repository.ts');
const { createModelConfigurationService } = require('../src/features/models/model-configuration.ts');
const KEY = 'private-test-credential-A123';
const REPLACEMENT = 'private-test-credential-B456';
const JOURNAL = 'lingban_model_pending';
const now = '2026-10-20T00:00:00.000Z';
const model = (id = 'alpha', patch = {}) => ({
  id, name: id, provider: 'custom', baseUrl: 'https://example.test/v1', apiModel: 'custom-model',
  apiKeyAlias: null, isDefault: false, cotMode: 'off', cotPresetId: null,
  createdAt: now, updatedAt: now, ...patch,
});

async function harness(t) {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  const db = {
    execSync: (sql) => sqlite.exec(sql),
    runSync: (sql, args = []) => sqlite.prepare(sql).run(...args),
    getFirstSync: (sql, args = []) => sqlite.prepare(sql).get(...args) ?? null,
    getAllSync: (sql, args = []) => sqlite.prepare(sql).all(...args),
  };
  const ordinaryStorage = new Map();
  const repository = createSqlRepository(() => db, {
    getItem: async (key) => ordinaryStorage.get(key) ?? null,
    setItem: async (key, value) => { ordinaryStorage.set(key, value); },
  });
  await repository.initialize();
  const keys = new Map();
  const calls = [];
  let failure = () => false;
  const credentials = Object.fromEntries(['get', 'set', 'remove'].map((operation) => [operation,
    async (key, value) => {
      calls.push([operation, key]);
      if (failure(operation, key, value)) throw new Error(`native failure deliberately containing ${KEY}`);
      if (operation === 'get') return keys.get(key) ?? null;
      if (operation === 'set') keys.set(key, value);
      else keys.delete(key);
    }]));
  const service = createModelConfigurationService(repository, credentials);
  return { sqlite, repository, service, keys, calls, ordinaryStorage, credentials,
    fail: (predicate) => { failure = predicate; },
    restart: () => createModelConfigurationService(repository, credentials) };
}

test('keys only cross the secure boundary; canonical aliases and field whitelist keep models clean', async (t) => {
  const app = await harness(t);
  const result = await app.service.save({ ...model(), apiKey: KEY, password: KEY }, KEY);
  assert.equal(result.models[0].apiKeyAlias, 'model_alpha');
  assert.equal(result.models[0].isDefault, true);
  assert.equal(result.cleanupPending, false);
  assert.deepEqual(await app.service.getKeySummary('model_alpha'), { configured: true, lastFour: 'A123' });
  assert.equal(await app.service.getApiKey('model_alpha'), KEY);
  assert.equal(app.keys.get('model_alpha'), KEY);
  assert.equal(app.keys.has(JOURNAL), false);
  const persisted = JSON.stringify(await app.repository.initialize());
  assert.ok(!persisted.includes(KEY));
  assert.ok(!JSON.stringify(result).includes(KEY));
  assert.ok(!JSON.stringify([...app.ordinaryStorage]).includes(KEY));
  const columns = app.sqlite.prepare('PRAGMA table_info(models)').all().map((item) => item.name);
  assert.ok(columns.includes('api_key_alias'));
  assert.ok(!columns.includes('api_key'));
});

test('a coordinated role commit receives the canonical model and owns the only database write', async (t) => {
  const app = await harness(t);
  let commits = 0;
  const result = await app.service.save(model('role-model'), KEY, async (persisted) => {
    commits += 1;
    assert.equal(persisted.apiKeyAlias, 'model_role-model');
    assert.equal(JSON.stringify(persisted).includes(KEY), false);
    assert.equal((await app.repository.initialize()).models.length, 0, 'No model is saved ahead of the parent transaction.');
    await app.repository.saveModel(persisted);
  });
  assert.equal(commits, 1);
  assert.equal(result.models[0].id, 'role-model');
  assert.equal(app.keys.get('model_role-model'), KEY);
  assert.equal(app.keys.has(JOURNAL), false);
});

test('the role and staged model commit atomically before the secure journal is cleared', async (t) => {
  const app = await harness(t);
  const before = await app.repository.initialize();
  const original = before.personas[0];
  const next = { ...structuredClone(original), profile: { ...original.profile, name: '完整角色' },
    configuration: { version: 1, confirmed: true, currentModelId: 'bundle-model',
      models: { 'bundle-model': { mode: 'off', thinking: require('../src/features/companion/thinking-config.ts').createModelThinkingConfig() } },
      variables: [], chatSettings: { contextWindow: 12, streamOutput: false } } };
  await app.service.save(model('bundle-model'), KEY, async (persisted) => {
    await app.repository.saveRole(next, original, persisted);
  });
  const committed = await app.repository.initialize();
  assert.equal(committed.personas[0].profile.name, '完整角色');
  assert.equal(committed.personas[0].configuration.currentModelId, 'bundle-model');
  assert.equal(committed.models[0].apiKeyAlias, 'model_bundle-model');
  assert.equal(app.keys.get('model_bundle-model'), KEY);
  assert.equal(JSON.stringify(committed).includes(KEY), false);
});

test('invalid role data rolls back its staged model row and compensates the new secure credential', async (t) => {
  const app = await harness(t);
  const before = await app.repository.initialize();
  const original = before.personas[0];
  const next = { ...structuredClone(original), profile: { ...original.profile, name: '' } };
  await assert.rejects(app.service.save(model('failed-bundle'), KEY, async (persisted) => {
    await app.repository.saveRole(next, original, persisted);
  }));
  const after = await app.repository.initialize();
  assert.deepEqual(after.personas, before.personas);
  assert.deepEqual(after.models, before.models);
  assert.equal(app.keys.has('model_failed-bundle'), false);
  assert.equal(app.keys.has(JOURNAL), false);
});

test('a rejected parent role transaction restores the credential and leaves no isolated model', async (t) => {
  const app = await harness(t);
  await assert.rejects(app.service.save(model('cancelled-role'), KEY, async () => {
    throw new Error('role baseline changed');
  }), /保存失败/);
  assert.equal((await app.repository.initialize()).models.length, 0);
  assert.equal(app.keys.has('model_cancelled-role'), false);
  assert.equal(app.keys.has(JOURNAL), false);
});

test('a failed parent transaction changing an existing credential restores its previous key', async (t) => {
  const app = await harness(t);
  const saved = (await app.service.save(model('existing-role'), KEY)).models[0];
  await assert.rejects(app.service.save({ ...saved, name: 'not committed' }, REPLACEMENT, async () => {
    throw new Error('role validation failed');
  }), /保存失败/);
  const unchanged = (await app.repository.initialize()).models[0];
  assert.equal(unchanged.name, saved.name);
  assert.equal(app.keys.get('model_existing-role'), KEY);
  assert.equal(app.keys.has(JOURNAL), false);
});

test('undefined keeps a key; explicit clear is allowed only for custom endpoints', async (t) => {
  const app = await harness(t);
  await assert.rejects(app.service.save(model('official', { provider: 'deepseek' })), /填写 API Key/);
  let saved = (await app.service.save(model(), KEY)).models[0];
  saved = (await app.service.save({ ...saved, name: 'edited' })).models[0];
  assert.equal(await app.service.getApiKey(saved.apiKeyAlias), KEY);
  await assert.rejects(app.service.save({ ...saved, provider: 'deepseek' }, ''), /填写 API Key/);
  saved = (await app.service.save(saved, '')).models[0];
  assert.equal(saved.apiKeyAlias, null);
  assert.equal(app.keys.has('model_alpha'), false);
  assert.deepEqual(await app.service.getKeySummary(null), { configured: false, lastFour: '' });
});

test('changing provider or URL requires explicit credentials, while a trailing slash keeps the same target', async (t) => {
  const app = await harness(t);
  const saved = (await app.service.save(model(), KEY)).models[0];
  await assert.rejects(app.service.save({ ...saved, baseUrl: 'https://different.test/v1' }), /接口地址已改变/);
  await assert.rejects(app.service.save({ ...saved, provider: 'deepseek' }), /服务商或接口地址已改变/);
  assert.equal((await app.repository.initialize()).models[0].baseUrl, saved.baseUrl);
  await app.service.save({ ...saved, baseUrl: `${saved.baseUrl}/` });
  const moved = await app.service.save({ ...saved, baseUrl: 'https://different.test/v1' }, REPLACEMENT);
  assert.equal(moved.models[0].baseUrl, 'https://different.test/v1');
  assert.equal(await app.service.getApiKey('model_alpha'), REPLACEMENT);
});

test('a secure write failure leaves both old key and database untouched and strips native error text', async (t) => {
  const app = await harness(t);
  const original = (await app.service.save(model(), KEY)).models[0];
  app.fail((operation, key, value) => operation === 'set' && key === 'model_alpha' && value === REPLACEMENT);
  await assert.rejects(app.service.save({ ...original, name: 'must not save' }, REPLACEMENT), (error) => {
    assert.match(error.message, /API Key 操作失败/);
    assert.ok(!error.message.includes(KEY));
    return true;
  });
  assert.equal(app.keys.get('model_alpha'), KEY);
  assert.equal(app.keys.has(JOURNAL), false);
  assert.deepEqual((await app.repository.initialize()).models[0], original);
});

test('a database save failure restores an old key, and removes a new model orphan', async (t) => {
  const app = await harness(t);
  const original = (await app.service.save(model(), KEY)).models[0];
  app.sqlite.exec("CREATE TRIGGER reject_model BEFORE UPDATE ON models BEGIN SELECT RAISE(ABORT, 'disk error'); END");
  await assert.rejects(app.service.save({ ...original, name: 'not saved' }, REPLACEMENT), /原有配置未覆盖/);
  assert.equal(app.keys.get('model_alpha'), KEY);
  assert.deepEqual((await app.repository.initialize()).models[0], original);
  app.sqlite.exec('DROP TRIGGER reject_model');
  app.sqlite.exec("CREATE TRIGGER reject_new BEFORE INSERT ON models BEGIN SELECT RAISE(ABORT, 'disk error'); END");
  await assert.rejects(app.service.save(model('beta'), REPLACEMENT), /原有配置未覆盖/);
  assert.equal(app.keys.has('model_beta'), false);
  assert.equal(app.keys.has(JOURNAL), false);
  assert.equal((await app.repository.initialize()).models.length, 1);
});

test('failed compensation stays recoverable after restart and blocks reading the replacement key', async (t) => {
  const app = await harness(t);
  const original = (await app.service.save(model(), KEY)).models[0];
  app.sqlite.exec("CREATE TRIGGER reject_model BEFORE UPDATE ON models BEGIN SELECT RAISE(ABORT, 'disk error'); END");
  app.fail((operation, key, value) => operation === 'set' && key === 'model_alpha' && value === KEY);
  await assert.rejects(app.service.save(original, REPLACEMENT), /恢复尚未完成/);
  assert.equal(app.keys.get('model_alpha'), REPLACEMENT);
  assert.ok(app.keys.has(JOURNAL));
  const restarted = app.restart();
  await assert.rejects(restarted.getApiKey('model_alpha'), /读取失败/);
  app.fail(() => false);
  await restarted.recover();
  assert.equal(await restarted.getApiKey('model_alpha'), KEY);
  assert.equal(app.keys.has(JOURNAL), false);
});

test('post-commit cleanup failure is explicit and recovery keeps the committed key', async (t) => {
  const app = await harness(t);
  app.fail((operation, key) => operation === 'remove' && key === JOURNAL);
  const result = await app.service.save(model(), KEY);
  assert.equal(result.cleanupPending, true);
  assert.equal((await app.repository.initialize()).models.length, 1);
  assert.ok(app.keys.has(JOURNAL));
  await assert.rejects(app.restart().recover(), /恢复失败/);
  app.fail(() => false);
  await app.restart().recover();
  assert.equal(app.keys.get('model_alpha'), KEY);
  assert.equal(app.keys.has(JOURNAL), false);
});

test('delete must remove the key first, and a failed deletion remains retryable', async (t) => {
  const app = await harness(t);
  await app.service.save(model(), KEY);
  app.fail((operation, key) => operation === 'remove' && key === 'model_alpha');
  await assert.rejects(app.service.delete('alpha'), /模型仍保留/);
  assert.equal((await app.repository.initialize()).models.length, 1);
  assert.equal(app.keys.get('model_alpha'), KEY);
  app.fail(() => false);
  const result = await app.service.delete('alpha');
  assert.deepEqual(result.models, []);
  assert.equal(result.cleanupPending, false);
  assert.equal(app.keys.has('model_alpha'), false);
  assert.equal(app.keys.has(JOURNAL), false);
});

test('delete and default promotion roll back as one SQLite transaction, including session references and key', async (t) => {
  const app = await harness(t);
  await app.service.save(model('alpha'), KEY);
  await app.service.save(model('beta'), REPLACEMENT);
  await app.repository.saveSession({ id: 'session', title: 'history', modelId: 'alpha', personaId: null,
    pinned: false, createdAt: now, updatedAt: now });
  app.sqlite.exec("CREATE TRIGGER reject_promotion BEFORE UPDATE OF is_default ON models WHEN NEW.id = 'beta' AND NEW.is_default = 1 BEGIN SELECT RAISE(ABORT, 'promotion failed'); END");
  await assert.rejects(app.service.delete('alpha'), /原有配置未覆盖/);
  let snapshot = await app.repository.initialize();
  assert.equal(snapshot.models.length, 2);
  assert.equal(snapshot.models.find((item) => item.id === 'alpha').isDefault, true);
  assert.equal(snapshot.sessions[0].modelId, 'alpha');
  assert.equal(app.keys.get('model_alpha'), KEY);
  app.sqlite.exec('DROP TRIGGER reject_promotion');
  const result = await app.service.delete('alpha');
  assert.equal(result.models[0].id, 'beta');
  assert.equal(result.models[0].isDefault, true);
  snapshot = await app.repository.initialize();
  assert.deepEqual(result.models, snapshot.models);
  assert.equal(snapshot.sessions[0].modelId, null);
});

test('delete commit reports a cleanup warning and restart removes the last secure backup', async (t) => {
  const app = await harness(t);
  await app.service.save(model(), KEY);
  app.fail((operation, key) => operation === 'remove' && key === JOURNAL);
  const result = await app.service.delete('alpha');
  assert.equal(result.cleanupPending, true);
  assert.deepEqual(result.models, []);
  assert.equal(app.keys.has('model_alpha'), false);
  assert.ok(app.keys.has(JOURNAL));
  app.fail(() => false);
  await app.restart().recover();
  assert.equal(app.keys.has(JOURNAL), false);
  assert.equal(app.keys.size, 0);
});

test('concurrent requests serialize credentials and DAO writes in call order', async (t) => {
  const app = await harness(t);
  const first = app.service.save(model(), KEY);
  const second = app.service.save(model('alpha', { name: 'second edit', isDefault: true }), REPLACEMENT);
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.models[0].name, 'alpha');
  assert.equal(b.models[0].name, 'second edit');
  assert.equal((await app.repository.initialize()).models[0].name, 'second edit');
  assert.equal(await app.service.getApiKey('model_alpha'), REPLACEMENT);
  assert.ok(b.models[0].updatedAt > a.models[0].updatedAt);
  assert.equal(app.keys.has(JOURNAL), false);
});

test('web credentials exist only in a page-local Map and disappear when the module reloads', async () => {
  const file = require.resolve('../src/lib/secure.web.ts');
  const source = fs.readFileSync(file, 'utf8');
  assert.ok(!/AsyncStorage|localStorage|sessionStorage/.test(source));
  const first = require(file);
  assert.equal(first.credentialStorageMode, 'session');
  await first.credentialStorage.set('model_alpha', KEY);
  assert.equal(await first.credentialStorage.get('model_alpha'), KEY);
  delete require.cache[file];
  const restarted = require(file);
  assert.equal(await restarted.credentialStorage.get('model_alpha'), null);
});

test('an unreferenced credential can be cleaned up but is never implicitly attached to an anonymous model', async (t) => {
  const app = await harness(t);
  app.keys.set('model_alpha', KEY);
  const result = await app.service.save(model());
  assert.equal(result.models[0].apiKeyAlias, null);
  assert.equal(app.keys.has('model_alpha'), false);
  assert.equal(app.keys.has(JOURNAL), false);
});
