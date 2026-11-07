import test from 'node:test';
import assert from 'node:assert/strict';
import { HistoryDialog } from '../public/history-dialog.js';

const fingerprint = 'a'.repeat(64);
const version = { id: 'version-1', createdAt: '2026-10-25T00:00:00.000Z', reason: 'subtitles', transcriptCount: 1, speakerNames: ['Cô Hương'], isCurrent: false };
const preview = () => ({ version, currentFingerprint: fingerprint, comparison: { added: 0, removed: 0, changed: 1, speakersChanged: 0 },
  transcript: [{ time: 1.25, end: 4, speaker: 's1', text: 'Nội dung đã lưu.' }], speakers: [{ id: 's1', name: 'Cô Hương' }] });
function setup(overrides = {}) {
  const elements = new Map(), listeners = new Map(), calls = [], opened = [], messages = [];
  const element = selector => {
    if (!elements.has(selector)) elements.set(selector, { textContent: '', innerHTML: '', value: '', hidden: false, disabled: false, classList: { toggle() {} } });
    return elements.get(selector);
  };
  const dialog = { open: true, querySelector: element, setAttribute() {}, addEventListener: (type, callback) => listeners.set(type, callback),
    showModal() { this.open = true; }, close() { this.open = false; listeners.get('close')?.(); } };
  const controller = new HistoryDialog({ dialog, getProject: () => ({ id: 'project-1', name: 'Bài giảng' }), savePending: async () => {},
    request: async (url, init) => { calls.push({ url, init }); return { id: 'project-1' }; },
    onRestored: async id => opened.push(id), toast: message => messages.push(message), ...overrides });
  controller.projectId = 'project-1'; controller.versions = [version]; controller.selectedId = version.id; controller.preview = preview(); controller.render();
  return { controller, dialog, element, calls, opened, messages };
}

test('history dialog waits for pending edits and refuses to restore or snapshot an unsaved draft', async () => {
  const f = setup({ savePending: async () => { throw new Error('Bản nháp chưa lưu'); } });
  await f.controller.restore(); await f.controller.saveVersion();
  assert.equal(f.calls.length, 0); assert.equal(f.dialog.open, true); assert.match(f.element('#historyStatus').textContent, /Bản nháp chưa lưu/);
  assert.equal(f.controller.busy, false);
});

test('a saved restore with failed UI refresh retries opening the saved project without another restore', async () => {
  let opens = 0;
  const f = setup({ onRestored: async () => { if (++opens === 1) throw new Error('Thư viện tạm lỗi'); } });
  await f.controller.restore();
  assert.equal(f.calls.length, 1); assert.equal(JSON.parse(f.calls[0].init.body).expectedFingerprint, fingerprint);
  assert.equal(f.controller.restoredId, 'project-1'); assert.equal(f.dialog.open, true);
  assert.equal(f.element('#historyRestoreButton').textContent, 'Mở phiên bản đã khôi phục');
  await f.controller.restore();
  assert.equal(opens, 2); assert.equal(f.calls.length, 1); assert.equal(f.dialog.open, false); assert.equal(f.messages.length, 1);
});

test('a stale preview disables restore until a fresh preview is loaded', async () => {
  const calls = []; let stale = true;
  const f = setup({ request: async (url, init = {}) => {
    calls.push({ url, init });
    if (init.method === 'POST') { if (stale) throw Object.assign(new Error('Tải lại lịch sử'), { status: 409 }); return { id: 'project-1' }; }
    return url.endsWith('/history') ? { versions: [version] } : { ...preview(), currentFingerprint: 'b'.repeat(64) };
  } });
  await f.controller.restore(); assert.equal(f.controller.stale, true); assert.equal(f.element('#historyRestoreButton').disabled, true);
  await f.controller.restore(); assert.equal(calls.length, 1);
  stale = false; await f.controller.load(); assert.equal(f.element('#historyRestoreButton').disabled, false);
  await f.controller.restore(); assert.equal(JSON.parse(calls.at(-1).init.body).expectedFingerprint, 'b'.repeat(64));
});

test('closing a read aborts it before any request if pending saves have not finished', async () => {
  let release; const pending = new Promise(resolve => { release = resolve; });
  const f = setup({ savePending: () => pending });
  const loaded = f.controller.load(); assert.equal(f.controller.busy, true); assert.equal(f.controller.writing, false);
  f.dialog.close(); release(); await loaded;
  assert.equal(f.calls.length, 0); assert.equal(f.controller.busy, false);
});

test('in-flight writes block escape and close controls; busy audio processing blocks new writes', async () => {
  let release; const pending = new Promise(resolve => { release = resolve; });
  const f = setup({ savePending: () => pending });
  const restored = f.controller.restore(); assert.equal(f.controller.writing, true);
  assert.equal(f.element('#historyCloseButton').disabled, true); assert.equal(f.element('[data-close-modal="historyModal"]').disabled, true);
  release(); await restored; assert.equal(f.controller.writing, false);
  const busy = setup({ isBusy: () => true }); await busy.controller.restore(); await busy.controller.saveVersion();
  assert.equal(busy.calls.length, 0); assert.match(busy.element('#historyStatus').textContent, /Đợi tác vụ/u);
});
