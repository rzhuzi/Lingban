const assert = require('node:assert/strict');
const test = require('node:test');
const { createUiHarness } = require('./helpers/ui-harness.cjs');

function environment() {
  const chat = { activeSessionId: 's', sessions: [{ id: 's', personaId: 'p' }], messages: [
    { id: 'u', sessionId: 's', role: 'user', content: '第一条' },
    { id: 'a', sessionId: 's', role: 'assistant', content: '回复', reasoning: '思考', status: 'done' },
  ] };
  const persona = { id: 'p', profile: { name: '角色' }, configuration: { confirmed: true, currentModelId: 'm' } };
  const runtime = { isSending: false, streamingSessionId: null };
  const calls = [];
  const seams = {
    '@/constants/theme': { Spacing: {} },
    '@shopify/flash-list': { FlashList: 'FlashList', useRecyclingState: (value) => [value, () => {}] },
    'expo-router': { router: Object.fromEntries(['push', 'replace', 'dismissTo'].map((method) => [method, (route) => calls.push([method, route])])), usePathname: () => '/' },
    'expo-image': { Image: 'Image' },
    'react-native-safe-area-context': { SafeAreaView: 'SafeAreaView', useSafeAreaInsets: () => ({ top: 0 }) },
    '@/features/chat/use-chat-role': { useChatRole: () => ({ role: persona, roleId: 'p' }) },
    '@/features/companion/role-config': { getRoleModelConfiguration: () => ({ mode: 'off' }) },
    '@/features/companion/thinking-config': { THINKING_MODE_LABELS: { off: '关闭' } },
    '@/lib/chat/runtime': { useChatRuntimeStore: (select) => select ? select(runtime) : runtime },
    '@/lib/chat/engine': {},
    '@/stores/app-stores': {
      useChatStore: (select) => select(chat),
      usePersonaStore: (select) => select({ activePersonaId: 'p', personas: [persona] }),
      useModelStore: (select) => select({ models: [{ id: 'm' }] }),
      useAppMaintenanceStore: (select) => select({ active: false }),
    },
    '@/features/chat/chat-composer': { ChatComposer: 'ChatComposer' },
    '@/features/models/model-picker': { ModelPicker: 'ModelPicker' },
    '@/features/chat/role-picker': { RolePicker: 'RolePicker' },
    '@/components/recovery-notice': { RecoveryNotice: 'RecoveryNotice' },
    '@/features/chat/message-bubble': { MessageBubble: 'MessageBubble' },
    '@/features/chat/message-list': { MessageList: 'MessageList' },
  };
  return { chat, runtime, calls, seams };
}

test('short conversations start at the top and preserve oldest-to-newest append order', () => {
  const env = environment();
  const app = createUiHarness('src/features/chat/chat-screen.tsx', 'ChatScreen', {
    ...env.seams, '@/components/app-shell': { AppShell: 'AppShell', ChatWelcome: 'ChatWelcome' },
  });
  const list = () => app.nodes((node) => node.type === 'MessageList')[0];
  assert.equal(list().key, 's', 'Each session owns its scroll state.');
  env.chat.messages.push({ id: 'u2', sessionId: 's', role: 'user', content: '第二条' });
  app.render();
  assert.deepEqual(list().props.messages.map((message) => message.id), ['u', 'a', 'u2']);
});

function messageListHarness() {
  const env = environment();
  const props = { messages: env.chat.messages, generating: true, retryEnabled: false };
  const calls = [];
  const app = createUiHarness('src/features/chat/message-list.tsx', 'MessageList', env.seams, props);
  const list = () => app.nodes((node) => node.type === 'FlashList')[0];
  list().props.ref.current = { scrollToEnd: (options) => calls.push(options) };
  const resize = () => list().props.onContentSizeChange(400, 1000);
  const scroll = (offset, height = 1000) => list().props.onScroll({ nativeEvent: {
    contentOffset: { y: offset }, contentSize: { height }, layoutMeasurement: { height: 600 },
  } });
  const output = (content) => { props.messages[1] = { ...props.messages[1], content }; app.render(props); };
  resize(); calls.length = 0;
  return { ...app, props, calls, list, resize, scroll, output };
}

test('reasoning expansion never triggers bottom autoscroll, including while a reply streams', () => {
  const app = messageListHarness();
  assert.equal(app.list().props.maintainVisibleContentPosition?.autoscrollToBottomThreshold, undefined);
  assert.notEqual(app.list().props.maintainVisibleContentPosition?.startRenderingFromBottom, true);
  assert.notEqual(app.list().props.inverted, true);
  app.output('已经到达但尚未产生新高度的内容');
  app.list().props.renderItem({ item: app.props.messages[1] }).props.onReasoningToggle();
  app.resize();
  assert.equal(app.calls.length, 0, 'A toggle must not consume an outstanding output follow.');
  app.output('继续流式输出'); app.resize();
  assert.equal(app.calls.length, 0);
  app.props.messages.push({ id: 'a2', sessionId: 's', role: 'assistant', content: '', status: 'streaming' });
  app.render(app.props); app.resize();
  assert.equal(app.calls.length, 1, 'A new turn can follow again.');
});

test('new output follows after size-only scroll events, while upward reading stays stable', () => {
  const app = messageListHarness();
  app.scroll(400);
  app.output('增加一段回复');
  app.scroll(400, 1400); app.resize();
  assert.equal(app.calls.length, 1, 'Growth before measurement must not cancel bottom intent.');
  app.scroll(800, 1400); // Programmatic scroll settles at the bottom.
  app.scroll(100, 1400); // Reader scrolls upward.
  app.output('继续增加回复'); app.resize();
  assert.equal(app.calls.length, 1, 'Reading old messages must not be interrupted.');
  app.scroll(800, 1400);
  app.output('读者已回到底部'); app.resize();
  assert.equal(app.calls.length, 2);
  app.resize();
  assert.equal(app.calls.length, 2, 'A layout-only resize must not request another follow.');
  app.props.generating = false; app.output('已完成'); app.resize();
  assert.equal(app.calls.length, 2, 'Completed messages do not auto-scroll on layout.');
});

test('manually scrolling back to the bottom resumes following after a reasoning toggle', () => {
  const app = messageListHarness();
  app.scroll(400);
  app.list().props.renderItem({ item: app.props.messages[1] }).props.onReasoningToggle();
  app.list().props.onScrollBeginDrag?.();
  app.scroll(100);
  app.output('阅读旧内容时新增输出'); app.resize();
  assert.equal(app.calls.length, 0);
  app.scroll(400);
  app.list().props.onScrollEndDrag?.({ nativeEvent: { contentOffset: { y: 400 }, contentSize: { height: 1000 }, layoutMeasurement: { height: 600 }, velocity: { x: 0, y: 0 } } });
  app.output('回到底部后的新输出'); app.resize();
  assert.equal(app.calls.length, 1);
});

test('a drag finishing with momentum at the bottom restores following without a layout-only resume', () => {
  const app = messageListHarness();
  app.scroll(400);
  app.list().props.renderItem({ item: app.props.messages[1] }).props.onReasoningToggle();
  app.list().props.onScrollBeginDrag?.();
  app.scroll(100);
  app.scroll(200);
  const event = (y) => ({ nativeEvent: { contentOffset: { y }, contentSize: { height: 1000 }, layoutMeasurement: { height: 600 }, velocity: { x: 0, y: 1 } } });
  app.list().props.onScrollEndDrag?.(event(200));
  app.list().props.onMomentumScrollBegin?.(event(200));
  app.scroll(400);
  app.output('惯性滚动结束前'); app.resize();
  assert.equal(app.calls.length, 0, 'A layout scroll after finger release cannot resume following by itself.');
  app.list().props.onMomentumScrollEnd?.(event(400));
  app.output('惯性滚动已回到底部'); app.resize();
  assert.equal(app.calls.length, 1);
});

test('an upward drag inside the bottom threshold never gets interrupted by new output', () => {
  const app = messageListHarness(); app.scroll(400);
  app.list().props.renderItem({ item: app.props.messages[1] }).props.onReasoningToggle();
  app.list().props.onScrollBeginDrag?.(); app.scroll(350);
  app.output('向上阅读时的输出'); app.resize();
  assert.equal(app.calls.length, 0);
  app.list().props.onScrollEndDrag?.({ nativeEvent: { contentOffset: { y: 350 }, contentSize: { height: 1000 }, layoutMeasurement: { height: 600 }, velocity: { x: 0, y: 0 } } });
  app.output('释放手指后继续阅读'); app.resize();
  assert.equal(app.calls.length, 0);
});

test('a drag without momentum cannot lend its resume intent to a later programmatic scroll', () => {
  const app = messageListHarness(); app.scroll(400);
  app.list().props.renderItem({ item: app.props.messages[1] }).props.onReasoningToggle();
  app.list().props.onScrollBeginDrag?.(); app.scroll(100); app.scroll(200);
  app.list().props.onScrollEndDrag?.({ nativeEvent: { contentOffset: { y: 200 }, contentSize: { height: 1000 }, layoutMeasurement: { height: 600 }, velocity: { x: 0, y: 0 } } });
  const event = { nativeEvent: { contentOffset: { y: 400 }, contentSize: { height: 1000 }, layoutMeasurement: { height: 600 } } };
  app.list().props.onMomentumScrollBegin?.(event); app.scroll(400); app.list().props.onMomentumScrollEnd?.(event);
  app.output('程序滚动不表示恢复跟随'); app.resize();
  assert.equal(app.calls.length, 0);
});

test('a reasoning toggle invalidates a pending momentum resume from an earlier drag', () => {
  const app = messageListHarness();
  app.list().props.onScrollBeginDrag?.();
  app.list().props.onScrollEndDrag?.({ nativeEvent: { contentOffset: { y: 100 }, contentSize: { height: 1000 }, layoutMeasurement: { height: 600 } } });
  app.list().props.renderItem({ item: app.props.messages[1] }).props.onReasoningToggle();
  app.list().props.onMomentumScrollEnd?.({ nativeEvent: { contentOffset: { y: 400 }, contentSize: { height: 1000 }, layoutMeasurement: { height: 600 } } });
  app.output('展开后保留阅读位置'); app.resize();
  assert.equal(app.calls.length, 0);
});

test('the first drag has a native geometry baseline even before any scroll event', () => {
  const app = messageListHarness();
  const event = (y) => ({ nativeEvent: { contentOffset: { y }, contentSize: { height: 1000 }, layoutMeasurement: { height: 600 }, velocity: { x: 0, y: 0 } } });
  app.list().props.renderItem({ item: app.props.messages[1] }).props.onReasoningToggle();
  app.list().props.onScrollBeginDrag?.(event(0));
  app.scroll(400);
  app.list().props.onScrollEndDrag?.(event(400));
  app.output('首次手动回到底部'); app.resize();
  assert.equal(app.calls.length, 1);
});

test('the drag end includes final downward movement missed by throttled scroll events', () => {
  const app = messageListHarness();
  const event = (y) => ({ nativeEvent: { contentOffset: { y }, contentSize: { height: 1000 }, layoutMeasurement: { height: 600 }, velocity: { x: 0, y: 0 } } });
  app.list().props.renderItem({ item: app.props.messages[1] }).props.onReasoningToggle();
  app.list().props.onScrollBeginDrag?.(event(100));
  app.list().props.onScrollEndDrag?.(event(400));
  app.output('释放事件记录最后位移'); app.resize();
  assert.equal(app.calls.length, 1);
});

test('scrolling down through continuously growing streamed content still restores following', () => {
  const app = messageListHarness(); app.scroll(100);
  const event = (y, height) => ({ nativeEvent: { contentOffset: { y }, contentSize: { height }, layoutMeasurement: { height: 600 }, velocity: { x: 0, y: 0 } } });
  app.list().props.renderItem({ item: app.props.messages[1] }).props.onReasoningToggle();
  app.list().props.onScrollBeginDrag?.(event(100, 1000));
  app.scroll(300, 1100); app.scroll(600, 1200);
  app.list().props.onScrollEndDrag?.(event(600, 1200));
  app.output('不断增长时仍跟随'); app.resize();
  assert.equal(app.calls.length, 1);
});

test('height-only changes during a stationary drag never restore a paused turn', () => {
  const app = messageListHarness(); app.scroll(400);
  const event = { nativeEvent: { contentOffset: { y: 400 }, contentSize: { height: 1000 }, layoutMeasurement: { height: 600 }, velocity: { x: 0, y: 0 } } };
  app.list().props.renderItem({ item: app.props.messages[1] }).props.onReasoningToggle();
  app.list().props.onScrollBeginDrag?.(event);
  app.scroll(400, 1200); app.scroll(400, 1000);
  app.list().props.onScrollEndDrag?.(event);
  app.output('只有布局改变'); app.resize();
  assert.equal(app.calls.length, 0);
});

test('settings keeps chat in history; switching main pages replaces only the secondary page', () => {
  const env = environment();
  const app = createUiHarness('src/components/app-shell.tsx', 'AppShell', env.seams);
  const menuNode = app.nodes((node) => typeof node.type === 'function' && node.type.name === 'NavigationMenu')[0];
  const navigate = (activeRoute, label) => {
    const menu = menuNode.type({ ...menuNode.props, activeRoute });
    const item = app.nodes((node) => node.type === 'Pressable' && app.text(node).trim() === label, menu)[0];
    assert.ok(item, label); item.props.onPress();
  };
  navigate('/(tabs)', '设置');
  navigate('/(tabs)/settings', '历史会话');
  navigate('/(tabs)/history', '聊天');
  assert.deepEqual(env.calls, [['push', '/(tabs)/settings'], ['replace', '/(tabs)/history'], ['dismissTo', '/(tabs)']]);
});

test('reasoning toggle notifies list before resizing; content stays below header; icon is half size', () => {
  const env = environment();
  let expanded = false, notified = 0;
  env.seams['@shopify/flash-list'].useRecyclingState = () => [expanded, (value) => { assert.equal(notified, 1); expanded = value; }];
  delete env.seams['@/features/chat/message-bubble'];
  env.seams['@/features/chat/audit-sheet'] = { AuditSheet: 'AuditSheet' };
  const app = createUiHarness('src/features/chat/message-bubble.tsx', 'MessageBubble', env.seams,
    { message: env.chat.messages[1], canRetry: false, onReasoningToggle: () => { notified += 1; } });
  const blockNode = app.nodes((node) => typeof node.type === 'function' && node.type.name === 'ReasoningBlock')[0];
  let block = blockNode.type(blockNode.props);
  assert.equal(app.nodes((node) => node.props.name === 'orbit', block)[0].props.size, 8);
  app.nodes((node) => node.props.accessibilityLabel === '展开思考过程', block)[0].props.onPress();
  block = blockNode.type(blockNode.props);
  assert.equal(expanded, true);
  assert.equal(block.props.children[0].props.accessibilityLabel, '收起思考过程');
  assert.equal(block.props.children[1].props.children, '思考');
});
