const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');

// Keep these pure-domain checks dependency-free while the application is bundled by Metro.
const cache = new Map();
function load(name, parent = path.join(path.dirname(require.resolve('../package.json')), 'src', 'features', 'companion')) {
  const file = path.resolve(parent, `${name}.ts`);
  if (cache.has(file)) return cache.get(file);
  const compiled = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const exports = {};
  cache.set(file, exports);
  new Function('require', 'exports', compiled.outputText)((id) => id.startsWith('.') ? load(id, path.dirname(file)) : require(id), exports);
  return exports;
}

const { createDefaultData, createDefaultTemplates } = load('defaults');
const { normalizeCompanion } = load('normalize');
const { renderPrompt } = load('prompt-utils');

test('fresh defaults round-trip, and each reset creates independent editable templates', () => {
  const original = createDefaultData();
  assert.deepEqual(normalizeCompanion(JSON.parse(JSON.stringify(original))), { data: original, recovered: false, migrated: false });
  const edited = createDefaultTemplates();
  edited[0].prompt = 'edited';
  assert.notEqual(createDefaultTemplates()[0].prompt, 'edited');
  assert.deepEqual(original.memories, []);
  assert.deepEqual(original.profile.traits, []);
});

test('recovery preserves editable strings and marks damaged input for backup', () => {
  const original = createDefaultData();
  original.profile.description = '  自定义人物设定\n完整保留  ';
  original.thinking.nativeParameters = '{ unfinished';
  original.memories = [{ id: 'kept', text: '我的记忆', icon: 'unknown', createdAt: 'custom-date' }];
  const result = normalizeCompanion(original);
  assert.equal(result.recovered, true);
  assert.equal(result.data.profile.description, original.profile.description);
  assert.equal(result.data.thinking.nativeParameters, '{ unfinished');
  assert.equal(result.data.memories[0].text, '我的记忆');
  assert.equal(result.data.memories[0].updatedAt, 'custom-date');
  assert.equal(result.data.memories[0].icon, 'heart');
  assert.equal(normalizeCompanion(null).recovered, true);
  const malformedProfileOnly = createDefaultData();
  malformedProfileOnly.profile.avatarUri = 42;
  assert.equal(normalizeCompanion(malformedProfileOnly).recovered, true);
});

test('user-deleted lists stay empty, and newer schemas are never overwritten', () => {
  const source = createDefaultData();
  source.thinking.templates = [];
  source.thinking.variables = [];
  source.thinking.selectedTemplateId = null;
  const result = normalizeCompanion(source);
  assert.equal(result.recovered, false);
  assert.deepEqual(result.data.thinking.templates, []);
  assert.deepEqual(result.data.thinking.variables, []);
  assert.throws(() => normalizeCompanion({ schemaVersion: 3 }), /较新版本/);
});

test('template enabled flags round-trip without changing IDs or old enabled defaults', () => {
  const source = createDefaultData();
  source.thinking.templates[0].enabled = false;
  source.thinking.templates[1].enabled = true;
  const result = normalizeCompanion(source);
  assert.equal(result.recovered, false);
  assert.equal(result.data.thinking.templates[0].enabled, false);
  assert.equal(result.data.thinking.templates[1].enabled, true);
  assert.equal(result.data.thinking.templates[2].enabled, undefined);
  assert.deepEqual(result.data.thinking.templates.map((template) => template.id), source.thinking.templates.map((template) => template.id));
  source.thinking.templates[0].enabled = 'disabled';
  const repaired = normalizeCompanion(source);
  assert.equal(repaired.recovered, true);
  assert.equal(repaired.data.thinking.templates[0].enabled, true);
});

test('template rendering handles custom, unknown, escaped, and non-recursive variables', () => {
  const data = createDefaultData();
  data.profile.name = '自定义伙伴';
  data.thinking.variables.push({ id: 'custom', name: 'custom', value: '{persona}' });
  data.thinking.variables[0].value = '阿青';
  assert.equal(renderPrompt('{persona} / {user_name} / {date} / {missing} / \\{persona} / {custom}', data, new Date(2026, 9, 20)),
    '自定义伙伴 / 阿青 / 2026-10-20 / {missing} / {persona} / {persona}');
  data.thinking.variables.push({ id: 'spoof', name: 'date', value: 'spoof' });
  assert.equal(renderPrompt('{date}', data, new Date(2026, 9, 20)), '2026-10-20');
  assert.equal(renderPrompt('{{persona}} / {{missing}} / {persona} / {missing} / \\{user_name}', data),
    '{persona} / {missing} / 自定义伙伴 / {missing} / {user_name}');
});

test('v1 mode migration is distinct from corruption and preserves every authored string', () => {
  for (const mode of ['native', 'prefill', 'persona', 'off']) {
    const source = createDefaultData();
    source.schemaVersion = 1;
    source.thinking.mode = mode;
    source.thinking.prompt = '  <think>\n【PERSONA_LOAD】{user_name}  ';
    source.thinking.nativeParameters = '{ unfinished retained';
    delete source.thinking.drafts;
    const result = normalizeCompanion(source);
    assert.equal(result.migrated, true);
    assert.equal(result.recovered, false);
    assert.equal(result.data.schemaVersion, 2);
    assert.equal(result.data.thinking.mode, mode === 'persona' ? 'persona' : 'off');
    assert.equal(result.data.thinking.prompt, source.thinking.prompt);
    assert.equal(result.data.thinking.nativeParameters, source.thinking.nativeParameters);
    assert.equal(result.data.thinking.drafts.official.text, '');
    assert.equal(result.data.thinking.drafts.instruction.text, '');
    assert.equal(normalizeCompanion(result.data).migrated, false);
    assert.equal(normalizeCompanion(result.data).recovered, false);
  }
});

test('all current modes round-trip as current settings without falsely claiming corruption', () => {
  for (const mode of ['official', 'instruction', 'persona', 'off']) {
    const source = createDefaultData();
    source.thinking.mode = mode;
    source.thinking.drafts.official.text = 'reasoning seed';
    source.thinking.drafts.instruction.text = '<think>LANG_ZH_CN_ONLY';
    source.thinking.drafts.persona.text = '请简洁回答';
    assert.deepEqual(normalizeCompanion(source), { data: source, recovered: false, migrated: false });
  }
});

test('variable rename updates independent draft/applied texts once and preserves literal markers', () => {
  const { createModelThinkingConfig } = load('thinking-config');
  const { renameModelThinkingVariable } = load('thinking-variables');
  const config = createModelThinkingConfig();
  config.instruction.draft.text = '<think>{old} / {{old}} / \\{old} / {other}';
  config.instruction.applied = { ...config.instruction.draft, text: 'applied {old}' };
  config.official.draft.text = 'different {old}';
  const next = renameModelThinkingVariable(config, 'old', 'new');
  assert.equal(next.instruction.draft.text, '<think>{new} / {{old}} / \\{old} / {other}');
  assert.equal(next.instruction.applied.text, 'applied {new}');
  assert.equal(next.official.draft.text, 'different {new}');
  assert.equal(config.instruction.applied.text, 'applied {old}');
});
