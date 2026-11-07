import { parseClipTime, formatClipTime, clipRangeError } from './clips.js';

export class ClipEditor {
  constructor({ getProject, mainAudio, toast, onExport }) {
    this.getProject = getProject;
    this.mainAudio = mainAudio;
    this.toast = toast;
    this.onExport = onExport;
    this.modal = document.querySelector('#clipModal');
    this.preview = document.querySelector('#clipAudioElement');
    this.fields = Object.fromEntries(['start', 'end', 'variant', 'format'].map(key => [key, document.querySelector(`#clip${key[0].toUpperCase()}${key.slice(1)}`)]));
    this.previewButton = document.querySelector('#clipPreviewButton');
    this.exportButton = document.querySelector('#clipExportButton');
    this.cancelButton = document.querySelector('#clipCancelExport');
    this.download = document.querySelector('#clipDownloadLink');
    this.frame = null;
    for (const [key, field] of Object.entries(this.fields)) field.addEventListener(key === 'start' || key === 'end' ? 'input' : 'change', () => {
      this.stopPreview();
      this.invalidateDownload();
      if (key === 'variant') this.setPreviewSource();
      const { start, end } = this.bounds();
      if (!clipRangeError(start, end, this.project.duration)) this.preview.currentTime = start;
      this.update();
    });
    this.previewButton.onclick = () => this.togglePreview();
    this.exportButton.onclick = () => this.export();
    this.cancelButton.onclick = () => this.controller?.abort();
    this.modal.addEventListener('close', () => {
      this.controller?.abort();
      this.stopPreview();
      this.preview.removeAttribute('src');
      this.preview.load();
    });
    this.preview.onplay = () => this.tick();
    this.preview.onpause = () => this.renderPreview();
    this.preview.ontimeupdate = () => this.checkPreviewEnd();
    this.preview.onended = () => this.stopPreview();
    this.preview.onerror = () => {
      if (this.modal.open && this.preview.hasAttribute('src')) {
        this.stopPreview();
        this.toast('Không tải được audio để nghe thử. Kiểm tra kết nối với máy chủ.', 'error');
      }
    };
  }

  open(range, useClean) {
    if (this.controller) return;
    this.project = this.getProject();
    this.fields.start.value = formatClipTime(range.start);
    this.fields.end.value = formatClipTime(range.end);
    this.fields.variant.querySelector('[value="clean"]').disabled = !this.project.processed.noise;
    this.fields.variant.value = useClean && this.project.processed.noise ? 'clean' : 'original';
    this.fields.format.value = 'mp3';
    document.querySelector('#clipProjectName').textContent = this.project.name;
    document.querySelector('#clipSourceDuration').textContent = formatClipTime(this.project.duration);
    this.invalidateDownload();
    this.setPreviewSource();
    this.mainAudio.pause();
    this.update();
    this.modal.showModal();
  }

  bounds() {
    return { start: parseClipTime(this.fields.start.value), end: parseClipTime(this.fields.end.value) };
  }

  invalidateDownload() {
    document.querySelector('#clipReady').hidden = true;
    this.download.removeAttribute('href');
    document.querySelector('#clipExportStatus').textContent = '';
  }

  update() {
    const { start, end } = this.bounds();
    const error = clipRangeError(start, end, this.project.duration);
    document.querySelector('#clipRangeError').textContent = error;
    for (const key of ['start', 'end']) this.fields[key].setAttribute('aria-invalid', String(!!error));
    document.querySelector('#clipDuration').textContent = error ? '—' : `${((end - start).toFixed(3)).replace(/\.?0+$/, '').replace('.', ',')} giây`;
    this.previewButton.disabled = !!error || !!this.controller;
    this.exportButton.disabled = !!error || !!this.controller;
    const lines = error ? [] : this.project.transcript.filter(line => line.time < end && line.end > start);
    document.querySelector('#clipPassageCount').textContent = `${lines.length} đoạn transcript trong khoảng cắt`;
    const text = lines.map(line => line.text).join(' ');
    document.querySelector('#clipExcerpt').textContent = text.length > 900 ? `${text.slice(0, 900)}…` : text || 'Khoảng cắt này không có lời trong transcript.';
    this.renderPreview();
  }

  setPreviewSource() {
    this.preview.src = this.fields.variant.value === 'clean' ? this.project.cleanUrl : this.project.audioUrl;
    this.preview.currentTime = this.bounds().start;
    this.preview.volume = this.mainAudio.volume;
    this.preview.muted = this.mainAudio.muted;
    this.preview.playbackRate = 1;
  }

  stopPreview() {
    this.preview.pause();
    cancelAnimationFrame(this.frame);
    this.frame = null;
    this.renderPreview();
  }

  async togglePreview() {
    if (!this.preview.paused) return this.stopPreview();
    const { start, end } = this.bounds();
    if (clipRangeError(start, end, this.project.duration)) return;
    this.mainAudio.pause();
    try {
      this.preview.currentTime = start;
      await this.preview.play();
      if (!this.modal.open) this.stopPreview();
    } catch (error) {
      if (this.modal.open && error.name !== 'AbortError') this.toast('Không phát được đoạn nghe thử. Thử lại sau khi audio tải xong.', 'error');
    }
  }

  checkPreviewEnd() {
    const { end } = this.bounds();
    if (!this.preview.paused && this.preview.currentTime >= end) {
      this.stopPreview();
      this.preview.currentTime = end;
    }
    this.renderPreview();
  }

  tick() {
    this.checkPreviewEnd();
    if (!this.preview.paused) this.frame = requestAnimationFrame(() => this.tick());
  }

  renderPreview() {
    const { start, end } = this.bounds();
    const elapsed = Math.max(0, Math.min(end - start, this.preview.currentTime - start));
    this.previewButton.textContent = this.preview.paused ? '▷ Nghe thử đoạn cắt' : 'Ⅱ Dừng nghe thử';
    document.querySelector('#clipPreviewTime').textContent = Number.isFinite(elapsed) ? formatClipTime(elapsed) : '00:00.000';
  }

  setExporting(busy) {
    for (const field of Object.values(this.fields)) field.disabled = busy;
    this.cancelButton.hidden = !busy;
    this.exportButton.textContent = busy ? 'Đang xuất clip…' : 'Xuất & tải clip';
    this.modal.setAttribute('aria-busy', String(busy));
    this.update();
  }

  async export() {
    if (this.controller) return;
    const { start, end } = this.bounds();
    if (clipRangeError(start, end, this.project.duration)) return;
    this.stopPreview();
    this.invalidateDownload();
    const controller = new AbortController();
    this.controller = controller;
    this.setExporting(true);
    document.querySelector('#clipExportStatus').textContent = 'Đang tạo file trên máy. Clip dài có thể cần thêm thời gian.';
    try {
      const response = await fetch(`/api/projects/${this.project.id}/clips`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ start, end, variant: this.fields.variant.value, format: this.fields.format.value }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Không xuất được clip.');
      if (!this.modal.open || controller.signal.aborted) return;
      this.download.href = result.url;
      this.download.download = result.filename;
      this.download.textContent = `Tải clip ${this.fields.format.value.toUpperCase()} · ${(result.size / 1024 / 1024).toFixed(2)} MB`;
      document.querySelector('#clipReady').hidden = false;
      document.querySelector('#clipExportStatus').textContent = 'Clip đã sẵn sàng. Nếu chưa tải xuống, nhấn liên kết bên dưới.';
      this.download.click();
      this.onExport(result.filename);
      this.toast('Đã tạo clip. File được tải vào thư mục Downloads.');
    } catch (error) {
      const message = error.name === 'AbortError' ? 'Đã huỷ xuất clip.' : error.message;
      if (this.modal.open) {
        document.querySelector('#clipExportStatus').textContent = message;
        if (error.name !== 'AbortError') this.toast(message, 'error');
      }
    } finally {
      if (this.controller === controller) this.controller = null;
      this.setExporting(false);
    }
  }
}
