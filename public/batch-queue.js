export { batchProgress } from './batch-progress.js';
export const MAX_BATCH_FILES = 20;
const terminal = new Set(['completed', 'failed', 'cancelled']);
const json = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

export function audioFileError(file) {
  if (!file) return 'Chưa chọn file âm thanh.';
  if (file.size > 250 * 1024 * 1024) return 'File vượt quá 250 MB.';
  if (!file.size) return 'File âm thanh đang trống.';
  if (!file.type?.startsWith('audio/') && !/\.(mp3|wav|m4a|aac|flac|ogg|webm)$/i.test(file.name)) return 'Chọn một file MP3, WAV, M4A, AAC, FLAC, OGG hoặc WebM.';
  return null;
}

// Only transferring bytes belongs to the browser. Scheduling, cancellation and
// processing checkpoints belong to the durable, shared server queue.
export class BatchQueue {
  constructor({ request, onChange = () => {}, onSettled = () => {}, onError = () => {}, pollInterval = 1400 }) {
    Object.assign(this, { request, onChange, onSettled, onError, pollInterval });
    this.items = []; this.uploads = new Map(); this.running = false; this.exporting = false;
    this.options = null; this.clearRequested = false; this.ready = false; this.revision = -1;
    this.connectionError = ''; this.serverError = ''; this.starting = false; this.disposed = false;
  }
  changed() { this.onChange(this); }
  get hasUnuploaded() { return [...this.uploads.values()].some(local => !local.invalid && !local.cancelled && !local.discard); }
  get uploading() { return [...this.uploads.values()].some(local => local.busy); }

  apply(snapshot) {
    if (snapshot.revision < this.revision) return;
    const wasRunning = this.running, previous = new Map(this.items.map(item => [item.id, item]));
    if (this.generation && snapshot.generation !== this.generation) {
      for (const local of this.uploads.values()) { local.discard = true; local.controller?.abort(); }
      this.uploads.clear();
    }
    this.generation = snapshot.generation; this.revision = snapshot.revision; this.remote = snapshot;
    this.running = snapshot.running; this.options = snapshot.options; this.clearRequested = snapshot.clearing;
    this.serverError = snapshot.error || ''; this.connectionError = ''; this.ready = true;
    for (const item of snapshot.items) if (item.uploaded || item.imported) this.uploads.delete(item.id);
    this.items = snapshot.items.map(item => ({ ...item, remoteStatus: item.status, needsUpload: !item.uploaded && !item.imported,
      selected: previous.get(item.id)?.selected !== false }));
    for (const [id, local] of this.uploads) {
      const item = this.items.find(entry => entry.id === id);
      const overlay = { file: local.file, status: local.cancelled ? 'cancelled' : local.busy ? 'uploading' : 'failed',
        error: local.error || '', message: local.busy ? 'Đang tải file lên máy. Chờ tải xong trước khi đóng tab…' : '' };
      if (item && !item.uploaded && !item.imported && item.status !== 'cancelled') Object.assign(item, overlay);
      else if (!item && !local.discard) this.items.push({ id, name: local.file.name, size: local.file.size, project: null,
        needsUpload: true, remoteStatus: null, selected: true, progress: null, ...overlay });
    }
    this.changed();
    if (wasRunning && !this.running && !this.clearRequested) Promise.resolve(this.onSettled(this)).catch(this.onError);
  }

  async refresh() { this.apply(await this.request('/api/queue')); }
  async retryStorage() { this.apply(await this.request('/api/queue/recover', json({}))); }
  async connect({ poll = true } = {}) {
    if (!this.connecting) this.connecting = this.refresh().finally(() => { this.connecting = null; });
    try { await this.connecting; }
    finally { if (poll) this.schedule(); }
  }
  schedule() {
    clearTimeout(this.timer);
    if (this.disposed) return;
    this.timer = setTimeout(async () => {
      try { await this.refresh(); }
      catch { this.connectionError = 'Mất kết nối máy chủ. Danh sách đã lưu sẽ hiện lại khi kết nối trở lại.'; this.changed(); }
      finally { this.schedule(); }
    }, this.connectionError ? 4000 : this.pollInterval);
  }
  dispose() { this.disposed = true; clearTimeout(this.timer); }

  async add(files) {
    if (!this.ready) await this.connect();
    const additions = Array.from(files).slice(0, Math.max(0, MAX_BATCH_FILES - this.items.length));
    const locals = additions.map(file => {
      const error = audioFileError(file);
      const local = { id: crypto.randomUUID(), file, generation: this.generation, busy: !error, cancelled: false, discard: false, invalid: !!error, error: error || '' };
      this.uploads.set(local.id, local); return local;
    });
    if (this.remote) this.apply(this.remote);
    for (const local of locals) if (!local.invalid && !local.discard && !local.cancelled) await this.transfer(local);
    return additions.length;
  }

  async transfer(local) {
    local.busy = true; local.error = ''; if (this.remote) this.apply(this.remote);
    try {
      if (!local.reserved) {
        const snapshot = await this.request('/api/queue/items', json({ generation: local.generation, id: local.id, name: local.file.name, size: local.file.size }));
        local.reserved = true; this.apply(snapshot);
      }
      if (local.discard) { await this.request(`/api/queue/items/${local.id}`, { method: 'DELETE' }); return; }
      if (local.cancelled) { this.apply(await this.request(`/api/queue/items/${local.id}/cancel`, json({}))); return; }
      const form = new FormData(); form.append('audio', local.file);
      local.controller = new AbortController();
      this.apply(await this.request(`/api/queue/items/${local.id}/audio`, { method: 'PUT', body: form, signal: local.controller.signal }));
      this.uploads.delete(local.id);
    } catch (error) {
      if (!local.cancelled && !local.discard) local.error = error.message || 'Tải file chưa xong. Nhấn Thử lại.';
    } finally {
      local.busy = false; local.controller = null;
      if (this.remote) this.apply(this.remote);
    }
  }

  async replaceFile(id, file) {
    const item = this.items.find(entry => entry.id === id);
    if (!item || !item.needsUpload) return;
    const error = audioFileError(file);
    if (error) throw new Error(error);
    if (file.name !== item.name || file.size !== item.size) throw new Error(`Chọn đúng file “${item.name}” (${item.size} byte).`);
    if (terminal.has(item.remoteStatus)) this.apply(await this.request(`/api/queue/items/${id}/retry`, json({})));
    const local = { id, file, generation: this.generation, reserved: true, busy: true, cancelled: false, discard: false, error: '' };
    this.uploads.set(id, local); await this.transfer(local);
  }

  async retry(id) {
    const item = this.items.find(entry => entry.id === id); if (!item) return;
    const local = this.uploads.get(id);
    if (local?.invalid) return;
    if (terminal.has(item.remoteStatus)) this.apply(await this.request(`/api/queue/items/${id}/retry`, json({})));
    if (local) { local.cancelled = false; await this.transfer(local); }
  }
  async cancel(id) {
    const local = this.uploads.get(id);
    if (local) { local.cancelled = true; local.controller?.abort(); if (this.remote) this.apply(this.remote); }
    try { this.apply(await this.request(`/api/queue/items/${id}/cancel`, json({}))); }
    catch (error) { if (!local || error.status !== 404) throw error; }
  }
  async remove(id) {
    const local = this.uploads.get(id);
    if (local) { local.discard = true; local.controller?.abort(); this.uploads.delete(id); }
    try { this.apply(await this.request(`/api/queue/items/${id}`, { method: 'DELETE' })); }
    catch (error) { if (!local || error.status !== 404) throw error; }
    if (this.remote) this.apply(this.remote);
  }
  async clear() {
    this.clearRequested = true; this.changed();
    for (const local of this.uploads.values()) { local.discard = true; local.controller?.abort(); }
    this.uploads.clear();
    try { this.apply(await this.request('/api/queue', { method: 'DELETE' })); }
    finally { this.clearRequested = !!this.remote?.clearing; this.changed(); }
  }
  async start(options) {
    if (this.starting || this.running) return;
    this.starting = true; this.changed();
    try { this.apply(await this.request('/api/queue/start', json({ generation: this.generation, options: { kind: 'all', ...options } }))); }
    finally { this.starting = false; this.changed(); }
  }
}
