const MAX_BYTES = 1536 * 1024 * 1024;
const json = body => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const sizeText = bytes => bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${Math.max(.1, bytes / 1024 ** 2).toFixed(1)} MB`;
const dateText = value => { const date = new Date(value); return Number.isNaN(date.valueOf()) ? 'Chưa xác định' : date.toLocaleString('vi-VN'); };
const timeText = value => `${Math.floor(value / 60)} phút ${Math.floor(value % 60)} giây`;

export class BackupDialog {
  constructor({ dialog, request, getProject, savePending, getDemoSnapshot, onRestored, onExport, toast, isRecording = () => false }) {
    Object.assign(this, { dialog, request, getProject, savePending, getDemoSnapshot, onRestored, onExport, toast, isRecording });
    this.review = null; this.task = null; this.restoreResult = null;
    this.$ = selector => dialog.querySelector(selector);
    this.$('#backupCreateButton').onclick = () => void this.create();
    this.$('#backupChooseButton').onclick = () => this.$('#backupFileInput').click();
    this.$('#backupFileInput').onchange = event => { const file = event.target.files[0]; event.target.value = ''; if (file) void this.inspect(file); };
    this.$('#backupRestoreButton').onclick = () => void this.restore();
    this.$('#backupOpenExistingButton').onclick = () => void this.openExisting();
    this.$('#backupCancelButton').onclick = () => this.cancel();
    dialog.addEventListener('cancel', event => { if (this.task?.kind === 'restore') event.preventDefault(); });
    dialog.addEventListener('close', () => {
      if (this.task?.kind !== 'restore') this.task?.controller.abort();
      if (this.task?.kind !== 'restore') void this.discardReview();
    });
    this.render();
  }
  get busy() { return !!this.task; }
  open() {
    if (this.isRecording()) { this.toast('Hoàn tất thu âm và lưu bản thu trước khi sao lưu hoặc khôi phục.', 'info'); return; }
    this.render(); if (!this.dialog.open) this.dialog.showModal();
  }
  status(message, error = false) {
    this.$('#backupStatus').textContent = message; this.$('#backupStatus').classList.toggle('error', error);
  }
  render() {
    const project = this.getProject(), review = this.review, busy = this.busy;
    if (this.downloadProjectId !== project?.id) this.$('#backupDownloadLink').hidden = true;
    this.dialog.setAttribute('aria-busy', String(busy));
    this.$('#backupCurrentProject').textContent = project ? project.name : 'Mở dự án để tạo bản sao lưu.';
    this.$('#backupCreateButton').disabled = busy || !project;
    this.$('#backupChooseButton').disabled = busy;
    this.$('#backupCancelButton').hidden = !busy || this.task.kind === 'restore';
    this.$('[data-close-modal="backupModal"]').disabled = this.task?.kind === 'restore';
    this.$('#backupPreview').hidden = !review;
    this.$('#backupRestoreButton').hidden = !review || review.status === 'duplicate';
    this.$('#backupRestoreButton').disabled = busy;
    this.$('#backupOpenExistingButton').hidden = !review?.existing;
    this.$('#backupOpenExistingButton').disabled = busy;
    if (!review) return;
    const saved = review.project;
    this.$('#backupProjectName').textContent = saved.name;
    this.$('#backupPreviewMeta').textContent = `${saved.fileName} · ${timeText(saved.duration)} · ${sizeText(review.totalBytes)}`;
    this.$('#backupPreviewCounts').textContent = `${saved.transcriptCount} đoạn transcript · ${saved.speakerCount} người nói · ${saved.noteCount} ghi chú${saved.hasInsights ? ' · Có tóm tắt' : ''}${saved.hasClean ? ' · Có bản lọc ồn' : ''}`;
    this.$('#backupPreviewDate').textContent = `Ngày sao lưu: ${dateText(review.exportedAt)}`;
    this.$('#backupConflict').textContent = review.status === 'duplicate'
      ? review.reason === 'same' ? 'Dự án và âm thanh này đã có trên máy. Mở dự án hiện có để tiếp tục.' : 'Bản sao lưu này đã được khôi phục. Dự án trên máy có thể đã được chỉnh sửa thêm.'
      : review.status === 'conflict' ? `Dự án “${review.existing.name}” đã có nội dung khác. Khôi phục thành bản riêng sẽ giữ cả hai phiên bản.`
        : 'Sẵn sàng khôi phục đầy đủ âm thanh và nội dung vào thư viện.';
    this.$('#backupConflict').dataset.kind = review.status;
    this.$('#backupRestoreButton').textContent = this.restoreResult ? 'Mở dự án đã khôi phục' : review.status === 'conflict' ? 'Khôi phục thành bản riêng' : 'Khôi phục dự án';
  }
  async discardReview() {
    const review = this.review; this.review = null; this.restoreResult = null;
    if (review) await this.request(`/api/backups/${review.token}`, { method: 'DELETE' }).catch(() => {});
  }
  cancel() { if (this.task?.kind !== 'restore') this.task?.controller.abort(); }
  async create() {
    if (this.busy || !this.getProject()) return;
    const project = this.getProject(), task = { kind: 'create', controller: new AbortController() }; this.task = task;
    this.$('#backupDownloadLink').hidden = true; this.status('Đang lưu chỉnh sửa và chuẩn bị ZIP có đầy đủ âm thanh…'); this.render();
    try {
      await this.savePending(); if (task.controller.signal.aborted) return;
      const body = project.id === 'demo' ? { project: this.getDemoSnapshot(project) } : {};
      const file = await this.request(`/api/projects/${project.id}/backup`, { ...json(body), signal: task.controller.signal });
      if (task.controller.signal.aborted) return;
      this.downloadProjectId = project.id;
      const link = this.$('#backupDownloadLink'); link.href = file.url; link.download = file.filename; link.hidden = false; link.textContent = `↓ Tải ZIP sao lưu (${sizeText(file.bytes)})`;
      link.click(); this.onExport(file.filename, project.name);
      this.status('Đã chuẩn bị bản sao lưu và yêu cầu trình duyệt tải xuống. Liên kết tạm dùng trong 30 phút.');
    } catch (error) { this.status(error.name === 'AbortError' ? 'Đã huỷ tạo bản sao lưu.' : error.message, error.name !== 'AbortError'); }
    finally { if (this.task === task) this.task = null; this.render(); }
  }
  async inspect(file) {
    if (this.busy) return;
    if (!/\.zip$/i.test(file.name)) { this.status('Chọn ZIP sao lưu dự án có kèm âm thanh (.audiokit.zip).', true); return; }
    if (file.size > MAX_BYTES) { this.status('File sao lưu vượt quá 1,5 GB.', true); return; }
    const task = { kind: 'inspect', controller: new AbortController() }; this.task = task;
    await this.discardReview(); this.status(`Đang tải và kiểm tra “${file.name}” (${sizeText(file.size)})…`); this.render();
    try {
      const form = new FormData(); form.append('backup', file);
      const review = await this.request('/api/backups/inspect', { method: 'POST', body: form, signal: task.controller.signal });
      if (task.controller.signal.aborted) { await this.request(`/api/backups/${review.token}`, { method: 'DELETE' }).catch(() => {}); return; }
      this.review = review; this.status('Đã kiểm tra file và âm thanh. Xem thông tin bên dưới trước khi khôi phục.');
    } catch (error) { this.status(error.name === 'AbortError' ? 'Đã huỷ đọc bản sao lưu.' : error.message, error.name !== 'AbortError'); }
    finally { if (this.task === task) this.task = null; this.render(); }
  }
  async restore() {
    if (this.busy || !this.review) return;
    if (this.restoreResult) { try { await this.openRestored(); } catch(error) { this.status(error.message,true); } return; }
    const task = { kind: 'restore', controller: new AbortController() }; this.task = task;
    this.status('Đang khôi phục dự án vào thư viện…'); this.render();
    try {
      await this.savePending();
      const result = await this.request(`/api/backups/${this.review.token}/restore`, json({ mode: this.review.status === 'conflict' ? 'copy' : 'restore' }));
      if (result.status === 'conflict') { this.review = result.review; this.status('Dự án trên máy vừa thay đổi. Xem lại trước khi khôi phục thành bản riêng.'); return; }
      this.restoreResult = result.project; this.status(result.status === 'duplicate' ? 'Dự án đã có trên máy. Đang mở dự án hiện có…' : 'Đã khôi phục đầy đủ dự án.');
      await this.openRestored();
    } catch (error) { this.status(this.restoreResult ? `Dự án đã khôi phục, nhưng chưa mở được: ${error.message}. Nhấn Mở dự án đã khôi phục để thử lại.` : error.message, true); }
    finally { if (this.task === task) this.task = null; if(!this.dialog.open)await this.discardReview(); this.render(); }
  }
  async openRestored() {
    await this.onRestored(this.restoreResult.id); this.dialog.close(); this.toast('Đã mở dự án khôi phục.');
  }
  async openExisting() {
    if (!this.review?.existing || this.busy) return;
    try { await this.savePending(); await this.onRestored(this.review.existing.id); this.dialog.close(); }
    catch (error) { this.status(error.message, true); }
  }
}
