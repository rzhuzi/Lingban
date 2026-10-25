const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const { test } = require('node:test');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: filename,
}).outputText, filename);
const { createDataResetService, DATA_RESET_JOURNAL, DataResetError } = require('../src/lib/data/reset-core.ts');
const { createSqlRepository } = require('../src/lib/db/sql-repository.ts');
const { createWebRepository } = require('../src/lib/db/web-repository.ts');
const { LEGACY_STORAGE_KEY } = require('../src/lib/db/legacy.ts');

const model = { id: 'reset-fixture', name: 'fixture', provider: 'custom', baseUrl: 'https://example.test/v1', apiModel: 'fixture',
  apiKeyAlias: 'model_reset-fixture', isDefault: true, cotMode: 'off', cotPresetId: null, createdAt: '2026-10-20T01:00:00.000Z', updatedAt: '2026-10-20T01:00:00.000Z' };
async function setup(t, web = false) {
  const values = new Map();
  const journal = { getItem: async (key) => values.get(key) ?? null, setItem: async (key, value) => { values.set(key, value); }, removeItem: async (key) => { values.delete(key); } };
  const sqlite = new DatabaseSync(':memory:'); t.after(() => sqlite.close());
  const db = { execSync: (sql) => sqlite.exec(sql), runSync: (sql, params = []) => sqlite.prepare(sql).run(...params),
    getAllSync: (sql, params = []) => sqlite.prepare(sql).all(...params).map((row) => ({ ...row })),
    getFirstSync: (sql, params = []) => { const row = sqlite.prepare(sql).get(...params); return row ? { ...row } : null; } };
  const repository = web ? createWebRepository(journal) : createSqlRepository(() => db, journal);
  await repository.initialize(); await repository.saveModel(model);
  await repository.saveSession({ id: 'session', title: 'private title', modelId: model.id, personaId: 'persona-default', pinned: false, createdAt: model.createdAt, updatedAt: model.updatedAt });
  await repository.saveMessage({ id: 'message', sessionId: 'session', role: 'user', content: 'private message', reasoning: '', status: 'done', error: null,
    cotMode: 'off', cotPresetId: null, modelId: model.id, createdAt: model.createdAt });
  const keys = new Map([[model.apiKeyAlias, 'fixture-secret-key'], ['unrelated-app', 'other-secret']]);
  values.set(LEGACY_STORAGE_KEY, '{legacy private config}'); values.set(LEGACY_STORAGE_KEY + '/recovery/fixture', 'backup');
  const counts = { before: 0, legacy: 0, files: 0 }; const files = new Set(['old-avatar']);
  const deps = { repository, journal, credentials: { remove: async (alias) => { keys.delete(alias); } },
    beforeReset: async () => { counts.before++; },
    cleanupLegacy: async () => { counts.legacy++; for (const key of values.keys()) if (key === LEGACY_STORAGE_KEY || key.startsWith(LEGACY_STORAGE_KEY + '/recovery/')) values.delete(key); },
    collectFiles: async () => [...files],
    cleanupFiles: async (captured) => { counts.files++; captured.forEach((file) => files.delete(file)); }, revision: () => 'fixture-reset-revision' };
  return { repository, deps, values, keys, counts, files, service: createDataResetService(deps),
    reopen: () => web ? createWebRepository(journal) : createSqlRepository(() => db, journal) };
}
const committedError = (expected) => (error) => {
  assert.ok(error instanceof DataResetError); assert.equal(error.committed, expected);
  assert.doesNotMatch(error.message + JSON.stringify(error), /fixture-secret|raw native secret|private message/); return true;
};

for (const web of [false, true]) {
  test(`${web ? 'web' : 'SQLite'} reset clears local records, keys and legacy backup without touching unrelated credentials`, async (t) => {
    const app = await setup(t, web); const { snapshot: cleared, didReset } = await app.service.reset(); assert.equal(didReset, true);
    assert.equal(cleared.models.length, 0); assert.equal(cleared.sessions.length, 0); assert.equal(cleared.messages.length, 0);
    assert.equal(cleared.personas.length, 1); assert.equal(cleared.companion.profile.name, '小零');
    assert.equal(app.keys.has(model.apiKeyAlias), false); assert.equal(app.keys.get('unrelated-app'), 'other-secret');
    assert.equal(app.values.has(DATA_RESET_JOURNAL), false); assert.equal(app.values.has(LEGACY_STORAGE_KEY), false);
    assert.deepEqual(await app.reopen().initialize(), cleared);
    assert.deepEqual(app.counts, { before: 1, legacy: 1, files: 1 });
  });
}

test('a failed atomic DB reset preserves records and keys and never runs destructive cleanup', async (t) => {
  const app = await setup(t); const before = await app.repository.initialize();
  app.repository.resetData = async () => { throw new Error('raw native secret'); };
  await assert.rejects(app.service.reset(), committedError(false));
  assert.deepEqual(await app.repository.initialize(), before); assert.equal(app.keys.get(model.apiKeyAlias), 'fixture-secret-key');
  assert.equal(app.values.has(DATA_RESET_JOURNAL), false); assert.equal(app.counts.legacy, 0); assert.equal(app.counts.files, 0);
});

test('journal write failure prevents the DB transaction and cannot delete a key', async (t) => {
  const app = await setup(t); let resets = 0;
  app.repository.resetData = async () => { resets++; throw new Error(); };
  app.deps.journal.setItem = async () => { throw new Error('raw native secret'); };
  await assert.rejects(app.service.reset(), committedError(false));
  assert.equal(resets, 0); assert.equal(app.keys.get(model.apiKeyAlias), 'fixture-secret-key');
});

test('a committed cleanup failure resumes across startup without wiping later data again', async (t) => {
  const app = await setup(t); let fail = true;
  app.deps.credentials.remove = async (alias) => { if (fail) throw new Error('raw native secret'); app.keys.delete(alias); };
  await assert.rejects(app.service.reset(), committedError(true));
  assert.equal((await app.repository.initialize()).models.length, 0);
  const pending = app.values.get(DATA_RESET_JOURNAL); assert.ok(pending); assert.doesNotMatch(pending, /fixture-secret-key|private message|other-secret/);
  const newer = { ...model, id: 'newer', apiKeyAlias: 'model_newer' }; await app.repository.saveModel(newer); app.keys.set('model_newer', 'new-secret');
  app.files.add('new-avatar');
  fail = false;
  const { snapshot: after, didReset } = await createDataResetService(app.deps).reset(); assert.equal(didReset, false);
  assert.equal(after.models[0].id, 'newer'); assert.equal(app.keys.get('model_newer'), 'new-secret');
  assert.equal(app.keys.has(model.apiKeyAlias), false); assert.equal(app.counts.before, 1); assert.equal(app.values.has(DATA_RESET_JOURNAL), false);
  assert.equal(app.files.has('old-avatar'), false); assert.equal(app.files.has('new-avatar'), true);
});

test('a leftover uncommitted journal is dropped on startup and never deletes original credentials', async (t) => {
  const app = await setup(t); const reset = app.repository.resetData;
  app.repository.resetData = async () => { throw new Error('disk'); };
  const removeItem = app.deps.journal.removeItem;
  app.deps.journal.removeItem = async () => { throw new Error('disk'); };
  await assert.rejects(app.service.reset(), committedError(false));
  assert.ok(app.values.has(DATA_RESET_JOURNAL));
  app.deps.journal.removeItem = removeItem; app.repository.resetData = reset;
  assert.equal(await createDataResetService(app.deps).recover(), false);
  assert.equal(app.keys.get(model.apiKeyAlias), 'fixture-secret-key'); assert.equal((await app.repository.initialize()).messages.length, 1);
});

test('legacy and file cleanup stay retryable after keys were removed', async (t) => {
  const app = await setup(t); const cleanupFiles = app.deps.cleanupFiles;
  app.deps.cleanupFiles = async () => { throw new Error('raw native secret'); };
  await assert.rejects(app.service.reset(), committedError(true));
  assert.equal(app.keys.has(model.apiKeyAlias), false); assert.ok(app.values.has(DATA_RESET_JOURNAL));
  app.deps.cleanupFiles = cleanupFiles;
  assert.equal(await createDataResetService(app.deps).recover(), true); assert.equal(app.values.has(DATA_RESET_JOURNAL), false);
});

test('corrupt or foreign-alias journals fail closed without touching any key', async (t) => {
  const app = await setup(t);
  for (const raw of ['{invalid', JSON.stringify({ version: 1, revision: 'x', aliases: ['unrelated-app'] })]) {
    app.values.set(DATA_RESET_JOURNAL, raw);
    await assert.rejects(createDataResetService(app.deps).recover(), /清理记录异常/);
    assert.equal(app.keys.get(model.apiKeyAlias), 'fixture-secret-key'); assert.equal(app.keys.get('unrelated-app'), 'other-secret');
  }
  assert.equal(app.counts.before, 0); assert.equal(app.counts.files, 0);
});

test('journal read failure after the DB commit is still reported as committed and stays recoverable', async (t) => {
  const app = await setup(t); const reset = app.repository.resetData; const read = app.deps.journal.getItem;
  let committed = false;
  app.repository.resetData = async (revision) => { const result = await reset(revision); committed = true; return result; };
  app.deps.journal.getItem = async (key) => { if (committed && key === DATA_RESET_JOURNAL) throw new Error('disk unavailable'); return read(key); };
  await assert.rejects(app.service.reset(), (error) => { committedError(true)(error); assert.equal(error.didReset, true); assert.equal(error.snapshot.models.length, 0); return true; });
  assert.equal((await app.repository.initialize()).models.length, 0); assert.ok(app.values.has(DATA_RESET_JOURNAL));
  app.deps.journal.getItem = read;
  assert.equal(await createDataResetService(app.deps).recover(), true);
});

test('snapshot read failure after cleanup retains the journal and its retry identity', async (t) => {
  const app = await setup(t); const reset = app.repository.resetData; const initialize = app.repository.initialize;
  let committed = false;
  app.repository.resetData = async (revision) => { const result = await reset(revision); committed = true; return result; };
  app.repository.initialize = async () => { if (committed) throw new Error('temporary read failure'); return initialize(); };
  await assert.rejects(app.service.reset(), (error) => { committedError(true)(error); assert.equal(error.snapshot.messages.length, 0); return true; });
  assert.ok(app.values.has(DATA_RESET_JOURNAL));
  app.repository.initialize = initialize;
  await app.repository.saveModel({ ...model, id: 'newer', apiKeyAlias: null });
  const result = await app.service.reset();
  assert.equal(result.didReset, false); assert.equal(result.snapshot.models[0].id, 'newer');
});
