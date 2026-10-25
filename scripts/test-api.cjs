/* global __dirname, Buffer */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

function load(file) {
  const absolute = path.resolve(__dirname, '..', file);
  const source = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInThisContext(`(function(require,module,exports){${source}\n})`, { filename: absolute })(require, module, module.exports);
  return module.exports;
}

const { ApiError, normalizeChatCompletionsUrl, testConnection } = load('src/lib/api/client.ts');
const { PROVIDERS, getProvider } = load('src/lib/api/providers.ts');
const valid = { choices: [{ message: { role: 'assistant', content: 'Hi' } }] };
const jsonResponse = (value) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const options = { baseUrl: 'https://example.invalid/v1', apiModel: 'fixture', apiKey: 'fixture-secret-never-log' };

function errorCode(code) {
  return (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, code);
    assert.doesNotMatch(JSON.stringify(error) + error.message + error.stack, /fixture-secret|raw-provider-error/);
    return true;
  };
}

test('provider defaults preserve editable endpoints without obsolete thinking capability flags', () => {
  assert.deepEqual(PROVIDERS.map((item) => item.id), ['deepseek', 'moonshot', 'dashscope', 'zhipu', 'custom']);
  for (const provider of PROVIDERS) {
    assert.equal('supportsPrefill' in provider, false);
    assert.equal('nativeCoTConfig' in provider, false);
    assert.equal(getProvider(provider.id), provider);
    if (provider.id !== 'custom') assert.match(normalizeChatCompletionsUrl(provider.baseUrl), /^https:\/\//);
  }
  assert.equal(getProvider('deepseek').defaultModel, 'deepseek-flash');
  assert.equal(getProvider('moonshot').defaultModel, 'moonshot-v1-8k');
  assert.equal(getProvider('dashscope').defaultModel, 'qwen-turbo');
  assert.equal(getProvider('zhipu').defaultModel, 'glm-4-flash-250414');
  assert.equal(getProvider('custom').defaultModel, '');
  assert.equal(getProvider('future-provider').id, 'custom');
});

test('URL normalization preserves API versions and full/custom completion endpoints', () => {
  const cases = [
    [' https://example.com/v1/ ', 'https://example.com/v1/chat/completions'],
    ['https://example.com/v1/chat/completions/', 'https://example.com/v1/chat/completions'],
    ['https://api.deepseek.com', 'https://api.deepseek.com/chat/completions'],
    ['https://example.com/api/paas/v4', 'https://example.com/api/paas/v4/chat/completions'],
    ['http://10.0.2.2:8765/compatible-mode/v1', 'http://10.0.2.2:8765/compatible-mode/v1/chat/completions'],
  ];
  for (const [input, expected] of cases) assert.equal(normalizeChatCompletionsUrl(input), expected);
  for (const input of ['', 'not a URL', 'file:///secret', 'https://user:secret@example.com/v1',
    'https://example.com/v1?api_key=secret', 'https://example.com/v1#secret', 'https://example.com/?',
    'https://example.com/#', 'https://example.com/a b', 'https:\\example.com']) {
    assert.throws(() => normalizeChatCompletionsUrl(input), errorCode('validation'));
  }
});

test('input validation and an already aborted signal send no request', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return jsonResponse(valid); };
  for (const change of [{ apiModel: '' }, { apiModel: 'a\nb' }, { apiKey: 'a\nb' },
    { timeoutMs: 0 }, { timeoutMs: Number.NaN }, { timeoutMs: 60_001 }]) {
    await assert.rejects(testConnection({ ...options, fetchImpl, ...change }), errorCode('validation'));
  }
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(testConnection({ ...options, fetchImpl, signal: controller.signal }), errorCode('cancelled'));
  assert.equal(calls, 0);
});

test('test probe disables default thinking only for the exact official DeepSeek origin and current model', async () => {
  const probes = [];
  const fetchImpl = async (url, init) => {
    probes.push({ url, body: JSON.parse(init.body), redirect: init.redirect });
    return jsonResponse(valid);
  };
  await testConnection({ ...options, baseUrl: 'https://api.deepseek.com', apiModel: 'deepseek-flash', fetchImpl });
  await testConnection({ ...options, baseUrl: 'https://api.deepseek.com.evil.invalid', apiModel: 'deepseek-flash', fetchImpl });
  await testConnection({ ...options, baseUrl: 'https://api.deepseek.com', apiModel: 'custom-model', fetchImpl });
  assert.deepEqual(probes[0].body, {
    model: 'deepseek-flash', messages: [{ role: 'user', content: 'Hi' }], stream: false,
    max_tokens: 8, thinking: { type: 'disabled' },
  });
  assert.equal('thinking' in probes[1].body, false);
  assert.equal('thinking' in probes[2].body, false);
  assert.ok(probes.every((probe) => probe.redirect === 'error'));
});

test('invalid successful responses are rejected rather than mistaken for a connection', async () => {
  const payloads = [null, {}, { choices: [] }, { choices: [{ message: { role: 'user', content: 'Hi' } }] },
    { choices: [{ message: { role: 'assistant', content: '' } }] },
    { choices: [{ message: { role: 'assistant', content: null, reasoning_content: 42 } }] },
    { choices: [{ index: 1, message: { role: 'assistant', content: 'Hi' } }] },
    { choices: [{ finish_reason: 42, message: { role: 'assistant', content: '', reasoning_content: 'reasoning' } }] },
    { ...valid, error: { message: 'raw-provider-error fixture-secret' } }];
  for (const payload of payloads) {
    await assert.rejects(testConnection({ ...options, fetchImpl: async () => jsonResponse(payload) }), errorCode('invalid_response'));
  }
  await assert.rejects(testConnection({ ...options, fetchImpl: async () => new Response('<html>raw-provider-error</html>') }), errorCode('invalid_response'));
});

test('LB-0505 local reasoning-only probes prove connectivity without requiring visible answer tokens', async (t) => {
  let requests = 0;
  const server = http.createServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    requests++;
    const content = req.url.startsWith('/null/') ? null : '';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ index: 0, finish_reason: 'length',
      message: { role: 'assistant', content, reasoning_content: 'bounded probe reasoning' } }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  for (const path of ['null', 'empty']) {
    const result = await testConnection({ ...options, apiKey: null,
      baseUrl: `http://127.0.0.1:${server.address().port}/${path}` });
    assert.ok(Number.isFinite(result.latencyMs));
  }
  assert.equal(requests, 2);
  for (const message of [{ role: 'assistant', content: '', reasoning_content: '  ' },
    { role: 'user', content: null, reasoning_content: 'reasoning' },
    { role: 'assistant', content: 42, reasoning_content: 'reasoning' }]) {
    await assert.rejects(testConnection({ ...options, fetchImpl: async () => jsonResponse({ choices: [{ message }] }) }), errorCode('invalid_response'));
  }
});

test('deadlines and cancellation cover fetch and body reads even when a transport ignores abort', async () => {
  const never = () => new Promise(() => {});
  for (const fetchImpl of [never, async () => ({ ok: true, json: never })]) {
    const startedAt = Date.now();
    await assert.rejects(testConnection({ ...options, timeoutMs: 20, fetchImpl }), errorCode('timeout'));
    assert.ok(Date.now() - startedAt < 1000);
    const controller = new AbortController();
    const pending = testConnection({ ...options, fetchImpl, signal: controller.signal });
    controller.abort('fixture-secret');
    await assert.rejects(pending, errorCode('cancelled'));
  }
  await assert.rejects(testConnection({ ...options, fetchImpl: async () => { throw new Error('fixture-secret raw-provider-error'); } }), errorCode('network'));
});

test('real local HTTP requests verify protocol, status classification, redirects, abort, and no-key mode', async () => {
  const requests = [];
  let redirectTargetCalls = 0;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ path: req.url, authorization: req.headers.authorization, contentType: req.headers['content-type'], body: JSON.parse(Buffer.concat(chunks).toString()) });
    if (req.url.startsWith('/redirect-target/')) redirectTargetCalls += 1;
    if (req.url.startsWith('/redirect/')) {
      res.writeHead(307, { Location: '/redirect-target/chat/completions' });
      res.end();
      return;
    }
    if (req.url.startsWith('/slow/')) return;
    if (req.url.startsWith('/status/')) {
      res.writeHead(Number(req.url.split('/')[2]), { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'raw-provider-error fixture-secret' } }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(valid));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const result = await testConnection({ ...options, baseUrl: `${baseUrl}/v1/` });
    assert.deepEqual(Object.keys(result), ['latencyMs']);
    assert.ok(Number.isFinite(result.latencyMs) && result.latencyMs >= 0);
    assert.deepEqual(requests[0], {
      path: '/v1/chat/completions', authorization: `Bearer ${options.apiKey}`, contentType: 'application/json',
      body: { model: 'fixture', messages: [{ role: 'user', content: 'Hi' }], stream: false, max_tokens: 8 },
    });
    await testConnection({ ...options, baseUrl: `${baseUrl}/v1/chat/completions`, apiKey: null });
    assert.equal(requests[1].path, '/v1/chat/completions');
    assert.equal(requests[1].authorization, undefined);
    for (const [status, code] of [[400, 'http'], [401, 'auth'], [403, 'auth'], [404, 'http'], [429, 'rate_limit'], [500, 'server'], [503, 'server']]) {
      await assert.rejects(testConnection({ ...options, baseUrl: `${baseUrl}/status/${status}` }), (error) => {
        assert.equal(error.status, status);
        return errorCode(code)(error);
      });
    }
    await assert.rejects(testConnection({ ...options, baseUrl: `${baseUrl}/redirect` }), errorCode('network'));
    assert.equal(redirectTargetCalls, 0, 'credentials must never reach a redirect target');
    await assert.rejects(testConnection({ ...options, baseUrl: `${baseUrl}/slow`, timeoutMs: 30 }), errorCode('timeout'));
    const controller = new AbortController();
    const pending = testConnection({ ...options, baseUrl: `${baseUrl}/slow`, signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(pending, errorCode('cancelled'));
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
