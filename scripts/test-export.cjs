const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: filename,
}).outputText, filename);
const core = require('../src/lib/data/export-core.ts');
const { chatSettingsValues } = require('../src/features/settings/settings-values.ts');
const { captureCotAttempt, isCotAudit } = require('../src/lib/cot/types.ts');
const date = new Date('2026-10-20T12:34:56.789Z');
const session = { id: 'session-1', title: '聊天🙂', modelId: 'model-1', personaId: 'persona-1', pinned: false, createdAt: date.toISOString(), updatedAt: date.toISOString() };
const message = { id: 'message-1', sessionId: session.id, role: 'assistant', content: '完整正文🙂\n第二行', reasoning: '已返回的思考',
  status: 'done', error: null, cotMode: 'native', cotPresetId: null, modelId: 'model-1', createdAt: date.toISOString() };
const audit = { version: 1, requestedMode: 'native', effectiveMode: 'native', templateId: null, templateName: null,
  renderedPrefix: '用户编辑的框架', warnings: [], nativeParameters: { thinking: { type: 'enabled' } },
  modelName: '我的模型', provider: 'custom', apiModel: 'fixture', baseUrl: 'https://example.test/v1' };
const snapshot = () => ({ sessions: [structuredClone(session)], messages: [structuredClone(message)] });

test('chat JSON exports complete Unicode content, reasoning, statuses and audit with a stable version', () => {
  const source = snapshot(); source.messages[0].cotAudit = structuredClone(audit);
  const before = JSON.stringify(source);
  const result = JSON.parse(core.buildChatExport(source, date));
  assert.equal(result.schemaVersion, 2); assert.equal(result.exportedAt, date.toISOString());
  assert.equal(result.messages[0].content, message.content); assert.equal(result.messages[0].reasoning, message.reasoning);
  assert.equal(result.messages[0].cotAudit.renderedPrefix, audit.renderedPrefix);
  assert.deepEqual(result.messages[0].cotAudit.nativeParameters, audit.nativeParameters);
  assert.equal(JSON.stringify(source), before);
  assert.equal(core.chatExportFilename(date), 'lingban-chats-2026-10-20T12-34-56-789Z.json');
});

test('export whitelists records and removes credential fields and credential-bearing URL parts', () => {
  const source = snapshot();
  source.models = [{ apiKey: 'SECRET_MODEL' }]; source.settings = { password: 'SECRET_SETTINGS' }; source.companion = { private: 'SECRET_PERSONA' };
  source.sessions[0].apiKeyAlias = 'SECRET_SESSION_ALIAS'; source.messages[0].apiKey = 'SECRET_MESSAGE_KEY';
  source.messages[0].cotAudit = { ...audit, alias: 'SECRET_AUDIT_ALIAS',
    baseUrl: 'https://user:SECRET_URL_PASSWORD@example.test/v1?api_key=SECRET_QUERY#SECRET_FRAGMENT',
    nativeParameters: { api_key: 'SECRET_PARAMETER', thinking: { type: 'enabled', apiKeyAlias: 'SECRET_NESTED_ALIAS' },
      vendor: [{ headers: { Authorization: 'SECRET_HEADER' }, key: 'SECRET_GENERIC_KEY', clientSecret: 'SECRET_CLIENT',
        apiToken: 'SECRET_API_TOKEN', mode: 'valid' }] } };
  const output = core.buildChatExport(source, date);
  assert.doesNotMatch(output, /SECRET_/);
  const value = JSON.parse(output);
  assert.deepEqual(Object.keys(value), ['schemaVersion', 'app', 'exportedAt', 'sessions', 'messages']);
  assert.equal(value.messages[0].cotAudit.baseUrl, 'https://example.test/v1');
  assert.deepEqual(value.messages[0].cotAudit.nativeParameters, { thinking: { type: 'enabled' }, vendor: [{ mode: 'valid' }] });
});

test('empty exports remain usable and messages without an exported session are excluded', () => {
  assert.deepEqual(JSON.parse(core.buildChatExport({ sessions: [], messages: [message] }, date)).messages, []);
  const output = JSON.parse(core.buildChatExport({ sessions: [], messages: [] }, date));
  assert.deepEqual(output.sessions, []); assert.deepEqual(output.messages, []);
  const value = JSON.parse(core.buildChatExport(snapshot(), date));
  assert.equal(value.messages[0].cotAudit, null);
});

test('export remains bounded for deep or circular historical extension parameters', () => {
  const source = snapshot(); const circular = { type: 'enabled' }; circular.self = circular;
  source.messages[0].cotAudit = { ...audit, nativeParameters: circular };
  const result = JSON.parse(core.buildChatExport(source, date));
  assert.equal(result.messages[0].cotAudit.nativeParameters.type, 'enabled');
  assert.ok(JSON.stringify(result).length < 10000);
});

test('version 2 exports retain legacy snapshots with the same nested credential filtering', () => {
  const source = snapshot();
  source.messages[0].thinkingMode = 'official';
  source.messages[0].cotAudit = { ...audit, version: 2, requestedMode: 'official', effectiveMode: 'official', target: 'reasoning_content',
    legacySnapshot: { cotMode: 'native', cotPresetId: 'old-template', modelId: 'old-model',
      audit: { ...audit, apiKey: 'SECRET_AUDIT', baseUrl: 'https://user:SECRET_PASSWORD@example.test/v1?api_key=SECRET_QUERY',
        nativeParameters: { vendor: 'preserved', headers: { Authorization: 'SECRET_HEADER' } } } } };
  const output = core.buildChatExport(source, date);
  assert.doesNotMatch(output, /SECRET_/);
  const value = JSON.parse(output);
  assert.equal(value.schemaVersion, 2); assert.equal(value.messages[0].thinkingMode, 'official');
  assert.equal(value.messages[0].cotMode, 'native');
  assert.equal(value.messages[0].cotAudit.target, 'reasoning_content');
  const legacy = value.messages[0].cotAudit.legacySnapshot;
  assert.equal(legacy.cotMode, 'native'); assert.equal(legacy.audit.version, 1);
  assert.deepEqual(legacy.audit.nativeParameters, { vendor: 'preserved' });
  assert.equal(legacy.audit.baseUrl, 'https://example.test/v1');
  assert.equal(JSON.parse(core.buildChatExport(snapshot(), date)).messages[0].thinkingMode, null);
});

test('the first v2 attempt is flat, bounded and exported with credential filtering', () => {
  const source = snapshot();
  const current = { ...audit, version: 2, requestedMode: 'official', effectiveMode: 'official', target: 'reasoning_content' };
  current.originalAttempt = captureCotAttempt({ ...current,
    baseUrl: 'https://user:SECRET_PASSWORD@example.test/v1?api_key=SECRET_QUERY',
    nativeParameters: { thinking: { type: 'enabled' }, headers: { Authorization: 'SECRET_HEADER' }, apiKey: 'SECRET_KEY' } }, 'original-model');
  assert.equal(isCotAudit(current), true);
  assert.equal(isCotAudit({ ...current, originalAttempt: { ...current.originalAttempt, originalAttempt: current.originalAttempt } }), false);
  assert.equal(isCotAudit({ ...current, originalAttempt: { ...current.originalAttempt, apiKey: 'SECRET_EXTRA' } }), false);
  assert.equal(isCotAudit({ ...current, originalAttempt: { ...current.originalAttempt, renderedPrefix: 'x'.repeat(32769) } }), false);
  source.messages[0].cotAudit = current;
  const output = core.buildChatExport(source, date);
  assert.doesNotMatch(output, /SECRET_/);
  const first = JSON.parse(output).messages[0].cotAudit.originalAttempt;
  assert.equal(first.modelId, 'original-model');
  assert.equal(first.baseUrl, 'https://example.test/v1');
  assert.deepEqual(first.nativeParameters, { thinking: { type: 'enabled' } });
  assert.equal(first.originalAttempt, undefined);
});

function loadPlatform(file, dependencies, context = {}) {
  const filename = path.resolve(__dirname, '../src/lib/data', file);
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: filename,
  }).outputText;
  const module = { exports: {} };
  const requireMock = (name) => name === './export-core' ? core : dependencies[name];
  vm.runInNewContext(`(function(require,module,exports){${source}\n})`, { ...context }, { filename })(requireMock, module, module.exports);
  return module.exports;
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function nativeFixture(options = {}) {
  const calls = { files: [], shared: [], folder: null };
  const writeStarted = deferred();
  class Directory {
    constructor(cache, name) { this.uri = `${cache.uri}/${name}`; calls.folder = this; }
    create() { if (options.writeError) throw new Error('SECRET_OS_ERROR'); }
  }
  class File {
    constructor(folder, name) { this.uri = `${folder.uri}/${name}`; calls.files.push(this); }
    create() {}
    async write(value) {
      writeStarted.resolve();
      if (options.writeDeferred) await options.writeDeferred.promise;
      this.value = value;
    }
  }
  const sharing = { isAvailableAsync: async () => options.available !== false,
    shareAsync: async (uri, shareOptions) => { if (options.shareError) throw new Error('SECRET_SHARE_ERROR'); calls.shared.push({ uri, options: shareOptions }); } };
  return { calls, writeStarted: writeStarted.promise,
    module: loadPlatform('export-chats.ts', { 'expo-file-system': { Directory, File, Paths: { cache: { uri: 'file:///owned-cache' } } }, 'expo-sharing': sharing }) };
}

test('native export writes a JSON file in only its cache folder and opens the share chooser', async () => {
  const fixture = nativeFixture();
  await fixture.module.exportAllChats(snapshot());
  assert.equal(fixture.calls.folder.uri, 'file:///owned-cache/chat-exports');
  assert.equal(fixture.calls.files.length, 1); assert.equal(fixture.calls.shared.length, 1);
  assert.equal(fixture.calls.shared[0].options.mimeType, 'application/json');
  assert.match(fixture.calls.shared[0].uri, /^file:\/\/\/owned-cache\/chat-exports\/lingban-chats-.*\.json$/);
  assert.equal(JSON.parse(fixture.calls.files[0].value).messages[0].content, message.content);
});

test('native export failures do not leak platform errors or open a share chooser without a file', async () => {
  for (const options of [{ available: false }, { writeError: true }, { shareError: true }]) {
    const fixture = nativeFixture(options);
    await assert.rejects(fixture.module.exportAllChats(snapshot()), (error) => {
      assert.match(error.message, /导出失败/); assert.doesNotMatch(error.message, /SECRET_/); return true;
    });
    assert.equal(fixture.calls.shared.length, 0);
  }
});

test('native export waits for file writing to finish before opening the share chooser', async () => {
  const disk = deferred();
  const fixture = nativeFixture({ writeDeferred: disk });
  const exporting = fixture.module.exportAllChats(snapshot());
  await fixture.writeStarted;
  await new Promise((resolve) => setImmediate(resolve));
  try {
    assert.equal(fixture.calls.shared.length, 0);
    assert.equal(fixture.calls.files[0].value, undefined);
  } finally { disk.resolve(); await exporting; }
  assert.equal(fixture.calls.shared.length, 1);
  assert.equal(JSON.parse(fixture.calls.files[0].value).messages[0].content, message.content);
});

test('native export reports an asynchronous write failure without opening the share chooser', async () => {
  const disk = deferred();
  const fixture = nativeFixture({ writeDeferred: disk });
  const exporting = fixture.module.exportAllChats(snapshot());
  const failure = assert.rejects(exporting, (error) => {
    assert.match(error.message, /导出失败/);
    assert.doesNotMatch(error.message, /SECRET_DISK_ERROR/);
    return true;
  });
  await fixture.writeStarted;
  disk.reject(new Error('SECRET_DISK_ERROR'));
  await failure;
  assert.equal(fixture.calls.shared.length, 0);
  assert.equal(fixture.calls.files[0].value, undefined);
});

test('web export downloads JSON through a Blob and releases its temporary URL', async () => {
  const link = { clickCount: 0, removeCount: 0, click() { this.clickCount++; }, remove() { this.removeCount++; } };
  let blob, cleanup, revoked;
  const module = loadPlatform('export-chats.web.ts', {}, { Blob, document: { createElement: () => link, body: { appendChild() {} } },
    URL: { createObjectURL: (value) => { blob = value; return 'blob:fixture'; }, revokeObjectURL: (value) => { revoked = value; } },
    setTimeout: (callback) => { cleanup = callback; } });
  await module.exportAllChats(snapshot());
  assert.equal(link.href, 'blob:fixture'); assert.match(link.download, /^lingban-chats-.*\.json$/);
  assert.equal(link.clickCount, 1); assert.equal(link.removeCount, 1);
  assert.equal(JSON.parse(await blob.text()).messages[0].reasoning, message.reasoning);
  cleanup(); assert.equal(revoked, 'blob:fixture');
});

test('settings form validates blank and partial fields without coercing them to saved values', () => {
  for (const name of ['', '   ', 'a'.repeat(101)]) assert.equal(chatSettingsValues(name, '20'), null);
  for (const context of ['', '0', '101', '1.5', '-1', '1e2', ' 20']) assert.equal(chatSettingsValues('昵称', context), null);
  assert.deepEqual(chatSettingsValues('  昵称  ', '1'), { userName: '昵称', contextWindow: 1 });
  assert.deepEqual(chatSettingsValues('🙂'.repeat(100), '100'), { userName: '🙂'.repeat(100), contextWindow: 100 });
});
