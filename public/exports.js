import { insightsAreCurrent } from './insights.js';

export function formatTimestamp(value) {
  const seconds = Math.floor(Math.max(0, Number(value) || 0));
  const hours = Math.floor(seconds / 3600);
  return (hours ? `${String(hours).padStart(2, '0')}:` : '') + `${String(Math.floor(seconds % 3600 / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
export function createExport(project, type) {
  if (!['txt', 'json', 'srt', 'vtt'].includes(type)) throw new Error('Định dạng xuất không hợp lệ.');
  const base = project.name.replace(/[<>:"/\\|?*]/g, '-').slice(0, 80) || 'audio-toolkit';
  const speaker = id => project.speakers.find(person => person.id === id)?.name || 'Chưa gán';
  const stamp = (value, vtt) => {
    const ms = Math.round(value * 1000);
    return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}${vtt ? '.' : ','}${String(ms % 1000).padStart(3, '0')}`;
  };
  let content, mime = 'text/plain;charset=utf-8';
  if (type === 'json') {
    const { audioUrl, cleanUrl, files, words, ...data } = project;
    content = JSON.stringify({ ...data, insights: project.insights ? { ...project.insights, stale: !insightsAreCurrent(project) } : null,
      schemaVersion: 2, exportedAt: new Date().toISOString() }, null, 2); mime = 'application/json';
  } else if (type === 'srt' || type === 'vtt') {
    if (!project.transcript.length) throw new Error('Chưa có transcript để xuất phụ đề.');
    const text = value => value.replace(/\r?\n+/g, ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    content = (type === 'vtt' ? 'WEBVTT\n\n' : '') + project.transcript.map((line, index) =>
      `${index + 1}\n${stamp(line.time, type === 'vtt')} --> ${stamp(line.end, type === 'vtt')}\n${text(speaker(line.speaker))}: ${text(line.text)}\n`).join('\n');
  } else {
    const sections = [project.name]; const insights = project.insights;
    if (insights) {
      sections.push(`TÓM TẮT${insightsAreCurrent(project) ? '' : ' — CHƯA CẬP NHẬT'}\nTrích xuất từ transcript, giữ ngôn ngữ bản thu.\n\n` +
        insights.summary.map(item => `[${formatTimestamp(item.time)}] ${item.text}`).join('\n\n'));
      sections.push('CHƯƠNG NỘI DUNG\n\n' + insights.chapters.map((item, index) => `${index + 1}. [${formatTimestamp(item.start)} – ${formatTimestamp(item.end)}] ${item.title}`).join('\n'));
      sections.push('Ý CHÍNH\n\n' + insights.highlights.map(item => `[${formatTimestamp(item.time)}] ${speaker(item.speaker)}: ${item.text}`).join('\n\n'));
    }
    sections.push('TRANSCRIPT\n\n' + project.transcript.map(line => `[${formatTimestamp(line.time)}] ${speaker(line.speaker)}: ${line.text}`).join('\n\n'));
    sections.push('GHI CHÚ\n\n' + project.notes.map(note => `[${formatTimestamp(note.time)}] ${note.text}`).join('\n'));
    content = '\uFEFF' + sections.join('\n\n') + '\n';
  }
  return { content, filename: `${base}.${type}`, mime };
}
