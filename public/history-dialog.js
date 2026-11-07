const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
const reasons = { manual: 'Đã lưu thủ công', edit: 'Trước khi chỉnh sửa', transcript: 'Trước khi tạo lại transcript', speakers: 'Trước khi tách người nói', subtitles: 'Trước khi nhập phụ đề', restore: 'Trước khi khôi phục' };
const dateText = value => new Date(value).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' });
const timeText = value => {
  const ms = Math.round(Math.max(0, Number(value) || 0) * 1000), hours = Math.floor(ms / 3600000);
  return `${hours ? `${String(hours).padStart(2, '0')}:` : ''}${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
};
const PAGE_SIZE = 100;

export class HistoryDialog {
  constructor({ dialog, request, getProject, savePending, onRestored, toast, isBusy = () => false }) {
    Object.assign(this, { dialog, request, getProject, savePending, onRestored, toast, isBusy });
    this.$ = selector => dialog.querySelector(selector);
    this.versions = []; this.preview = null; this.task = null; this.projectId = null;
    this.selectedId = null; this.restoredId = null; this.query = ''; this.page = 0; this.stale = false;
    this.$('#historySaveButton').onclick = () => void this.saveVersion();
    this.$('#historyReloadButton').onclick = () => void this.load();
    this.$('#historyRestoreButton').onclick = () => void this.restore();
    this.$('#historyVersionList').onclick = event => { const button = event.target.closest('[data-history-version]'); if (button) void this.select(button.dataset.historyVersion); };
    this.$('#historySearch').oninput = event => { this.query = event.target.value; this.page = 0; this.renderLines(); };
    this.$('#historyPrevious').onclick = () => { this.page--; this.renderLines(); };
    this.$('#historyNext').onclick = () => { this.page++; this.renderLines(); };
    dialog.addEventListener('cancel', event => { if (this.writing) event.preventDefault(); });
    dialog.addEventListener('close', () => { if (!this.writing) this.task?.controller.abort(); });
    this.render();
  }
  get busy() { return !!this.task; }
  get writing() { return this.task?.kind === 'save' || this.task?.kind === 'restore'; }
  open() {
    const project = this.getProject();
    if (!project || project.id === 'demo') { this.toast('Nhập bản thu hoặc tạo bản sao mẫu để dùng lịch sử phiên bản.', 'info'); return; }
    if (this.busy) return;
    if (this.projectId !== project.id) { this.versions = []; this.preview = null; this.selectedId = null; this.restoredId = null; }
    this.projectId = project.id; this.$('#historyProjectName').textContent = project.name;
    if (!this.dialog.open) this.dialog.showModal(); void this.load();
  }
  status(message, error = false) {
    const element = this.$('#historyStatus'); element.textContent = message; element.classList.toggle('error', error);
  }
  start(kind, message) {
    const task = { kind, controller: new AbortController() }; this.task = task;
    this.status(message); this.render(); return task;
  }
  finish(task) { if (this.task === task) this.task = null; this.render(); }
  assertProject() { if (this.getProject()?.id !== this.projectId) throw new Error('Dự án đã thay đổi. Mở lại lịch sử của dự án hiện tại.'); }
  async read(task, list) {
    const result = list || await this.request(`/api/projects/${this.projectId}/history`, { signal: task.controller.signal });
    if (task.controller.signal.aborted) return;
    this.versions = result.versions;
    this.selectedId = this.versions.some(item => item.id === this.selectedId) ? this.selectedId : this.versions[0]?.id;
    this.preview = null; this.stale = false; this.query = ''; this.page = 0;
    this.$('#historySearch').value = '';
    if (this.selectedId) this.preview = await this.request(`/api/projects/${this.projectId}/history/${this.selectedId}`, { signal: task.controller.signal });
  }
  async load() {
    if (this.busy) return;
    const task = this.start('read', 'Đang tải lịch sử phiên bản…');
    try {
      await this.savePending(); if (task.controller.signal.aborted) return; this.assertProject();
      await this.read(task);
      if (!task.controller.signal.aborted) this.status(this.restoredId ? 'Phiên bản đã khôi phục. Nhấn Mở phiên bản đã khôi phục để tải lại dự án.' : '');
    } catch (error) { if (error.name !== 'AbortError') this.status(error.message, true); }
    finally { this.finish(task); }
  }
  async select(id) {
    if (this.busy || id === this.selectedId && this.preview) return;
    this.selectedId = id; this.preview = null; this.stale = false; this.query = ''; this.page = 0;
    this.$('#historySearch').value = '';
    const task = this.start('read', 'Đang mở phiên bản…');
    try {
      this.assertProject();
      this.preview = await this.request(`/api/projects/${this.projectId}/history/${id}`, { signal: task.controller.signal });
      this.status('');
    } catch (error) { if (error.name !== 'AbortError') this.status(error.message, true); }
    finally { this.finish(task); }
  }
  writable() {
    this.assertProject();
    if (this.isBusy()) throw new Error('Đợi tác vụ hiện tại hoàn tất rồi tải lại lịch sử để lưu hoặc khôi phục.');
  }
  async saveVersion() {
    if (this.busy) return;
    const task = this.start('save', 'Đang lưu phiên bản hiện tại…'); let saved = false;
    try {
      this.writable(); await this.savePending(); this.assertProject();
      const result = await this.request(`/api/projects/${this.projectId}/history`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      saved = true; this.selectedId = result.versions[0]?.id;
      await this.read(task, result); this.status('Đã lưu phiên bản hiện tại. Nội dung trùng sẽ dùng lại phiên bản gần nhất.');
    } catch (error) { this.status(saved ? `Đã lưu phiên bản. Chưa tải được xem trước: ${error.message}` : error.message, true); }
    finally { this.finish(task); }
  }
  async restore() {
    if (this.busy || !this.restoredId && (!this.preview || this.preview.version.isCurrent || this.stale)) return;
    const task = this.start('restore', this.restoredId ? 'Đang mở dự án đã khôi phục…' : 'Đang lưu bản hiện tại và khôi phục phiên bản…');
    try {
      this.assertProject();
      if (!this.restoredId) {
        this.writable(); await this.savePending(); this.assertProject();
        const result = await this.request(`/api/projects/${this.projectId}/history/${this.selectedId}/restore`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedFingerprint: this.preview.currentFingerprint }) });
        this.restoredId = result.id;
      }
      await this.onRestored(this.restoredId);
      this.restoredId = null; this.dialog.close(); this.toast('Đã khôi phục transcript và người nói. Ghi chú và âm thanh được giữ nguyên.');
    } catch (error) {
      if (error.status === 409 && !this.restoredId) this.stale = true;
      this.status(this.restoredId ? `Đã khôi phục nhưng chưa mở được dự án: ${error.message}. Nhấn Mở phiên bản đã khôi phục để thử lại.` : error.message, true);
    } finally { this.finish(task); }
  }
  render() {
    const busy = this.busy, blocked = this.isBusy(), preview = this.preview;
    this.dialog.setAttribute('aria-busy', String(busy));
    this.$('#historySaveButton').disabled = busy || blocked || !!this.restoredId;
    this.$('#historyReloadButton').disabled = busy;
    this.$('#historyRestoreButton').disabled = busy || !this.restoredId && (blocked || !preview || preview.version.isCurrent || this.stale);
    this.$('#historyRestoreButton').textContent = this.restoredId ? 'Mở phiên bản đã khôi phục' : 'Khôi phục phiên bản';
    this.$('#historyCloseButton').disabled = this.writing;
    this.$('[data-close-modal="historyModal"]').disabled = this.writing;
    this.$('#historyEmpty').hidden = this.versions.length > 0 || busy;
    this.$('#historyLayout').hidden = !this.versions.length;
    this.$('#historyVersionList').innerHTML = this.versions.map(version => `<button class="history-version${version.id === this.selectedId ? ' selected' : ''}" data-history-version="${escapeHtml(version.id)}" aria-pressed="${version.id === this.selectedId}"${busy ? ' disabled' : ''}><strong>${escapeHtml(reasons[version.reason] || version.reason)}</strong><time datetime="${escapeHtml(version.createdAt)}">${escapeHtml(dateText(version.createdAt))}</time><span>${version.transcriptCount.toLocaleString('vi-VN')} đoạn · ${escapeHtml(version.speakerNames.join(', ') || 'Chưa có người nói')}</span>${(version.id === this.selectedId && preview ? preview.version.isCurrent : version.isCurrent) ? '<small>Giống bản hiện tại</small>' : ''}</button>`).join('');
    this.$('#historyPreview').hidden = !preview;
    if (!preview) return;
    this.$('#historyPreviewTitle').textContent = reasons[preview.version.reason] || 'Phiên bản đã lưu';
    this.$('#historyPreviewDate').textContent = dateText(preview.version.createdAt);
    this.$('#historyPreviewSpeakers').textContent = preview.speakers.map(person => person.name).join(' · ') || 'Chưa có người nói';
    const changes = preview.comparison;
    this.$('#historyComparison').textContent = preview.version.isCurrent ? 'Nội dung giống bản đang mở.'
      : `Khi khôi phục: thêm ${changes.added} đoạn, bỏ ${changes.removed} đoạn, thay đổi ${changes.changed} đoạn và ${changes.speakersChanged} người nói.`;
    this.renderLines();
  }
  renderLines() {
    if (!this.preview) return;
    const speakers = new Map(this.preview.speakers.map(person => [person.id, person.name]));
    const query = this.query.trim().toLocaleLowerCase('vi-VN');
    const lines = this.preview.transcript.filter(line => !query || `${line.text} ${speakers.get(line.speaker) || ''}`.toLocaleLowerCase('vi-VN').includes(query));
    const pages = Math.max(1, Math.ceil(lines.length / PAGE_SIZE)); this.page = Math.max(0, Math.min(pages - 1, this.page));
    this.$('#historyPreviewList').innerHTML = lines.slice(this.page * PAGE_SIZE, (this.page + 1) * PAGE_SIZE).map(line => `<div class="history-line"><time>${escapeHtml(timeText(line.time))} → ${escapeHtml(timeText(line.end))}</time><strong>${escapeHtml(speakers.get(line.speaker) || 'Chưa gán')}</strong><p>${escapeHtml(line.text)}</p></div>`).join('') || `<p class="history-no-lines">${query ? 'Không có đoạn khớp từ khoá.' : 'Transcript của phiên bản này đang trống.'}</p>`;
    this.$('#historyPageState').textContent = `${lines.length.toLocaleString('vi-VN')} đoạn · Trang ${this.page + 1}/${pages}`;
    this.$('#historyPrevious').disabled = this.page === 0; this.$('#historyNext').disabled = this.page + 1 >= pages;
    this.$('#historyPreviewList').scrollTop = 0;
  }
}
