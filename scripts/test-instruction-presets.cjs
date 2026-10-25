const assert = require('node:assert/strict');
const fs = require('node:fs');
const { test } = require('node:test');
const ts = require('typescript');

require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: filename,
}).outputText, filename);

const { INSTRUCTION_PRESETS, findInstructionPreset, getInstructionPresetCompatibility } = require('../src/features/companion/instruction-presets.ts');

const prompts = [
  '<|start|>assistant<|channel|>analysis<|message|>',
  '<｜begin▁of▁thinking｜>',
  '/think',
  '<|im_start|>assistant',
  '<|start_header_id|>assistant<|end_header_id|>',
  '<start_of_turn>model',
  '【PERSONA_LOAD】',
];

test('catalog contains the seven exact user-provided strings with unique editable entries', () => {
  assert.deepEqual(INSTRUCTION_PRESETS.map((preset) => preset.prompt), prompts);
  assert.equal(new Set(INSTRUCTION_PRESETS.map((preset) => preset.id)).size, prompts.length);
  assert.equal(new Set(INSTRUCTION_PRESETS.map((preset) => preset.prompt)).size, prompts.length);
  for (const preset of INSTRUCTION_PRESETS) {
    assert.ok(preset.name && preset.summary && preset.usage && preset.caveat && preset.modelScope);
    if (preset.sourceUrl) assert.equal(new URL(preset.sourceUrl).protocol, 'https:');
  }
  assert.deepEqual(INSTRUCTION_PRESETS[2].modelIds, ['Qwen/Qwen3-8B']);
  assert.ok(INSTRUCTION_PRESETS.filter((preset) => preset.provenance === 'protocol-example').length >= 4);
  assert.ok(INSTRUCTION_PRESETS.every((preset) => preset.provenance !== 'format-example'));
});

test('only the documented Qwen3 model receives conditional soft-switch documentation status', () => {
  const preset = INSTRUCTION_PRESETS.find((item) => item.id === 'qwen3-think');
  for (const apiModel of ['Qwen/Qwen3-8B', 'qwen/QWEN3-8b', 'Qwen3-8B', 'qwen3-8b', ' Qwen3-8B ']) {
    const result = getInstructionPresetCompatibility(preset, { apiModel });
    assert.equal(result.level, 'documented');
    assert.match(result.label, /文档说明.*服务端待确认/);
    assert.match(result.detail, /enable_thinking=True/);
  }
  for (const apiModel of ['Qwen3-32B', 'Qwen/Qwen3-8B-AWQ', 'Qwen3.5-8B', 'qwen-plus', 'deepseek-flash']) {
    assert.equal(getInstructionPresetCompatibility(preset, { apiModel }).level, 'unverified', apiModel);
  }
});

test('protocol markers and community strings never claim compatibility based on model name', () => {
  for (const preset of INSTRUCTION_PRESETS.filter((item) => item.id !== 'qwen3-think')) {
    for (const apiModel of ['Qwen/Qwen3-8B', 'deepseek-v4-pro', 'meta-llama/Meta-Llama-3-8B-Instruct', 'custom']) {
      const result = getInstructionPresetCompatibility(preset, { apiModel });
      assert.equal(result.level, 'unverified');
      assert.match(result.label, /未适配|未核实|待确认/);
    }
  }
});

test('missing model never claims documented compatibility', () => {
  for (const preset of INSTRUCTION_PRESETS) {
    for (const model of [undefined, { apiModel: '' }, { apiModel: ' \t' }]) {
      const result = getInstructionPresetCompatibility(preset, model);
      assert.equal(result.level, 'no-model');
      assert.match(result.label, /未选择模型/);
    }
  }
});

test('preset recognition requires unchanged full text and the original insertion point', () => {
  for (const preset of INSTRUCTION_PRESETS) {
    assert.equal(findInstructionPreset(preset.prompt, preset.placement), preset);
    const otherPlacement = preset.placement === 'system-start' ? 'user-prefix' : 'system-start';
    assert.equal(findInstructionPreset(preset.prompt, otherPlacement), undefined);
    assert.equal(findInstructionPreset(`${preset.prompt}\n`, preset.placement), undefined);
    assert.equal(findInstructionPreset(`${preset.prompt} 自定义修改`, preset.placement), undefined);
  }
});

test('copying and editing a role draft does not mutate the shared preset catalog', () => {
  const preset = INSTRUCTION_PRESETS[2];
  const firstRoleDraft = { text: preset.prompt, placement: preset.placement };
  const secondRoleDraft = { text: preset.prompt, placement: preset.placement };
  firstRoleDraft.text = '自定义';
  firstRoleDraft.placement = 'system-start';
  assert.deepEqual(secondRoleDraft, { text: '/think', placement: 'user-prefix' });
  assert.equal(preset.prompt, '/think');
  assert.ok(Object.isFrozen(INSTRUCTION_PRESETS));
  assert.ok(INSTRUCTION_PRESETS.every(Object.isFrozen));
  assert.ok(Object.isFrozen(preset.modelIds));
});
