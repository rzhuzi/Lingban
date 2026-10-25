const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const ts = require('typescript');

const cache = new Map();
function load(file) {
  const absolute = path.resolve(__dirname, '..', file);
  if (cache.has(absolute)) return cache.get(absolute).exports;
  const source = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  cache.set(absolute, module);
  const localRequire = (id) => id.startsWith('.')
    ? load(path.relative(path.resolve(__dirname, '..'), path.resolve(path.dirname(absolute), `${id}.ts`)))
    : require(id);
  vm.runInThisContext(`(function(require,module,exports){${source}\n})`, { filename: absolute })(localRequire, module, module.exports);
  return module.exports;
}

const { ModelsListError, normalizeModelsUrl, listModels } = load('src/lib/api/models.ts');
const { getModelSuggestions } = load('src/lib/api/model-suggestions.ts');
const options = { baseUrl: 'https://example.invalid/v1', apiKey: 'fixture-secret-never-log' };
const valid = { data: [{ id: 'fixture' }] };
const jsonResponse = (value, init = {}) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' }, ...init });
const never = () => new Promise(() => {});
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
function errorCode(code, status) {
  return (error) => {
    assert.ok(error instanceof ModelsListError);
    assert.equal(error.name, 'ModelsListError');
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    assert.doesNotMatch(JSON.stringify(error) + error.message + error.stack, /fixture-secret|raw-provider-error|example\.invalid/);
    return true;
  };
}
async function fixtureServer(handler, port = 0) {
  const server = http.createServer((req, res) => {
    // A new fixture can immediately inherit a closed fixture's port on Windows.
    // Prevent Node fetch from reusing that fixture's not-yet-closed pooled sockets.
    res.setHeader('Connection', 'close');
    return handler(req, res);
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      // Server.close settles before the client's socket-close callbacks; drain those too.
      await new Promise((resolve) => setImmediate(() => setImmediate(resolve)));
    },
  };
}

test('normalization retains versions, custom paths and existing models endpoints', () => {
  for (const [input, expected] of [
    [' https://api.deepseek.com/ ', 'https://api.deepseek.com/models'],
    ['https://example.com/v1/', 'https://example.com/v1/models'],
    ['https://example.com/v1/chat/completions/', 'https://example.com/v1/models'],
    ['https://example.com/api/coding/v3/chat/completions', 'https://example.com/api/coding/v3/models'],
    ['https://example.com/api/paas/v4', 'https://example.com/api/paas/v4/models'],
    ['https://dashscope.aliyuncs.com/compatible-mode/v1', 'https://dashscope.aliyuncs.com/compatible-mode/v1/models'],
    ['http://10.0.2.2:8080/proxy/v2/models/', 'http://10.0.2.2:8080/proxy/v2/models'],
  ]) assert.equal(normalizeModelsUrl(input), expected);
  for (const input of ['', null, 12, 'invalid', 'file:///secret', 'ftp://example.com/v1',
    'https://user:fixture-secret@example.com/v1', 'https://example.com/v1?api_key=fixture-secret',
    'https://example.com/#', 'https://example.com/?', 'https://example.com/v1#fragment',
    'https://example.com/a b', 'https:\\example.com']) {
    assert.throws(() => normalizeModelsUrl(input), errorCode('validation'));
  }
});

test('validation and pre-cancellation make no request and never expose a key', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return jsonResponse(valid); };
  for (const change of [{ apiKey: 'fixture-secret\nheader' }, { apiKey: 'a'.repeat(8193) },
    { apiKey: 1 }, { timeoutMs: 0 }, { timeoutMs: NaN }, { timeoutMs: Infinity }, { timeoutMs: 60_001 }]) {
    await assert.rejects(listModels({ ...options, fetchImpl, ...change }), errorCode('validation'));
  }
  const controller = new AbortController();
  controller.abort('fixture-secret');
  await assert.rejects(listModels({ ...options, fetchImpl, signal: controller.signal }), errorCode('cancelled'));
  assert.equal(calls, 0);
});

test('model rows are trimmed, deduplicated, sorted deterministically and whitelisted', async () => {
  const result = await listModels({ ...options, fetchImpl: async () => jsonResponse({
    object: 'list', data: [
      { id: ' z ', name: ' 名称 ', owned_by: ' 厂商 ', api_key: 'fixture-secret', other: { raw: 'raw-provider-error' } },
      { id: 'a', name: '', owned_by: null }, { id: 'z', name: 'duplicate' },
      { id: '__proto__' }, { id: 'A', name: null },
    ],
  }) });
  assert.deepEqual(result, [{ id: 'A' }, { id: '__proto__' }, { id: 'a' }, { id: 'z', name: '名称', ownedBy: '厂商' }]);
  assert.doesNotMatch(JSON.stringify(result), /fixture-secret|raw-provider-error|api_key|other/);
});

test('an empty catalog is a successful empty list', async () => {
  assert.deepEqual(await listModels({ ...options, fetchImpl: async () => jsonResponse({ data: [] }) }), []);
});

test('malformed catalogs and rows are rejected without returning a partial list', async () => {
  for (const value of [null, [], {}, { output: { models: [] } }, { data: null }, { data: [] , error: 'raw-provider-error' },
    { data: [null] }, { data: ['fixture'] }, { data: [{}] }, { data: [{ id: 1 }] },
    { data: [{ id: ' ' }] }, { data: [{ id: 'a'.repeat(201) }] }, { data: [{ id: 'a\u0000b' }] },
    { data: [{ id: 'ok' }, { id: 'bad', name: 42 }] }, { data: [{ id: 'ok', owned_by: [] }] },
    { data: [{ id: 'ok', name: 'a'.repeat(201) }] }, { data: Array.from({ length: 5001 }, () => ({ id: 'fixture' })) }]) {
    await assert.rejects(listModels({ ...options, fetchImpl: async () => jsonResponse(value) }), errorCode('invalid_response'));
  }
  for (const value of [{ data: [], has_more: true }, { data: [], next: 'https://other.invalid/models' }, { data: [], next_page: 'token' }]) {
    await assert.rejects(listModels({ ...options, fetchImpl: async () => jsonResponse(value) }), errorCode('unsupported'));
  }
});

test('JSON decoding, UTF-8 integrity and response size are bounded', async () => {
  for (const response of [new Response('<html>raw-provider-error</html>'), new Response(''),
    new Response(new Uint8Array([0xff, 0xfe, 0xfd])),
    new Response(JSON.stringify(valid), { headers: { 'Content-Length': String(2 * 1024 * 1024 + 1) } }),
    new Response(' '.repeat(2 * 1024 * 1024 + 1)), new Response(null)]) {
    await assert.rejects(listModels({ ...options, fetchImpl: async () => response }), errorCode('invalid_response'));
  }
});

test('UTF-8 characters split across streamed chunks are decoded correctly', async () => {
  const bytes = new TextEncoder().encode(JSON.stringify({ data: [{ id: 'fixture', name: '你好' }] }));
  const body = new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
    controller.close();
  } });
  assert.deepEqual(await listModels({ ...options, fetchImpl: async () => new Response(body) }), [{ id: 'fixture', name: '你好' }]);
});

test('real local HTTP GET preserves the endpoint path and only sends optional Bearer authorization', async () => {
  const requests = [];
  const fixture = await fixtureServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ method: req.method, path: req.url, authorization: req.headers.authorization,
      accept: req.headers.accept, contentType: req.headers['content-type'], body: Buffer.concat(chunks).toString() });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(valid));
  });
  try {
    assert.deepEqual(await listModels({ ...options, baseUrl: `${fixture.baseUrl}/api/coding/v3/chat/completions` }), [{ id: 'fixture' }]);
    await listModels({ ...options, baseUrl: `${fixture.baseUrl}/v1`, apiKey: null });
    await listModels({ ...options, baseUrl: `${fixture.baseUrl}/v1/models`, apiKey: '   ' });
    assert.deepEqual(requests[0], { method: 'GET', path: '/api/coding/v3/models', authorization: `Bearer ${options.apiKey}`,
      accept: 'application/json', contentType: undefined, body: '' });
    assert.equal(requests[1].authorization, undefined);
    assert.equal(requests[2].authorization, undefined);
    assert.equal(requests[1].path, '/v1/models');
  } finally { await fixture.close(); }
});

test('real HTTP failures map to fixed errors without reading or exposing server error bodies', async () => {
  const fixture = await fixtureServer((req, res) => {
    res.writeHead(Number(req.url.split('/')[2]), { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'raw-provider-error fixture-secret' } }));
  });
  try {
    for (const [status, code] of [[400, 'http'], [401, 'auth'], [403, 'auth'], [404, 'unsupported'],
      [405, 'unsupported'], [429, 'rate_limit'], [500, 'server'], [501, 'unsupported'], [503, 'server']]) {
      await assert.rejects(listModels({ ...options, baseUrl: `${fixture.baseUrl}/status/${status}` }), errorCode(code, status));
    }
  } finally { await fixture.close(); }
});

test('loopback fixtures isolate fetch connections when a listening port is immediately reused', async () => {
  const first = await fixtureServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(valid));
  });
  const port = Number(new URL(first.baseUrl).port);
  try {
    // Two pooled sockets become idle after alternating three successful requests.
    for (let request = 0; request < 3; request++) await listModels({ ...options, baseUrl: first.baseUrl });
  } finally { await first.close(); }
  const replacement = await fixtureServer((_req, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{}');
  }, port);
  try {
    await assert.rejects(listModels({ ...options, baseUrl: replacement.baseUrl }), errorCode('http', 400));
  } finally { await replacement.close(); }
});

test('real redirects are never followed and no credentials reach the redirect target', async () => {
  let targetCalls = 0;
  const target = await fixtureServer((req, res) => { targetCalls += 1; res.end(JSON.stringify(valid)); });
  const fixture = await fixtureServer((req, res) => { res.writeHead(307, { Location: `${target.baseUrl}/models` }); res.end(); });
  try {
    await assert.rejects(listModels({ ...options, baseUrl: fixture.baseUrl }), errorCode('network'));
    assert.equal(targetCalls, 0);
  } finally { await fixture.close(); await target.close(); }
});

test('redirect-detecting transports reject a changed URL and cancel the unexpected body', async () => {
  for (const change of [{ redirected: true }, { url: 'https://other.invalid/models' }]) {
    let cancelled = 0;
    const response = jsonResponse(valid);
    const body = new ReadableStream({ cancel() { cancelled += 1; } });
    const fetchImpl = async (_url, init) => {
      assert.equal(init.redirect, 'error');
      return { ok: true, status: 200, headers: response.headers, body, ...change };
    };
    await assert.rejects(listModels({ ...options, fetchImpl }), errorCode('network'));
    assert.equal(cancelled, 1);
  }
});

test('deadlines bound ignored fetch aborts and cancel a response arriving after timeout', { timeout: 5000 }, async () => {
  const late = deferred();
  let signal;
  let cancelled = 0;
  const started = Date.now();
  await assert.rejects(listModels({ ...options, timeoutMs: 20,
    fetchImpl: async (_url, init) => { signal = init.signal; return late.promise; } }), errorCode('timeout'));
  // Deadline/cancellation are the contract; concurrent native builds can delay timer scheduling.
  assert.ok(Date.now() - started < 5000);
  assert.equal(signal.aborted, true);
  late.resolve(new Response(new ReadableStream({ cancel() { cancelled += 1; } })));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, 1);
});

test('cancellation and deadlines include uncooperative body reads and uncooperative cleanup', async () => {
  for (const code of ['timeout', 'cancelled']) {
    let cancelled = 0;
    const readStarted = deferred();
    const controller = new AbortController();
    const fetchImpl = async () => ({ ok: true, status: 200, headers: new Headers(), body: {
      getReader: () => ({ read() { readStarted.resolve(); return never(); }, cancel() { cancelled += 1; return never(); }, releaseLock() {} }),
    } });
    const started = Date.now();
    const pending = listModels({ ...options, fetchImpl, signal: controller.signal, timeoutMs: code === 'timeout' ? 20 : 1000 });
    await readStarted.promise;
    if (code === 'cancelled') controller.abort('fixture-secret');
    await assert.rejects(pending, errorCode(code));
    assert.ok(Date.now() - started < 1000);
    assert.equal(cancelled, 1);
  }
});

test('real HTTP body stalls and caller aborts are bounded after successful response headers', async () => {
  const fixture = await fixtureServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.write('{"data":[');
  });
  try {
    await assert.rejects(listModels({ ...options, baseUrl: fixture.baseUrl, timeoutMs: 30 }), errorCode('timeout'));
    const controller = new AbortController();
    const pending = listModels({ ...options, baseUrl: fixture.baseUrl, signal: controller.signal });
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(pending, errorCode('cancelled'));
  } finally { await fixture.close(); }
});

test('subsequent errors and cancellation never resolve to a previous successful list', async () => {
  assert.deepEqual(await listModels({ ...options, fetchImpl: async () => jsonResponse(valid) }), [{ id: 'fixture' }]);
  await assert.rejects(listModels({ ...options, fetchImpl: async () => { throw new Error('fixture-secret raw-provider-error'); } }), errorCode('network'));
  const controller = new AbortController();
  const pending = listModels({ ...options, fetchImpl: never, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, errorCode('cancelled'));
});

test('documented DashScope origins use same-origin native listing and complete bounded text-model pagination', async () => {
  for (const origin of ['https://dashscope-intl.aliyuncs.com', 'https://cn-hongkong.dashscope.aliyuncs.com']) {
    const requests = [];
    const fetchImpl = async (input, init) => {
      const url = new URL(input);
      requests.push({ url, init });
      const page = Number(url.searchParams.get('page_no'));
      return jsonResponse({ success: true, output: { total: 21, page_no: page, models: page === 1
        ? Array.from({ length: 20 }, (_, i) => ({ model: `qwen-${String(i).padStart(2, '0')}`, name: `模型${i}`, provider: 'qwen' }))
        : [{ model: 'qwen-00', name: 'duplicate', provider: 'qwen' }] } });
    };
    const result = await listModels({ ...options, baseUrl: `${origin}/compatible-mode/v1/chat/completions`, fetchImpl });
    assert.equal(result.length, 20);
    assert.deepEqual(result[0], { id: 'qwen-00', name: '模型0', ownedBy: 'qwen' });
    assert.equal(requests.length, 2);
    for (const { url, init } of requests) {
      assert.equal(url.origin, origin);
      assert.equal(url.pathname, '/api/v1/models');
      assert.equal(url.searchParams.get('capabilities'), 'TG');
      assert.equal(url.searchParams.get('page_size'), '20');
      assert.equal(init.method, 'GET');
      assert.equal(init.headers.Authorization, `Bearer ${options.apiKey}`);
      assert.equal(init.redirect, 'error');
    }
  }
});

test('DashScope empty results succeed and malformed or incomplete pagination never leaks partial catalogs', async () => {
  const native = { ...options, baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1' };
  assert.deepEqual(await listModels({ ...native, fetchImpl: async () => jsonResponse({ success: true, output: { total: 0, models: [] } }) }), []);
  for (const payload of [valid, { success: false, message: 'raw-provider-error' },
    { success: true, output: { total: 1, models: [] } }, { success: true, output: { total: -1, models: [] } },
    { success: true, output: { total: 5001, models: [] } }, { success: true, output: { total: 0.5, models: [] } },
    { success: true, output: { total: 1, models: [{ model: 'fixture' }], page_no: 2 } },
    { success: true, output: { total: 1, models: [{ model: '' }] } },
    { success: true, output: { total: 21, models: Array.from({ length: 21 }, () => ({ model: 'fixture' })) } }]) {
    await assert.rejects(listModels({ ...native, fetchImpl: async () => jsonResponse(payload) }), errorCode('invalid_response'));
  }
  let calls = 0;
  await assert.rejects(listModels({ ...native, fetchImpl: async () => {
    calls += 1;
    return jsonResponse({ success: true, output: { total: calls === 1 ? 2 : 3, models: [{ model: `fixture-${calls}` }] } });
  } }), errorCode('invalid_response'));
  assert.equal(calls, 2);
});

test('DashScope pagination shares one deadline and abort signal across pages', async () => {
  const secondPage = deferred();
  const controller = new AbortController();
  let calls = 0;
  const pending = listModels({ ...options, baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', signal: controller.signal,
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return jsonResponse({ success: true, output: { total: 2, models: [{ model: 'fixture' }] } });
      secondPage.resolve();
      return never();
    } });
  await secondPage.promise;
  controller.abort();
  await assert.rejects(pending, errorCode('cancelled'));
  assert.equal(calls, 2);
});

test('a paginated listing has one total deadline rather than a fresh timeout for every page', async () => {
  const signals = [];
  let calls = 0;
  await assert.rejects(listModels({ ...options, baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', timeoutMs: 100,
    fetchImpl: async (_url, init) => {
      signals.push(init.signal);
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 60));
      return jsonResponse({ success: true, output: { total: 2, models: [{ model: `fixture-${calls}` }] } });
    } }), errorCode('timeout'));
  assert.equal(calls, 2);
  assert.equal(signals[0], signals[1]);
  assert.equal(signals[0].aborted, true);
});

test('custom, lookalike, different-path and unverified origins never activate native adaptation', async () => {
  for (const baseUrl of ['https://dashscope.aliyuncs.com/compatible-mode/v1',
    'http://dashscope-intl.aliyuncs.com/compatible-mode/v1', 'https://dashscope-intl.aliyuncs.com:444/compatible-mode/v1',
    'https://dashscope-intl.aliyuncs.com.evil.invalid/compatible-mode/v1',
    'https://dashscope-intl.aliyuncs.com/proxy/compatible-mode/v1', 'https://example.invalid/compatible-mode/v1']) {
    const requests = [];
    const result = await listModels({ ...options, baseUrl, fetchImpl: async (url) => { requests.push(url); return jsonResponse(valid); } });
    assert.deepEqual(result, [{ id: 'fixture' }]);
    assert.deepEqual(requests, [normalizeModelsUrl(baseUrl)]);
  }
});

test('reference suggestions require exact official origin and path, contain current IDs and are fresh copies', () => {
  const expected = [
    ['https://api.deepseek.com/v1/chat/completions', ['deepseek-flash', 'deepseek-v4-pro']],
    ['https://api.moonshot.cn/v1', ['kimi-k3', 'kimi-k2.6']],
    ['https://dashscope.aliyuncs.com/compatible-mode/v1', ['qwen3.8-max', 'qwen3.7-plus', 'qwen3.8-flash']],
    ['https://open.bigmodel.cn/api/paas/v4', ['glm-5.3', 'glm-4.7', 'glm-4.5-flash']],
  ];
  for (const [baseUrl, ids] of expected) {
    assert.deepEqual(getModelSuggestions(baseUrl).map((model) => model.id), ids);
    getModelSuggestions(baseUrl)[0].id = 'mutated';
    assert.deepEqual(getModelSuggestions(baseUrl).map((model) => model.id), ids);
  }
  for (const baseUrl of ['', 'https://example.invalid/v1', 'https://api.deepseek.com.evil.invalid/v1',
    'http://api.deepseek.com/v1', 'https://open.bigmodel.cn/api/coding/paas/v4',
    'https://api.moonshot.cn/proxy/v1', 'https://api.moonshot.cn/v1?api_key=fixture-secret']) {
    assert.deepEqual(getModelSuggestions(baseUrl), []);
  }
});
