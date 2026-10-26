const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const { createChatDraftStore, chatDraftKey } = require('./helpers/chat-draft-store.cjs');

test('acceptance clears only the captured draft and preserves edits even when text matches again', () => {
  const store = createChatDraftStore(), key = chatDraftKey('chat-a', 'role-a');
  store.getState().updateDraft(key, '原文');
  const sent = store.getState().drafts[key];
  store.getState().updateDraft(key, '改过'); store.getState().updateDraft(key, '原文');
  store.getState().acceptDraft(key, sent, 'chat-a');
  assert.equal(store.getState().drafts[key].text, '原文');
  const latest = store.getState().drafts[key];
  store.getState().acceptDraft(key, latest, 'chat-a');
  assert.equal(store.getState().drafts[key], undefined);
});

test('cleared or deleted drafts cannot be resurrected or erase another session by a stale acceptance', () => {
  const store = createChatDraftStore();
  const pending = chatDraftKey(null, 'role-a'), other = chatDraftKey('other', 'role-b');
  store.getState().updateDraft(pending, '待发送');
  const sent = store.getState().drafts[pending];
  store.getState().clearDrafts();
  store.getState().acceptDraft(pending, sent, 'created');
  assert.deepEqual(store.getState().drafts, {});
  store.getState().updateDraft(pending, '后来重新输入');
  store.getState().acceptDraft(pending, sent, 'created');
  assert.equal(store.getState().drafts[chatDraftKey('created', '')].text, '后来重新输入');
  store.getState().updateDraft(other, '其他会话');
  store.getState().discardDraft(chatDraftKey('created', ''));
  assert.equal(store.getState().drafts[other].text, '其他会话');
});

for (const fails of [false, true]) {
  test(`session deletion ${fails ? 'failure retains' : 'success discards'} only that conversation's draft`, async () => {
    const drafts = createChatDraftStore(), deleted = chatDraftKey('deleted', ''), retained = chatDraftKey('retained', '');
    drafts.getState().updateDraft(deleted, '待删除会话草稿');
    drafts.getState().updateDraft(retained, '其他会话草稿');
    let finish;
    const waiting = new Promise((resolve) => { finish = resolve; });
    const emptyStore = { getState: () => ({}), setState() {} };
    const seams = {
      '@/features/companion/defaults': {}, '@/features/models/model-service': {}, '@/lib/api/stream': {}, '@/lib/db/repository': {},
      '@/stores/app-stores': { useChatStore: emptyStore },
      '@/stores/chat-draft-store': { chatDraftKey, useChatDraftStore: drafts },
      './runtime': { useChatRuntimeStore: emptyStore },
      './engine-core': { createChatEngine: () => ({ deleteChatSession: async (id) => {
        assert.equal(id, 'deleted'); await waiting;
        if (fails) throw new Error('fixture deletion failed');
      } }) },
    };
    const filename = path.resolve(__dirname, '../src/lib/chat/engine.ts');
    const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, fileName: filename,
    }).outputText;
    const loaded = { exports: {} };
    vm.runInThisContext(`(function(require,module,exports){${compiled}\n})`, { filename })(
      (name) => { assert.ok(name in seams, name); return seams[name]; }, loaded, loaded.exports);
    const deletion = loaded.exports.deleteChatSession('deleted');
    assert.equal(drafts.getState().drafts[deleted].text, '待删除会话草稿');
    finish();
    if (fails) await assert.rejects(deletion, /fixture deletion failed/);
    else await deletion;
    assert.equal(drafts.getState().drafts[deleted]?.text, fails ? '待删除会话草稿' : undefined);
    assert.equal(drafts.getState().drafts[retained].text, '其他会话草稿');
  });
}
