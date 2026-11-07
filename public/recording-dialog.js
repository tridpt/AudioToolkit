import { AudioRecorder, recordingFilename, RECORDING_MAX_BYTES } from './recorder.js';

const content = `
  <div class="modal-header"><div><p class="card-kicker">BẮT ĐẦU BẰNG GIỌNG NÓI</p><h2 id="recordingTitle">Một ý tưởng. Nhấn thu.</h2></div><button class="modal-close" id="recordingClose" aria-label="Đóng cửa sổ thu âm">×</button></div>
  <p class="modal-copy">Thu cuộc trò chuyện ngay tại đây. Nghe lại, đặt tên rồi lưu để xử lý.</p>
  <div class="recorder-stage" id="recordingStage" data-phase="idle">
    <div class="recorder-state"><span class="recorder-dot"></span><span id="recordingStatus" role="status">Sẵn sàng thu âm</span><span class="recorder-local">TRÊN MÁY CỦA BẠN</span></div>
    <div class="recorder-clock" id="recordingClock" role="timer" aria-label="Thời lượng đã thu" aria-live="off">00:00.0</div>
    <canvas id="recordingWaveform" height="66" aria-label="Tín hiệu âm thanh từ micro"></canvas>
    <span class="recorder-meter-label" id="recordingMeterLabel">Micro chỉ mở khi bạn nhấn bắt đầu.</span>
  </div>
  <p class="recording-message error" id="recordingError" role="alert" hidden></p>
  <p class="recording-message" id="recordingNotice" role="status" hidden></p>
  <div class="recording-controls">
    <button class="button record-start" id="recordingStart"><span aria-hidden="true">●</span> Bắt đầu thu</button>
    <button class="button secondary" id="recordingPause" hidden>Tạm dừng</button>
    <button class="button secondary" id="recordingResume" hidden>Tiếp tục thu</button>
    <button class="button record-stop" id="recordingStop" hidden><span aria-hidden="true">■</span> Dừng & nghe lại</button>
    <button class="button secondary" id="recordingCancelRequest" hidden>Huỷ mở micro</button>
  </div>
  <section class="recording-review" id="recordingReview" aria-label="Nghe lại và lưu bản thu" hidden>
    <div class="recording-review-heading"><strong>Nghe lại bản thu</strong><span id="recordingSize"></span></div>
    <audio id="recordingPreview" controls preload="metadata" aria-label="Nghe lại bản thu vừa tạo"></audio>
    <label class="field-label" for="recordingName">Tên bản thu</label><input class="modal-input" id="recordingName" type="text" maxlength="140" autocomplete="off" />
    <div class="recording-review-actions"><a id="recordingDownload" download>Tải file dự phòng ↓</a><button id="recordingRetake">Thu bản mới</button></div>
    <div class="recording-discard" id="recordingDiscard" hidden><p>Bản này chưa lưu vào dự án. Tải file trước nếu bạn muốn giữ lại.</p><div><button class="button secondary" id="recordingKeep">Giữ bản này</button><button class="button secondary" id="recordingConfirmRetake">Bỏ bản này, thu lại</button></div></div>
  </section>
  <p class="recording-footnote" id="recordingHelp">Cho phép dùng micro khi trình duyệt hỏi. Tối đa 2 giờ / 250 MB. Thời gian tạm dừng được bỏ qua.</p>
  <p class="recording-save-status" id="recordingSaveStatus" role="status"></p>
  <div class="modal-footer"><button class="button secondary" id="recordingBack">Đóng</button><button class="button primary" id="recordingSave" hidden>Lưu thành dự án</button></div>`;

function clock(seconds) {
  const tenths = Math.floor(Math.max(0, seconds) * 10);
  const hours = Math.floor(tenths / 36000);
  return `${hours ? `${String(hours).padStart(2, '0')}:` : ''}${String(Math.floor(tenths / 600) % 60).padStart(2, '0')}:${String(Math.floor(tenths / 10) % 60).padStart(2, '0')}.${tenths % 10}`;
}

export class RecordingDialog {
  constructor({ dialog, upload, onSaved, mainAudio, toast, recorder = new AudioRecorder(), AudioContext = globalThis.AudioContext || globalThis.webkitAudioContext }) {
    Object.assign(this, { dialog, upload, onSaved, mainAudio, toast, recorder, AudioContext });
    dialog.innerHTML = content;
    this.$ = selector => dialog.querySelector(selector);
    this.preview = this.$('#recordingPreview');
    this.preview.onloadedmetadata = () => {
      // Streaming WebM has no duration header. A seek past the buffered end
      // makes Chromium discover it, then return to the start for review.
      if (!Number.isFinite(this.preview.duration)) {
        this.probingDuration = true;
        this.preview.currentTime = Math.max(86400, this.recorder.duration + 1);
        this.probeTimer = setTimeout(() => this.finishDurationProbe(), 3000);
      }
    };
    this.preview.ondurationchange = () => { if (this.probingDuration && Number.isFinite(this.preview.duration)) this.finishDurationProbe(); };
    this.preview.onseeked = () => { if (this.probingDuration) this.finishDurationProbe(); };
    this.canvas = this.$('#recordingWaveform');
    this.$('#recordingStart').onclick = () => { this.mainAudio?.pause(); this.recorder.start(); };
    this.$('#recordingPause').onclick = () => this.recorder.pause();
    this.$('#recordingResume').onclick = () => this.recorder.resume();
    this.$('#recordingStop').onclick = () => this.recorder.stop();
    this.$('#recordingCancelRequest').onclick = () => this.recorder.cancelRequest();
    for (const id of ['recordingClose', 'recordingBack']) this.$(`#${id}`).onclick = () => dialog.close();
    this.$('#recordingSave').onclick = () => this.save();
    this.$('#recordingName').oninput = () => this.updateDownloadName();
    this.$('#recordingRetake').onclick = () => {
      if (this.saving) return;
      if (recorder.saved) this.retake();
      else { this.$('#recordingDiscard').hidden = false; this.$('#recordingKeep').focus(); }
    };
    this.$('#recordingKeep').onclick = () => { this.$('#recordingDiscard').hidden = true; this.$('#recordingRetake').focus(); };
    this.$('#recordingConfirmRetake').onclick = () => this.retake();
    dialog.addEventListener('cancel', event => { if (this.saving) event.preventDefault(); });
    dialog.addEventListener('close', () => {
      recorder.stop(); this.preview.pause(); this.stopMeter();
      if (recorder.unsaved) this.toast?.('Bản thu đang giữ trong phiên này. Mở Thu âm để nghe lại và lưu.', 'info');
    });
    recorder.addEventListener('change', () => this.render());
    this.unload = event => { if (recorder.unsaved || this.saving) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', this.unload);
    window.addEventListener('pagehide', () => { recorder.stop(); this.stopMeter(); });
    this.render();
  }

  open() {
    this.mainAudio?.pause(); this.render(); this.dialog.showModal(); this.drawMeter();
  }

  retake() {
    if (this.saving) return;
    this.savedProject = null;
    this.$('#recordingDiscard').hidden = true;
    this.$('#recordingSaveStatus').textContent = '';
    this.$('#recordingName').value = '';
    this.recorder.reset();
    this.$('#recordingStart').focus();
  }

  render() {
    const { phase, error, notice, blob, saved } = this.recorder;
    const states = { idle: 'Sẵn sàng thu âm', requesting: 'Đang chờ quyền micro…', recording: 'Đang thu âm', paused: 'Đã tạm dừng', stopping: 'Đang hoàn tất bản thu…', ready: saved ? 'Đã lưu thành dự án' : 'Bản thu đã sẵn sàng' };
    this.$('#recordingStage').dataset.phase = phase;
    this.$('#recordingStatus').textContent = states[phase];
    this.$('#recordingClock').textContent = clock(this.recorder.duration);
    for (const [id, visible] of Object.entries({ recordingStart: phase === 'idle', recordingCancelRequest: phase === 'requesting', recordingPause: phase === 'recording', recordingResume: phase === 'paused', recordingStop: ['recording', 'paused'].includes(phase), recordingReview: !!blob, recordingSave: !!blob })) this.$(`#${id}`).hidden = !visible;
    this.$('#recordingError').hidden = !error; this.$('#recordingError').textContent = error;
    this.$('#recordingNotice').hidden = !notice; this.$('#recordingNotice').textContent = notice;
    const saveButton = this.$('#recordingSave');
    saveButton.disabled = !!this.saving || !blob || this.recorder.duration < 1 || blob.size > RECORDING_MAX_BYTES;
    saveButton.textContent = this.saving ? 'Đang lưu…' : saved ? 'Mở dự án đã lưu' : 'Lưu thành dự án';
    for (const id of ['recordingRetake', 'recordingName', 'recordingClose', 'recordingBack']) this.$(`#${id}`).disabled = !!this.saving;
    this.dialog.setAttribute('aria-busy', String(!!this.saving));
    this.$('#recordingHelp').textContent = blob ? saved ? 'Bản thu đã lưu trên máy. Có thể mở lại từ thư viện dự án.' : this.recorder.duration < 1 ? 'Bản thu quá ngắn. Thu ít nhất 1 giây để lưu thành dự án; vẫn có thể tải file dự phòng.' : 'Bản này đang giữ trong trình duyệt. Lưu dự án hoặc tải file trước khi tải lại hay đóng trang.' : phase === 'paused' ? 'Micro vẫn mở để tiếp tục thu. Nhấn Dừng & nghe lại để tắt micro.' : 'Cho phép dùng micro khi trình duyệt hỏi. Tối đa 2 giờ / 250 MB. Thời gian tạm dừng được bỏ qua.';
    if (blob !== this.currentBlob) {
      this.preview.pause();
      this.probingDuration = false; clearTimeout(this.probeTimer);
      if (this.url) URL.revokeObjectURL(this.url);
      this.currentBlob = blob;
      this.url = blob ? URL.createObjectURL(blob) : null;
      if (blob) {
        this.preview.src = this.url;
        this.$('#recordingDownload').href = this.url;
        const now = new Date();
        if (!this.$('#recordingName').value) this.$('#recordingName').value = `Bản thu ${now.toLocaleDateString('vi-VN').replaceAll('/', '-')} ${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}`;
        this.$('#recordingSize').textContent = `${(blob.size / 1024 / 1024).toFixed(2)} MB`;
        this.updateDownloadName();
      } else { this.preview.removeAttribute('src'); this.preview.load(); this.$('#recordingDownload').removeAttribute('href'); }
    }
    if (['recording', 'paused'].includes(phase) && this.recorder.stream && this.dialog.open) this.startMeter();
    else this.stopMeter();
    this.drawMeter();
  }

  updateDownloadName() {
    if (this.recorder.blob) this.$('#recordingDownload').download = recordingFilename(this.$('#recordingName').value, this.recorder.blob.type);
  }

  finishDurationProbe() {
    this.probingDuration = false; clearTimeout(this.probeTimer);
    if (this.preview.hasAttribute('src')) this.preview.currentTime = 0;
  }

  startMeter() {
    if (this.meter || !this.AudioContext) return;
    let context;
    try {
      context = new this.AudioContext();
      const source = context.createMediaStreamSource(this.recorder.stream);
      const analyser = context.createAnalyser(); analyser.fftSize = 256;
      source.connect(analyser);
      this.meter = { context, source, analyser, buffer: new Uint8Array(analyser.fftSize) };
      context.resume().catch(() => {});
      this.animateMeter();
    } catch { if (context && context.state !== 'closed') context.close().catch(() => {}); this.stopMeter(); }
  }

  stopMeter() {
    cancelAnimationFrame(this.frame); this.frame = null;
    if (this.meter) {
      this.meter.source.disconnect();
      this.meter.context.close().catch(() => {}); this.meter = null;
    }
  }

  animateMeter() {
    this.drawMeter();
    if (this.meter && this.dialog.open) this.frame = requestAnimationFrame(() => this.animateMeter());
  }

  drawMeter() {
    const width = this.canvas.clientWidth, height = 66;
    if (!width) return;
    const ratio = devicePixelRatio || 1;
    if (this.canvas.width !== Math.round(width * ratio)) { this.canvas.width = Math.round(width * ratio); this.canvas.height = height * ratio; }
    const ctx = this.canvas.getContext('2d'); if (!ctx) return;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.clearRect(0, 0, width, height);
    ctx.strokeStyle = this.recorder.phase === 'recording' ? '#db9ba7' : '#5d5a78'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    const active = this.meter && this.recorder.phase === 'recording';
    if (active) this.meter.analyser.getByteTimeDomainData(this.meter.buffer);
    for (let index = 0; index < 128; index++) {
      const y = height / 2 + (active ? (this.meter.buffer[index * 2] - 128) / 128 * (height / 2 - 3) : 0);
      if (!index) ctx.moveTo(6, y); else ctx.lineTo(6 + index / 127 * (width - 12), y);
    }
    ctx.stroke();
    this.$('#recordingMeterLabel').textContent = this.recorder.phase === 'recording' ? 'Đang nhận âm thanh từ micro' : this.recorder.phase === 'paused' ? 'Đã tạm dừng · không ghi thêm âm thanh' : this.recorder.blob ? 'Micro đã tắt · sẵn sàng nghe lại' : 'Micro chỉ mở khi bạn nhấn bắt đầu.';
  }

  async save() {
    if (this.saving || !this.recorder.blob || this.recorder.duration < 1 || this.recorder.blob.size > RECORDING_MAX_BYTES) return;
    this.saving = true; this.preview.pause(); this.render();
    const status = this.$('#recordingSaveStatus');
    status.textContent = this.savedProject ? 'Đang mở dự án đã lưu…' : 'Đang lưu và chuẩn bị dạng sóng. Bản thu dài có thể cần thêm thời gian…';
    try {
      if (!this.savedProject) {
        const file = new File([this.recorder.blob], recordingFilename(this.$('#recordingName').value, this.recorder.blob.type), { type: this.recorder.blob.type });
        this.savedProject = await this.upload(file);
        this.recorder.saved = true;
      }
      await this.onSaved(this.savedProject);
      status.textContent = 'Đã lưu bản thu thành dự án.';
      this.toast?.('Đã lưu bản thu. Bạn có thể lọc ồn và tạo transcript.', 'success');
      this.dialog.close();
    } catch (error) {
      status.textContent = this.savedProject ? 'Dự án đã lưu nhưng chưa mở được. Nhấn Mở dự án đã lưu để thử lại.' : `Chưa lưu được: ${error.message} Bản thu vẫn được giữ; có thể thử lại hoặc tải file dự phòng.`;
    } finally { this.saving = false; this.render(); }
  }
}
