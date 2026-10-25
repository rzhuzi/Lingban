const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const ts = require('typescript');

require.extensions['.ts'] = (module, filename) => {
  module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: filename,
  }).outputText, filename);
};
const { resolveOfficialTarget: official } = require('../src/lib/cot/provider-adapters.ts');
const { CotConfigurationError } = require('../src/lib/cot/errors.ts');
const deepseek = { provider: 'deepseek', baseUrl: 'https://api.deepseek.com', apiModel: 'deepseek-flash' };
function safeError(operation, pattern) {
  assert.throws(operation, (error) => {
    assert.ok(error instanceof CotConfigurationError);
    assert.doesNotMatch(error.message, /RAW_SECRET|sensitive\.invalid/);
    if (pattern) assert.match(error.message, pattern);
    return true;
  });
}

test('official DeepSeek reasoning-prefix targets normalize documented origins and paths to beta', () => {
  for (const baseUrl of ['https://api.deepseek.com', 'https://api.deepseek.com/v1/',
    'https://api.deepseek.com/beta', 'https://api.deepseek.com/beta/chat/completions',
    'https://api.deepseek.com/v1/chat/completions/']) {
    for (const apiModel of ['deepseek-flash', 'deepseek-v4-pro']) {
      assert.deepEqual(official({ ...deepseek, baseUrl, apiModel }, '{}'), {
        baseUrl: 'https://api.deepseek.com/beta', requestParameters: { thinking: { type: 'enabled' } },
      });
    }
  }
});

test('official adapter accepts only documented thinking fields and exact parameter types', () => {
  for (const reasoning_effort of ['low', 'high', 'max']) {
    assert.deepEqual(official(deepseek, JSON.stringify({ reasoning_effort })).requestParameters,
      { thinking: { type: 'enabled' }, reasoning_effort });
  }
  assert.deepEqual(official(deepseek, '{"thinking":{}}').requestParameters, { thinking: { type: 'enabled' } });
  for (const raw of ['{"reasoning_effort":"ultra"}', '{"reasoning_effort":["high"]}',
    '{"thinking":{"type":["enabled"]}}', '{"thinking":{"type":"enabled","unknown":true}}',
    '{"thinking":null}', '{"temperature":0.5}', '{"enable_thinking":true}']) {
    safeError(() => official(deepseek, raw), /不支持/);
  }
});

test('official thinking prefix rejects disabled thinking instead of silently overriding the user', () => {
  for (const raw of ['{"thinking":{"type":"disabled"}}', '{"reasoning_effort":"none"}',
    '{"thinking":{"type":"disabled"},"reasoning_effort":"high"}']) {
    safeError(() => official(deepseek, raw), /开启思考/);
  }
});

test('official adapters require matching provider, origin, path and documented model', () => {
  for (const baseUrl of ['http://api.deepseek.com', 'https://api.deepseek.com.sensitive.invalid',
    'https://api.deepseek.com:8443', 'https://api.deepseek.com/unknown',
    'https://RAW_SECRET@api.deepseek.com', 'https://api.deepseek.com?key=RAW_SECRET',
    'https://api.deepseek.com/#RAW_SECRET', 'not-a-url']) {
    safeError(() => official({ ...deepseek, baseUrl }, '{}'), /尚未接入/);
  }
  for (const apiModel of ['deepseek-future', 'deepseek-chat', '', 'deepseek-flash-extra']) {
    safeError(() => official({ ...deepseek, apiModel }, '{}'), /尚未接入/);
  }
  safeError(() => official({ ...deepseek, provider: 'custom' }, '{}'), /尚未接入/);
});

test('non-DeepSeek and custom providers never receive guessed native or reasoning-prefix protocols', () => {
  for (const model of [
    { provider: 'moonshot', baseUrl: 'https://api.moonshot.cn/v1', apiModel: 'kimi-k2.6' },
    { provider: 'moonshot', baseUrl: 'https://api.moonshot.cn/v1', apiModel: 'kimi-k3' },
    { provider: 'dashscope', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiModel: 'qwen-plus' },
    { provider: 'zhipu', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', apiModel: 'glm-5.3' },
    { provider: 'custom', baseUrl: 'http://127.0.0.1:8792/v1', apiModel: 'fixture' },
  ]) {
    safeError(() => official(model, '{}'), /尚未接入/);
    safeError(() => official(model, '{"thinking":{"type":"enabled"}}'), /尚未接入/);
  }
});

test('invalid JSON and nonobject values produce fixed configuration errors', () => {
  for (const raw of ['RAW_SECRET', 'null', '[]', '"RAW_SECRET"', '42', '']) {
    safeError(() => official(deepseek, raw), /有效的 JSON 对象/);
  }
});

test('base request and credential overrides are rejected with no secret in the error', () => {
  for (const key of ['model', 'Messages', 'stream', 'max_tokens', 'max_completion_tokens', 'stream_options',
    'headers', 'body', 'method', 'url', 'baseurl', 'base_url', 'endpoint', 'signal', 'timeout', 'timeoutms',
    'fetch', 'fetchimpl', 'api_key', 'apikey', 'authorization', 'password', 'access_token', 'tools', 'tool_choice', 'n']) {
    safeError(() => official(deepseek, JSON.stringify({ [key]: 'RAW_SECRET' })), /不支持/);
  }
});

test('prototype keys, nonfinite numeric values and excessive nesting are rejected', () => {
  for (const raw of ['{"__proto__":{"enabled":true}}',
    '{"thinking":{"constructor":{"prototype":{"polluted":true}}}}',
    '{"thinking":{"budget":1e999}}']) safeError(() => official(deepseek, raw), /不支持/);
  let nested = true;
  for (let i = 0; i < 20; i += 1) nested = { nested };
  safeError(() => official(deepseek, JSON.stringify({ thinking: nested })), /不支持/);
  assert.equal({}.polluted, undefined);
});
