import { Image } from 'expo-image';
import { router, useLocalSearchParams, usePreventRemove } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Switch, useWindowDimensions, View, type ScrollViewInstance } from 'react-native';

import { AppIcon } from '@/components/app-icon';
import { Card, Chip, DetailScreen, Field, SectionHeading, Sheet, SmallAction, useConfirmation } from '@/components/customization-ui';
import { RoleAvatar } from '@/components/role-avatar';
import { ThemedText } from '@/components/themed-text';
import { Typography } from '@/constants/typography';
import { ModelEditor, type ModelEditorDraft } from '@/features/models/model-editor';
import { useTheme } from '@/hooks/use-theme';
import { startNewConversation } from '@/lib/chat/engine';
import { useChatRuntimeStore } from '@/lib/chat/runtime';
import { buildRequestMessages } from '@/lib/cot/inject';
import { renderTemplate, templateValues } from '@/lib/cot/template';
import type { PersonaRecord, RoleConfiguration, RoleModelConfiguration } from '@/lib/db/types';
import { useAppMaintenanceStore, useCotStore, useModelStore, usePersonaStore, useSettingsStore } from '@/stores/app-stores';

import { createId } from './defaults';
import { InstructionPresetPicker } from './instruction-preset-picker';
import { findInstructionPreset, INSTRUCTION_PRESETS, type InstructionPreset } from './instruction-presets';
import { previewOfficialThinking } from './native-thinking';
import { pickProfileImage } from './pick-image';
import { PersonaManager } from './persona-manager';
import { createRoleConfiguration, createRoleModelConfiguration, getRoleConfiguration, getRoleModelConfiguration } from './role-config';
import { copyModelThinkingConfig, templateMatchesMode, THINKING_CONTENT_MODES, THINKING_MODE_LABELS } from './thinking-config';
import type { CompanionData, MemoryIcon, MemoryItem, PromptVariable, ThinkingDraft, ThinkingMode } from './types';

const modes: ThinkingMode[] = ['off', 'official', 'instruction', 'persona'];
const memoryIcons: MemoryIcon[] = ['heart', 'sparkles', 'cafe', 'moon', 'briefcase', 'bookmark'];
const memoryLabels = { heart: '心情', sparkles: '偏好', cafe: '日常', moon: '感受', briefcase: '生活', bookmark: '其他' };
const reserved = new Set(['persona', 'user_name', 'date']);
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
const first = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;
const tags = (value: string) => [...new Set(value.split(/[、,，\n]/u).map((item) => item.trim()).filter(Boolean))];
type EditorSection = 'profile' | 'model' | 'thinking' | 'memories' | 'advanced';
type PresetPickerSession = { id: string; roleId: string; modelId: string };

function memoryDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : `${String(date.getMonth() + 1).padStart(2, '0')}.${String(date.getDate()).padStart(2, '0')}`;
}

function editingBinding(binding: RoleModelConfiguration): RoleModelConfiguration {
  const next = copy(binding);
  if (next.mode !== 'off' && next.thinking[next.mode].applied) next.thinking[next.mode].draft = copy(next.thinking[next.mode].applied!);
  return next;
}

function renameToken(text: string, oldName: string, newName: string) {
  return text.replace(/\\\{([^{}]+)\}|\{\{([^{}]+)\}\}|\{([^{}]+)\}/g,
    (token, escaped: string | undefined, doubled: string | undefined, name: string | undefined) =>
      escaped === undefined && doubled === undefined && name === oldName ? '{' + newName + '}' : token);
}

export function PersonaScreen() {
  const params = useLocalSearchParams<{ id?: string; create?: string; section?: string; modelId?: string; addModel?: string }>();
  const { personas, activePersonaId, ready } = usePersonaStore();
  const isNew = first(params.create) === '1';
  const id = first(params.id) ?? activePersonaId;
  const persona = isNew ? undefined : personas.find((item) => item.id === id);
  if (!ready) return <DetailScreen title="角色配置"><ActivityIndicator /></DetailScreen>;
  if (!isNew && !persona) return <DetailScreen title="角色配置"><Card><ThemedText>这个角色已不存在。</ThemedText>
    <SmallAction label="新建角色" icon="add" onPress={() => router.replace({ pathname: '/role', params: { create: '1' } })} /></Card></DetailScreen>;
  return <RoleEditor key={isNew ? 'new-role' : id} persona={persona} isNew={isNew}
    focusThinking={first(params.section) === 'thinking'} requestedModelId={first(params.modelId)} addModel={first(params.addModel) === '1'} />;
}

export function RoleEditor({ persona, isNew, focusThinking, requestedModelId, addModel }: {
  persona?: PersonaRecord; isNew: boolean; focusThinking: boolean; requestedModelId?: string; addModel: boolean;
}) {
  const theme = useTheme();
  const { fontScale } = useWindowDimensions();
  const modeHeight = Math.ceil(52 * Math.max(1, fontScale));
  const { confirm, dialog } = useConfirmation();
  const globalThinking = useCotStore((state) => state.thinking);
  const settings = useSettingsStore((state) => state.settings);
  const models = useModelStore((state) => state.models);
  const roleBusy = usePersonaStore((state) => state.busy);
  const maintenance = useAppMaintenanceStore((state) => state.active);
  const generating = useChatRuntimeStore((state) => state.isSending || state.hasUnsaved);
  const baseline = useRef(persona ? copy(persona) : null);
  const [draft, setDraft] = useState<PersonaRecord>(() => {
    const initial: PersonaRecord = persona ? copy(persona) : { id: createId(), isActive: true,
      profile: { name: '', description: '', avatarUri: null, coverUri: null, traits: [] }, memories: [], interests: [] };
    const configuration = persona ? getRoleConfiguration(persona, settings, globalThinking.variables) : createRoleConfiguration(settings);
    const suggested = models.find((item) => item.id === requestedModelId)
      ?? (!configuration.currentModelId ? models.find((item) => item.isDefault) ?? models[0] : undefined);
    if (suggested) configuration.currentModelId = suggested.id;
    const model = models.find((item) => item.id === configuration.currentModelId);
    if (model) {
      const stored = Object.hasOwn(configuration.models, model.id) ? getRoleModelConfiguration(configuration, model.id)
        : persona && !configuration.confirmed ? createRoleModelConfiguration(model, globalThinking) : getRoleModelConfiguration(configuration, model.id);
      configuration.models[model.id] = editingBinding(stored);
    }
    return { ...initial, configuration };
  });
  const [initial, setInitial] = useState(() => JSON.stringify(draft));
  const openedModelIds = useRef(new Set(draft.configuration?.currentModelId ? [draft.configuration.currentModelId] : []));
  const editedModelIds = useRef(new Set<string>());
  const [pendingModel, setPendingModel] = useState<ModelEditorDraft | null>(null);
  const [editing, setEditing] = useState(isNew || focusThinking || !!requestedModelId || addModel);
  const [modelEditor, setModelEditor] = useState(addModel);
  const [modelPicker, setModelPicker] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [profileExtras, setProfileExtras] = useState(false);
  const [thoughtAdvanced, setThoughtAdvanced] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [templatePicker, setTemplatePicker] = useState(false);
  const [instructionPicker, setInstructionPicker] = useState<PresetPickerSession | null>(null);
  const [saving, setSaving] = useState(false);
  const [allowLeave, setAllowLeave] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [imageBusy, setImageBusy] = useState(false);
  const [imageEditor, setImageEditor] = useState<'avatar' | 'cover' | null>(null);
  const [memoryDraft, setMemoryDraft] = useState<MemoryItem | null>(null);
  const [variableDraft, setVariableDraft] = useState<(PromptVariable & { originalName?: string }) | null>(null);
  const [variableError, setVariableError] = useState<string | null>(null);
  const [contextInput, setContextInput] = useState(String(draft.configuration!.chatSettings.contextWindow));
  const [traitsInput, setTraitsInput] = useState(draft.profile.traits.join('、'));
  const [interestsInput, setInterestsInput] = useState(draft.interests.join('、'));
  const alive = useRef(true);
  const scrollRef = useRef<ScrollViewInstance>(null);
  const sectionToFocus = useRef<EditorSection | null>(focusThinking ? 'thinking' : null);
  const sectionY = useRef<Partial<Record<EditorSection, number>>>({});
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  const configuration = draft.configuration!;
  const availableModels = pendingModel ? [...models.filter((item) => item.id !== pendingModel.model.id), pendingModel.model] : models;
  const selectedModel = availableModels.find((item) => item.id === configuration.currentModelId);
  const overviewTraits = tags(traitsInput);
  const overviewInterests = tags(interestsInput);
  const binding = selectedModel ? getRoleModelConfiguration(configuration, selectedModel.id) : null;
  const mode = binding?.mode ?? 'off';
  const contentMode = mode === 'off' ? null : mode;
  const content = contentMode && binding ? binding.thinking[contentMode].draft : null;
  const dirty = JSON.stringify(draft) !== initial || !!pendingModel || traitsInput !== draft.profile.traits.join('、')
    || interestsInput !== draft.interests.join('、') || contextInput !== String(configuration.chatSettings.contextWindow);
  const locked = saving || roleBusy || maintenance || imageBusy;
  const pickerScope = JSON.stringify([draft.id, selectedModel?.id, mode, locked, editing, modelEditor]);
  const [previousPickerScope, setPreviousPickerScope] = useState(pickerScope);
  if (previousPickerScope !== pickerScope) {
    setPreviousPickerScope(pickerScope);
    setInstructionPicker(null);
  }
  const presetContext = useRef({ session: instructionPicker, roleId: draft.id, modelId: selectedModel?.id, pendingModelId: pendingModel?.model.id, mode, locked, editing, modelEditor });
  useEffect(() => {
    presetContext.current = { session: instructionPicker, roleId: draft.id, modelId: selectedModel?.id, pendingModelId: pendingModel?.model.id, mode, locked, editing, modelEditor };
    return () => { presetContext.current.session = null; };
  }, [instructionPicker, draft.id, selectedModel?.id, pendingModel?.model.id, mode, locked, editing, modelEditor]);
  const closeInstructionPicker = () => { presetContext.current.session = null; setInstructionPicker(null); };
  function fillInstructionPreset(preset: InstructionPreset, session: PresetPickerSession) {
    const current = presetContext.current;
    const canonical = INSTRUCTION_PRESETS.find((item) => item.id === preset.id);
    if (!canonical || !alive.current || current.session !== session || current.roleId !== session.roleId
      || current.modelId !== session.modelId || current.mode !== 'instruction' || current.locked || !current.editing || current.modelEditor
      || useAppMaintenanceStore.getState().active || usePersonaStore.getState().busy) return;
    if (current.pendingModelId !== session.modelId && !useModelStore.getState().models.some((item) => item.id === session.modelId)) return;
    editedModelIds.current.add(session.modelId);
    setError(null); setNotice(null);
    setDraft((latest) => {
      const config = latest.configuration!;
      const target = config.models[session.modelId];
      if (config.currentModelId !== session.modelId || target?.mode !== 'instruction') return latest;
      return { ...latest, configuration: { ...config, models: { ...config.models, [session.modelId]: {
        ...target, blockedReason: undefined, thinking: { ...target.thinking, instruction: { ...target.thinking.instruction,
          draft: { ...target.thinking.instruction.draft, text: canonical.prompt, placement: canonical.placement, templateId: null } } },
      } } } };
    });
    closeInstructionPicker();
  }
  const disablePrevention = usePreventRemove(!allowLeave && (saving || dirty || modelEditor), ({ repeat }) => {
    if (saving) return;
    confirm({ title: '放弃未保存的修改？', message: '当前角色的已保存配置不会改变。', confirmLabel: '放弃修改', destructive: true,
      onConfirm: () => { setAllowLeave(true); setPendingModel(null); repeat(); } });
  });
  const leave = () => { if (!locked) { if (router.canGoBack()) router.back(); else router.replace('/(tabs)'); } };
  const openEditor = (section: EditorSection = 'profile') => {
    sectionToFocus.current = section;
    if (section === 'advanced') setAdvanced(true);
    if (editing) scrollRef.current?.scrollTo({ y: sectionY.current[section] ?? 0, animated: true });
    setEditing(true);
  };
  const recordSection = (section: EditorSection, y: number) => {
    sectionY.current[section] = y;
    if (sectionToFocus.current === section) {
      scrollRef.current?.scrollTo({ y, animated: true });
      sectionToFocus.current = null;
    }
  };
  const showOverview = () => { if (locked) return; setEditing(false); sectionToFocus.current = null; scrollRef.current?.scrollTo({ y: 0, animated: false }); };
  const addMemory = () => {
    const now = new Date().toISOString(); setMemoryDraft({ id: createId(), text: '', icon: 'heart', createdAt: now, updatedAt: now });
  };
  const patchConfiguration = (patch: Partial<RoleConfiguration>) => {
    setError(null); setNotice(null); setDraft((current) => ({ ...current, configuration: { ...current.configuration!, ...patch } }));
  };
  const discardTemporaryModel = (next: RoleConfiguration, modelId: string) => {
    delete next.models[modelId];
    editedModelIds.current.delete(modelId);
    openedModelIds.current.delete(modelId);
  };
  const patchBinding = (patch: Partial<RoleModelConfiguration>) => {
    if (selectedModel && binding) {
      editedModelIds.current.add(selectedModel.id);
      patchConfiguration({ models: { ...configuration.models, [selectedModel.id]: { ...binding, ...patch } } });
    }
  };
  const patchContent = (patch: Partial<ThinkingDraft>) => {
    if (binding && contentMode && content) patchBinding({ blockedReason: undefined, thinking: { ...binding.thinking,
      [contentMode]: { ...binding.thinking[contentMode], draft: { ...content, ...patch, templateId: null } } } });
  };
  const previewData: CompanionData = { schemaVersion: 2, profile: { ...draft.profile, traits: tags(traitsInput) }, memories: draft.memories,
    interests: tags(interestsInput), thinking: { ...globalThinking, templates: [], variables: [...configuration.variables,
      { id: 'builtin-user-name', name: 'user_name', value: settings.userName }] } };
  const rendered = content ? renderTemplate(content.text, templateValues(previewData)) : null;
  const officialPreview = mode === 'official' ? previewOfficialThinking(selectedModel, rendered?.text ?? '', content?.parametersJson ?? '{}') : null;
  let requestPreview: ReturnType<typeof buildRequestMessages> | null = null;
  let previewError: string | null = null;
  if (selectedModel && binding) try {
    const candidate = copyModelThinkingConfig(binding.thinking);
    if (contentMode && content) candidate[contentMode].applied = { ...content, templateId: null };
    requestPreview = buildRequestMessages({ ...selectedModel, cotMode: mode, thinkingConfig: candidate, cotPresetId: null }, previewData,
      [{ role: 'user', content: '（本次提问）' }]);
  } catch (failure) { previewError = failure instanceof Error ? failure.message : '请检查思维配置。'; }

  async function save() {
    if (locked || generating) return;
    setError(null); setNotice(null);
    try {
      if (!draft.profile.name.trim()) throw new Error('请填写角色名字。');
      if (!selectedModel || !binding) throw new Error('请为这个角色选择模型。');
      const contextWindow = Number(contextInput);
      if (!Number.isInteger(contextWindow) || contextWindow < 1 || contextWindow > 100) throw new Error('上下文条数需为 1 至 100 的整数。');
      if (binding.blockedReason && mode !== 'off') throw new Error(binding.blockedReason);
      if (previewError) throw new Error(previewError);
      const nextModels = copy(configuration.models);
      for (const modelId of new Set([...editedModelIds.current, selectedModel.id])) {
        const target = availableModels.find((item) => item.id === modelId);
        const targetBinding = nextModels[modelId];
        if (!target || !targetBinding) throw new Error('编辑的模型已不存在，请重新选择。');
        if (targetBinding.blockedReason && targetBinding.mode !== 'off') throw new Error(target.name + '：' + targetBinding.blockedReason);
        if (targetBinding.mode !== 'off') targetBinding.thinking[targetBinding.mode].applied = { ...targetBinding.thinking[targetBinding.mode].draft, templateId: null };
        try { buildRequestMessages({ ...target, cotMode: targetBinding.mode, thinkingConfig: targetBinding.thinking, cotPresetId: null }, previewData,
          [{ role: 'user', content: '配置校验' }]); }
        catch (failure) { throw new Error(target.name + '：' + (failure instanceof Error ? failure.message : '请检查配置。')); }
      }
      const next: PersonaRecord = { ...copy(draft), profile: { ...draft.profile, name: draft.profile.name.trim(), traits: tags(traitsInput) },
        interests: tags(interestsInput), configuration: { ...configuration, confirmed: true,
          chatSettings: { ...configuration.chatSettings, contextWindow }, models: nextModels } };
      setSaving(true);
      await usePersonaStore.getState().saveRole(next, baseline.current, pendingModel ?? undefined);
      if (!alive.current) return;
      const saved = usePersonaStore.getState().personas.find((item) => item.id === next.id) ?? next;
      baseline.current = copy(saved); setInitial(JSON.stringify(saved)); setDraft(copy(saved)); editedModelIds.current.clear();
      setTraitsInput(saved.profile.traits.join('、')); setInterestsInput(saved.interests.join('、'));
      setContextInput(String(saved.configuration!.chatSettings.contextWindow)); setPendingModel(null); setNotice('已保存');
      if (isNew) { setAllowLeave(true); disablePrevention(); startNewConversation(); router.replace('/(tabs)'); }
    } catch (failure) { if (alive.current) setError(failure instanceof Error ? failure.message : '保存失败，修改内容仍保留，请重试。'); }
    finally { if (alive.current) setSaving(false); }
  }
  async function selectImage(target: 'avatar' | 'cover') {
    if (locked) return;
    setImageBusy(true); setError(null);
    try {
      const uri = await pickProfileImage(target);
      if (alive.current && uri && !useAppMaintenanceStore.getState().active) {
        setDraft((current) => ({ ...current, profile: { ...current.profile, [target === 'avatar' ? 'avatarUri' : 'coverUri']: uri } }));
        setImageEditor(null);
      }
    } catch (failure) { if (alive.current) setError(failure instanceof Error ? failure.message : '无法打开相册。'); }
    finally { if (alive.current) setImageBusy(false); }
  }
  function saveVariable() {
    if (!variableDraft) return;
    const name = variableDraft.name.trim();
    if (!name || /[{}\s]/u.test(name) || reserved.has(name)) { setVariableError('填写不含空格或花括号的名称，不能使用内置变量名。'); return; }
    if (configuration.variables.some((item) => item.id !== variableDraft.id && item.name === name)) { setVariableError('这个变量名已存在。'); return; }
    const next = copy(configuration);
    const variable = { id: variableDraft.id, name, value: variableDraft.value };
    next.variables = next.variables.some((item) => item.id === variable.id)
      ? next.variables.map((item) => item.id === variable.id ? variable : item) : [...next.variables, variable];
    if (variableDraft.originalName && variableDraft.originalName !== name) for (const item of Object.values(next.models)) for (const key of THINKING_CONTENT_MODES) {
      item.thinking[key].draft.text = renameToken(item.thinking[key].draft.text, variableDraft.originalName, name);
      if (item.thinking[key].applied) item.thinking[key].applied!.text = renameToken(item.thinking[key].applied!.text, variableDraft.originalName, name);
    }
    patchConfiguration(next); setVariableDraft(null);
  }

  if (modelEditor) return <><ModelEditor model={pendingModel?.model} initialApiKey={pendingModel?.apiKey} onCancel={() => setModelEditor(false)}
    onComplete={(result) => { setPendingModel(result); setModelEditor(false); const next = copy(configuration);
      if (pendingModel && pendingModel.model.id !== result.model.id) discardTemporaryModel(next, pendingModel.model.id);
      next.currentModelId = result.model.id; next.models[result.model.id] ??= getRoleModelConfiguration(next, result.model.id); patchConfiguration(next); }} />{dialog}</>;

  return <DetailScreen title={isNew ? '新建角色' : editing ? '编辑角色' : '角色'} onBack={!isNew && editing ? showOverview : leave} scrollRef={scrollRef} right={<PersonaManager disabled={dirty || locked} />}
    footer={editing || dirty ? <View style={s.saveArea}>
      {error ? <ThemedText accessibilityRole="alert" style={[s.note, { color: theme.danger }]}>{error}</ThemedText> : null}
      {notice ? <ThemedText accessibilityLiveRegion="polite" style={[s.note, { color: theme.success }]}>{notice}</ThemedText> : null}
      {generating ? <ThemedText style={s.note} themeColor="textSecondary">停止或结束生成后可保存角色配置。</ThemedText> : null}
      <Pressable accessibilityRole="button" accessibilityLabel={isNew ? '保存角色并聊天' : '保存角色配置'} disabled={locked || generating} onPress={() => { void save(); }}
        style={[s.save, { backgroundColor: theme.primaryStrong, opacity: locked || generating ? 0.5 : 1 }]}>{saving ? <ActivityIndicator color={theme.onPrimary} /> : <ThemedText style={[s.saveLabel, { color: theme.onPrimary }]}>{isNew ? '保存并聊天' : '保存角色'}</ThemedText>}</Pressable>
    </View> : undefined}>
    <View pointerEvents={locked ? 'none' : 'auto'} style={[s.content, locked && s.dimmed]}>
      {!isNew && !configuration.confirmed ? <View style={[s.status, { backgroundColor: theme.primarySurface }]}>
        <AppIcon name="information-circle-outline" size={18} color={theme.primary} /><ThemedText style={[s.note, s.flex]}>原资料已保留，确认模型和思维配置后保存一次即可使用。</ThemedText>
      </View> : null}
      {!editing ? <View style={s.overview}>
        {draft.profile.coverUri ? <Pressable accessibilityRole="button" accessibilityLabel="更换角色封面" onPress={() => setImageEditor('cover')} style={s.overviewCover}>
          <Image source={{ uri: draft.profile.coverUri }} style={StyleSheet.absoluteFill} contentFit="cover" />
        </Pressable> : null}
        <View style={s.overviewIdentity}>
          <Pressable accessibilityRole="button" accessibilityLabel="更换角色头像" onPress={() => setImageEditor('avatar')}>
            <RoleAvatar profile={draft.profile} size={62} />
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="编辑角色身份" onPress={() => openEditor('profile')} style={s.flex}>
            <ThemedText style={s.overviewName}>{draft.profile.name}</ThemedText>
            {overviewTraits.length || draft.profile.description.trim() ? <ThemedText numberOfLines={2} style={s.overviewIntro} themeColor="textSecondary">
              {overviewTraits.length ? overviewTraits.join(' · ') : draft.profile.description.trim()}
            </ThemedText> : null}
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="编辑角色资料" onPress={() => openEditor('profile')} style={s.overviewAction}>
            <AppIcon name="create-outline" size={16} color={theme.textSecondary} />
          </Pressable>
        </View>
        <View style={[s.overviewSection, { borderColor: theme.border }]}>
          <View style={s.overviewSectionHeading}><ThemedText accessibilityRole="header" style={s.overviewHeading}>人设</ThemedText>
            <Pressable accessibilityRole="button" accessibilityLabel="编辑人设" onPress={() => openEditor('profile')} style={s.overviewAction}>
              <AppIcon name="create-outline" size={16} color={theme.textSecondary} />
            </Pressable>
          </View>
          <Pressable accessibilityRole="button" accessibilityLabel="编辑角色人设与标签" onPress={() => openEditor('profile')}>
            <ThemedText numberOfLines={4} style={s.overviewPersona} themeColor="textSecondary">{draft.profile.description.trim() || '添加人设'}</ThemedText>
          </Pressable>
          {overviewTraits.length || overviewInterests.length ? <View style={s.overviewTags}>{[...new Set([...overviewTraits, ...overviewInterests])].map((item) =>
            <View key={item} style={[s.overviewTag, { backgroundColor: theme.backgroundElement }]}><ThemedText themeColor="textSecondary" style={s.overviewTagText}>{item}</ThemedText></View>)}</View> : null}
        </View>
        <View style={[s.overviewSection, s.overviewConfig, { borderColor: theme.border }]}>
          <View style={s.overviewSectionHeading}><ThemedText accessibilityRole="header" style={s.overviewHeading}>对话配置</ThemedText><AppIcon name="options-outline" size={16} color={theme.textSecondary} /></View>
          {([
            { label: '模型', value: selectedModel?.name ?? '选择模型', section: 'model', accessibilityLabel: '编辑角色模型', icon: 'cube-outline' },
            { label: '思维配置', value: THINKING_MODE_LABELS[mode], section: 'thinking', accessibilityLabel: '编辑角色思维配置', icon: 'orbit' },
            { label: '上下文', value: '最近 ' + contextInput + ' 条', section: 'advanced', accessibilityLabel: '编辑角色上下文', icon: 'options-outline' },
          ] as const).map((item, index) => <Pressable key={item.section} accessibilityRole="button" accessibilityLabel={item.accessibilityLabel} onPress={() => openEditor(item.section)}
            style={[s.overviewSetting, index > 0 && s.overviewSettingBorder, { borderColor: theme.border }]}>
            <AppIcon name={item.icon} size={17} color={theme.textSecondary} />
            <ThemedText style={s.overviewSettingLabel}>{item.label}</ThemedText><View style={s.overviewSettingValue}><ThemedText themeColor="textSecondary" numberOfLines={1} style={s.overviewValue}>{item.value}</ThemedText><AppIcon name="chevron-forward" size={13} color={theme.textSecondary} /></View>
          </Pressable>)}
        </View>
        <View style={[s.overviewSection, { borderColor: theme.border }]}>
          <View style={s.overviewSectionHeading}>
            <Pressable accessibilityRole="button" accessibilityLabel="编辑角色记忆" onPress={() => openEditor('memories')} style={s.overviewHeadingButton}><ThemedText accessibilityRole="header" style={s.overviewHeading}>记忆</ThemedText></Pressable>
            <Pressable accessibilityRole="button" accessibilityLabel="添加记忆" onPress={addMemory} style={s.overviewAction}><AppIcon name="add" size={19} color={theme.textSecondary} /></Pressable>
          </View>
          {draft.memories.length ? draft.memories.map((memory) => <Pressable key={memory.id} accessibilityRole="button" accessibilityLabel={'编辑记忆：' + memory.text}
            onPress={() => setMemoryDraft(copy(memory))} style={s.overviewMemory}>
            <AppIcon name={memory.icon} size={16} color={theme.textSecondary} /><ThemedText numberOfLines={2} style={[s.overviewMemoryText, s.flex]}>{memory.text}</ThemedText>
            <ThemedText themeColor="textSecondary" style={s.overviewMemoryDate}>{memoryDate(memory.updatedAt)}</ThemedText>
          </Pressable>) : <Pressable accessibilityRole="button" accessibilityLabel="添加第一条记忆" onPress={addMemory} style={s.overviewEmpty}><ThemedText themeColor="textSecondary" style={s.note}>添加记忆</ThemedText></Pressable>}
        </View>
        <View style={s.overviewFooter}><SmallAction label="编辑角色配置" icon="create-outline" tone="muted" onPress={() => openEditor()} />
          <SmallAction label="回到对话" icon="chevron-forward" tone="muted" onPress={() => { if (!locked) router.dismissTo('/(tabs)'); }} /></View>
      </View> : <>
      <View onLayout={(event) => recordSection('profile', event.nativeEvent.layout.y)}>
      <Card>
        <View style={s.identity}><Pressable accessibilityRole="button" accessibilityLabel="更换角色头像" onPress={() => setImageEditor('avatar')} style={[s.avatar, { backgroundColor: theme.primarySurface }]}>
          <RoleAvatar profile={draft.profile} size={62} />
          <View style={[s.camera, { backgroundColor: theme.surface }]}><AppIcon name="camera-outline" size={12} color={theme.primary} /></View>
        </Pressable><View style={s.flex}><Field label="名字" value={draft.profile.name} maxLength={24} placeholder="给 TA 起个名字"
          onChangeText={(name) => setDraft((current) => ({ ...current, profile: { ...current.profile, name } }))} /></View></View>
        <Field label="人设" multiline value={draft.profile.description} maxLength={1000} placeholder="性格、背景、说话方式，以及你们的相处习惯"
          onChangeText={(description) => setDraft((current) => ({ ...current, profile: { ...current.profile, description } }))} style={s.personaInput} />
        <SmallAction label={profileExtras ? '收起封面与标签' : '封面与标签'} icon={profileExtras ? 'chevron-up' : 'chevron-down'} tone="muted" onPress={() => setProfileExtras(!profileExtras)} />
        {profileExtras ? <><Pressable accessibilityRole="button" accessibilityLabel="更换角色封面" onPress={() => setImageEditor('cover')} style={[s.cover, { backgroundColor: theme.backgroundElement }]}>
          {draft.profile.coverUri ? <Image source={{ uri: draft.profile.coverUri }} style={StyleSheet.absoluteFill} contentFit="cover" /> : <><AppIcon name="image-outline" size={23} color={theme.primary} /><ThemedText style={s.note}>添加封面</ThemedText></>}
        </Pressable><Field label="性格特质" value={traitsInput} onChangeText={setTraitsInput} maxLength={600} placeholder="用顿号或逗号分隔" />
          <Field label="兴趣与标签" value={interestsInput} onChangeText={setInterestsInput} maxLength={600} placeholder="用顿号或逗号分隔" /></> : null}
      </Card>
      </View>
      <View onLayout={(event) => recordSection('model', event.nativeEvent.layout.y)}>
      <Card><SectionHeading title="使用模型" /><Pressable accessibilityRole="button" accessibilityLabel="为这个角色选择模型" onPress={() => setModelPicker(true)}
        style={[s.modelRow, { borderColor: theme.border, backgroundColor: theme.background }]}><AppIcon name="cube-outline" size={18} color={theme.textSecondary} />
        <View style={s.flex}><ThemedText numberOfLines={1} style={s.label}>{selectedModel?.name ?? '选择模型'}</ThemedText>
          {selectedModel ? <ThemedText numberOfLines={1} themeColor="textSecondary" style={s.note}>{selectedModel.apiModel}{pendingModel ? ' · 待随角色保存' : ''}</ThemedText> : null}</View>
        <AppIcon name="chevron-down" size={17} color={theme.textSecondary} /></Pressable>
        <SmallAction label={pendingModel ? '编辑待添加的模型' : '添加模型'} icon={pendingModel ? 'create-outline' : 'add'} onPress={() => setModelEditor(true)} />
      </Card>
      </View>
      <View onLayout={(event) => recordSection('thinking', event.nativeEvent.layout.y)}>
        <Card><SectionHeading title="思维配置" />
          <View style={[s.modeGrid, { backgroundColor: theme.backgroundElement }]}>{[modes.slice(0, 2), modes.slice(2)].map((row, index) => <View key={index} style={s.modeRow}>{row.map((item) =>
            <Pressable key={item} accessibilityRole="radio" accessibilityLabel={THINKING_MODE_LABELS[item]} accessibilityState={{ checked: mode === item, disabled: !selectedModel }} disabled={!selectedModel}
              onPress={() => { patchBinding({ mode: item }); setThoughtAdvanced(false); }} style={[s.mode, { height: modeHeight, backgroundColor: mode === item ? theme.primaryStrong : 'transparent' }]}>
              <ThemedText numberOfLines={2} style={[s.modeLabel, { color: mode === item ? theme.onPrimary : theme.textSecondary }]}>{THINKING_MODE_LABELS[item]}</ThemedText>
            </Pressable>)}</View>)}</View>
          {mode === 'off' ? <ThemedText themeColor="textSecondary" style={s.note}>人设、记忆和聊天历史仍会发送。</ThemedText> : null}
          {content ? <>{mode === 'instruction' ? <Pressable accessibilityRole="button" accessibilityLabel="选择第三方指令预设" disabled={locked}
            onPress={() => { const current = presetContext.current;
              if (alive.current && !current.locked && current.editing && current.mode === 'instruction' && current.modelId && !current.modelEditor) {
                setInstructionPicker({ id: createId(), roleId: current.roleId, modelId: current.modelId });
              } }}
            style={[s.presetButton, { borderColor: theme.border, backgroundColor: theme.backgroundElement }]}>
            <AppIcon name="book-outline" size={17} color={theme.textSecondary} />
            <View style={s.flex}><ThemedText style={s.label}>指令预设</ThemedText><ThemedText themeColor="textSecondary" style={s.note}>
              {findInstructionPreset(content.text, content.placement)?.name ?? (content.text.trim() ? '自定义内容' : '选择预设，查看用法与适用模型')}</ThemedText></View>
            <AppIcon name="chevron-down" size={14} color={theme.textSecondary} />
          </Pressable> : null}<Field label={mode === 'official' ? '思考前缀' : mode === 'instruction' ? '自定义指令' : '额外回答要求'} multiline maxLength={4000} value={content.text}
            onChangeText={(text) => patchContent({ text })} placeholder={mode === 'official' ? '填写希望模型续写的思考开头' : mode === 'instruction' ? '填写自定义标记与指令' : '补充希望 TA 如何回答'} style={s.thoughtInput} />
            <View style={s.wrap}>{['persona', 'user_name', 'date', ...configuration.variables.map((item) => item.name)].map((name) => <Chip key={name} label={'{' + name + '}'} tone="accent"
              onPress={() => patchContent({ text: content.text + '{' + name + '}' })} />)}</View>
            <View style={s.between}><SmallAction label="使用模板" icon="book-outline" onPress={() => setTemplatePicker(true)} /><SmallAction label={thoughtAdvanced ? '收起高级' : '高级'} icon="options-outline" tone="muted" onPress={() => setThoughtAdvanced(!thoughtAdvanced)} /></View>
            {binding?.blockedReason ? <><ThemedText style={[s.note, { color: theme.danger }]}>{binding.blockedReason}</ThemedText><SmallAction label="已检查，使用这段内容" onPress={() => patchBinding({ blockedReason: undefined })} /></> : null}
            {officialPreview?.state === 'error' ? <ThemedText accessibilityRole="alert" style={[s.note, { color: theme.danger }]}>{officialPreview.message}</ThemedText> : null}
            {thoughtAdvanced ? <>{mode === 'official' ? <Field label="接口参数覆盖（JSON，可选）" value={content.parametersJson === '{}' ? '' : content.parametersJson}
              onChangeText={(value) => patchContent({ parametersJson: value.trim() ? value : '{}' })} multiline autoCapitalize="none" autoCorrect={false} maxLength={4000} placeholder="留空使用协议默认参数" style={s.jsonInput} /> : null}
              {mode === 'instruction' ? <><ThemedText style={s.label}>注入位置</ThemedText><View style={s.wrap}><Chip label="系统提示词最前" selected={content.placement === 'system-start'} onPress={() => patchContent({ placement: 'system-start' })} />
                <Chip label="本次消息之前" selected={content.placement === 'user-prefix'} onPress={() => patchContent({ placement: 'user-prefix' })} /></View></> : null}
              <SmallAction label={showPreview ? '收起发送预览' : '查看发送预览'} icon="information-circle-outline" tone="muted" onPress={() => setShowPreview(!showPreview)} />
              {showPreview ? <ThemedText selectable style={[s.preview, { backgroundColor: theme.background, color: theme.textSecondary }]}>{previewError ?? JSON.stringify({ messages: requestPreview?.messages, parameters: requestPreview?.requestParameters }, null, 2)}</ThemedText> : null}
              {!isNew && selectedModel ? <SmallAction label="导入旧模型未应用草稿" tone="muted" onPress={() => patchContent(createRoleModelConfiguration(selectedModel, globalThinking).thinking[contentMode!].draft)} /> : null}
              {globalThinking.drafts?.[contentMode!] ? <SmallAction label="导入旧公共草稿" tone="muted" onPress={() => patchContent(globalThinking.drafts![contentMode!])} /> : null}
            </> : null}
            {rendered?.warnings.map((warning) => <ThemedText key={warning} style={[s.note, { color: theme.danger }]}>{warning}</ThemedText>)}</> : null}
        </Card>
      </View>
      <View onLayout={(event) => recordSection('memories', event.nativeEvent.layout.y)}>
      <Card><SectionHeading title={'记忆' + (draft.memories.length ? ' · ' + draft.memories.length : '')} action="添加" icon="add" onAction={addMemory} />{draft.memories.length ? draft.memories.map((memory) => <Pressable key={memory.id} accessibilityRole="button" accessibilityLabel={'编辑记忆：' + memory.text}
        onPress={() => setMemoryDraft(copy(memory))} style={[s.memoryRow, { borderColor: theme.border }]}><AppIcon name={memory.icon} size={17} color={theme.textSecondary} />
        <ThemedText numberOfLines={2} style={[s.overviewMemoryText, s.flex]}>{memory.text}</ThemedText><AppIcon name="chevron-forward" size={15} color={theme.textSecondary} /></Pressable>)
        : <ThemedText themeColor="textSecondary" style={s.note}>可以以后再添加。</ThemedText>}</Card>
      </View>
      <View onLayout={(event) => recordSection('advanced', event.nativeEvent.layout.y)}>
      <Card><Pressable accessibilityRole="button" accessibilityLabel="角色高级设置" accessibilityState={{ expanded: advanced }} onPress={() => setAdvanced(!advanced)} style={s.between}>
        <ThemedText style={s.sectionTitle}>高级设置</ThemedText><AppIcon name={advanced ? 'chevron-up' : 'chevron-down'} size={17} color={theme.textSecondary} /></Pressable>
        {advanced ? <><Field label="上下文条数" value={contextInput} onChangeText={setContextInput} keyboardType="number-pad" maxLength={3} />
          <View style={s.between}><ThemedText style={s.label}>流式输出</ThemedText><Switch accessibilityLabel="角色流式输出" value={configuration.chatSettings.streamOutput}
            onValueChange={(streamOutput) => patchConfiguration({ chatSettings: { ...configuration.chatSettings, streamOutput } })} trackColor={{ true: theme.primary, false: theme.border }} thumbColor={theme.onPrimary} /></View>
          <SectionHeading title="角色变量" action="添加" icon="add" onAction={() => { setVariableError(null); setVariableDraft({ id: createId(), name: '', value: '' }); }} />
          {configuration.variables.map((variable) => <Pressable key={variable.id} accessibilityRole="button" accessibilityLabel={'编辑变量 ' + variable.name}
            onPress={() => { setVariableError(null); setVariableDraft({ ...variable, originalName: variable.name }); }} style={[s.variableRow, { borderColor: theme.border }]}>
            <ThemedText style={s.label}>{'{' + variable.name + '}'}</ThemedText><ThemedText numberOfLines={1} style={[s.note, s.flex]} themeColor="textSecondary">{variable.value}</ThemedText><AppIcon name="create-outline" size={15} color={theme.textSecondary} /></Pressable>)}
          <ThemedText themeColor="textSecondary" style={s.note}>自定义变量只影响此角色。用户昵称在 App 设置中修改。</ThemedText></> : null}
      </Card>
      </View>
      </>}
      {!editing && !dirty && error ? <ThemedText accessibilityRole="alert" style={[s.note, { color: theme.danger }]}>{error}</ThemedText> : null}
      {!editing && !dirty && notice ? <ThemedText accessibilityLiveRegion="polite" style={[s.note, { color: theme.success }]}>{notice}</ThemedText> : null}
      {dirty ? <SmallAction label="放弃修改并返回" tone="muted" onPress={leave} /> : null}
    </View>

    {mode === 'instruction' && content && instructionPicker && selectedModel && instructionPicker.modelId === selectedModel.id ? <InstructionPresetPicker
      key={instructionPicker.id} visible={!locked && editing && !modelEditor} model={selectedModel} value={content} disabled={locked}
      onClose={closeInstructionPicker} onSelect={(preset) => fillInstructionPreset(preset, instructionPicker)} /> : null}
    <Sheet visible={modelPicker} title="为这个角色选择模型" onClose={() => setModelPicker(false)}>
      {availableModels.map((model) => <Pressable key={model.id} accessibilityRole="radio" accessibilityLabel={'使用模型：' + model.name} accessibilityState={{ checked: model.id === selectedModel?.id }}
        onPress={() => { const next = copy(configuration); if (!Object.hasOwn(next.models, model.id)) next.models[model.id] = !isNew && !configuration.confirmed
          ? editingBinding(createRoleModelConfiguration(model, globalThinking)) : getRoleModelConfiguration(next, model.id);
          else if (!openedModelIds.current.has(model.id)) next.models[model.id] = editingBinding(next.models[model.id]);
          openedModelIds.current.add(model.id);
          next.currentModelId = model.id; if (pendingModel && pendingModel.model.id !== model.id) { discardTemporaryModel(next, pendingModel.model.id); setPendingModel(null); }
          patchConfiguration(next); setModelPicker(false); }} style={[s.modelRow, { backgroundColor: model.id === selectedModel?.id ? theme.primarySurface : theme.background, borderColor: theme.border }]}>
        <View style={s.flex}><ThemedText numberOfLines={1} style={s.label}>{model.name}</ThemedText><ThemedText numberOfLines={1} themeColor="textSecondary" style={s.note}>
          {model.apiModel} · {THINKING_MODE_LABELS[configuration.models[model.id]?.mode ?? (!isNew && !configuration.confirmed ? model.cotMode : 'off')]}</ThemedText></View>
        <AppIcon name={model.id === selectedModel?.id ? 'checkmark-circle' : 'ellipse-outline'} size={20} color={theme.primary} /></Pressable>)}
      <SmallAction label="添加模型" icon="add" onPress={() => { setModelPicker(false); setModelEditor(true); }} />
    </Sheet>
    <Sheet visible={templatePicker} title="复制模板到此角色" onClose={() => setTemplatePicker(false)}>
      {globalThinking.templates.filter((item) => contentMode && templateMatchesMode(item, contentMode)).map((template) => <Pressable key={template.id} accessibilityRole="button"
        accessibilityLabel={'复制模板：' + template.name} disabled={template.enabled === false} onPress={() => { patchContent({ text: template.prompt, templateId: null }); setTemplatePicker(false); }}
        style={[s.modelRow, { borderColor: theme.border }, template.enabled === false && s.dimmed]}><AppIcon name={template.icon} size={20} color={theme.primary} />
        <View style={s.flex}><ThemedText style={s.label}>{template.name}</ThemedText><ThemedText style={s.note} themeColor="textSecondary">{template.enabled === false ? '已停用' : template.description}</ThemedText></View></Pressable>)}
      <ThemedText themeColor="textSecondary" style={s.note}>复制后独立保存，修改模板原件不会影响这个角色。</ThemedText>
    </Sheet>
    <Sheet visible={imageEditor !== null} title={imageEditor === 'avatar' ? '角色头像' : '角色封面'} onClose={() => { if (!imageBusy) setImageEditor(null); }}>
      {(imageEditor === 'avatar' ? draft.profile.avatarUri : draft.profile.coverUri) ? <Image source={{ uri: (imageEditor === 'avatar' ? draft.profile.avatarUri : draft.profile.coverUri)! }}
        style={[s.imagePreview, imageEditor === 'avatar' && s.avatarPreview]} contentFit="cover" /> : null}
      {imageBusy ? <ActivityIndicator color={theme.primary} /> : <SmallAction label="从相册选择" icon="images-outline" onPress={() => { if (imageEditor) void selectImage(imageEditor); }} />}
      <SmallAction label="移除图片" icon="trash-outline" tone="danger" onPress={() => { if (!imageEditor) return;
        setDraft((current) => ({ ...current, profile: { ...current.profile, [imageEditor === 'avatar' ? 'avatarUri' : 'coverUri']: null } })); setImageEditor(null); }} />
    </Sheet>
    <Sheet visible={memoryDraft !== null} title="角色记忆" onClose={() => setMemoryDraft(null)} saveLabel="完成" saveDisabled={!memoryDraft?.text.trim()}
      onSave={() => { if (!memoryDraft?.text.trim()) return; const memory = { ...memoryDraft, text: memoryDraft.text.trim(), updatedAt: new Date().toISOString() };
        setDraft((current) => ({ ...current, memories: current.memories.some((item) => item.id === memory.id)
          ? current.memories.map((item) => item.id === memory.id ? memory : item) : [...current.memories, memory] })); setMemoryDraft(null); }}
      footer={memoryDraft && draft.memories.some((item) => item.id === memoryDraft.id) ? <SmallAction label="删除记忆" icon="trash-outline" tone="danger" onPress={() => {
        setDraft((current) => ({ ...current, memories: current.memories.filter((item) => item.id !== memoryDraft.id) })); setMemoryDraft(null);
      }} /> : undefined}>
      <View style={s.wrap}>{memoryIcons.map((icon) => <Pressable key={icon} accessibilityRole="radio" accessibilityLabel={'记忆分类：' + memoryLabels[icon]} accessibilityState={{ checked: memoryDraft?.icon === icon }}
        onPress={() => setMemoryDraft((current) => current ? { ...current, icon } : null)} style={[s.memoryIcon, { backgroundColor: memoryDraft?.icon === icon ? theme.primarySurface : theme.background }]}><AppIcon name={icon} size={22} color={theme.primary} /></Pressable>)}</View>
      <Field label="记忆内容" multiline value={memoryDraft?.text ?? ''} maxLength={1000} placeholder="写下希望 TA 记住的事" onChangeText={(text) => setMemoryDraft((current) => current ? { ...current, text } : null)} />
    </Sheet>
    <Sheet visible={variableDraft !== null} title="角色变量" onClose={() => setVariableDraft(null)} saveLabel="完成" onSave={saveVariable}
      footer={variableDraft?.originalName ? <SmallAction label="删除变量" icon="trash-outline" tone="danger" onPress={() => {
        patchConfiguration({ variables: configuration.variables.filter((item) => item.id !== variableDraft.id) }); setVariableDraft(null);
      }} /> : undefined}>
      <Field label="名称" value={variableDraft?.name ?? ''} maxLength={64} autoCapitalize="none" autoCorrect={false} onChangeText={(name) => setVariableDraft((current) => current ? { ...current, name } : null)} />
      <Field label="内容" multiline value={variableDraft?.value ?? ''} maxLength={4000} onChangeText={(value) => setVariableDraft((current) => current ? { ...current, value } : null)} />
      {variableError ? <ThemedText accessibilityRole="alert" style={[s.note, { color: theme.danger }]}>{variableError}</ThemedText> : null}
    </Sheet>
    {dialog}
  </DetailScreen>;
}

const s = StyleSheet.create({
  content: { gap: 8 }, flex: { flex: 1, minWidth: 0 }, dimmed: { opacity: 0.5 }, identity: { flexDirection: 'row', alignItems: 'center', gap: 13 },
  overview: { paddingHorizontal: 0 },
  overviewCover: { height: 116, borderRadius: 12, overflow: 'hidden', marginTop: 4 },
  overviewIdentity: { flexDirection: 'row', alignItems: 'center', gap: 13, paddingTop: 12, paddingBottom: 23 },
  overviewName: { ...Typography.title, marginBottom: 4 },
  overviewIntro: { ...Typography.secondary },
  overviewSection: { borderTopWidth: StyleSheet.hairlineWidth, paddingTop: 15, paddingBottom: 17 },
  overviewSectionHeading: { minHeight: 38, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 7 },
  overviewHeadingButton: { minHeight: 38, justifyContent: 'center', flex: 1 },
  overviewHeading: { ...Typography.section },
  overviewAction: { width: 36, height: 36, alignItems: 'center', justifyContent: 'center' },
  overviewPersona: { ...Typography.body },
  overviewTags: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 12 },
  overviewTag: { borderRadius: 6, paddingHorizontal: 9, paddingVertical: 4 },
  overviewTagText: { ...Typography.caption },
  overviewMemory: { minHeight: 47, flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 10 },
  overviewMemoryText: { ...Typography.body },
  overviewMemoryDate: { ...Typography.caption, fontVariant: ['tabular-nums'] },
  overviewEmpty: { minHeight: 38, justifyContent: 'center' },
  overviewConfig: { paddingTop: 8, paddingBottom: 4 },
  overviewSetting: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 56, paddingVertical: 13 },
  overviewSettingBorder: { borderTopWidth: StyleSheet.hairlineWidth },
  overviewSettingLabel: { ...Typography.row },
  overviewSettingValue: { flex: 1, minWidth: 0, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 7 },
  overviewValue: { ...Typography.secondary, flexShrink: 1 },
  overviewFooter: { paddingTop: 10, flexDirection: 'row', justifyContent: 'space-between', gap: 8 },
  avatar: { width: 62, height: 62, borderRadius: 31, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  camera: { position: 'absolute', right: 1, bottom: 1, width: 21, height: 21, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  personaInput: { minHeight: 114 }, thoughtInput: { ...Typography.input, minHeight: 140 }, jsonInput: { ...Typography.code, minHeight: 115, fontFamily: 'monospace' },
  presetButton: { minHeight: 55, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 9, flexDirection: 'row', alignItems: 'center', gap: 9 },
  cover: { aspectRatio: 2.1, borderRadius: 13, overflow: 'hidden', alignItems: 'center', justifyContent: 'center', gap: 6 },
  note: { ...Typography.secondary }, label: { ...Typography.rowTitle }, sectionTitle: { ...Typography.section },
  status: { borderRadius: 12, padding: 12, flexDirection: 'row', gap: 8, alignItems: 'center' },
  modelRow: { minHeight: 57, paddingHorizontal: 0, paddingVertical: 12, borderBottomWidth: StyleSheet.hairlineWidth, flexDirection: 'row', alignItems: 'center', gap: 10 },
  modeGrid: { padding: 5, borderRadius: 13, gap: 5 }, modeRow: { flexDirection: 'row', gap: 5 },
  mode: { flex: 1, minWidth: 0, minHeight: 52, borderRadius: 9, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  modeLabel: { ...Typography.compact, textAlign: 'center' }, wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' },
  between: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  memoryRow: { flexDirection: 'row', alignItems: 'center', gap: 9, borderTopWidth: StyleSheet.hairlineWidth, paddingVertical: 11 },
  memoryIcon: { width: 43, height: 43, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  variableRow: { flexDirection: 'row', alignItems: 'center', gap: 10, borderTopWidth: StyleSheet.hairlineWidth, paddingVertical: 10 },
  preview: { ...Typography.code, fontFamily: 'monospace', padding: 12, borderRadius: 10 },
  saveArea: { gap: 8 }, save: { minHeight: 48, paddingVertical: 10, borderRadius: 12, alignItems: 'center', justifyContent: 'center' }, saveLabel: { ...Typography.button },
  imagePreview: { width: '100%', aspectRatio: 2, borderRadius: 14 }, avatarPreview: { width: 155, aspectRatio: 1, borderRadius: 78, alignSelf: 'center' },
});
