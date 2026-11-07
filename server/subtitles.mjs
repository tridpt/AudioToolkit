import { createHash, randomUUID } from 'node:crypto';
import { parseSubtitle, prepareImportedTranscript } from '../public/subtitles.js';
import { buildInsights } from '../public/insights.js';
import { editSchema, validateEdits } from './domain.mjs';

const failure = (status, message) => Object.assign(new Error(message), { status });
const fingerprint = project => createHash('sha256').update(JSON.stringify([project.transcript, project.speakers])).digest('hex');

export function applySubtitleImport(project, parsed) {
  const edits = editSchema.parse(prepareImportedTranscript(parsed, project));
  const next = { ...validateEdits(project, edits), words: [], turns: [], transcriptEdited: true,
    processed: { ...project.processed, transcript: true, speakers: false }, insights: null };
  // Labels in a subtitle file are editorial annotations, not a new diarization.
  // Clear stale word and turn alignment before the next speaker-processing job.
  if (next.transcript.some(line => /[\p{L}\p{N}]/u.test(line.text))) next.insights = buildInsights(next);
  delete next.queueCheckpoint;
  return next;
}

export class SubtitleStore {
  constructor({ now = Date.now, lifetime = 30 * 60 * 1000, maxSessions = 8, maxBytes = 50 * 1024 * 1024 } = {}) {
    Object.assign(this, { now, lifetime, maxSessions, maxBytes }); this.sessions = new Map();
  }
  cleanup() {
    for (const [token, session] of this.sessions) if (session.expiresAt <= this.now() && !session.importing) this.sessions.delete(token);
  }
  inspect(input, filename, project) {
    if (project.id === 'demo') throw failure(400, 'Hãy nhập file âm thanh hoặc tạo bản sao mẫu trước khi nhập transcript.');
    if (!/\.(srt|vtt)$/iu.test(filename)) throw failure(400, 'Chọn file có đuôi .srt hoặc .vtt.');
    const parsed = parseSubtitle(input, { duration: project.duration });
    const prepared = prepareImportedTranscript(parsed, project);
    editSchema.parse(prepared); validateEdits(project, prepared);
    const bytes = Buffer.byteLength(JSON.stringify(parsed));
    this.cleanup();
    let total = [...this.sessions.values()].reduce((sum, session) => sum + session.bytes, 0);
    while (this.sessions.size >= this.maxSessions || total + bytes > this.maxBytes) {
      const oldest = [...this.sessions].find(([, session]) => !session.importing);
      if (!oldest) throw failure(409, 'Đang nhập phụ đề. Đợi hoàn tất rồi chọn lại file.');
      total -= oldest[1].bytes; this.sessions.delete(oldest[0]);
    }
    const token = randomUUID(), expiresAt = this.now() + this.lifetime;
    this.sessions.set(token, { token, projectId: project.id, parsed, bytes, expiresAt, fingerprint: fingerprint(project), completed: false, importing: false });
    return { token, projectId: project.id, format: parsed.format, filename, cueCount: prepared.transcript.length,
      speakerNames: [...new Set(prepared.transcript.map(line => prepared.speakers.find(speaker => speaker.id === line.speaker).name))],
      firstTime: parsed.cues[0].start, lastTime: Math.max(...parsed.cues.map(cue => cue.end)), overlappingCueCount: parsed.overlappingCueCount,
      replacesTranscript: project.transcript.length > 0,
      transcriptPreview: prepared.transcript.slice(0, 6).map(line => ({ time: line.time, end: line.end, speaker: prepared.speakers.find(person => person.id === line.speaker).name, text: line.text })),
      expiresAt: new Date(expiresAt).toISOString() };
  }
  get(token, projectId) {
    const session = this.sessions.get(token);
    if (!session || session.expiresAt <= this.now() && !session.importing) {
      this.sessions.delete(token);
      throw failure(410, 'Phiên xem trước phụ đề đã hết hạn. Chọn lại file để tiếp tục.');
    }
    if (session.projectId !== projectId) throw failure(404, 'Không tìm thấy phiên nhập phụ đề của dự án này.');
    return session;
  }
  async commit(token, projectId, mutate) {
    const session = this.get(token, projectId);
    if (session.importing) throw failure(409, 'Đang nhập transcript này. Đợi hoàn tất.');
    session.importing = true;
    try {
      const project = await mutate(projectId, latest => {
        if (session.completed) return latest;
        if (fingerprint(latest) !== session.fingerprint) throw failure(409, 'Transcript hoặc người nói vừa thay đổi. Chọn lại file để xem trước nội dung mới nhất.');
        return applySubtitleImport(latest, session.parsed);
      });
      session.completed = true; session.parsed = null; session.bytes = 0;
      return project;
    } finally { session.importing = false; }
  }
  discard(token) { if (!this.sessions.get(token)?.importing) this.sessions.delete(token); }
  clear() { this.sessions.clear(); }
}
