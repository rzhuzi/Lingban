const assert = require('node:assert/strict');
const test = require('node:test');
const { createUiHarness } = require('./helpers/ui-harness.cjs');
const copy = (value) => JSON.parse(JSON.stringify(value));
const draft = (text = '') => ({ text, templateId: null, parametersJson: '{}', placement: 'system-start' });
const modelConfig = () => ({ version: 1, official: { draft: draft(), applied: null },
  instruction: { draft: draft(), applied: null }, persona: { draft: draft(), applied: null } });
const model = (id, isDefault = false) => ({ id, name: `模型${id}`, provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1',
  apiModel: 'deepseek-flash', apiKeyAlias: null, isDefault, cotMode: 'off', cotPresetId: null, thinkingConfig: modelConfig(),
  createdAt: '2026-10-21T00:00:00.000Z', updatedAt: '2026-10-21T00:00:00.000Z' });

function environment(route = { id: 'B' }) {
  const models = [model('A', true), model('B')];
  const thinking = { mode: 'persona', prompt: '旧自然语言提示词', nativeParameters: '{}', selectedTemplateId: null,
    drafts: { official: draft(), instruction: draft(), persona: draft() },
    templates: [{ id: 'plain', name: '普通模板', prompt: '自然回答', description: '', icon: 'heart', kind: 'persona' },
      { id: 'instruction', name: '指令模板', prompt: 'LANG_ZH_CN_ONLY\n{persona}', description: '', icon: 'sparkles', kind: 'instruction' },
      { id: 'official', name: '思考模板', prompt: '先理解问题。', description: '', icon: 'analytics', kind: 'official' }],
    variables: [{ id: 'user', name: 'user_name', value: '朋友' }] };
  const data = { schemaVersion: 2, profile: { name: '测试人设', description: '人设描述', traits: [], avatarUri: null, coverUri: null },
    memories: [], interests: [], thinking };
  const writes = [], modelSaves = [], navigations = [], sessions = {}, updates = [], maintenance = { active: false };
  const state = { models,
    async saveThinkingConfiguration(id, config, mode, editedMode) {
      writes.push(copy({ id, config, mode: mode ?? null, editedMode: editedMode ?? null }));
      await Promise.resolve();
      const target = models.find((item) => item.id === id), next = copy(target.thinkingConfig);
      for (const slot of ['official', 'instruction', 'persona']) if (!editedMode || slot === editedMode) next[slot].draft = copy(config[slot].draft);
      if (mode && mode !== 'off') next[mode].applied = copy(config[mode].applied);
      target.thinkingConfig = next;
      if (mode) target.cotMode = mode;
    },
  };
  const editor = {
    sessions, locked: false,
    begin(snapshot) { if (editor.locked) throw new Error('正在更新提示词变量，请稍后重试。'); const id = `editor-${Object.keys(sessions).length + 1}`; sessions[id] = { model: copy(snapshot) }; return id; },
    update(id, patch) { updates.push(copy({ id, patch })); sessions[id].model = { ...sessions[id].model, ...copy(patch) }; },
    remove(id) { delete sessions[id]; },
  };
  const useModels = (select) => select(state); useModels.getState = () => state;
  const useEditor = (select) => select(editor); useEditor.getState = () => editor;
  const cot = { thinking, async renameThinkingVariable() {} };
  const useCot = (select) => select(cot); useCot.getState = () => cot;
  const seams = {
    'expo-router': { useLocalSearchParams: () => route, router: { push: (value) => navigations.push(value), canGoBack: () => false, replace() {}, back() {} } },
    '@/features/companion/companion-store': { useCompanion: () => ({ data, updateThinking: (patch) => Object.assign(thinking, patch) }) },
    '@/stores/app-stores': { useModelStore: useModels, useCotStore: useCot, usePersonaStore: (select) => select({ personas: [] }), useAppMaintenanceStore: (select) => select(maintenance) },
    '@/stores/thinking-editor-store': { useThinkingEditorStore: useEditor },
    './model-service': { getModelKeySummary: async () => ({ configured: false, lastFour: '' }), getModelApiKey: async () => null,
      saveModelConfiguration: async (record, key, baseline) => modelSaves.push({ record: copy(record), key, baseline: baseline ? copy(baseline) : undefined }) },
    './model-cleanup-warning': { ModelCleanupWarning: 'ModelCleanupWarning' }, './remote-model-picker': { RemoteModelPicker: 'RemoteModelPicker' },
  };
  return { models, thinking, data, writes, modelSaves, navigations, sessions, updates, editor, maintenance, seams,
    screen: () => createUiHarness('src/features/companion/thinking-screen.tsx', 'ThinkingScreen', seams),
    modelEditor: (input) => createUiHarness('src/features/models/model-editor.tsx', 'ModelEditor', seams, { model: input }),
  };
}

test('targeted configuration never previews a different default model; draft saves do not apply', async () => {
  const env = environment(), app = env.screen();
  assert.match(app.text(), /模型B/); assert.doesNotMatch(app.text(), /此模型当前使用：官方/);
  app.press('编辑模式：第三方指令配置');
  app.change('第三方指令草稿', 'LANG_ZH_CN_ONLY\n测试指令');
  await app.settle();
  assert.equal(env.models[1].thinkingConfig.instruction.draft.text, 'LANG_ZH_CN_ONLY\n测试指令');
  assert.equal(env.models[1].thinkingConfig.instruction.applied, null);
  assert.equal(env.models[1].cotMode, 'off'); assert.equal(env.models[0].thinkingConfig.instruction.draft.text, '');
  assert.equal(env.writes.at(-1).editedMode, 'instruction');
  app.press('应用到此模型'); await app.settle();
  assert.equal(env.models[1].cotMode, 'instruction');
  app.change('第三方指令草稿', '尚未应用的新草稿'); await app.settle();
  assert.equal(env.models[1].thinkingConfig.instruction.applied.text, 'LANG_ZH_CN_ONLY\n测试指令');
});

test('drafts and advanced placement are independent for every target model and mode', async () => {
  const env = environment(), app = env.screen();
  app.press('编辑模式：第三方指令配置'); app.change('第三方指令草稿', 'B的指令'); await app.settle();
  app.find('注入位置').props.onAction(); app.render(); app.press('本次消息之前'); await app.settle();
  app.press('编辑模式：普通提示词'); app.change('普通提示词草稿', 'B的普通提示词'); await app.settle();
  app.press('编辑模式：第三方指令配置'); assert.equal(app.find('第三方指令草稿').props.value, 'B的指令');
  app.press('选择目标模型'); app.press('模型A · deepseek-flash');
  assert.equal(app.find('第三方指令草稿').props.value, '');
  app.change('第三方指令草稿', 'A的指令'); await app.settle();
  app.press('选择目标模型'); app.press('模型B · deepseek-flash');
  assert.equal(app.find('第三方指令草稿').props.value, 'B的指令');
  assert.equal(env.models[1].thinkingConfig.instruction.draft.placement, 'user-prefix');
  assert.equal(env.models[0].thinkingConfig.instruction.draft.placement, 'system-start');
  assert.equal(env.models[1].thinkingConfig.persona.draft.text, 'B的普通提示词');
  app.find('发送草稿预览').props.onAction(); app.render();
  const preview = JSON.parse(app.text(app.find('请求消息顺序预览')));
  assert.equal(preview.at(-1).content, 'B的指令\n\n（本次提问）');
  assert.equal(preview.some((message) => message.role === 'assistant'), false);
});

test('invalid official JSON remains scoped to its target and blocks Apply without changing effective config', async () => {
  const env = environment(), app = env.screen();
  app.press('编辑模式：官方 API 配置'); app.change('思考前缀草稿', '先理解{persona}。'); await app.settle();
  let card = app.nodes((node) => typeof node.type === 'function' && node.type.name === 'NativeThinkingCard')[0];
  card.props.onDraftChange('{ broken'); app.render();
  assert.equal(app.find('应用到此模型').props.disabled, true);
  app.press('编辑模式：普通提示词'); app.press('编辑模式：官方 API 配置');
  card = app.nodes((node) => typeof node.type === 'function' && node.type.name === 'NativeThinkingCard')[0];
  assert.equal(card.props.parameterDraft, '{ broken');
  app.press('选择目标模型'); app.press('模型A · deepseek-flash');
  card = app.nodes((node) => typeof node.type === 'function' && node.type.name === 'NativeThinkingCard')[0];
  assert.equal(card.props.parameterDraft, null);
  app.press('选择目标模型'); app.press('模型B · deepseek-flash');
  card = app.nodes((node) => typeof node.type === 'function' && node.type.name === 'NativeThinkingCard')[0];
  card.props.onDraftChange(null); card.props.onChange('{"reasoning_effort":"high"}'); app.render(); await app.settle();
  app.press('应用到此模型'); await app.settle();
  assert.equal(env.models[1].cotMode, 'official');
  assert.equal(env.models[1].thinkingConfig.official.applied.parametersJson, '{"reasoning_effort":"high"}');
});

test('templates are filtered by purpose and deleted/disabled applied bindings require explicit recovery', async () => {
  const env = environment(), app = env.screen();
  app.press('编辑模式：第三方指令配置');
  assert.equal(app.nodes((node) => node.props.accessibilityLabel === '使用模板：普通模板').length, 0);
  assert.equal(app.nodes((node) => node.props.accessibilityLabel === '使用模板：思考模板').length, 0);
  app.press('使用模板：指令模板'); await app.settle(); app.press('应用到此模型'); await app.settle();
  assert.equal(env.models[1].thinkingConfig.instruction.applied.templateId, 'instruction');
  env.thinking.templates.find((template) => template.id === 'instruction').enabled = false; app.render();
  assert.equal(app.find('应用到此模型').props.disabled, true); assert.match(app.text(), /已停用/);
  env.thinking.templates = env.thinking.templates.filter((template) => template.id !== 'instruction'); app.render();
  assert.match(app.text(), /当前模式需要重新应用/);
  assert.equal(app.find('第三方指令草稿').props.value, 'LANG_ZH_CN_ONLY\n{persona}');
});

test('with no target the editor keeps a public workspace and never silently selects a default model', async () => {
  const env = environment({}), app = env.screen();
  assert.match(app.text(), /尚未选择模型/); assert.equal(app.find('应用到此模型').props.disabled, true);
  app.change('普通提示词草稿', '公共草稿');
  assert.equal(env.thinking.drafts.persona.text, '公共草稿'); assert.equal(env.writes.length, 0);
  app.press('选择目标模型'); app.press('模型B · deepseek-flash');
  assert.equal(app.find('普通提示词草稿').props.value, '');
  app.press('复制公共草稿'); await app.settle();
  assert.equal(app.find('普通提示词草稿').props.value, '公共草稿'); assert.equal(env.models[1].cotMode, 'off');
});

test('uncommitted model context edits and applies locally without writing a persisted model', async () => {
  const env = environment({ editorId: 'temporary' }); env.sessions.temporary = { model: model('new') };
  const app = env.screen(); app.press('编辑模式：第三方指令配置'); app.change('第三方指令草稿', '<think>\n自定义');
  app.press('应用到此模型'); await app.settle();
  assert.equal(env.writes.length, 0); assert.equal(env.modelSaves.length, 0);
  assert.equal(env.sessions.temporary.model.cotMode, 'instruction');
  assert.equal(env.sessions.temporary.model.thinkingConfig.instruction.applied.text, '<think>\n自定义');
  assert.match(app.text(), /保存模型后生效/);
  assert.equal(env.models.some((item) => item.id === 'new'), false);
});

test('model library edits only connection metadata without a second thinking editor or credential in the record', async () => {
  const env = environment(), app = env.modelEditor(); await app.settle();
  app.change('API Key', 'fixture-private-key'); app.change('API 地址', 'https://uncommitted.invalid/v1');
  app.press('手动输入模型 ID'); app.change('模型 ID', 'uncommitted-model');
  assert.doesNotMatch(app.text(), /编辑模式与配置|设为默认模型/);
  assert.deepEqual(env.sessions, {});
  assert.equal(env.modelSaves.length, 0); app.press('保存模型'); await app.settle();
  assert.equal(env.modelSaves.length, 1); assert.equal(env.modelSaves[0].record.cotMode, 'off');
  assert.equal(env.modelSaves[0].record.apiModel, 'uncommitted-model');
  assert.equal(env.modelSaves[0].record.baseUrl, 'https://uncommitted.invalid/v1');
  assert.equal(JSON.stringify(env.modelSaves[0].record).includes('fixture-private-key'), false);
});

test('v1 audits retain historical meaning and v2 audits expose the unchanged legacy snapshot', () => {
  const details = { templateId: 'old-template', templateName: '旧模板', renderedPrefix: '旧正文前缀', warnings: [], nativeParameters: null,
    modelName: '旧模型', provider: 'deepseek', apiModel: 'old-model', baseUrl: 'https://old.invalid/v1' };
  const legacy = { ...details, version: 1, requestedMode: 'prefill', effectiveMode: 'prefill' };
  const message = { cotMode: 'prefill', modelId: 'old-id', cotPresetId: 'old-template', cotAudit: legacy };
  const app = createUiHarness('src/features/chat/audit-sheet.tsx', 'AuditSheet', {}, { message, visible: true, onClose() {} });
  assert.match(app.text(undefined, true), /旧正文前缀续写/); assert.doesNotMatch(app.text(undefined, true), /第三方指令配置/);
  const next = { ...details, version: 2, requestedMode: 'instruction', effectiveMode: 'instruction', target: 'user-prefix',
    renderedPrefix: '本次自定义指令', legacySnapshot: { cotMode: 'prefill', modelId: 'old-id', cotPresetId: 'old-template', audit: legacy } };
  const before = copy(next);
  app.render({ message: { ...message, thinkingMode: 'instruction', cotAudit: next }, visible: true, onClose() {} });
  const text = app.text(undefined, true);
  assert.match(text, /第三方指令配置/); assert.match(text, /本次 user 消息之前/); assert.match(text, /升级前原始配置/);
  assert.match(text, /旧正文前缀续写/); assert.match(text, /旧正文前缀/); assert.match(text, /old-id/);
  assert.deepEqual(next, before, 'Rendering must never rewrite an immutable historical snapshot.');
  next.legacySnapshot.audit = null; app.render({ message: { ...message, cotAudit: next }, visible: true, onClose() {} });
  assert.match(app.text(undefined, true), /旧消息没有详细配置快照/);
});

test('connection edits preserve the legacy thinking archive without applying it to any role', async () => {
  const env = environment(), original = copy(env.models[1]), app = env.modelEditor(original);
  await app.settle(); app.change('API Key', 'fixture-private-key');
  const refreshed = { ...original, cotMode: 'instruction', thinkingConfig: modelConfig() };
  refreshed.thinkingConfig.instruction.applied = draft('外部新配置');
  app.render({ model: refreshed });
  app.press('保存模型'); await app.settle();
  assert.equal(env.modelSaves.length, 1);
  assert.equal(env.modelSaves[0].baseline, undefined);
  assert.equal(env.modelSaves[0].record.cotMode, 'instruction');
  assert.equal(env.modelSaves[0].record.thinkingConfig.instruction.applied.text, '外部新配置');
  assert.deepEqual(env.sessions, {});
});

test('ordinary model metadata saves do not claim an explicit thinking baseline', async () => {
  const env = environment(), app = env.modelEditor(env.models[1]);
  await app.settle(); app.change('API Key', 'fixture-private-key'); app.change('模型名称', '只改名称');
  app.press('保存模型'); await app.settle();
  assert.equal(env.modelSaves.length, 1); assert.equal(env.modelSaves[0].baseline, undefined);
  assert.equal(env.modelSaves[0].record.name, '只改名称');
});

test('connection forms do not create shared thinking sessions even while legacy template maintenance is locked', async () => {
  const env = environment(), app = env.modelEditor(env.models[1]); await app.settle();
  env.editor.locked = true; app.change('模型名称', '接入名称');
  assert.doesNotMatch(app.text(), /编辑模式与配置|应用到此模型/);
  assert.equal(env.navigations.length, 0);
  assert.deepEqual(env.sessions, {});
});

test('maintenance prevents mode edits, draft mutations and Apply while retaining the current editor', async () => {
  const env = environment(), app = env.screen();
  app.press('编辑模式：第三方指令配置'); app.change('第三方指令草稿', '原有草稿'); await app.settle();
  const before = copy(env.thinking), writes = env.writes.length;
  env.maintenance.active = true; app.render();
  assert.equal(app.find('第三方指令草稿').props.editable, false);
  assert.equal(app.find('编辑模式：普通提示词').props.disabled, true);
  assert.equal(app.find('应用到此模型').props.disabled, true);
  app.change('第三方指令草稿', '锁定期间的修改'); await app.settle();
  assert.equal(env.writes.length, writes); assert.deepEqual(env.thinking, before);
  assert.equal(app.find('第三方指令草稿').props.value, '原有草稿');
});

test('an expired temporary session never falls through to public drafts through text, variable, or reset actions', async () => {
  const env = environment({ editorId: 'temporary' }); env.sessions.temporary = { model: model('new') };
  const app = env.screen(); app.press('编辑模式：普通提示词');
  delete env.sessions.temporary; app.render(); const before = copy(env.thinking);
  assert.equal(app.find('普通提示词草稿').props.editable, false);
  assert.equal(app.find('应用到此模型').props.disabled, true);
  app.change('普通提示词草稿', '不能变成公共草稿'); app.press('{persona}');
  app.find('普通提示词').props.onAction(); app.render(); await app.settle();
  assert.deepEqual(env.thinking, before); assert.equal(env.writes.length, 0); assert.equal(env.updates.length, 0);
  assert.match(app.text(), /编辑会话已结束/);
});

test('a deleted explicit target stays unavailable until another target or public workspace is selected', async () => {
  const env = environment(), app = env.screen(); app.press('编辑模式：普通提示词');
  env.models.splice(1, 1); app.render(); const before = copy(env.thinking);
  assert.match(app.text(), /目标模型已删除/); assert.equal(app.find('普通提示词草稿').props.editable, false);
  app.change('普通提示词草稿', '不能误存公共草稿'); await app.settle();
  assert.deepEqual(env.thinking, before); assert.equal(env.writes.length, 0);
  app.press('选择目标模型'); app.press('模型A · deepseek-flash');
  assert.equal(app.find('普通提示词草稿').props.editable, true);
});
