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
  const localRequire = (name) => name.startsWith('.')
    ? load(path.relative(path.resolve(__dirname, '..'), path.resolve(path.dirname(absolute), `${name}.ts`)))
    : require(name);
  vm.runInThisContext(`(function(require,module,exports){${source}\n})`, { filename: absolute })(localRequire, module, module.exports);
  return module.exports;
}

const { ApiError } = load('src/lib/api/client.ts');
const { streamChat } = load('src/lib/api/stream.ts');
const { SseParser } = load('src/lib/api/sse.ts');
const { buildRequestMessages } = load('src/lib/cot/inject.ts');
const { createDefaultData } = load('src/features/companion/defaults.ts');
const { createModelThinkingConfig, createThinkingDraft } = load('src/features/companion/thinking-config.ts');
const encoder = new TextEncoder();
const frame = (delta, finish_reason = null) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
const done = 'data: [DONE]\n\n';
const options = { baseUrl: 'https://example.invalid/v1', apiModel: 'fixture', apiKey: 'fixture-secret-never-log',
  messages: [{ role: 'system', content: 'fixture private system' }, { role: 'user', content: 'fixture private user' }] };

function safeError(code) {
  return (error) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.code, code);
    assert.doesNotMatch(JSON.stringify(error) + error.message + error.stack,
      /fixture-secret|raw-provider-error|fixture private|fixture-upstream/);
    return true;
  };
}

function responseFor(chunks, hooks = {}) {
  let index = 0;
  return {
    response: { ok: true, status: 200, headers: new Headers({ 'Content-Type': 'text/event-stream; charset=utf-8' }),
      body: { getReader: () => ({
        read: async () => {
          if (index < chunks.length) return { done: false, value: chunks[index++] };
          if (hooks.readEnd) return hooks.readEnd();
          return { done: true };
        },
        cancel: async () => hooks.cancel?.(),
        releaseLock: () => hooks.release?.(),
      }) } },
  };
}

async function collect(chunks, changes = {}, hooks) {
  const content = [];
  const reasoning = [];
  const { response } = responseFor(chunks, hooks);
  await streamChat({ ...options, onContent: (delta) => content.push(delta), onReasoning: (delta) => reasoning.push(delta),
    fetchImpl: async () => response, ...changes });
  return { content, reasoning };
}

test('SSE framing preserves multi-line data and CR/LF boundaries, ignores heartbeat/id/retry fields', () => {
  const events = [];
  const parser = new SseParser((data, event) => events.push({ data, event }));
  const input = ':heartbeat\r\nid: 8\rretry: 1000\n' +
    'event: message\r\ndata: first\r\ndata:  second\r\n\r\n' +
    'data:\n\ndata: discarded without final blank line\n';
  for (const character of input) parser.push(character);
  assert.deepEqual(events, [{ data: 'first\n second', event: 'message' }, { data: '', event: '' }]);
  assert.throws(() => new SseParser(() => {}, 8).push('data: too large'), /SSE event limit/);
});

test('official reasoning prefixes preserve their empty answer content and dedicated wire field', async () => {
  let sent;
  const { response } = responseFor([encoder.encode(frame({ content: '回答' }) + done)]);
  await streamChat({ ...options, messages: [...options.messages, { role: 'assistant', content: '', reasoning_content: '思考前缀', prefix: true }],
    requestParameters: { thinking: { type: 'enabled' } }, onContent() {},
    fetchImpl: async (url, init) => { sent = JSON.parse(init.body); return response; } });
  assert.deepEqual(sent.thinking, { type: 'enabled' }); assert.equal(sent.stream, true);
  assert.deepEqual(sent.messages.at(-1), { role: 'assistant', content: '', reasoning_content: '思考前缀', prefix: true });
  assert.equal(sent.model, options.apiModel);
  const second = responseFor([encoder.encode(frame({ content: '回答' }) + done)]);
  await streamChat({ ...options, onContent() {}, fetchImpl: async (url, init) => { sent = JSON.parse(init.body); return second.response; } });
  assert.ok(sent.messages.every((message) => !('prefix' in message) && !('partial' in message) && !('reasoning_content' in message)));
});

test('reserved native fields and misplaced continuation flags send no network request', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('must not request'); };
  for (const changes of [{ requestParameters: { messages: [] } }, { requestParameters: { stream: false } },
    { messages: [{ role: 'user', content: 'x', prefix: true }] },
    { messages: [{ role: 'assistant', content: 'x', partial: true }, { role: 'user', content: 'y' }] },
    { messages: [{ role: 'assistant', content: 'x', prefix: true, partial: true }] }]) {
    await assert.rejects(streamChat({ ...options, ...changes, onContent() {}, fetchImpl }), safeError('validation'));
  }
  for (const changes of [
    { messages: [{ role: 'assistant', content: '', reasoning_content: 'reason' }] },
    { messages: [{ role: 'user', content: '', reasoning_content: 'reason', prefix: true }] },
    { messages: [{ role: 'assistant', content: 'visible prefix', reasoning_content: 'reason', prefix: true }] },
    { messages: [{ role: 'assistant', content: '', reasoning_content: 'reason', prefix: true }, { role: 'user', content: 'later' }] },
    { messages: [{ role: 'assistant', content: '', reasoning_content: ' ', prefix: true }] },
    { messages: [{ role: 'assistant', content: '', reasoning_content: 'reason', prefix: true }], requestParameters: { thinking: { type: 'disabled' } } },
    { messages: [{ role: 'assistant', content: '', reasoning_content: 'reason', prefix: true }], requestParameters: { thinking: { type: 'enabled' }, reasoning_effort: 'none' } },
  ]) await assert.rejects(streamChat({ ...options, ...changes, onContent() {}, fetchImpl }), safeError('validation'));
  assert.equal(calls, 0);
});

test('non-streaming mode requests JSON and emits complete content/reasoning once across UTF-8 byte boundaries', async () => {
  const payload = { choices: [{ index: 0, message: { role: 'assistant', content: '完整回复🙂', reasoning_content: '可见思考' } }] };
  const chunks = Array.from(encoder.encode(JSON.stringify(payload)), (byte) => Uint8Array.of(byte));
  const { response } = responseFor(chunks); response.headers = new Headers({ 'Content-Type': 'application/json; charset=utf-8' });
  const content = [], reasoning = []; let sent;
  await streamChat({ ...options, streamOutput: false, onContent: (part) => content.push(part), onReasoning: (part) => reasoning.push(part),
    fetchImpl: async (url, init) => { sent = JSON.parse(init.body); return response; } });
  assert.equal(sent.stream, false); assert.deepEqual(content, ['完整回复🙂']); assert.deepEqual(reasoning, ['可见思考']);
});

test('non-streaming malformed JSON and empty replies keep fixed errors and cancel their reader', async () => {
  for (const [raw, code] of [['not JSON raw-provider-error', 'invalid_response'],
    ['{"error":{"message":"raw-provider-error"}}', 'server'],
    ['{"choices":[{"message":{"role":"assistant","content":"","reasoning_content":"思考"}}]}', 'empty_response'],
    ['{"choices":[{"message":{"role":"user","content":"wrong"}}]}', 'invalid_response']]) {
    let cancelled = 0;
    const { response } = responseFor([encoder.encode(raw)], { cancel: () => { cancelled++; } });
    response.headers = new Headers({ 'Content-Type': 'application/json' });
    await assert.rejects(streamChat({ ...options, streamOutput: false, onContent() {}, fetchImpl: async () => response }), safeError(code));
    assert.equal(cancelled, 1);
  }
});

test('every UTF-8 byte split is decoded correctly and content/reasoning remain distinct', async () => {
  const text = '\ufeff: keepalive\r\n\r\n' +
    frame({ role: 'assistant', content: '' }).replaceAll('\n', '\r\n') +
    frame({ reasoning_content: '先想一想🧠', content: null }) + frame({ content: '你好🌸' }) +
    frame({ content: '，我在。' }, 'stop') + 'data: {"choices":[],"usage":{"total_tokens":9}}\n\n' + done;
  const bytes = encoder.encode(text);
  const result = await collect(Array.from(bytes, (byte) => Uint8Array.of(byte)));
  assert.deepEqual(result, { content: ['你好🌸', '，我在。'], reasoning: ['先想一想🧠'] });
});

test('JSON may span SSE data lines, empty deltas and usage chunks are harmless', async () => {
  const multiline = 'data: {"choices":[\ndata: {"delta":{"content":"完整"},"finish_reason":null}]}\n\n';
  const result = await collect([encoder.encode(frame({}) + multiline + frame({}, 'stop') + done)]);
  assert.deepEqual(result, { content: ['完整'], reasoning: [] });
  assert.deepEqual(await collect([encoder.encode(frame({ content: 'EOF after finish' }, 'stop'))]),
    { content: ['EOF after finish'], reasoning: [] });
});

test('invalid inputs and pre-aborted requests make no network call', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new Error('must not call'); };
  for (const change of [{ baseUrl: 'https://user:fixture-secret@example.invalid' }, { apiModel: '' },
    { apiModel: 'unsafe\nmodel' }, { apiKey: 'unsafe\nkey' }, { timeoutMs: 0 }, { timeoutMs: NaN },
    { timeoutMs: 120_001 }, { maxTokens: 0 }, { maxTokens: 1.5 }, { maxTokens: 32_769 }, { allowJsonFallback: 'true' },
    { messages: [] }, { messages: [{ role: 'tool', content: 'no tools' }] }, { messages: [{ role: 'user', content: 42 }] }]) {
    await assert.rejects(streamChat({ ...options, onContent: () => {}, fetchImpl, ...change }), safeError('validation'));
  }
  const controller = new AbortController();
  controller.abort('fixture-secret');
  await assert.rejects(streamChat({ ...options, onContent: () => {}, fetchImpl, signal: controller.signal }), safeError('cancelled'));
  assert.equal(calls, 0);
});

test('raw provider errors, malformed shapes and invalid UTF-8 are sanitized and close the reader', async () => {
  const payloads = [
    'data: not json raw-provider-error fixture-secret\n\n',
    'event: error\ndata: raw-provider-error fixture-secret\n\n',
    'data: {"error":{"message":"raw-provider-error fixture-secret"}}\n\n',
    'data: null\n\n', 'data: {"choices":[]}\n\n',
    'data: {"choices":[{"delta":{"content":42}}]}\n\n',
    'data: {"choices":[{"delta":null}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":42}]}\n\n',
    frame({ content: 'one' }, 'stop') + frame({ content: 'late' }),
    'data: ' + 'x'.repeat(1_048_577),
  ];
  for (const [index, payload] of payloads.entries()) {
    let cancelled = 0;
    const code = index === 1 || index === 2 ? 'server' : 'invalid_response';
    await assert.rejects(collect([encoder.encode(payload)], {}, { cancel: () => { cancelled += 1; } }), safeError(code));
    assert.equal(cancelled, 1);
  }
  await assert.rejects(collect([Uint8Array.of(0xc3, 0x28)]), safeError('invalid_response'));
});

test('unexpected EOF, incomplete final events and empty completion are not successful replies', async () => {
  for (const text of ['', ':heartbeat\n\n', frame({ content: 'partial reply' }),
    frame({ content: 'partial reply' }) + 'data: [DONE]\n']) {
    await assert.rejects(collect([encoder.encode(text)]), safeError('interrupted_response'));
  }
  await assert.rejects(collect([encoder.encode(done)]), safeError('invalid_response'));
  let partial = '';
  await assert.rejects(collect([encoder.encode(frame({ content: 'kept' }))], { onContent: (value) => { partial += value; } }),
    safeError('interrupted_response'));
  assert.equal(partial, 'kept');
});

test('reasoning without usable reply content reports an empty response unless the provider explicitly exhausted its length budget', async () => {
  for (const ending of [frame({}, 'stop') + done, frame({}, 'stop')]) {
    const reasoning = [];
    await assert.rejects(collect([encoder.encode(frame({ reasoning_content: 'reasoning was generated' }) +
      frame({ content: ' \n\t' }) + ending)], { onReasoning: (delta) => reasoning.push(delta) }), (error) => {
      assert.equal(error.message, '模型没有返回正文，请重试或更换模型。');
      return safeError('empty_response')(error);
    });
    assert.deepEqual(reasoning, ['reasoning was generated']);
  }
  assert.deepEqual(await collect([encoder.encode(frame({ reasoning_content: 'reasoning' }) +
    frame({ content: 'usable partial answer' }, 'length') + done)]),
  { content: ['usable partial answer'], reasoning: ['reasoning'] });
});

test('callback and transport exceptions cannot leak private text', async () => {
  await assert.rejects(collect([encoder.encode(frame({ content: 'hello' }) + done)], {
    onContent: () => { throw new Error('raw-provider-error fixture-secret fixture private'); },
  }), safeError('invalid_response'));
  await assert.rejects(streamChat({ ...options, onContent: () => {}, fetchImpl: async () => {
    throw new Error('fixture-upstream https://fixture-secret.invalid');
  } }), safeError('network'));
  await assert.rejects(collect([], {}, { readEnd: () => { throw new Error('fixture-secret raw-provider-error'); } }), safeError('network'));
});

test('deadline covers headers and body even when fetch/read/cancel ignore AbortSignal', async () => {
  const never = () => new Promise(() => {});
  for (const fetchImpl of [never, async () => responseFor([], { readEnd: never, cancel: never }).response]) {
    const startedAt = Date.now();
    await assert.rejects(streamChat({ ...options, onContent: () => {}, timeoutMs: 25, fetchImpl }), safeError('timeout'));
    assert.ok(Date.now() - startedAt < 1000);
  }
});

test('abort promptly cancels a pending reader and prevents late deltas after the promise rejects', async () => {
  let resolveRead;
  let readStarted;
  let cancelled = 0;
  let released = 0;
  const reading = new Promise((resolve) => { readStarted = resolve; });
  const lateRead = new Promise((resolve) => { resolveRead = resolve; });
  const controller = new AbortController();
  const deltas = [];
  const { response } = responseFor([], { readEnd: () => { readStarted(); return lateRead; },
    cancel: () => { cancelled += 1; }, release: () => { released += 1; } });
  const pending = streamChat({ ...options, signal: controller.signal, onContent: (delta) => deltas.push(delta),
    fetchImpl: async () => response });
  await reading;
  controller.abort('fixture-secret');
  await assert.rejects(pending, safeError('cancelled'));
  assert.equal(cancelled, 1);
  assert.equal(released, 1);
  resolveRead({ done: false, value: encoder.encode(frame({ content: 'must not emit' }) + done) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(deltas, []);
});

test('a fetch that resolves after cancellation has its late body closed', async () => {
  let resolveFetch;
  let cancelled = 0;
  const controller = new AbortController();
  const fetchImpl = () => new Promise((resolve) => { resolveFetch = resolve; });
  const pending = streamChat({ ...options, signal: controller.signal, onContent: () => {}, fetchImpl });
  controller.abort();
  await assert.rejects(pending, safeError('cancelled'));
  resolveFetch(responseFor([], { cancel: () => { cancelled += 1; } }).response);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, 1);
});

test('invalid success content types and missing streams are rejected without reading raw bodies', async () => {
  for (const response of [new Response('raw-provider-error fixture-secret'),
    { ok: true, status: 200, body: null, headers: new Headers({ 'Content-Type': 'text/event-stream' }) },
    { ...responseFor([]).response, redirected: true }]) {
    await assert.rejects(streamChat({ ...options, onContent: () => {}, fetchImpl: async () => response }), safeError('invalid_response'));
  }
});

test('real HTTP streams deliver 20 characters before completion, use bounded chat requests and reject credential redirects', async () => {
  const requests = [];
  let redirectCalls = 0;
  let serverFinished = false;
  const timers = new Set();
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ path: req.url, auth: req.headers.authorization, accept: req.headers.accept,
      body: JSON.parse(Buffer.concat(chunks).toString()) });
    if (req.url.startsWith('/redirect-target/')) redirectCalls += 1;
    if (req.url.startsWith('/redirect/')) { res.writeHead(307, { Location: '/redirect-target/chat/completions' }); res.end(); return; }
    if (req.url.startsWith('/status/')) {
      res.writeHead(Number(req.url.split('/')[2]), { 'Content-Type': 'application/json' });
      res.end('raw-provider-error fixture-secret');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
    res.flushHeaders();
    if (req.url.startsWith('/stall/')) return;
    if (req.url.startsWith('/broken/')) {
      res.write(frame({ content: 'already generated' }));
      const timer = setTimeout(() => { timers.delete(timer); res.destroy(); }, 15);
      timers.add(timer);
      return;
    }
    const characters = Array.from('我会认真听你说话也会一直陪在你的身边呀呢');
    let index = 0;
    const timer = setInterval(() => {
      if (index < characters.length) { res.write(frame({ content: characters[index++] })); return; }
      clearInterval(timer); timers.delete(timer); serverFinished = true;
      res.end(frame({}, 'stop') + done);
    }, 8);
    timers.add(timer);
    res.on('close', () => { clearInterval(timer); timers.delete(timer); });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    let output = '';
    let callbackBeforeEnd = false;
    await streamChat({ ...options, baseUrl: `${baseUrl}/v1/`, fetchImpl: fetch, onContent: (delta) => {
      output += delta;
      if (!serverFinished) callbackBeforeEnd = true;
    } });
    assert.equal(Array.from(output).length, 20);
    assert.equal(callbackBeforeEnd, true);
    assert.deepEqual(requests[0], { path: '/v1/chat/completions', auth: `Bearer ${options.apiKey}`, accept: 'text/event-stream',
      body: { model: 'fixture', messages: options.messages, stream: true, max_tokens: 2048 } });
    await streamChat({ ...options, apiKey: null, baseUrl: `${baseUrl}/no-key`, fetchImpl: fetch, onContent: () => {} });
    assert.equal(requests[1].auth, undefined);
    await assert.rejects(streamChat({ ...options, baseUrl: `${baseUrl}/redirect`, fetchImpl: fetch, onContent: () => {} }), safeError('network'));
    assert.equal(redirectCalls, 0);
    for (const [status, code] of [[400, 'http'], [401, 'auth'], [403, 'auth'], [429, 'rate_limit'], [500, 'server']]) {
      await assert.rejects(streamChat({ ...options, baseUrl: `${baseUrl}/status/${status}`, fetchImpl: fetch, onContent: () => {} }), (error) => {
        assert.equal(error.status, status); return safeError(code)(error);
      });
    }
    let partial = '';
    await assert.rejects(streamChat({ ...options, baseUrl: `${baseUrl}/broken`, fetchImpl: fetch,
      onContent: (delta) => { partial += delta; } }), safeError('network'));
    assert.equal(partial, 'already generated');
    await assert.rejects(streamChat({ ...options, baseUrl: `${baseUrl}/stall`, fetchImpl: fetch, timeoutMs: 25, onContent: () => {} }), safeError('timeout'));
    const controller = new AbortController();
    const pending = streamChat({ ...options, baseUrl: `${baseUrl}/stall`, fetchImpl: fetch, signal: controller.signal, onContent: () => {} });
    setTimeout(() => controller.abort(), 20);
    await assert.rejects(pending, safeError('cancelled'));
  } finally {
    for (const timer of timers) clearTimeout(timer);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('LB-0503 local endpoints keep finish-only SSE, opt-in completed JSON and broken EOF distinct', async (t) => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const body = [];
    for await (const chunk of req) body.push(chunk);
    requests.push(JSON.parse(Buffer.concat(body).toString()));
    if (req.url.startsWith('/json/')) {
      res.writeHead(200, { 'Content-Type': 'Application/JSON; charset=utf-8' });
      const finish_reason = req.url.includes('missing') ? undefined : 'stop';
      res.end(JSON.stringify({ choices: [{ index: 0, finish_reason,
        message: { role: 'assistant', content: 'JSON response' } }] }));
      return;
    }
    if (req.url.startsWith('/json-error/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"error":{"message":"raw-provider-error fixture-secret"}}');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'Text/Event-Stream; charset=utf-8' });
    res.end(frame({ content: 'SSE response' }, req.url.startsWith('/finish/') ? 'stop' : null));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const request = (path, changes = {}) => streamChat({ ...options, apiKey: null,
    baseUrl: `http://127.0.0.1:${server.address().port}/${path}`, fetchImpl: fetch, onContent() {}, ...changes });
  assert.deepEqual(await request('json/complete', { allowJsonFallback: true }), { finishReason: 'stop' });
  assert.deepEqual(await request('finish'), { finishReason: 'stop' });
  await assert.rejects(request('eof', { allowJsonFallback: true }), safeError('interrupted_response'));
  await assert.rejects(request('json/complete'), safeError('invalid_response'));
  await assert.rejects(request('json/missing', { allowJsonFallback: true }), safeError('interrupted_response'));
  await assert.rejects(request('json-error', { allowJsonFallback: true }), safeError('server'));
  // Choosing non-streaming is a deliberate compatibility path; no retry or second request is sent.
  assert.deepEqual(await request('json/complete', { streamOutput: false }), { finishReason: 'stop' });
  assert.equal(requests.length, 7);
  assert.equal(requests.at(-1).stream, false);
});

test('LB-0506 completion metadata preserves length for streamed and complete JSON replies, including reasoning-only', async () => {
  for (const streamOutput of [true, false]) {
    for (const content of ['partial answer', '', null]) {
      const payload = streamOutput
        ? frame({ reasoning_content: 'reasoning', content }, 'length') + done
        : JSON.stringify({ choices: [{ index: 0, finish_reason: 'length',
          message: { role: 'assistant', content, reasoning_content: 'reasoning' } }] });
      const { response } = responseFor([encoder.encode(payload)]);
      response.headers = new Headers({ 'Content-Type': streamOutput ? 'text/event-stream' : 'application/json' });
      assert.deepEqual(await streamChat({ ...options, streamOutput, onContent() {}, onReasoning() {},
        fetchImpl: async () => response }), { finishReason: 'length' });
    }
  }
});

test('official builder sends reasoning_content in the actual HTTP message while both reply channels remain untouched', async (t) => {
  const requests = [];
  const prefix = '已配置的思考前缀🙂';
  const server = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({ path: req.url, authorization: req.headers.authorization, body });
    res.writeHead(200, { 'Content-Type': body.stream ? 'text/event-stream' : 'application/json', Connection: 'close' });
    res.end(body.stream ? frame({ reasoning_content: prefix + '继续思考' }) + frame({ content: prefix + '正文' }, 'stop') + done
      : JSON.stringify({ choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', reasoning_content: prefix + '继续思考', content: prefix + '正文' } }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const thinkingConfig = createModelThinkingConfig();
  thinkingConfig.official.applied = createThinkingDraft(prefix);
  const request = buildRequestMessages({ provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', apiModel: 'deepseek-flash',
    name: 'fixture', cotMode: 'official', cotPresetId: null, thinkingConfig }, createDefaultData(), [{ role: 'user', content: '原文' }]);
  for (const streamOutput of [true, false]) {
    let content = '', reasoning = '';
    await streamChat({ ...options, baseUrl: request.baseUrl, messages: request.messages, requestParameters: request.requestParameters,
      streamOutput, onContent: (part) => { content += part; }, onReasoning: (part) => { reasoning += part; },
      fetchImpl: (url, init) => { assert.equal(url, 'https://api.deepseek.com/beta/chat/completions');
        return fetch(`http://127.0.0.1:${server.address().port}/beta/chat/completions`, init); } });
    assert.equal(content, prefix + '正文'); assert.equal(reasoning, prefix + '继续思考');
  }
  for (const { path, authorization, body } of requests) {
    assert.equal(path, '/beta/chat/completions'); assert.equal(authorization, `Bearer ${options.apiKey}`);
    assert.deepEqual(body.thinking, { type: 'enabled' }); assert.equal(body.extra_body, undefined);
    assert.deepEqual(body.messages.at(-1), { role: 'assistant', content: '', reasoning_content: prefix, prefix: true });
    assert.ok(body.messages.every((message) => !('partial' in message)));
    assert.doesNotMatch(JSON.stringify(body), /fixture-secret-never-log/);
  }
});
