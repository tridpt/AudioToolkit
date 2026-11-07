import { MAX_SUBTITLE_BYTES } from './subtitles.js';

const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[character]));
const formatTime = value => {
  const ms = Math.round(Math.max(0, Number(value) || 0) * 1000), hours = Math.floor(ms / 3600000);
  return `${hours ? `${String(hours).padStart(2, '0')}:` : ''}${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`;
};
const sizeText = bytes => bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(bytes > 10 * 1024 * 1024 ? 0 : 1)} MB`;

export class SubtitleDialog {
  constructor({ dialog, request, getProject, savePending, onImported, toast, isBusy = () => false }) {
    Object.assign(this, { dialog, request, getProject, savePending, onImported, toast, isBusy });
    this.review = null; this.task = null; this.importResult = null;
    this.$ = selector => dialog.querySelector(selector);
    this.$('#subtitleChooseButton').onclick = () => this.$('#subtitleFileInput').click();
    this.$('#subtitleFileInput').onchange = event => { const file = event.target.files[0]; event.target.value = ''; if (file) void this.inspect(file); };
    this.$('#subtitleImportButton').onclick = () => void this.import();
    this.$('#subtitleCancelButton').onclick = () => this.cancel();
    dialog.addEventListener('cancel', event => { if (this.task?.kind === 'import') event.preventDefault(); });
    dialog.addEventListener('close', () => {
      if (this.task?.kind !== 'import') this.task?.controller.abort();
      if (this.task?.kind !== 'import') void this.discardReview();
    });
    this.render();
  }
  get busy() { return !!this.task; }
  open() {
    const project = this.getProject();
    if (!project) { this.toast('Mở một dự án trước khi nhập transcript.', 'info'); return; }
    if (project.id === 'demo') { this.toast('Hãy nhập file âm thanh hoặc tạo bản sao mẫu trước khi nhập transcript.', 'info'); return; }
    if (this.isBusy()) { this.toast('Đợi tác vụ hiện tại hoàn tất trước khi nhập transcript.', 'info'); return; }
    if (!this.busy && !this.review) this.status('');
    this.render(); if (!this.dialog.open) this.dialog.showModal();
  }
  status(message, error = false) {
    const status = this.$('#subtitleStatus'); status.textContent = message; status.classList.toggle('error', error);
  }
  render() {
    const review = this.review, busy = this.busy, importing = this.task?.kind === 'import';
    this.dialog.setAttribute('aria-busy', String(busy));
    this.$('#subtitleChooseButton').disabled = busy;
    this.$('#subtitleCancelButton').disabled = importing;
    this.$('#subtitleImportButton').hidden = !review;
    this.$('#subtitleImportButton').disabled = busy || !review;
    this.$('#subtitleImportButton').textContent = this.importResult ? 'Mở transcript đã nhập' : 'Nhập transcript';
    this.$('#subtitleCancelButton').textContent = this.task?.kind === 'inspect' ? 'Huỷ đọc file' : 'Huỷ';
    this.$('[data-close-modal="subtitleModal"]').disabled = importing;
    this.$('#subtitlePreview').hidden = !review;
    if (!review) return;
    this.$('#subtitlePreviewFormat').textContent = review.format.toUpperCase();
    this.$('#subtitlePreviewFile').textContent = `${review.filename} · ${review.cueCount.toLocaleString('vi-VN')} đoạn`;
    this.$('#subtitlePreviewRange').textContent = `${formatTime(review.firstTime)} → ${formatTime(review.lastTime)}`;
    this.$('#subtitlePreviewSpeakers').textContent = review.speakerNames.length ? review.speakerNames.join(' · ') : 'Chưa có nhãn người nói';
    this.$('#subtitlePreviewWarning').textContent = (review.replacesTranscript
      ? 'Nhập sẽ thay toàn bộ transcript hiện tại. Ghi chú và âm thanh vẫn được giữ.'
      : 'Transcript hiện đang trống. Ghi chú và âm thanh vẫn được giữ.') + (review.overlappingCueCount ? ` Có ${review.overlappingCueCount} đoạn chồng thời gian; các mốc được giữ nguyên.` : '');
    this.$('#subtitlePreviewList').innerHTML = review.transcriptPreview.map(line => `<div class="subtitle-preview-line"><span>${escapeHtml(formatTime(line.time))}</span><strong>${escapeHtml(line.speaker || 'Chưa gán')}</strong><p>${escapeHtml(line.text)}</p></div>`).join('');
  }
  async discardReview() {
    const review = this.review; this.review = null; this.importResult = null;
    if (review) await this.request(`/api/subtitles/${review.token}`, { method: 'DELETE' }).catch(() => {});
  }
  cancel() {
    if (this.task?.kind === 'import') return;
    if (this.task) this.task.controller.abort(); else this.dialog.close();
  }
  async inspect(file) {
    if (this.busy) return;
    if (!/\.(?:srt|vtt)$/iu.test(file.name) || file.size > MAX_SUBTITLE_BYTES) {
      await this.discardReview(); this.render(); this.status(file.size > MAX_SUBTITLE_BYTES ? 'File phụ đề vượt quá 25 MB.' : 'Chọn file phụ đề có đuôi .srt hoặc .vtt.', true); return;
    }
    if (this.isBusy()) { this.status('Đợi tác vụ hiện tại hoàn tất trước khi nhập transcript.', true); return; }
    const task = { kind: 'inspect', controller: new AbortController() }; this.task = task;
    const projectId = this.getProject().id;
    await this.discardReview(); this.status(`Đang kiểm tra “${file.name}” (${sizeText(file.size)})…`); this.render();
    try {
      await this.savePending(); if (task.controller.signal.aborted) return;
      if (this.getProject().id !== projectId) throw new Error('Dự án đã thay đổi. Chọn lại file phụ đề.');
      const form = new FormData(); form.append('subtitle', file);
      const review = await this.request(`/api/projects/${projectId}/subtitles/inspect`, { method: 'POST', body: form, signal: task.controller.signal });
      if (task.controller.signal.aborted) { await this.request(`/api/subtitles/${review.token}`, { method: 'DELETE' }).catch(() => {}); return; }
      this.review = review; this.status('Đã kiểm tra file. Xem trước rồi bấm Nhập transcript để ghi vào dự án.');
    } catch (error) { this.status(error.name === 'AbortError' ? 'Đã huỷ đọc phụ đề.' : error.message, error.name !== 'AbortError'); }
    finally { if (this.task === task) this.task = null; this.render(); }
  }
  async import() {
    if (this.busy || !this.review) return;
    const project = this.getProject();
    if (!project || project.id === 'demo' || project.id !== this.review.projectId) { this.status('Dự án đã thay đổi. Chọn lại file phụ đề.', true); return; }
    if (!this.importResult && this.isBusy()) { this.status('Đợi tác vụ hiện tại hoàn tất trước khi nhập transcript.', true); return; }
    const task = { kind: 'import', controller: new AbortController() }; this.task = task;
    this.status('Đang nhập transcript và tạo lại tóm tắt…'); this.render();
    try {
      await this.savePending();
      if (task.controller.signal.aborted) return;
      const result = this.importResult || await this.request(`/api/projects/${project.id}/subtitles/${this.review.token}/import`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', signal: task.controller.signal });
      this.importResult = result;
      await this.onImported(result.id);
      await this.discardReview(); this.dialog.close(); this.toast(`Đã nhập ${result.transcript.length} đoạn transcript.`);
    } catch (error) { this.status(this.importResult ? `Transcript đã lưu nhưng chưa mở được: ${error.message}. Nhấn Mở transcript đã nhập để thử lại.` : error.message, true); }
    finally { if (this.task === task) this.task = null; this.render(); }
  }
}

