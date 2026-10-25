const assert = require('node:assert/strict');
const fs = require('node:fs');
const { test } = require('node:test');
const ts = require('typescript');

require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: filename,
}).outputText, filename);

const { editableNativeParameters, previewOfficialThinking } = require('../src/features/companion/native-thinking.ts');
const deepseek = { provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiModel: 'deepseek-flash' };
const prefix = '先理解问题，再自然回应。';

test('official preview uses the actual endpoint and dedicated assistant without changing the model', () => {
  const before = structuredClone(deepseek);
  assert.deepEqual(previewOfficialThinking(deepseek, prefix, '{}'), {
    state: 'ready', baseUrl: 'https://api.deepseek.com/beta', parameters: { thinking: { type: 'enabled' } },
    assistant: { role: 'assistant', content: '', prefix: true, reasoning_content: prefix }, message: null,
  });
  assert.deepEqual(deepseek, before);
});

test('official preview merges supported parameter overrides with enabled thinking', () => {
  const preview = previewOfficialThinking(deepseek, prefix, '{"reasoning_effort":"high"}');
  assert.equal(preview.state, 'ready');
  assert.deepEqual(preview.parameters, { reasoning_effort: 'high', thinking: { type: 'enabled' } });
  assert.equal(preview.assistant.reasoning_content, prefix);
});

test('empty prefixes preserve valid endpoint capability without claiming an executable prefix', () => {
  for (const text of ['', ' \n\t']) {
    const preview = previewOfficialThinking(deepseek, text, '{}');
    assert.equal(preview.state, 'needs-prefix');
    assert.equal(preview.baseUrl, 'https://api.deepseek.com/beta');
    assert.deepEqual(preview.parameters, { thinking: { type: 'enabled' } });
    assert.equal(preview.assistant, null);
    assert.match(preview.message, /填写思考前缀/);
  }
});

test('unsupported official models and endpoints preserve explanations and never preview guessed fields', () => {
  for (const model of [{ ...deepseek, apiModel: 'unknown-model' },
    { ...deepseek, baseUrl: 'https://proxy.example.invalid/v1' },
    { provider: 'custom', baseUrl: 'https://example.invalid/v1', apiModel: 'custom' },
    { provider: 'moonshot', baseUrl: 'https://api.moonshot.cn/v1', apiModel: 'kimi-k3' }]) {
    const result = previewOfficialThinking(model, prefix, '{}');
    assert.equal(result.state, 'error'); assert.equal(result.parameters, null);
    assert.equal(result.assistant, null); assert.equal(result.baseUrl, null);
    assert.match(result.message, /官方思考前缀尚未接入/);
  }
});

test('disabled thinking and foreign parameter drafts remain invalid instead of silently resetting', () => {
  for (const raw of ['{"enable_thinking":true}', '{"thinking":{"type":"disabled"}}', '{"reasoning_effort":"none"}']) {
    const result = previewOfficialThinking(deepseek, prefix, raw);
    assert.equal(result.state, 'error'); assert.equal(result.parameters, null); assert.equal(result.assistant, null);
    assert.equal(editableNativeParameters(raw), raw);
  }
});

test('automatic parameter editor hides only genuine empty JSON objects', () => {
  for (const raw of ['{}', ' \n{  }\t', '{\r\n\t}\n']) assert.equal(editableNativeParameters(raw), '');
  for (const raw of [' {"thinking": {"type":"enabled"}} ', '', '   ', '{ incomplete', '[]', 'null', '"{}"']) {
    assert.equal(editableNativeParameters(raw), raw);
  }
});

test('missing models return a no-model state before parsing an unfinished parameter draft', () => {
  for (const raw of ['{}', '{ unfinished']) {
    assert.deepEqual(previewOfficialThinking(undefined, prefix, raw), {
      state: 'no-model', baseUrl: null, parameters: null, assistant: null, message: '请先选择目标模型。',
    });
  }
});

test('invalid JSON and nonobject parameters return fixed configuration errors', () => {
  for (const raw of ['{ unfinished', '', 'null', '[]', '42']) {
    const result = previewOfficialThinking(deepseek, prefix, raw);
    assert.equal(result.state, 'error'); assert.equal(result.parameters, null); assert.equal(result.assistant, null);
    assert.equal(result.message, '原生参数必须是有效的 JSON 对象。');
  }
});

test('unexpected adapter failures never expose raw exception text', () => {
  const model = { ...deepseek, get provider() { throw new Error('fixture-private-raw-exception'); } };
  const result = previewOfficialThinking(model, prefix, '{}');
  assert.equal(result.state, 'error'); assert.equal(result.parameters, null); assert.equal(result.assistant, null);
  assert.equal(result.message, '无法预览官方配置，请检查目标模型后重试。');
  assert.doesNotMatch(JSON.stringify(result), /fixture-private/);
});
