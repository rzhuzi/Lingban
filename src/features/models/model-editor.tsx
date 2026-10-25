import { Typography } from '@/constants/typography';
import { AppIcon as Ionicons } from '@/components/app-icon';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, View } from 'react-native';

import { Card, DetailScreen, Field, Sheet, SmallAction } from '@/components/customization-ui';
import { ThemedText } from '@/components/themed-text';
import { createId } from '@/features/companion/defaults';
import { getModelThinkingConfig } from '@/features/companion/thinking-config';
import { useTheme } from '@/hooks/use-theme';
import { ApiError, normalizeChatCompletionsUrl, testConnection } from '@/lib/api/client';
import { listModels, ModelsListError, normalizeModelsUrl, type RemoteModel } from '@/lib/api/models';
import { getModelSuggestions } from '@/lib/api/model-suggestions';
import { getProvider, PROVIDERS } from '@/lib/api/providers';
import type { ModelRecord } from '@/lib/db/types';
import { usePersonaStore } from '@/stores/app-stores';

import { getModelApiKey, getModelKeySummary, saveModelConfiguration } from './model-service';
import { ModelCleanupWarning } from './model-cleanup-warning';
import { RemoteModelPicker } from './remote-model-picker';

type TestResult = { success: boolean; message: string };
export type ModelEditorDraft = { model: ModelRecord; apiKey?: string };
export function ModelEditor({ model, initialApiKey, onComplete, onCancel }: {
  model?: ModelRecord; initialApiKey?: string;
  onComplete?: (draft: ModelEditorDraft) => void; onCancel?: () => void;
}) {
  const theme = useTheme();
  const initialProvider = getProvider(model?.provider ?? 'deepseek');
  const [id] = useState(() => model?.id ?? createId());
  const [name, setName] = useState(model?.name ?? initialProvider.label);
  const [providerId, setProviderId] = useState<ModelRecord['provider']>(initialProvider.id);
  const [baseUrl, setBaseUrl] = useState(model?.baseUrl ?? initialProvider.baseUrl);
  const [apiModel, setApiModel] = useState(model?.apiModel ?? initialProvider.defaultModel);
  const nameEdited = useRef(!!model && model.name !== model.apiModel && model.name !== initialProvider.label);
  const [remoteModels, setRemoteModels] = useState<RemoteModel[]>(() => getModelSuggestions(baseUrl));
  const [modelsSource, setModelsSource] = useState<'reference' | 'remote' | null>(() => getModelSuggestions(baseUrl).length ? 'reference' : null);
  const [modelSheet, setModelSheet] = useState(false);
  const [manualModel, setManualModel] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const modelsRequest = useRef<AbortController | null>(null);
  const catalogRevision = useRef(0);
  const autoRevision = useRef<number | null>(null);
  // Legacy flags/configuration remain archived on the model; roles own live selections.
  const isDefault = model?.isDefault ?? false;
  const cotMode = model?.cotMode ?? 'off';
  const thinkingConfig = getModelThinkingConfig(model ?? {});
  const [apiKey, setApiKey] = useState(initialApiKey ?? '');
  const [anonymous, setAnonymous] = useState(model?.provider === 'custom' && model.apiKeyAlias === null && !initialApiKey?.trim());
  const affectedRoles = usePersonaStore((state) => state.personas.filter((persona) => persona.configuration?.currentModelId === model?.id).length);
  const [keySummary, setKeySummary] = useState<{ configured: boolean; lastFour: string } | null>(null);
  const [keyReadError, setKeyReadError] = useState(false);
  const [providerSheet, setProviderSheet] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const mounted = useRef(true);
  const request = useRef<AbortController | null>(null);
  const provider = getProvider(providerId);
  const busy = saving || testing;
  const targetChanged = !!model && (providerId !== model.provider || baseUrl.trim() !== model.baseUrl);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false; request.current?.abort(); modelsRequest.current?.abort();
    };
  }, []);

  useEffect(() => {
    let active = true;
    getModelKeySummary(model?.apiKeyAlias ?? null).then((summary) => {
      if (active) { setKeySummary(summary); setKeyReadError(false); }
    }).catch(() => { if (active) setKeyReadError(true); });
    return () => { active = false; };
  }, [model?.apiKeyAlias]);

  function cancelModelFetch() {
    modelsRequest.current?.abort();
    modelsRequest.current = null;
    setFetchingModels(false);
  }

  function invalidateModels(nextBaseUrl = baseUrl) {
    cancelModelFetch();
    catalogRevision.current += 1;
    const references = getModelSuggestions(nextBaseUrl);
    setRemoteModels(references); setModelsSource(references.length ? 'reference' : null);
    setModelsError(null); setModelsLoaded(false);
  }

  async function fetchModels(openPicker = true, automatic = false) {
    if (busy || automatic && autoRevision.current === catalogRevision.current) return;
    if (modelsRequest.current) { if (openPicker) setModelSheet(true); return; }
    let replacement: string | undefined;
    try {
      normalizeModelsUrl(baseUrl);
      replacement = credentialChange();
    } catch (failure) {
      if (!automatic) {
        setModelSheet(openPicker);
        setModelsError(failure instanceof Error ? failure.message : '请先填写接口地址和 API Key。');
      }
      return;
    }
    cancelModelFetch();
    autoRevision.current = catalogRevision.current;
    const controller = new AbortController();
    modelsRequest.current = controller;
    setFetchingModels(true); setModelsError(null);
    if (openPicker) setModelSheet(true);
    try {
      const key = replacement === undefined ? await getModelApiKey(model?.apiKeyAlias ?? null) : replacement;
      if (!mounted.current || modelsRequest.current !== controller) return;
      if (!anonymous && !key) { setModelsError('未找到已保存的 API Key，请重新填写。'); return; }
      const available = await listModels({ baseUrl: baseUrl.trim(), apiKey: key, signal: controller.signal });
      if (mounted.current && modelsRequest.current === controller) {
        setRemoteModels(available); setModelsLoaded(true); setModelsSource('remote');
      }
    } catch (failure) {
      if (mounted.current && modelsRequest.current === controller) {
        const references = getModelSuggestions(baseUrl);
        setRemoteModels(references); setModelsLoaded(false); setModelsSource(references.length ? 'reference' : null);
        setModelsError(failure instanceof ModelsListError
          ? references.length && ['unsupported', 'invalid_response'].includes(failure.code)
            ? '此接口未提供可用列表，可从参考模型中选择。' : failure.message
          : '无法获取模型列表，请检查地址和密钥后重试。');
      }
    } finally {
      if (mounted.current && modelsRequest.current === controller) {
        modelsRequest.current = null; setFetchingModels(false);
      }
    }
  }

  function selectRemoteModel(selected: RemoteModel) {
    invalidateTest();
    if (!nameEdited.current || !name.trim()) setName((selected.name || selected.id).slice(0, 80));
    setApiModel(selected.id); setManualModel(false); setModelSheet(false);
  }

  function closeModelPicker() { cancelModelFetch(); setModelSheet(false); }

  function invalidateTest() {
    request.current?.abort();
    request.current = null;
    setTesting(false);
    setTestResult(null);
    setError(null);
  }

  function selectProvider(nextId: ModelRecord['provider']) {
    if (nextId === providerId) { setProviderSheet(false); return; }
    const next = getProvider(nextId);
    invalidateTest();
    invalidateModels(next.baseUrl);
    if (!nameEdited.current || !name.trim()) setName(next.label);
    setProviderId(next.id);
    setBaseUrl(next.baseUrl);
    setApiModel(next.defaultModel);
    setApiKey('');
    setAnonymous(false);
    setProviderSheet(false);
  }

  function credentialChange(): string | undefined {
    if (anonymous && providerId === 'custom') return '';
    const replacement = apiKey.trim();
    if (replacement) return replacement;
    if (model?.apiKeyAlias && (providerId !== model.provider || baseUrl.trim() !== model.baseUrl)) {
      throw new Error('更换服务商或地址后，请重新填写 API Key。');
    }
    if (providerId !== 'custom' && !keySummary?.configured) throw new Error('请填写 API Key。');
    if (providerId === 'custom' && !keySummary?.configured) throw new Error('请填写 API Key，或选择不使用密钥。');
    return undefined;
  }

  function validate(requireName: boolean) {
    if (requireName && !name.trim()) throw new Error('请填写模型名称。');
    if (!apiModel.trim()) throw new Error('请填写模型 ID。');
    normalizeChatCompletionsUrl(baseUrl);
  }

  async function save() {
    if (busy) return;
    cancelModelFetch();
    setError(null);
    try {
      validate(true);
      const replacement = credentialChange();
      const now = new Date().toISOString();
      const record: ModelRecord = {
        id, name: name.trim(), provider: providerId, baseUrl: baseUrl.trim(), apiModel: apiModel.trim(),
        apiKeyAlias: model?.apiKeyAlias ?? null, isDefault,
        cotMode, cotPresetId: model?.cotPresetId ?? null, thinkingConfig,
        createdAt: model?.createdAt ?? now, updatedAt: now,
      };
      if (onComplete) {
        onComplete({ model: record, apiKey: replacement });
        return;
      }
      setSaving(true);
      await saveModelConfiguration(record, replacement);
      if (mounted.current) {
        setApiKey('');
        if (router.canGoBack()) router.back();
        else router.replace('/models');
      }
    } catch (failure) {
      if (mounted.current) setError(failure instanceof Error ? failure.message : '保存失败，请重试。');
    } finally { if (mounted.current) setSaving(false); }
  }

  async function test() {
    if (busy) return;
    setError(null);
    setTestResult(null);
    const controller = new AbortController();
    request.current = controller;
    try {
      validate(false);
      const replacement = credentialChange();
      setTesting(true);
      const key = replacement === undefined ? await getModelApiKey(model?.apiKeyAlias ?? null) : replacement;
      if (request.current !== controller || !mounted.current) return;
      if (!anonymous && !key) throw new Error('未找到已保存的 API Key，请重新填写。');
      const result = await testConnection({ baseUrl: baseUrl.trim(), apiModel: apiModel.trim(), apiKey: key, signal: controller.signal });
      if (mounted.current && request.current === controller) setTestResult({ success: true, message: `连接成功 · ${result.latencyMs} ms` });
    } catch (failure) {
      if (mounted.current && request.current === controller) setTestResult({ success: false,
        message: failure instanceof ApiError || failure instanceof Error ? failure.message : '测试失败，请重试。' });
    } finally {
      if (mounted.current && request.current === controller) { setTesting(false); request.current = null; }
    }
  }

  // Saved credentials and explicitly anonymous endpoints can be discovered on entry.
  // New keys fetch on blur, so typing does not send requests with partial keys.
  useEffect(() => {
    if (!keySummary?.configured && !anonymous) return;
    const timer = setTimeout(() => { void fetchModels(false, true); }, 0);
    return () => clearTimeout(timer);
    // Credential/endpoint edits invalidate their revision and fetch on blur.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keySummary?.configured, anonymous]);

  return <DetailScreen title={model ? '编辑模型' : '添加模型'} onBack={onComplete ? onCancel : undefined}>
    <ModelCleanupWarning />
    {model && affectedRoles > 0 && !onComplete ? <ThemedText themeColor="textSecondary" style={styles.hint}>此接入由 {affectedRoles} 个角色使用，修改接入信息会影响这些角色。</ThemedText> : null}
    <Card>
      <View style={styles.fieldGroup}>
        <ThemedText style={styles.label}>服务商</ThemedText>
        <Pressable accessibilityRole="button" accessibilityLabel={`选择服务商：${provider.label}`} disabled={saving}
          onPress={() => setProviderSheet(true)} style={[styles.provider, { backgroundColor: theme.background, borderColor: theme.border }]}>
          <ThemedText style={styles.value}>{provider.label}</ThemedText><Ionicons name="chevron-down" size={17} color={theme.textSecondary} />
        </Pressable>
      </View>
      <Field label="API 地址" value={baseUrl} editable={!saving} onChangeText={(value) => { invalidateTest(); invalidateModels(value); setBaseUrl(value); }}
        onEndEditing={() => { void fetchModels(false, true); }}
        autoCapitalize="none" autoCorrect={false} keyboardType="url" maxLength={2048} placeholder="https://example.com/v1" />
    </Card>
    <Card>
      <Field label="API Key" value={apiKey} onChangeText={(value) => { invalidateTest(); invalidateModels(); setApiKey(value); }}
        onEndEditing={() => { void fetchModels(false, true); }}
        editable={!saving && !anonymous} autoCapitalize="none" autoCorrect={false} secureTextEntry autoComplete="off" textContentType="none"
        placeholder={anonymous ? '此端点不使用 API Key' : targetChanged ? '请重新填写 API Key' : keySummary?.configured ? `已保存 ····${keySummary.lastFour}，留空保留` : '输入 API Key'} maxLength={2048} />
      {keyReadError ? <ThemedText style={[styles.hint, { color: theme.danger }]}>无法读取已保存的密钥，可重新填写后保存。</ThemedText> : null}
      {providerId === 'custom' ? <Pressable accessibilityRole="checkbox" accessibilityLabel="不使用 API Key" accessibilityState={{ checked: anonymous }} disabled={saving}
        onPress={() => { invalidateTest(); invalidateModels(); setAnonymous(!anonymous); setApiKey(''); }} style={styles.anonymous}>
        <Ionicons name={anonymous ? 'checkbox' : 'square-outline'} size={21} color={anonymous ? theme.primary : theme.textSecondary} />
        <ThemedText style={styles.hint}>不使用 API Key（自定义端点）</ThemedText>
      </Pressable> : null}
      <ThemedText themeColor="textSecondary" style={styles.hint}>{Platform.OS === 'web' ? 'Web 预览的密钥仅在当前页面会话内保留。' : '密钥保存在本机安全存储中。'}</ThemedText>
    </Card>
    <Card>
      <View style={styles.defaultRow}>
        <ThemedText style={styles.label}>模型</ThemedText>
        <Pressable accessibilityRole="button" accessibilityLabel={fetchingModels ? '取消获取模型' : modelsLoaded ? '刷新模型列表' : '获取模型列表'}
          disabled={busy} onPress={() => { if (fetchingModels) cancelModelFetch(); else void fetchModels(); }} style={styles.fetchAction}>
          {fetchingModels ? <ActivityIndicator size="small" color={theme.primary} /> : <Ionicons name={modelsLoaded ? 'refresh' : 'cloud-download-outline'} size={16} color={theme.primary} />}
          <ThemedText style={[styles.hint, { color: theme.primary }]}>{fetchingModels ? '取消' : modelsLoaded ? '刷新' : '获取模型'}</ThemedText>
        </Pressable>
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel="选择模型" disabled={saving}
        onPress={() => { setModelSheet(true); if (!modelsLoaded && !fetchingModels) void fetchModels(); }}
        style={[styles.provider, { backgroundColor: theme.background, borderColor: theme.border }]}>
        <ThemedText numberOfLines={1} themeColor={apiModel ? 'text' : 'textSecondary'} style={[styles.value, styles.templateLabel]}>{apiModel || '选择模型'}</ThemedText>
        <Ionicons name="chevron-down" size={17} color={theme.textSecondary} />
      </Pressable>
      {fetchingModels ? <ThemedText themeColor="textSecondary" style={styles.hint}>正在获取模型…</ThemedText>
        : modelsError ? <ThemedText accessibilityRole="alert" style={[styles.hint, { color: theme.danger }]}>{modelsError}</ThemedText>
          : modelsLoaded || modelsSource === 'reference' ? <ThemedText themeColor="textSecondary" style={styles.hint}>{remoteModels.length
            ? `${remoteModels.length} 个${modelsSource === 'reference' ? '参考' : '可选'}模型` : '该接口未返回可用模型。'}</ThemedText> : null}
      {manualModel ? <Field label="模型 ID" value={apiModel} editable={!saving} onChangeText={(value) => { invalidateTest(); setApiModel(value); }}
        autoCapitalize="none" autoCorrect={false} maxLength={200} placeholder="服务商提供的模型 ID" />
        : <SmallAction label="手动输入模型 ID" tone="muted" onPress={() => setManualModel(true)} />}
      <Field label="模型名称" value={name} onChangeText={(value) => { nameEdited.current = true; setName(value); }} maxLength={80} editable={!saving} placeholder="自动使用模型名称" />
    </Card>
    {error ? <ThemedText accessibilityRole="alert" style={[styles.message, { color: theme.danger }]}>{error}</ThemedText> : null}
    {testResult ? <View accessibilityRole="alert" style={[styles.result, { backgroundColor: testResult.success ? theme.backgroundElement : theme.primarySurface }]}>
      <Ionicons name={testResult.success ? 'checkmark-circle-outline' : 'alert-circle-outline'} size={19} color={testResult.success ? theme.success : theme.danger} />
      <ThemedText style={[styles.resultText, { color: testResult.success ? theme.success : theme.danger }]}>{testResult.message}</ThemedText>
    </View> : null}
    <View style={styles.actions}>
      <Pressable accessibilityRole="button" accessibilityLabel={testing ? '取消连通性测试' : '测试连接'} disabled={saving}
        onPress={() => {
          if (testing) { invalidateTest(); setTestResult({ success: false, message: '已取消连接测试。' }); }
          else void test();
        }}
        style={({ pressed }) => [styles.button, { backgroundColor: theme.backgroundElement, opacity: saving ? 0.4 : pressed ? 0.6 : 1 }]}>
        {testing ? <ActivityIndicator size="small" color={theme.textSecondary} /> : <Ionicons name="pulse-outline" size={18} color={theme.text} />}
        <ThemedText style={styles.buttonLabel}>{testing ? '取消测试' : '测试连接'}</ThemedText>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={onComplete ? '完成模型配置' : '保存模型'} disabled={busy} onPress={() => void save()}
        style={({ pressed }) => [styles.button, { backgroundColor: theme.primaryStrong, opacity: busy ? 0.4 : pressed ? 0.7 : 1 }]}>
        {saving ? <ActivityIndicator size="small" color={theme.onPrimary} /> : <Ionicons name="checkmark" size={18} color={theme.onPrimary} />}
        <ThemedText style={[styles.buttonLabel, { color: theme.onPrimary }]}>{onComplete ? '完成' : '保存'}</ThemedText>
      </Pressable>
    </View>
    <ThemedText themeColor="textSecondary" style={[styles.hint, styles.testHint]}>测试会向该地址发送一条简短请求。</ThemedText>
    <RemoteModelPicker visible={modelSheet} models={remoteModels} selectedId={apiModel} onSelect={selectRemoteModel}
      loading={fetchingModels} error={modelsError} onRefresh={() => { void fetchModels(); }} onClose={closeModelPicker}
      sourceLabel={modelsSource === 'reference' ? '参考模型' : undefined}
      onManualEntry={() => { closeModelPicker(); setManualModel(true); }} />
    <Sheet visible={providerSheet} title="选择服务商" onClose={() => setProviderSheet(false)}>
      {PROVIDERS.map((item) => <Pressable key={item.id} accessibilityRole="radio" accessibilityLabel={item.label} accessibilityState={{ checked: providerId === item.id }}
        onPress={() => selectProvider(item.id)} style={[styles.providerChoice, { backgroundColor: providerId === item.id ? theme.primarySurface : theme.background }]}>
        <ThemedText style={styles.value}>{item.label}</ThemedText>
        {providerId === item.id ? <Ionicons name="checkmark" size={20} color={theme.primary} /> : null}
      </Pressable>)}
    </Sheet>
  </DetailScreen>;
}

export function MissingModel() {
  return <DetailScreen title="模型配置"><Card><ThemedText>未找到这个模型</ThemedText><SmallAction label="模型管理" onPress={() => router.replace('/models')} /></Card></DetailScreen>;
}

const styles = StyleSheet.create({
  fieldGroup: { gap: 8 }, label: { ...Typography.label }, value: { ...Typography.row, flexShrink: 1 },
  provider: { borderWidth: StyleSheet.hairlineWidth, minHeight: 46, borderRadius: 10, paddingHorizontal: 13, paddingVertical: 11, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  providerChoice: { minHeight: 48, paddingHorizontal: 12, paddingVertical: 12, borderRadius: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  hint: { ...Typography.secondary }, anonymous: { flexDirection: 'row', alignItems: 'center', gap: 8, minHeight: 34 },
  defaultRow: { minHeight: 28, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }, actions: { flexDirection: 'row', gap: 12 },
  fetchAction: { minHeight: 32, flexDirection: 'row', alignItems: 'center', gap: 5 },
  button: { flex: 1, minHeight: 48, paddingVertical: 12, borderRadius: 12, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 7 },
  buttonLabel: { ...Typography.button },
  message: { ...Typography.secondary, paddingHorizontal: 4 }, result: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 12, borderRadius: 13 },
  resultText: { ...Typography.secondary, flex: 1, }, testHint: { textAlign: 'center' },
  segmented: { flexDirection: 'row', gap: 3, padding: 4, borderRadius: 13 },
  segment: { flex: 1, minHeight: 44, paddingVertical: 8, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  segmentLabel: { ...Typography.compact }, templateLabel: { flex: 1, marginRight: 8 },
});
