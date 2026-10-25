const assert = require('node:assert/strict');
const fs = require('node:fs');
const { test } = require('node:test');
const ts = require('typescript');
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: filename,
}).outputText, filename);
const { createDefaultData } = require('../src/features/companion/defaults.ts');
const { buildRequestMessages } = require('../src/lib/cot/inject.ts');
const { renderTemplate, templateValues } = require('../src/lib/cot/template.ts');
const { createModelThinkingConfig, createThinkingDraft } = require('../src/features/companion/thinking-config.ts');
const { isCotAudit, isCotAuditV1 } = require('../src/lib/cot/types.ts');
const { safeRequestParameters } = require('../src/lib/cot/request-parameters.ts');
const { CotConfigurationError } = require('../src/lib/cot/errors.ts');
const model = { id: 'fixture', provider: 'custom', name: 'Fixture', apiModel: 'fixture', baseUrl: 'http://127.0.0.1:8793/v1', cotMode: 'off', cotPresetId: null };
const history = [{ role: 'system', content: 'old system' }, { role: 'user', content: '原问题' }];
function configured(mode, text, extra = {}) {
  const thinkingConfig = createModelThinkingConfig();
  thinkingConfig[mode].applied = { ...createThinkingDraft(text), ...extra };
  return { ...model, cotMode: mode, thinkingConfig };
}

test('template rendering preserves unknown and escaped tokens, custom values do not recurse', () => {
  const data = createDefaultData(); data.profile.name = '零';
  data.thinking.variables.push({ id: 'x', name: 'custom', value: '{persona}' });
  const result = renderTemplate('{persona} {custom} {{persona}} \\{date} {missing} {missing}', templateValues(data, new Date(2026, 9, 20)));
  assert.equal(result.text, '零 {persona} {persona} {date} {missing} {missing}');
  assert.deepEqual(result.warnings, ['未定义变量：{missing}']);
});

test('off preserves base identity and memories but never adds an inactive framework or parameters', () => {
  const data = createDefaultData(); data.profile.description = '个人描述';
  data.memories = [{ text: '记忆内容' }]; data.thinking.prompt = '不应出现的框架'; data.thinking.mode = 'persona';
  const request = buildRequestMessages(model, data, history);
  assert.match(request.messages[0].content, /个人描述[\s\S]*记忆内容/);
  assert.doesNotMatch(JSON.stringify(request.messages), /old system|不应出现的框架|思维框架/);
  assert.deepEqual(request.requestParameters, {}); assert.equal(request.prefixToStrip, undefined);
  assert.equal(request.audit.version, 2); assert.equal(request.audit.target, 'none');
  assert.equal(request.audit.effectiveMode, 'off'); assert.equal(request.audit.renderedPrefix, '');
});

test('model binding selects its own template, disabled and missing bindings refuse before sending', () => {
  const data = createDefaultData(); data.thinking.prompt = 'global';
  data.thinking.templates[1].prompt = 'bound {persona}';
  const bound = configured('persona', 'inline', { templateId: data.thinking.templates[1].id });
  const request = buildRequestMessages(bound, data, history);
  assert.match(request.messages[0].content, /【思维框架】\nbound 小零/);
  assert.equal(request.audit.templateName, data.thinking.templates[1].name);
  data.thinking.templates[1].enabled = false;
  assert.throws(() => buildRequestMessages(bound, data, history), /停用/);
  bound.thinkingConfig.persona.applied.templateId = 'missing';
  assert.throws(() => buildRequestMessages(bound, data, history), /不存在/);
  bound.thinkingConfig.persona.applied.templateId = null;
  assert.equal(buildRequestMessages(bound, data, history).audit.renderedPrefix, 'inline');
});

test('official reasoning prefixes use the dedicated final assistant field and model-owned parameters', () => {
  const data = createDefaultData(); data.thinking.nativeParameters = '{"model":"must not be read"}';
  const target = { ...configured('official', '先想{persona}', { parametersJson: '{"reasoning_effort":"high"}' }),
    provider: 'deepseek', apiModel: 'deepseek-flash', baseUrl: 'https://api.deepseek.com/v1' };
  const deepseek = buildRequestMessages(target, data, history);
  assert.equal(deepseek.baseUrl, 'https://api.deepseek.com/beta');
  assert.deepEqual(deepseek.messages.at(-1), { role: 'assistant', content: '', reasoning_content: '先想小零', prefix: true });
  assert.deepEqual(deepseek.audit.nativeParameters, { thinking: { type: 'enabled' }, reasoning_effort: 'high' });
  assert.equal(deepseek.audit.target, 'reasoning_content'); assert.ok(isCotAudit(deepseek.audit));
  assert.throws(() => buildRequestMessages({ ...target, provider: 'custom' }, data, history), /尚未接入/);
  target.thinkingConfig.official.applied.text = ' ';
  assert.throws(() => buildRequestMessages(target, data, history), /不能为空/);
});

test('instruction placements modify only the outgoing copy and preserve custom markers literally', () => {
  const data = createDefaultData();
  const instructions = '<think>\n【PERSONA_LOAD】 LANG_ZH_CN_ONLY\nTIMEOUT_SIGNAL {persona}';
  const original = structuredClone(history);
  const plain = buildRequestMessages(model, data, history);
  for (const placement of ['system-start', 'user-prefix']) {
    const request = buildRequestMessages(configured('instruction', instructions, { placement }), data, history);
    const rendered = instructions.replace('{persona}', data.profile.name);
    assert.deepEqual(history, original);
    assert.equal(request.audit.target, placement); assert.equal(request.messages.length, plain.messages.length);
    if (placement === 'system-start') {
      assert.equal(request.messages[0].content, rendered + '\n\n' + plain.messages[0].content);
      assert.equal(request.messages.at(-1).content, '原问题');
    } else {
      assert.equal(request.messages[0].content, plain.messages[0].content);
      assert.equal(request.messages.at(-1).content, rendered + '\n\n原问题');
    }
    assert.ok(request.messages.every((message) => !('prefix' in message) && !('partial' in message) && !('reasoning_content' in message)));
    assert.deepEqual(request.requestParameters, {});
  }
});

test('unapplied drafts and wrong-kind templates cannot execute or fall back to global prompt', () => {
  const data = createDefaultData(); data.thinking.prompt = 'GLOBAL NEVER SEND';
  const target = configured('official', 'applied');
  target.thinkingConfig.official.applied = null; target.thinkingConfig.official.draft.text = 'DRAFT NEVER SEND';
  assert.throws(() => buildRequestMessages(target, data, history), /尚未应用/);
  const wrong = configured('instruction', 'inline', { templateId: data.thinking.templates[0].id });
  assert.throws(() => buildRequestMessages(wrong, data, history), /用途/);
  const persona = configured('persona', 'APPLIED'); persona.thinkingConfig.persona.draft.text = 'UNAPPLIED';
  assert.equal(buildRequestMessages(persona, data, history).audit.renderedPrefix, 'APPLIED');
  for (const cotMode of ['native', 'prefill']) assert.throws(() => buildRequestMessages({ ...model, cotMode }, data, history), /旧模式/);
});

test('v1 audit semantics remain readable while v2 requires matching targets and non-nested legacy snapshots', () => {
  const current = buildRequestMessages(model, createDefaultData(), history).audit;
  const legacy = { ...current, version: 1, requestedMode: 'prefill', effectiveMode: 'prefill' };
  delete legacy.target; delete legacy.legacySnapshot;
  assert.equal(isCotAuditV1(legacy), true); assert.equal(isCotAudit(legacy), true);
  current.legacySnapshot = { cotMode: 'prefill', cotPresetId: 'old-template', modelId: 'old-model', audit: legacy };
  assert.equal(isCotAudit(current), true);
  assert.equal(isCotAudit({ ...current, target: 'reasoning_content' }), false);
  assert.equal(isCotAudit({ ...current, effectiveMode: 'prefill' }), false);
  assert.equal(isCotAudit({ ...current, legacySnapshot: { ...current.legacySnapshot, audit: current } }), false);
});

test('native extension fields cannot replace transport, message history or prototype properties', () => {
  assert.deepEqual(safeRequestParameters({ thinking: { type: 'enabled' }, enable_thinking: true }), { thinking: { type: 'enabled' }, enable_thinking: true });
  for (const value of [{ model: 'evil' }, { messages: [] }, { stream: false }, { apiKey: 'secret' }, { headers: {} }, { thinking: JSON.parse('{"__proto__":{}}') }, { x: Infinity }, { x: () => {} }]) {
    assert.throws(() => safeRequestParameters(value), CotConfigurationError);
  }
});
