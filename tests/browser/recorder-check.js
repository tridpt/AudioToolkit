import { AudioRecorder } from '/recorder.js';
import { RecordingDialog } from '/recording-dialog.js';

let context, oscillator, lastStream, requests = 0, uploadCalls = 0, savedProjects = 0, projectId = null;
const recorder = new AudioRecorder({ mediaDevices: {
  async getUserMedia() {
    requests++;
    if (document.querySelector('#fixtureMode').value === 'denied') throw { name: 'NotAllowedError' };
    context = new AudioContext();
    const destination = context.createMediaStreamDestination();
    oscillator = context.createOscillator(); oscillator.frequency.value = 440;
    const gain = context.createGain(); gain.gain.value = .1;
    oscillator.connect(gain); gain.connect(destination); oscillator.start();
    await context.resume();
    lastStream = destination.stream;
    return lastStream;
  },
} });
function update() {
  document.querySelector('#fixtureStatus').textContent = JSON.stringify({ phase: recorder.phase, duration: Number(recorder.duration.toFixed(3)), requests, uploadCalls, savedProjects, projectId,
    tracks: lastStream?.getTracks().map(track => track.readyState) || [], blobSize: recorder.blob?.size || 0, mimeType: recorder.blob?.type || '', unsaved: recorder.unsaved }, null, 2);
  if (lastStream && lastStream.getTracks().every(track => track.readyState === 'ended') && context?.state !== 'closed') {
    oscillator?.stop(); context?.close();
  }
}
const view = new RecordingDialog({ dialog: document.querySelector('#recordingModal'), recorder,
  upload: async file => {
    uploadCalls++; update();
    if (document.querySelector('#fixtureFailSave').checked) throw new Error('Lỗi lưu được giả lập để kiểm tra giữ bản thu.');
    const form = new FormData(); form.append('audio', file);
    const response = await fetch('/api/projects', { method: 'POST', body: form });
    const project = await response.json();
    if (!response.ok) throw new Error(project.error);
    projectId = project.id; savedProjects++; update();
    return project;
  },
  onSaved: async () => { if (document.querySelector('#fixtureFailOpen').checked) throw new Error('Lỗi mở được giả lập.'); update(); },
});
recorder.addEventListener('change', update);
document.querySelector('#fixtureOpen').onclick = () => view.open();
update();
