/* Exercise the actual chat engine and SQLite repository with controlled stream/key boundaries. */
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');
const fs = require('node:fs');
const ts = require('typescript');
const http = require('node:http');

require.extensions['.ts'] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: filename,
  }).outputText, filename);
};
const { createChatEngine, buildChatContext } = require('../src/lib/chat/engine-core.ts');
const { createSqlRepository } = require('../src/lib/db/sql-repository.ts');
const { createWebRepository } = require('../src/lib/db/web-repository.ts');
const { ApiError } = require('../src/lib/api/client.ts');
const { streamChat } = require('../src/lib/api/stream.ts');
const { createDefaultData } = require('../src/features/companion/defaults.ts');
const { createModelThinkingConfig, createThinkingDraft } = require('../src/features/companion/thinking-config.ts');
const { createRoleConfiguration, createRoleModelConfiguration } = require('../src/features/companion/role-config.ts');
const { DEFAULT_SETTINGS } = require('../src/lib/db/types.ts');
const clone = (value) => structuredClone(value);
const settled = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function adapter(sqlite) {
  return {
    execSync: (sql) => sqlite.exec(sql),
    runSync: (sql, params = []) => sqlite.prepare(sql).run(...params),
    getAllSync: (sql, params = []) => sqlite.prepare(sql).all(...params).map((row) => ({ ...row })),
    getFirstSync: (sql, params = []) => { const row = sqlite.prepare(sql).get(...params); return row ? { ...row } : null; },
  };
}
const model = { id: 'model-1', name: '我的模型', provider: 'custom', baseUrl: 'https://example.test/v1', apiModel: 'chat',
  apiKeyAlias: 'model_model-1', isDefault: true, cotMode: 'off', cotPresetId: 'template-warm',
  createdAt: '2026-10-20T01:00:00.000Z', updatedAt: '2026-10-20T01:00:00.000Z' };
function configure(mode, text, extra = {}) {
  const thinkingConfig = createModelThinkingConfig(); thinkingConfig[mode].applied = { ...createThinkingDraft(text), ...extra };
  return { ...model, cotMode: mode, thinkingConfig };
}

test('an unconfirmed role never borrows the global default model or accepts input', async (t) => {
  const app = await setup(t);
  app.setRoleConfiguration(createRoleConfiguration(DEFAULT_SETTINGS));
  let accepted = 0;
  await app.engine.sendChatMessage('保留这段输入', () => { accepted++; });
  assert.equal(app.streams.length, 0);
  assert.equal(accepted, 0);
  assert.equal(app.state().messages.length, 0);
  assert.match(app.runtime().error, /角色.*确认|确认.*模型/);
});

test('a missing role model never falls back to another available default', async (t) => {
  const app = await setup(t);
  app.setModels([{ ...model, id: 'unrelated-default', isDefault: true }]);
  await app.engine.sendChatMessage('不能发给别的模型');
  assert.equal(app.streams.length, 0);
  assert.match(app.runtime().error, /模型已不存在/);
});

for (const web of [false, true]) {
  test(`${web ? 'web' : 'SQLite'} role edits and repeated retries preserve the first v2 attempt through disk failure`, async (t) => {
    const app = await setup(t, web);
    const configured = configure('instruction', 'FIRST');
    await app.repository.saveModel(configured); app.setRoleModel(configured);
    app.deps.stream = async (options) => { app.streams.push(options); options.onContent('partial'); throw new ApiError('interrupted_response'); };
    await app.engine.sendChatMessage('原问题');
    const originalId = app.state().messages[1].id;
    const originalAudit = clone(app.state().messages[1].cotAudit);
    configured.thinkingConfig.instruction.applied.text = 'SECOND'; app.setRoleModel(configured);
    const finish = app.repository.finishChatTurn;
    app.repository.finishChatTurn = async () => { throw new Error('disk'); };
    await app.engine.retryChatMessage(originalId);
    assert.equal(app.runtime().hasUnsaved, true);
    let audit = app.state().messages[1].cotAudit;
    assert.equal(audit.renderedPrefix, 'SECOND');
    assert.equal(audit.originalAttempt.renderedPrefix, originalAudit.renderedPrefix);
    assert.equal(audit.originalAttempt.modelId, model.id);
    app.repository.finishChatTurn = finish;
    await app.engine.retryChatPersistence();
    configured.thinkingConfig.instruction.applied.text = 'THIRD'; app.setRoleModel(configured);
    app.deps.stream = async (options) => { app.streams.push(options); options.onContent('finished'); };
    await app.engine.retryChatMessage(originalId);
    const saved = (await app.reopen().initialize()).messages[1];
    assert.equal(saved.cotAudit.renderedPrefix, 'THIRD');
    assert.deepEqual(saved.cotAudit.originalAttempt, audit.originalAttempt);
    assert.equal(saved.cotAudit.originalAttempt.originalAttempt, undefined);
    await assert.rejects(app.repository.saveMessage({ ...saved, cotAudit: { ...saved.cotAudit, originalAttempt: null } }), /首次回复/);
    await assert.rejects(app.repository.saveMessage({ ...saved, cotAudit: { ...saved.cotAudit,
      originalAttempt: { ...saved.cotAudit.originalAttempt, renderedPrefix: 'tampered' } } }), /首次回复/);
    assert.equal(app.streams.length, 3);
    assert.equal((await app.repository.initialize()).messages[0].content, '原问题');
  });
}

test('two roles share one model with independent instructions, variables, memories and chat settings', async (t) => {
  const app = await setup(t);
  const base = createDefaultData();
  const shared = { ...model, isDefault: false, cotMode: 'off', thinkingConfig: createModelThinkingConfig() };
  const unrelated = { ...model, id: 'global-default', isDefault: true, apiModel: 'must-not-run' };
  await app.repository.saveModel(unrelated);
  app.setModels([unrelated, shared]);
  const makeRole = (name, text, streamOutput) => {
    const configuration = createRoleConfiguration({ ...DEFAULT_SETTINGS, streamOutput }, [{ id: 'v', name: 'style', value: name }]);
    configuration.confirmed = true; configuration.currentModelId = shared.id;
    configuration.models[shared.id] = createRoleModelConfiguration(configure('instruction', `${text}-{style}`), base.thinking);
    return { data: { ...clone(base), profile: { ...base.profile, name }, memories: [{ id: name,
      text: `${name}的独立记忆`, icon: 'heart', createdAt: model.createdAt, updatedAt: model.updatedAt }] }, configuration };
  };
  const roles = { 'persona-default': makeRole('角色A', '指令A', false), other: makeRole('角色B', '指令B', true) };
  await app.repository.savePersona({ id: 'other', profile: roles.other.data.profile, memories: roles.other.data.memories, interests: [], isActive: false });
  let activeId = 'persona-default';
  app.deps.getCompanion = (id) => ({ ...roles[id ?? activeId], personaId: id ?? activeId });
  await app.engine.sendChatMessage('A的问题');
  const originalSession = app.state().activeSessionId;
  const originalAudit = clone(app.state().messages[1].cotAudit);
  assert.match(app.streams[0].messages[0].content, /^指令A-角色A/);
  assert.equal(app.streams[0].apiModel, shared.apiModel);
  assert.equal(app.streams[0].streamOutput, false);
  assert.doesNotMatch(app.streams[0].messages[0].content, /角色B/);
  activeId = 'other';
  await app.engine.sendChatMessage('仍属于A');
  assert.match(app.streams.at(-1).messages[0].content, /^指令A-角色A/);
  app.engine.startNewConversation(); await app.engine.sendChatMessage('B的问题');
  assert.match(app.streams.at(-1).messages[0].content, /^指令B-角色B/);
  assert.equal(app.streams.at(-1).streamOutput, true);
  assert.doesNotMatch(app.streams.at(-1).messages[0].content, /角色A/);
  roles['persona-default'].configuration.models[shared.id].thinking.instruction.applied.text = '更新后的A';
  await app.engine.openChatSession(originalSession);
  await app.engine.sendChatMessage('旧会话下一条使用A的新设置');
  assert.match(app.streams.at(-1).messages[0].content, /^更新后的A/);
  assert.deepEqual(app.state().messages.find((message) => message.id === app.state().messages[1].id).cotAudit, originalAudit);
  assert.equal(shared.cotMode, 'off');
  assert.equal(roles.other.configuration.models[shared.id].thinking.instruction.applied.text, '指令B-{style}');
});
async function setup(t, web = false) {
  const values = new Map();
  const storage = { getItem: async (key) => values.get(key) ?? null, setItem: async (key, value) => { values.set(key, value); } };
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  const db = adapter(sqlite);
  const repository = web ? createWebRepository(storage) : createSqlRepository(() => db, storage);
  await repository.initialize();
  await repository.saveModel(model);
  let state = { sessions: [], messages: [], activeSessionId: null };
  let runtime = { isSending: false, streamingSessionId: null, error: null, persistenceError: null, hasUnsaved: false };
  let models = [clone(model)];
  let roleConfiguration = createRoleConfiguration(DEFAULT_SETTINGS);
  roleConfiguration.confirmed = true;
  roleConfiguration.currentModelId = model.id;
  roleConfiguration.models[model.id] = { mode: 'off', thinking: createModelThinkingConfig() };
  let sequence = 0;
  const streams = [];
  const deps = {
    repository, initialize: async () => {},
    getChat: () => state, setChat: (patch) => { state = { ...state, ...patch }; },
    getModels: () => models, getCompanion: () => ({ data: createDefaultData(), personaId: 'persona-default' }),
    getSettings: () => ({ ...DEFAULT_SETTINGS }), setRuntime: (patch) => { runtime = { ...runtime, ...patch }; },
    getApiKey: async () => 'secret-test-key',
    stream: async (options) => { streams.push(options); options.onReasoning('推理'); options.onContent('你好🙂'); },
    now: () => new Date(Date.UTC(2026, 9, 20, 2, 0, 0, sequence++ * 10)).toISOString(),
    id: () => `id-${++sequence}`,
  };
  // Proxy closures allow each test to control failures without replacing production engine code.
  const engine = createChatEngine({ ...deps,
    getApiKey: (...args) => deps.getApiKey(...args), getCompanion: (...args) => ({ configuration: roleConfiguration, ...deps.getCompanion(...args) }), getSettings: () => deps.getSettings(), stream: (...args) => deps.stream(...args),
  });
  return { engine, deps, repository, storage, db, streams,
    state: () => state, runtime: () => runtime, setModels: (next) => { models = next; },
    configuration: () => roleConfiguration,
    setRoleConfiguration: (next) => { roleConfiguration = next; },
    setRoleSettings: (patch) => { roleConfiguration.chatSettings = { ...roleConfiguration.chatSettings, ...patch }; },
    setRoleModel: (next) => {
      models = [next];
      roleConfiguration.currentModelId = next.id;
      const data = deps.getCompanion().data;
      roleConfiguration.variables = data.thinking.variables.filter((item) => !['persona', 'date', 'user_name'].includes(item.name));
      roleConfiguration.models[next.id] = createRoleModelConfiguration(next, data.thinking);
    },
    reopen: () => web ? createWebRepository(storage) : createSqlRepository(() => db, storage),
  };
}

for (const web of [false, true]) {
  test(`${web ? 'web' : 'SQLite'} sends a durable atomic turn, streams, audits off and recovers after restart`, async (t) => {
    const app = await setup(t, web);
    let accepted = 0;
    const text = '😀一二三四五六七八九十一二三四五六七八九十一二三';
    app.deps.stream = async (options) => {
      app.streams.push(options);
      const snapshot = await app.repository.initialize();
      assert.equal(snapshot.messages.length, 2);
      assert.equal(snapshot.messages[1].status, 'pending');
      assert.equal(accepted, 1);
      options.onContent('第一段'); options.onReasoning('内部推理'); options.onContent('🙂');
    };
    await app.engine.sendChatMessage(text, () => { accepted += 1; });
    const state = app.state();
    assert.equal(Array.from(state.sessions[0].title).length, 20);
    assert.equal(state.sessions[0].personaId, 'persona-default');
    assert.equal(state.activeSessionId, state.sessions[0].id);
    assert.equal(state.messages[1].content, '第一段🙂');
    assert.equal(state.messages[1].status, 'done');
    for (const item of state.messages) { assert.equal(item.cotMode, 'off'); assert.equal(item.cotPresetId, null); assert.equal(item.modelId, model.id); }
    assert.ok(!JSON.stringify(state).includes('secret-test-key'));
    assert.ok(!JSON.stringify(app.runtime()).includes('secret-test-key'));
    const snapshot = await app.reopen().initialize();
    assert.equal(snapshot.messages[1].content, '第一段🙂');
    assert.equal(snapshot.messages[1].status, 'done');
    assert.equal(app.runtime().isSending, false);
  });
}

test('stop preserves partial output; retry replaces the same last turn without duplicate user rows', async (t) => {
  const app = await setup(t);
  const started = deferred();
  app.deps.stream = async (options) => {
    app.streams.push(options);
    options.onContent('已生成');
    started.resolve();
    await new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new ApiError('cancelled')), { once: true }));
  };
  const send = app.engine.sendChatMessage('问题');
  await started.promise;
  const id = app.state().messages[1].id;
  app.engine.stopGeneration();
  await send;
  assert.equal(app.state().messages[1].status, 'aborted');
  assert.equal(app.state().messages[1].content, '已生成');
  app.deps.stream = async (options) => { app.streams.push(options); options.onContent('重新完成'); };
  await app.engine.retryChatMessage(id);
  assert.equal(app.state().messages.length, 2);
  assert.equal(app.state().messages[1].id, id);
  assert.equal(app.state().messages[1].content, '重新完成');
  assert.equal(app.streams[1].messages.filter((item) => item.role === 'user').length, 1);
  await app.engine.retryChatMessage(id);
  assert.equal(app.streams.length, 2);
  assert.match(app.runtime().error, /只能重试/);
});

test('global single flight captures model/session and cannot append to a viewed different conversation', async (t) => {
  const app = await setup(t);
  await app.engine.sendChatMessage('旧会话');
  const old = app.state().activeSessionId;
  app.engine.startNewConversation();
  const started = deferred(), end = deferred();
  app.deps.stream = async (options) => { app.streams.push(options); options.onContent('A'); started.resolve(); await end.promise; options.onContent('B'); };
  const send = app.engine.sendChatMessage('新会话');
  await started.promise;
  const current = app.runtime().streamingSessionId;
  await app.engine.openChatSession(old);
  app.setModels([{ ...model, id: 'different' }]);
  await app.engine.sendChatMessage('并发不应发送');
  app.engine.startNewConversation();
  assert.equal(app.state().activeSessionId, old);
  end.resolve(); await send;
  assert.equal(app.state().messages.find((item) => item.sessionId === current && item.role === 'assistant').content, 'AB');
  assert.equal(app.state().messages.filter((item) => item.sessionId === old).length, 2);
  assert.equal(app.streams[1].apiModel, model.apiModel);
  assert.equal(app.state().sessions.length, 2);
});

test('failed final save retains full output and disk retry never calls the network again', async (t) => {
  const app = await setup(t);
  const finish = app.repository.finishChatTurn;
  app.repository.finishChatTurn = async () => { throw new Error('disk full secret-test-key'); };
  await app.engine.sendChatMessage('保留我的问题');
  assert.equal(app.runtime().hasUnsaved, true);
  assert.equal(app.state().messages[1].content, '你好🙂');
  assert.equal((await app.repository.initialize()).messages[1].status, 'pending');
  app.engine.startNewConversation();
  assert.notEqual(app.state().activeSessionId, null);
  await app.engine.sendChatMessage('不应发送');
  assert.equal(app.streams.length, 1);
  await app.engine.retryChatPersistence();
  assert.equal(app.runtime().hasUnsaved, true);
  app.repository.finishChatTurn = finish;
  await app.engine.retryChatPersistence();
  assert.equal(app.runtime().hasUnsaved, false);
  assert.equal(app.streams.length, 1);
  assert.equal((await app.repository.initialize()).messages[1].status, 'done');
});

test('initial disk failure retains an accepted local draft, then disk retry enables normal same-turn retry', async (t) => {
  const app = await setup(t);
  const begin = app.repository.saveChatTurn;
  app.repository.saveChatTurn = async () => { throw new Error('disk'); };
  let accepted = 0;
  await app.engine.sendChatMessage('本地草稿', () => { accepted += 1; });
  assert.equal(accepted, 1);
  assert.equal(app.streams.length, 0);
  assert.equal(app.state().messages[1].status, 'error');
  assert.equal((await app.repository.initialize()).sessions.length, 0);
  app.repository.saveChatTurn = begin;
  await app.engine.retryChatPersistence();
  await app.engine.retryChatMessage(app.state().messages[1].id);
  assert.equal(app.streams.length, 1);
  assert.equal((await app.repository.initialize()).messages.length, 2);
});

test('deleting an unrelated session cannot discard another session unsaved output', async (t) => {
  const app = await setup(t);
  await app.engine.sendChatMessage('B');
  const b = app.state().activeSessionId;
  app.engine.startNewConversation();
  const finish = app.repository.finishChatTurn;
  app.repository.finishChatTurn = async () => { throw new Error('disk'); };
  await app.engine.sendChatMessage('A');
  await app.engine.deleteChatSession(b);
  assert.equal(app.runtime().hasUnsaved, true);
  app.repository.finishChatTurn = finish;
  await app.engine.retryChatPersistence();
  assert.equal(app.runtime().hasUnsaved, false);
  assert.equal((await app.repository.initialize()).messages[1].status, 'done');
});

test('a persistence retry during deletion cannot recreate a first-turn draft after delete', async (t) => {
  const app = await setup(t);
  const begin = app.repository.saveChatTurn;
  app.repository.saveChatTurn = async () => { throw new Error('disk'); };
  await app.engine.sendChatMessage('draft');
  const sessionId = app.state().activeSessionId;
  app.repository.saveChatTurn = begin;
  const pending = deferred();
  const remove = app.repository.deleteSession;
  app.repository.deleteSession = async (id) => { await pending.promise; await remove(id); };
  const deleting = app.engine.deleteChatSession(sessionId);
  await settled();
  await app.engine.retryChatPersistence();
  pending.resolve();
  await deleting;
  assert.equal((await app.repository.initialize()).sessions.length, 0);
  assert.equal(app.runtime().hasUnsaved, false);
});

test('session is captured at the send action before asynchronous startup yields to history navigation', async (t) => {
  const app = await setup(t);
  await app.engine.sendChatMessage('original');
  const original = app.state().activeSessionId;
  app.engine.startNewConversation();
  await app.engine.sendChatMessage('other');
  const other = app.state().activeSessionId;
  await app.engine.openChatSession(original);
  const sending = app.engine.sendChatMessage('belongs to original');
  await app.engine.openChatSession(other);
  await sending;
  const last = app.state().messages.find((message) => message.content === 'belongs to original');
  assert.equal(last.sessionId, original);
  assert.equal(app.state().activeSessionId, other);
});

test('deleting during key lookup or streaming waits for cancellation and never resurrects the session', async (t) => {
  const app = await setup(t);
  await app.engine.sendChatMessage('已有会话');
  const sessionId = app.state().activeSessionId;
  const key = deferred();
  app.deps.getApiKey = async () => key.promise;
  const sending = app.engine.sendChatMessage('等待密钥');
  await settled();
  const deleting = app.engine.deleteChatSession(sessionId);
  key.resolve('secret-test-key');
  await Promise.all([sending, deleting]);
  assert.equal((await app.repository.initialize()).sessions.length, 0);
  assert.equal(app.state().sessions.length, 0);
  assert.equal(app.streams.length, 1);
  app.deps.getApiKey = async () => 'secret-test-key';
  const started = deferred();
  app.deps.stream = async (options) => {
    started.resolve();
    await new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new ApiError('cancelled')), { once: true }));
  };
  const next = app.engine.sendChatMessage('生成中');
  await started.promise;
  const newId = app.state().activeSessionId;
  await app.engine.deleteChatSession(newId);
  await next;
  assert.equal((await app.repository.initialize()).sessions.length, 0);
});

test('configuration revisions, absent model/key and unknown errors are safe and do not accept preflight failures', async (t) => {
  const app = await setup(t);
  let accepted = 0;
  app.setModels([]);
  await app.engine.sendChatMessage('输入保留', () => { accepted += 1; });
  assert.equal(accepted, 0);
  app.setModels([clone(model)]);
  app.deps.getApiKey = async () => null;
  await app.engine.sendChatMessage('输入保留', () => { accepted += 1; });
  assert.equal(accepted, 0);
  app.deps.getApiKey = async () => {
    app.setModels([{ ...model, baseUrl: 'https://new.example.test', updatedAt: 'new' }]);
    return 'secret-for-new-target';
  };
  await app.engine.sendChatMessage('不可向旧endpoint泄露新key', () => { accepted += 1; });
  assert.equal(accepted, 0);
  assert.equal(app.streams.length, 0);
  app.setModels([clone(model)]);
  app.deps.getApiKey = async () => 'secret-test-key';
  app.deps.stream = async () => { throw new Error('RAW SECRET secret-test-key'); };
  await app.engine.sendChatMessage('网络失败', () => { accepted += 1; throw new Error('callback'); });
  assert.equal(accepted, 1);
  assert.equal(app.state().messages[1].status, 'error');
  assert.ok(!JSON.stringify(app.state()).includes('RAW SECRET'));
  assert.ok(!JSON.stringify(app.runtime()).includes('secret-test-key'));
});

test('context has one minimal system message and only the newest 20 eligible content messages', () => {
  const messages = Array.from({ length: 30 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: `${index}`,
    status: 'done', reasoning: 'PRIVATE REASONING', cotMode: 'native' }));
  messages.push({ role: 'assistant', content: 'FAILED', status: 'error', reasoning: 'PRIVATE' });
  messages.push({ role: 'assistant', content: '', status: 'done', reasoning: 'PRIVATE' });
  messages.push({ role: 'system', content: 'OLD CUSTOM SYSTEM', status: 'done' });
  const context = buildChatContext(messages);
  assert.equal(context.length, 21);
  assert.equal(context[1].content, '10');
  assert.ok(!JSON.stringify(context).includes('PRIVATE'));
  assert.ok(!JSON.stringify(context).includes('FAILED'));
  assert.ok(!JSON.stringify(context).includes('OLD CUSTOM SYSTEM'));
});

for (const web of [false, true]) {
  test(`${web ? 'web' : 'SQLite'} model deletion after key lookup keeps the pending turn durable with a null session FK and original audit IDs`, async (t) => {
    const app = await setup(t, web);
    await app.engine.sendChatMessage('existing session');
    const getMessages = app.repository.getMessages;
    const reading = deferred(), release = deferred();
    app.repository.getMessages = async (id) => { reading.resolve(); await release.promise; return getMessages(id); };
    const sending = app.engine.sendChatMessage('preserve after model deletion');
    await reading.promise;
    // The captured key/config is valid, but deleting its live model removes the session FK.
    await app.repository.deleteModel(model.id);
    app.setModels([]);
    release.resolve();
    await sending;
    const snapshot = await app.repository.initialize();
    assert.equal(snapshot.sessions[0].modelId, null);
    assert.equal(snapshot.messages.length, 4);
    assert.equal(snapshot.messages[3].status, 'done');
    assert.equal(snapshot.messages[3].content, '你好🙂');
    assert.ok(snapshot.messages.every((message) => message.modelId === model.id));
    assert.equal(app.runtime().hasUnsaved, false);
    assert.equal(app.runtime().persistenceError, null);
    assert.equal(app.streams.length, 2);
  });

  test(`${web ? 'web' : 'SQLite'} interrupted pending messages recover once and search matches literal content only`, async (t) => {
    const app = await setup(t, web);
    await app.engine.sendChatMessage('标题');
    const [user, assistant] = app.state().messages;
    await app.repository.saveMessage({ ...assistant, status: 'streaming', content: '正文100%_匹配', reasoning: 'ONLY_REASONING', error: 'ONLY_ERROR' });
    const reopened = app.reopen();
    const snapshot = await reopened.initialize();
    assert.equal(snapshot.messages[1].status, 'aborted');
    assert.equal(snapshot.messages[1].content, '正文100%_匹配');
    assert.equal((await reopened.searchSessions('%_')).length, 1);
    assert.equal((await reopened.searchSessions('ONLY_REASONING')).length, 0);
    assert.equal((await reopened.searchSessions('ONLY_ERROR')).length, 0);
    assert.equal((await reopened.searchSessions("' OR 1=1 --")).length, 0);
    await reopened.saveMessage({ ...assistant, status: 'pending' });
    assert.equal((await reopened.initialize()).messages.find((message) => message.id === assistant.id).status, 'pending');
    await reopened.deleteSession(user.sessionId);
    await assert.rejects(reopened.finishChatTurn(user.sessionId, assistant, assistant.createdAt), /不存在/);
  });
}

test('SQLite atomic initial turn rolls back session and user when the assistant insert fails', async (t) => {
  const app = await setup(t);
  app.db.execSync("CREATE TRIGGER fail_assistant BEFORE INSERT ON messages WHEN NEW.role = 'assistant' BEGIN SELECT RAISE(ABORT, 'injected disk failure'); END");
  await app.engine.sendChatMessage('完整回滚');
  const snapshot = await app.repository.initialize();
  assert.equal(snapshot.sessions.length, 0);
  assert.equal(snapshot.messages.length, 0);
  assert.equal(app.state().messages.length, 2);
  assert.equal(app.runtime().hasUnsaved, true);
});

test('persona mode captures variables, memories and template audit before asynchronous key lookup', async (t) => {
  const app = await setup(t);
  let data = createDefaultData();
  data.profile.name = '测试伙伴'; data.profile.description = '保留我的介绍';
  data.memories = [{ id: 'memory', text: '用户喜欢清晨散步', icon: 'heart', createdAt: model.createdAt, updatedAt: model.updatedAt }];
  data.thinking.templates[0].prompt = '先倾听{user_name}，你是{persona}，{missing}';
  data.thinking.variables[0].value = '小明';
  app.deps.getCompanion = () => ({ data, personaId: 'persona-default' });
  app.deps.getSettings = () => ({ ...DEFAULT_SETTINGS, userName: '小明' });
  const configured = configure('persona', '', { templateId: data.thinking.templates[0].id });
  await app.repository.saveModel(configured); app.setRoleModel(configured);
  const key = deferred(); app.deps.getApiKey = () => key.promise;
  const sending = app.engine.sendChatMessage('你好');
  await settled();
  data = clone(data); data.profile.name = '之后改的名字'; data.thinking.templates[0].prompt = '之后改的提示';
  key.resolve('secret-test-key'); await sending;
  const options = app.streams[0];
  assert.match(options.messages[0].content, /保留我的介绍[\s\S]*用户喜欢清晨散步[\s\S]*【思维框架】[\s\S]*先倾听小明/);
  assert.doesNotMatch(options.messages[0].content, /之后改/);
  const audit = app.state().messages[1].cotAudit;
  assert.equal(audit.renderedPrefix, '先倾听小明，你是测试伙伴，{missing}');
  assert.deepEqual(audit.warnings, ['未定义变量：{missing}']);
  assert.equal(app.state().messages[1].cotMode, 'off'); assert.equal(app.state().messages[1].thinkingMode, 'persona');
  assert.deepEqual((await app.reopen().initialize()).messages[1].cotAudit, audit);
  data.thinking.templates = []; await app.repository.saveCompanion(data);
  assert.deepEqual((await app.repository.initialize()).messages[1].cotAudit, audit);
  assert.doesNotMatch(JSON.stringify(audit), /secret-test-key/);
});

test('official reasoning-prefix fields reach the request and invalid or disabled configuration preserves unaccepted input', async (t) => {
  const app = await setup(t);
  const data = createDefaultData(); data.thinking.nativeParameters = '{"thinking":{"type":"enabled"}}';
  app.deps.getCompanion = () => ({ data, personaId: 'persona-default' });
  const configured = { ...configure('official', '官方思考前缀'), provider: 'deepseek', apiModel: 'deepseek-flash', baseUrl: 'https://api.deepseek.com/v1' };
  await app.repository.saveModel(configured); app.setRoleModel(configured);
  await app.engine.sendChatMessage('原生模式');
  assert.deepEqual(app.streams[0].requestParameters, { thinking: { type: 'enabled' } });
  assert.deepEqual(app.streams[0].messages.at(-1), { role: 'assistant', content: '', reasoning_content: '官方思考前缀', prefix: true });
  assert.deepEqual(app.state().messages[1].cotAudit.nativeParameters, app.streams[0].requestParameters);
  configured.thinkingConfig.official.applied.parametersJson = '{"messages":[]}';
  app.setRoleModel(configured);
  let accepted = 0;
  await app.engine.sendChatMessage('输入必须保留', () => { accepted += 1; });
  assert.equal(accepted, 0); assert.equal(app.streams.length, 1); assert.equal(app.state().messages.length, 2);
  const disabled = configure('persona', '', { templateId: 'template-warm' });
  data.thinking.templates[0].enabled = false;
  await app.repository.saveModel(disabled); app.setRoleModel(disabled);
  await app.engine.sendChatMessage('停用模板时保留输入', () => { accepted += 1; });
  assert.equal(accepted, 0); assert.equal(app.streams.length, 1); assert.match(app.runtime().error, /停用/);
});

test('instruction retries rebuild only the outgoing copy once and never strip a matching answer prefix', async (t) => {
  const app = await setup(t);
  const data = createDefaultData(); data.thinking.prompt = 'BEGIN🙂';
  app.deps.getCompanion = () => ({ data, personaId: 'persona-default' });
  const configured = configure('instruction', 'BEGIN🙂', { placement: 'user-prefix' });
  await app.repository.saveModel(configured); app.setRoleModel(configured);
  app.deps.stream = async (options) => {
    app.streams.push(options);
    for (const text of ['BE', 'GIN', '🙂']) options.onContent(text);
    throw new ApiError('interrupted_response');
  };
  await app.engine.sendChatMessage('前缀测试');
  assert.equal(app.streams[0].messages.at(-1).content, 'BEGIN🙂\n\n前缀测试');
  assert.equal(app.state().messages[0].content, '前缀测试');
  assert.equal(app.state().messages[1].content, 'BEGIN🙂');
  assert.equal(app.state().messages[1].status, 'error');
  assert.match(app.state().messages[1].error, /意外中断/);
  const id = app.state().messages[1].id;
  configured.thinkingConfig.instruction.applied.text = 'NEXT';
  app.setRoleModel(configured);
  app.deps.stream = async (options) => {
    app.streams.push(options);
    for (const text of ['N', 'EXT答', '案NEXT']) options.onContent(text);
  };
  await app.engine.retryChatMessage(id);
  assert.equal(app.state().messages.length, 2); assert.equal(app.state().messages[1].id, id);
  assert.equal(app.streams[1].messages.at(-1).content, 'NEXT\n\n前缀测试');
  assert.equal(app.state().messages[1].status, 'done'); assert.equal(app.state().messages[1].content, 'NEXT答案NEXT');
  assert.ok(app.streams.every((options) => options.messages.every((message) => !message.prefix && !message.partial && !message.reasoning_content)));
  assert.equal(app.state().messages[1].cotAudit.renderedPrefix, 'NEXT');
  assert.equal((await app.repository.initialize()).messages[1].cotAudit.renderedPrefix, 'NEXT');
});

test('chat settings are captured per send and control recent context and non-streaming transport', async (t) => {
  const app = await setup(t);
  await app.engine.sendChatMessage('first'); await app.engine.sendChatMessage('second');
  let settings = { ...DEFAULT_SETTINGS, contextWindow: 2, streamOutput: false };
  app.deps.getSettings = () => settings;
  app.setRoleSettings({ contextWindow: 2, streamOutput: false });
  const key = deferred(); app.deps.getApiKey = () => key.promise;
  const sending = app.engine.sendChatMessage('third');
  await settled(); settings = { ...DEFAULT_SETTINGS, contextWindow: 50 }; app.setRoleSettings({ contextWindow: 50, streamOutput: true });
  key.resolve('secret-test-key'); await sending;
  assert.equal(app.streams.at(-1).streamOutput, false);
  assert.equal(app.streams.at(-1).messages.length, 3);
  assert.deepEqual(app.streams.at(-1).messages.slice(1).map((message) => message.role), ['assistant', 'user']);
  assert.equal(app.streams.at(-1).messages.at(-1).content, 'third');
});

test('switching active persona does not change an existing session owner or its memories', async (t) => {
  const app = await setup(t);
  const base = createDefaultData();
  await app.repository.savePersona({ id: 'other', profile: { ...base.profile, name: 'Other' }, memories: [], interests: [], isActive: false });
  let activeId = 'persona-default';
  app.deps.getCompanion = (id) => {
    const owner = id ?? activeId;
    if (owner === 'persona-default') return { data: { ...base, profile: { ...base.profile, name: 'Original' } }, personaId: owner };
    if (owner === 'other') return { data: { ...base, profile: { ...base.profile, name: 'Other' } }, personaId: owner };
    throw new Error('missing owner');
  };
  await app.engine.sendChatMessage('original question');
  activeId = 'other'; await app.repository.setActivePersona('other');
  await app.engine.sendChatMessage('still original session');
  assert.match(app.streams.at(-1).messages[0].content, /Original/);
  assert.equal(app.state().sessions[0].personaId, 'persona-default');
  app.engine.startNewConversation(); await app.engine.sendChatMessage('new session');
  assert.match(app.streams.at(-1).messages[0].content, /Other/);
  assert.equal(app.state().sessions.find((session) => session.id === app.state().activeSessionId).personaId, 'other');
});

test('maintenance refuses export during generation, stops before reset and prevents new sends until finished', async (t) => {
  const app = await setup(t); const started = deferred();
  app.deps.stream = async (options) => {
    app.streams.push(options); options.onContent('part'); started.resolve();
    await new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new ApiError('cancelled')), { once: true }));
  };
  const sending = app.engine.sendChatMessage('running'); await started.promise;
  await assert.rejects(app.engine.withChatMaintenance(async () => {}), /等待回复/);
  const work = deferred(), maintenanceStarted = deferred();
  const reset = app.engine.withChatMaintenance(async () => {
    assert.equal(app.runtime().isSending, false);
    assert.equal((await app.repository.initialize()).messages[1].status, 'aborted');
    maintenanceStarted.resolve(); await work.promise;
  }, { stop: true, discardUnsaved: true });
  await maintenanceStarted.promise;
  await app.engine.sendChatMessage('must not send'); assert.equal(app.streams.length, 1);
  work.resolve(); await Promise.all([sending, reset]);
  assert.equal(app.runtime().hasUnsaved, false);
});

test('cleanup-only retry preserves new unsaved output and its persistence retry', async (t) => {
  const app = await setup(t); const finish = app.repository.finishChatTurn;
  app.repository.finishChatTurn = async () => { throw new Error('disk'); };
  await app.engine.sendChatMessage('new output after earlier wipe');
  assert.equal(app.runtime().hasUnsaved, true);
  await app.engine.withChatMaintenance(async () => {}, { stop: true, discardUnsaved: () => false });
  assert.equal(app.runtime().hasUnsaved, true); assert.equal(app.state().messages[1].content, '你好🙂');
  app.repository.finishChatTurn = finish; await app.engine.retryChatPersistence();
  assert.equal(app.runtime().hasUnsaved, false); assert.equal((await app.repository.initialize()).messages[1].status, 'done');
});

for (const web of [false, true]) {
  for (const streamOutput of [true, false]) {
  test(`LB-0506 ${web ? 'web' : 'SQLite'} ${streamOutput ? 'SSE' : 'JSON'} length notices survive reopening and cannot retry a successful turn`, async (t) => {
    const app = await setup(t, web);
    app.deps.getSettings = () => ({ ...DEFAULT_SETTINGS, streamOutput });
    app.setRoleSettings({ streamOutput });
    let requests = 0;
    const server = http.createServer(async (req, res) => {
      const request = [];
      for await (const chunk of req) request.push(chunk);
      assert.equal(JSON.parse(Buffer.concat(request).toString()).stream, streamOutput);
      requests++;
      const message = { role: 'assistant', reasoning_content: 'bounded reasoning', content: requests === 1 ? 'partial answer' : '' };
      res.writeHead(200, { 'Content-Type': streamOutput ? 'text/event-stream' : 'application/json' });
      res.end(streamOutput ? 'data: ' + JSON.stringify({ choices: [{ index: 0, finish_reason: 'length', delta: message }] }) + '\n\ndata: [DONE]\n\n'
        : JSON.stringify({ choices: [{ index: 0, finish_reason: 'length', message }] }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
    app.deps.stream = (options) => streamChat({ ...options, baseUrl: `http://127.0.0.1:${server.address().port}`, fetchImpl: fetch });
    for (let turn = 0; turn < 2; turn++) {
      await app.engine.sendChatMessage(`length turn ${turn}`);
      const reply = app.state().messages.at(-1);
      assert.equal(reply.status, 'done');
      assert.match(reply.error, /回复已达长度上限/);
      assert.equal(reply.content, turn === 0 ? 'partial answer' : '');
      assert.equal(reply.reasoning, 'bounded reasoning');
      const saved = (await app.reopen().initialize()).messages.find((message) => message.id === reply.id);
      assert.equal(saved.status, 'done'); assert.equal(saved.error, reply.error);
      await app.engine.retryChatMessage(reply.id);
      assert.equal(requests, turn + 1, 'completed but length-limited replies are never retransmitted by retry');
    }
    assert.equal(app.state().messages.length, 4);
  });
  }
}

test('LB-0506 retrying disk persistence retains the length notice and never repeats the request', async (t) => {
  const app = await setup(t); let requests = 0;
  app.deps.stream = async (options) => { requests++; options.onContent('partial'); return { finishReason: 'length' }; };
  const finish = app.repository.finishChatTurn;
  app.repository.finishChatTurn = async () => { throw new Error('disk'); };
  await app.engine.sendChatMessage('length');
  assert.equal(app.runtime().hasUnsaved, true);
  assert.match(app.state().messages.at(-1).error, /回复已达长度上限/);
  app.repository.finishChatTurn = finish;
  await app.engine.retryChatPersistence();
  assert.equal(requests, 1); assert.equal(app.runtime().hasUnsaved, false);
  assert.equal((await app.reopen().initialize()).messages.at(-1).status, 'done');
  assert.match((await app.reopen().initialize()).messages.at(-1).error, /回复已达长度上限/);
});

test('LB-0503 only custom model requests enable strict completed-JSON fallback', async (t) => {
  const app = await setup(t);
  await app.engine.sendChatMessage('custom gateway');
  assert.equal(app.streams.at(-1).allowJsonFallback, true);
  const official = { ...model, provider: 'deepseek' };
  await app.repository.saveModel(official); app.setModels([official]);
  await app.engine.sendChatMessage('official endpoint');
  assert.equal(app.streams.at(-1).allowJsonFallback, false);
});

for (const web of [false, true]) {
  for (const withAudit of [false, true]) {
    test(`${web ? 'web' : 'SQLite'} old failed replies keep one original legacy snapshot across network and disk retries (${withAudit ? 'v1 audit' : 'no audit'})`, async (t) => {
      const app = await setup(t, web);
      const session = { id: 'legacy-session', title: '旧会话原文', modelId: model.id, personaId: 'persona-default', pinned: false,
        createdAt: model.createdAt, updatedAt: model.updatedAt };
      const user = { id: 'legacy-user', sessionId: session.id, role: 'user', content: '旧问题原文', reasoning: '', status: 'done', error: null,
        cotMode: 'off', thinkingMode: null, cotPresetId: null, modelId: model.id, createdAt: model.createdAt };
      const v1 = withAudit ? { version: 1, requestedMode: 'prefill', effectiveMode: 'prefill', templateId: 'old-template', templateName: '旧正文续写',
        renderedPrefix: 'OLD VISIBLE PREFIX', warnings: [], nativeParameters: null, modelName: model.name,
        provider: model.provider, apiModel: model.apiModel, baseUrl: model.baseUrl } : null;
      const assistant = { ...user, id: 'legacy-assistant', role: 'assistant', cotMode: 'prefill', cotPresetId: 'old-template',
        status: 'error', error: 'old failure', cotAudit: v1, createdAt: '2026-10-20T01:00:00.001Z' };
      await app.repository.saveSession(session); await app.repository.saveMessage(user); await app.repository.saveMessage(assistant);
      app.state().sessions = [clone(session)]; app.state().messages = [clone(user), clone(assistant)]; app.state().activeSessionId = session.id;
      const configured = configure('instruction', '【PERSONA_LOAD】', { placement: 'user-prefix' });
      await app.repository.saveModel(configured); app.setRoleModel(configured);
      let requests = 0;
      app.deps.stream = async (options) => { requests++; app.streams.push(options); options.onContent('partial raw text');
        throw new ApiError('interrupted_response'); };
      const finish = app.repository.finishChatTurn;
      app.repository.finishChatTurn = async () => { throw new Error('disk'); };
      await app.engine.retryChatMessage(assistant.id);
      const expected = { cotMode: 'prefill', cotPresetId: 'old-template', modelId: model.id, audit: v1 };
      assert.equal(app.runtime().hasUnsaved, true);
      assert.deepEqual(app.state().messages[1].cotAudit.legacySnapshot, expected);
      app.repository.finishChatTurn = finish; await app.engine.retryChatPersistence();
      assert.equal(requests, 1); assert.equal(app.runtime().hasUnsaved, false);
      let saved = (await app.reopen().initialize()).messages[1];
      assert.equal(saved.cotMode, 'prefill'); assert.equal(saved.thinkingMode, 'instruction'); assert.equal(saved.cotAudit.version, 2);
      assert.deepEqual(saved.cotAudit.legacySnapshot, expected);
      assert.equal(app.streams[0].messages.at(-1).content, '【PERSONA_LOAD】\n\n旧问题原文');
      configured.thinkingConfig.instruction.applied.text = 'LANG_ZH_CN_ONLY';
      app.setRoleModel(configured);
      app.deps.stream = async (options) => { requests++; app.streams.push(options); options.onContent('final answer'); };
      await app.engine.retryChatMessage(assistant.id);
      saved = (await app.reopen().initialize()).messages[1];
      assert.equal(saved.status, 'done'); assert.equal(saved.cotMode, 'prefill');
      assert.deepEqual(saved.cotAudit.legacySnapshot, expected);
      assert.equal(saved.cotAudit.renderedPrefix, 'LANG_ZH_CN_ONLY');
      assert.equal(app.streams[1].messages.at(-1).content, 'LANG_ZH_CN_ONLY\n\n旧问题原文');
      assert.equal((await app.repository.initialize()).messages[0].content, '旧问题原文');
      assert.equal((await app.repository.initialize()).sessions[0].title, '旧会话原文');
      assert.equal(requests, 2); assert.equal(app.state().messages.length, 2);
    });
  }
}
