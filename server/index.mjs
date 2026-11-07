import express from 'express';
import multer from 'multer';
import { z } from 'zod';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ffmpeg from 'ffmpeg-static';
import ffprobe from '@ffprobe-installer/ffprobe';
import { idSchema, editSchema, optionsSchema, validateEdits, validateClip, publicProject, uploadedFilename } from './domain.mjs';
import { buildInsights, transcriptFingerprint } from '../public/insights.js';
import { clipFilename } from '../public/clips.js';
import { createReport, reportRequestSchema, reportProjectSchema } from './report.mjs';
import { createBatchArchive, batchExportRequestSchema } from './batch.mjs';
import { stopProcess } from './process.mjs';
import { DurableQueue, atomicQueueWrite } from './queue.mjs';
import { BackupStore, createBackup, MAX_BACKUP_BYTES } from './backup.mjs';
import { MAX_SUBTITLE_BYTES } from '../public/subtitles.js';
import { SubtitleStore } from './subtitles.mjs';
import { withHistory, listHistory, previewHistory, restoreHistory } from './history.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = path.resolve(process.env.AUDIO_DATA_DIR || path.join(root, 'data'));
const projectsDir = path.join(data, 'projects');
const mediaDir = path.join(data, 'media');
const tempDir = path.join(data, 'tmp');
const clipDir = path.join(tempDir, 'clips');
await Promise.all([projectsDir, mediaDir, tempDir, clipDir].map(directory => fs.mkdir(directory, { recursive: true })));
const port = Number(process.env.PORT || 4188);
const python = process.env.AUDIO_PYTHON || path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  if (!['localhost', '127.0.0.1', '[::1]'].includes(req.hostname)) return res.status(403).json({ error: 'Chỉ truy cập từ máy này.' });
  const origins = [`http://localhost:${port}`, `http://127.0.0.1:${port}`];
  if (req.headers.origin && !origins.includes(req.headers.origin)) return res.status(403).json({ error: 'Hãy mở Audio Toolkit tại địa chỉ localhost.' });
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'");
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use(express.json({ limit: '16mb' }));
app.use('/fonts', express.static(path.join(root, 'node_modules', '@fontsource', 'be-vietnam-pro', 'files'), { fallthrough: false }));

const mutations = new Map();
const jobs = new Map();
let activeJob = null;
let activeClip = null;
let activeImport = null;
let queue;
let shuttingDown = false;
const clips = new Map();
const backupLocks = new Set();
const backupDownloads = new Map();
const subtitles = new SubtitleStore();
const clipLifetime = 30 * 60 * 1000;
async function cleanExpiredClips() {
  // This directory contains only disposable, server-generated clip files.
  for (const file of await fs.readdir(clipDir)) {
    if (!/^[0-9a-f-]{36}\.(mp3|wav)$/.test(file)) continue;
    const target = path.join(clipDir, file);
    try {
      const stat = await fs.stat(target);
      if (Date.now() - stat.mtimeMs < clipLifetime || activeClip?.file === target) continue;
      await fs.unlink(target);
      clips.delete(path.parse(file).name);
    } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'EBUSY' && error.code !== 'EPERM') console.error(error.message); }
  }
}
await cleanExpiredClips();
const clipCleanup = setInterval(() => void cleanExpiredClips().catch(error => console.error(error.message)), 60000);
clipCleanup.unref();
const httpError = (status, message) => Object.assign(new Error(message), { status });
async function loadProject(id) {
  idSchema.parse(id);
  const file = id === 'demo' ? path.join(root, 'public/demo/project.json') : path.join(projectsDir, `${id}.json`);
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') throw httpError(404, 'Không tìm thấy dự án.'); throw error; }
}
async function persist(project) {
  if (project.id === 'demo') return project;
  const target = path.join(projectsDir, `${project.id}.json`);
  await atomicQueueWrite(target, project);
  return project;
}
async function mutate(id, operation, historyOptions = {}) {
  if (id === 'demo') throw httpError(400, 'Nhập bản thu của bạn để lưu dự án riêng.');
  const previous = mutations.get(id) || Promise.resolve();
  const result = previous.catch(() => {}).then(async () => {
    const latest = await loadProject(id);
    const next = withHistory(latest, await operation(latest), historyOptions);
    if (next === latest) return latest;
    next.updatedAt = new Date().toISOString();
    return persist(next);
  });
  mutations.set(id, result);
  try { return await result; }
  finally { if (mutations.get(id) === result) mutations.delete(id); }
}
function run(command, args, { timeout = 120000, job, binary = false } = {}) {
  return new Promise((resolve, reject) => {
    if (job?.cancelled) return reject(httpError(400, 'Đã huỷ tác vụ.'));
    const child = spawn(command, args, { cwd: root, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', HF_HUB_DISABLE_SYMLINKS_WARNING: '1' } });
    if (job) job.child = child;
    const output = []; let stderr = ''; let size = 0;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; void stopProcess(child); }, timeout);
    child.stdout.on('data', chunk => { size += chunk.length; if (size < 24 * 1024 * 1024) output.push(chunk); });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-2500); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (job?.cancelled) return reject(httpError(400, 'Đã huỷ tác vụ.'));
      if (timedOut) return reject(httpError(504, 'Tác vụ quá thời gian chờ.'));
      if (code !== 0) return reject(new Error(stderr || 'Không thể xử lý file này.'));
      const buffer = Buffer.concat(output);
      resolve(binary ? buffer : buffer.toString('utf8'));
    });
  });
}
async function worker(payload, job) {
  if (job?.cancelled) throw httpError(400, 'Đã huỷ tác vụ.');
  if (!existsSync(python)) throw httpError(503, 'Thiếu môi trường AI. Chạy npm run setup:ai rồi thử lại.');
  const input = path.join(tempDir, `${randomUUID()}.json`);
  await fs.writeFile(input, JSON.stringify(payload));
  try {
    return await new Promise((resolve, reject) => {
      if (job?.cancelled) return reject(httpError(400, 'Đã huỷ tác vụ.'));
      const child = spawn(python, [path.join(root, 'server/worker.py'), '--input', input, '--data', data], {
        cwd: root, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', HF_HUB_DISABLE_SYMLINKS_WARNING: '1' },
      });
      if (job) job.child = child;
      let result; let failure; let stderr = '';
      const timer = setTimeout(() => { failure = 'Tác vụ quá 90 phút. Thử model nhỏ hơn hoặc bản thu ngắn hơn.'; void stopProcess(child); }, 90 * 60 * 1000);
      const lines = createInterface({ input: child.stdout });
      lines.on('line', line => {
        try {
          const event = JSON.parse(line);
          if (event.type === 'progress' && job) { job.message = event.message; job.stage = event.stage; job.progress = event.progress ?? null; }
          if (event.type === 'result') result = event.result;
          if (event.type === 'error') failure = event.message;
        } catch { /* Third-party model diagnostics are not job events. */ }
      });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-1800); });
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => {
        clearTimeout(timer);
        if (job?.cancelled) reject(httpError(400, 'Đã huỷ tác vụ.'));
        else if (code !== 0 || failure || !result) reject(new Error(failure || stderr || 'Xử lý AI chưa hoàn tất.'));
        else resolve(result);
      });
    });
  } finally { await fs.unlink(input).catch(() => {}); }
}
const upload = multer({ dest: tempDir, limits: { fileSize: 250 * 1024 * 1024, files: 1 } });
const backupUpload = multer({ dest: tempDir, limits: { fileSize: MAX_BACKUP_BYTES, files: 1 } });
const subtitleUpload = multer({ dest: tempDir, limits: { fileSize: MAX_SUBTITLE_BYTES, files: 1 } });
function mediaPath(project, key) {
  if (project.id === 'demo') return path.join(root, 'public/demo', project.files[key]);
  return path.join(mediaDir, project.id, project.files[key]);
}
const backupDirectory = path.join(tempDir, 'backups');
const backups = new BackupStore({ directory: backupDirectory, projectsDir, mediaDir, loadProject, persist,
  listProjects: async () => {
    const files = (await fs.readdir(projectsDir)).filter(file => file.endsWith('.json'));
    return (await Promise.all(files.map(file => fs.readFile(path.join(projectsDir, file), 'utf8').then(JSON.parse).catch(() => null)))).filter(Boolean);
  },
  isBusy: () => !!(activeJob || activeClip || shuttingDown),
  validateAudio: async ({ project, files, audio: directory }, signal) => {
    for (const role of ['source', 'original', 'playback', ...(project.processed.noise ? ['clean'] : [])]) {
      signal?.throwIfAborted(); const task = { cancelled: false };
      const cancel = () => { task.cancelled = true; void stopProcess(task.child); };
      signal?.addEventListener('abort', cancel, { once: true });
      try {
        const probe = JSON.parse(await run(ffprobe.path, ['-v','error','-protocol_whitelist','file','-format_whitelist','wav,mp3,flac,ogg,mov,matroska,webm,aac,aiff,amr,asf',
          '-show_format','-show_streams','-of','json',path.join(directory,files[role])], { timeout: 30000, job: task }));
        const stream = probe.streams?.find(item => item.codec_type === 'audio'), duration = Number(probe.format?.duration || stream?.duration);
        if (!stream || role !== 'original' && (!Number.isFinite(duration) || Math.abs(duration - project.duration) > .5)) throw httpError(400, 'Âm thanh trong bản sao lưu không khớp thời lượng dự án.');
        if (role === 'original' && Number.isFinite(duration) && Math.abs(duration - project.duration) > .5) throw httpError(400, 'File gốc không khớp thời lượng dự án.');
        if (role === 'source' && (stream.codec_name !== 'pcm_s16le' || Number(stream.sample_rate) !== 16000 || Number(stream.channels) !== 1)) throw httpError(400, 'Bản âm thanh chuẩn hoá trong ZIP không hợp lệ.');
        if (['playback','clean'].includes(role) && stream.codec_name !== 'mp3') throw httpError(400, 'Bản phát trong ZIP không phải MP3 hợp lệ.');
      } catch (error) {
        if (error.status || signal?.aborted) throw error;
        throw httpError(400, 'Không đọc được âm thanh trong bản sao lưu.');
      } finally { signal?.removeEventListener('abort', cancel); }
    }
  },
});
await backups.init();
async function cleanBackups() {
  await backups.cleanup();
  for (const [token, ticket] of backupDownloads) if (!ticket.inUse && ticket.expiresAt <= Date.now()) {
    backupDownloads.delete(token); await backups.removeFolder(ticket.folder);
  }
}
const backupCleanup = setInterval(() => void cleanBackups().catch(error => console.error(error.message)), 60000); backupCleanup.unref();
const subtitleCleanup = setInterval(() => subtitles.cleanup(), 60000); subtitleCleanup.unref();

app.post('/api/projects/:id/backup', async (req, res) => {
  const id = idSchema.parse(req.params.id);
  const { project: snapshot } = z.object({ project: reportProjectSchema.optional() }).strict().parse(req.body || {});
  if (backupLocks.has(id)) throw httpError(409, 'Đang tạo một bản sao lưu cho dự án này. Đợi hoàn tất rồi thử lại.');
  if (shuttingDown || activeJob && jobs.get(activeJob)?.projectId === id) throw httpError(409, 'Đợi tác vụ của dự án hoàn tất trước khi sao lưu.');
  backupLocks.add(id);
  const controller = new AbortController(), token = randomUUID(), folder = path.join(backupDirectory, token);
  let prepared = false;
  const cancel = () => { if (!res.writableEnded) controller.abort(); };
  res.on('close', cancel);
  try {
    let project = await loadProject(id);
    if (snapshot) {
      if (id !== 'demo' || snapshot.id !== 'demo' || snapshot.duration !== project.duration) throw httpError(400, 'Nội dung sao lưu không khớp dự án.');
      const edits = Object.fromEntries(['name','speakers','transcript','notes','insights'].filter(key => snapshot[key] !== undefined).map(key => [key,snapshot[key]]));
      project = { ...project, ...edits, transcriptEdited: true };
    }
    await fs.mkdir(folder);
    const archive = path.join(folder, 'backup.zip');
    const result = await createBackup(project, { mediaFile: role => mediaPath(project, role), target: archive, signal: controller.signal });
    if (controller.signal.aborted) return;
    await cleanBackups();
    // Bound temporary disk use without buffering large archives in the browser.
    if (backupDownloads.size >= 3) {
      const oldest = [...backupDownloads].find(([, ticket]) => !ticket.inUse);
      if (oldest) { backupDownloads.delete(oldest[0]); await backups.removeFolder(oldest[1].folder); }
      else throw httpError(409, 'Đợi các bản sao lưu đang tải xong rồi thử lại.');
    }
    const expiresAt = Date.now() + 30 * 60 * 1000;
    backupDownloads.set(token, { folder, archive, filename: result.filename, expiresAt, inUse: false }); prepared = true;
    res.status(201).json({ url: `/api/backups/download/${token}`, filename: result.filename, bytes: result.bytes, expiresAt: new Date(expiresAt).toISOString() });
  } catch (error) { if (!controller.signal.aborted && !res.headersSent) throw error; }
  finally { res.off('close', cancel); backupLocks.delete(id); if (!prepared) await backups.removeFolder(folder); queue?.wake(); }
});
app.get('/api/backups/download/:token', async (req, res) => {
  z.string().uuid().parse(req.params.token);
  const ticket = backupDownloads.get(req.params.token);
  if (!ticket || ticket.expiresAt <= Date.now()) throw httpError(410, 'Link sao lưu đã hết hạn. Tạo bản sao lưu mới.');
  ticket.inUse = (ticket.inUse || 0) + 1;
  try { await new Promise((resolve, reject) => res.download(ticket.archive, ticket.filename, { headers: { 'Content-Type':'application/zip', 'Cache-Control':'no-store' } }, error => error ? reject(error) : resolve())); }
  catch (error) { if (!res.headersSent && !res.destroyed) throw error; }
  finally { ticket.inUse--; }
});
app.post('/api/backups/inspect', backupUpload.single('backup'), async (req, res) => {
  if (!req.file) throw httpError(400, 'Chọn file ZIP sao lưu dự án.');
  const task = { cancelled: false }, controller = new AbortController();
  const cancel = () => { if (!res.writableEnded) { task.cancelled = true; controller.abort(); } };
  res.on('close', cancel); let review;
  try {
    if (activeJob || activeClip || activeImport || shuttingDown) throw httpError(409, 'Đợi tác vụ hiện tại hoàn tất trước khi đọc bản sao lưu.');
    activeImport = task;
    review = await backups.inspect(req.file.path, { signal: controller.signal });
    if (controller.signal.aborted) { await backups.discard(review.token); return; }
    res.status(200).json(review);
  } catch (error) { if (!controller.signal.aborted) throw error; }
  finally { await fs.unlink(req.file.path).catch(() => {}); res.off('close', cancel); if (activeImport === task) activeImport = null; queue?.wake(); }
});
app.post('/api/backups/:token/restore', async (req, res) => {
  const { mode } = z.object({ mode: z.enum(['restore','copy']).default('restore') }).strict().parse(req.body || {});
  if (activeJob || activeClip || activeImport || shuttingDown) throw httpError(409, 'Đợi tác vụ hiện tại hoàn tất trước khi khôi phục.');
  const task = { cancelled: false }; activeImport = task;
  try {
    const result = await backups.restore(req.params.token, mode);
    res.status(result.status === 'restored' ? 201 : 200).json(result.project ? { ...result, project: publicProject(result.project) } : result);
  } finally { if (activeImport === task) activeImport = null; queue?.wake(); }
});
app.delete('/api/backups/:token', async (req, res) => { z.string().uuid().parse(req.params.token); await backups.discard(req.params.token); res.status(204).end(); });

function projectQueueBusy(id) {
  return !!(activeJob && jobs.get(activeJob)?.projectId === id) || !!queue?.state?.items?.some(item => item.projectId === id && !['completed', 'failed', 'cancelled'].includes(item.status));
}

app.post('/api/projects/:id/subtitles/inspect', (req, res, next) => { idSchema.parse(req.params.id); next(); }, subtitleUpload.single('subtitle'), async (req, res) => {
  const id = req.params.id;
  if (!req.file) throw httpError(400, 'Chọn file phụ đề SRT hoặc VTT.');
  const originalname = uploadedFilename(req.file.originalname);
  const task = { cancelled: false }, cancel = () => { if (!res.writableEnded) task.cancelled = true; };
  res.on('close', cancel);
  try {
    if (activeJob || activeClip || activeImport || shuttingDown || projectQueueBusy(id)) throw httpError(409, 'Đợi tác vụ của dự án hoàn tất trước khi nhập transcript.');
    const project = await loadProject(id);
    const content = await fs.readFile(req.file.path);
    if (task.cancelled) return;
    const review = subtitles.inspect(content, originalname, project);
    res.status(200).json(review);
  } finally { await fs.unlink(req.file.path).catch(() => {}); res.off('close', cancel); queue?.wake(); }
});

app.post('/api/projects/:id/subtitles/:token/import', async (req, res) => {
  const id = idSchema.parse(req.params.id);
  z.string().uuid().parse(req.params.token);
  subtitles.get(req.params.token, id);
  if (activeJob || activeClip || activeImport || shuttingDown || projectQueueBusy(id)) throw httpError(409, 'Đợi tác vụ của dự án hoàn tất trước khi nhập transcript.');
  const task = { cancelled: false }; activeImport = task;
  try {
    const project = await subtitles.commit(req.params.token, id, (projectId, operation) => mutate(projectId, operation, { reason: 'subtitles' }));
    res.status(200).json(publicProject(project));
  } finally { if (activeImport === task) activeImport = null; queue?.wake(); }
});

app.delete('/api/subtitles/:token', async (req, res) => {
  z.string().uuid().parse(req.params.token);
  subtitles.discard(req.params.token);
  res.status(204).end();
});

function assertHistoryAvailable(id) {
  if (id === 'demo') throw httpError(400, 'Lịch sử phiên bản dùng cho dự án riêng. Nhập bản thu hoặc tạo bản sao mẫu để sử dụng.');
}
function assertHistoryWritable(id) {
  assertHistoryAvailable(id);
  if (activeJob || activeImport || shuttingDown || projectQueueBusy(id) || backupLocks.has(id)) throw httpError(409, 'Đợi tác vụ hiện tại hoàn tất trước khi lưu hoặc khôi phục phiên bản.');
}
app.get('/api/projects/:id/history', async (req, res) => {
  const project = await loadProject(req.params.id); assertHistoryAvailable(project.id);
  res.json(listHistory(project));
});
app.post('/api/projects/:id/history', async (req, res) => {
  const id = idSchema.parse(req.params.id); z.object({}).strict().parse(req.body || {}); assertHistoryWritable(id);
  const project = await mutate(id, latest => latest, { reason: 'manual', checkpoint: true });
  res.json(listHistory(project));
});
app.get('/api/projects/:id/history/:versionId', async (req, res) => {
  const project = await loadProject(req.params.id); assertHistoryAvailable(project.id);
  res.json(previewHistory(project, req.params.versionId));
});
app.post('/api/projects/:id/history/:versionId/restore', async (req, res) => {
  const id = idSchema.parse(req.params.id); z.string().uuid().parse(req.params.versionId);
  const { expectedFingerprint } = z.object({ expectedFingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(req.body);
  assertHistoryWritable(id);
  const task = { kind: 'history', projectId: id }; activeImport = task;
  try {
    const project = await mutate(id, latest => restoreHistory(latest, req.params.versionId, expectedFingerprint), { reason: 'restore' });
    res.json(publicProject(project));
  } finally { if (activeImport === task) activeImport = null; queue?.wake(); }
});

app.get('/api/health', async (req, res) => {
  res.json({ status: 'ok', aiInstalled: existsSync(python), activeJob: activeJob ? jobView(jobs.get(activeJob)) : null,
    activeClip: activeClip ? { projectId: activeClip.projectId } : null, queueRunning: queue?.view().running || false });
});
app.get('/api/projects', async (req, res) => {
  const files = (await fs.readdir(projectsDir)).filter(file => file.endsWith('.json'));
  const records = await Promise.all(files.map(file => fs.readFile(path.join(projectsDir, file), 'utf8').then(JSON.parse).catch(() => null)));
  res.json(records.filter(Boolean).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt)).map(project => ({
    id: project.id, name: project.name, duration: project.duration, updatedAt: project.updatedAt,
    transcriptCount: project.transcript.length, noteCount: project.notes.length,
  })));
});
app.get('/api/projects/:id', async (req, res) => res.json(publicProject(await loadProject(req.params.id))));
app.post('/api/projects/:id/reports', async (req, res) => {
  idSchema.parse(req.params.id);
  const request = reportRequestSchema.parse(req.body);
  const loaded = await loadProject(req.params.id);
  if (request.project && request.project.id !== req.params.id) throw httpError(400, 'Dự án báo cáo không khớp.');
  // The browser sends a snapshot so local demo edits and the latest draft are included.
  // When no snapshot is provided, fall back to the persisted project on disk.
  const report = await createReport(request.project || loaded, request.format, { layout: request.layout, baseUrl: `http://127.0.0.1:${port}` });
  res.status(200).set({
    'Content-Type': report.mime,
    'Content-Disposition': `attachment; filename="${report.filename.replace(/[^\x20-\x7E]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(report.filename).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)}`,
    'Content-Length': String(report.buffer.length),
    'Cache-Control': 'no-store',
  }).send(report.buffer);
});
app.post('/api/batch/export', async (req, res) => {
  const request = batchExportRequestSchema.parse(req.body);
  await Promise.all(request.items.map(item => loadProject(item.project.id)));
  const archive = await createBatchArchive(request, { baseUrl: `http://127.0.0.1:${port}` });
  res.status(200).set({
    'Content-Type': archive.mime,
    'Content-Disposition': `attachment; filename="${archive.filename}"`,
    'Content-Length': String(archive.buffer.length),
    'Cache-Control': 'no-store',
  }).send(archive.buffer);
});
app.post('/api/demo/copy', async (req, res) => {
  const demo = await loadProject('demo');
  const id = randomUUID(); const directory = path.join(mediaDir,id);
  await fs.mkdir(directory);
  for (const key of ['original','source','playback']) await fs.copyFile(mediaPath(demo,key),path.join(directory,demo.files[key]));
  const now = new Date().toISOString();
  const project = { ...demo, id, name: 'Thử AI — Thói quen sáng tạo', isDemo: false, language: null, notes: [], transcript: [], words: [], speakers: [], insights: null, processed: { noise:false,transcript:false,speakers:false },createdAt:now,updatedAt:now };
  await persist(project);
  res.status(201).json(publicProject(project));
});
app.patch('/api/projects/:id', async (req, res) => {
  const updates = editSchema.parse(req.body);
  if ((activeJob && jobs.get(activeJob)?.projectId === req.params.id || activeImport?.projectId === req.params.id) && (updates.transcript || updates.speakers)) throw httpError(409, 'Đợi tác vụ hoàn tất trước khi sửa transcript hoặc người nói.');
  const project = await mutate(req.params.id, latest => ({ ...validateEdits(latest, updates), ...(updates.transcript ? { transcriptEdited: true } : {}) }));
  res.json(publicProject(project));
});
app.post('/api/projects/:id/insights', async (req, res) => {
  const { sourceFingerprint } = z.object({ sourceFingerprint: z.string().min(1).max(100) }).strict().parse(req.body);
  if (activeJob && jobs.get(activeJob)?.projectId === req.params.id) throw httpError(409, 'Đợi tác vụ hoàn tất trước khi tạo tóm tắt.');
  const project = await mutate(req.params.id, latest => {
    if (transcriptFingerprint(latest.transcript) !== sourceFingerprint) throw httpError(409, 'Transcript đã thay đổi. Mở lại dự án rồi tạo tóm tắt.');
    if (!latest.transcript.some(line => /[\p{L}\p{N}]/u.test(line.text))) throw httpError(400, 'Cần transcript có nội dung trước khi tạo tóm tắt.');
    return { ...latest, insights: buildInsights(latest) };
  });
  res.json({ insights: project.insights });
});
async function importAudio(file, task, { id = randomUUID(), preserveInput = false } = {}) {
  // Queue IDs are allocated and saved before work starts. If a response or queue
  // write was interrupted after this project committed, reuse the same result.
  if (preserveInput) {
    try { return await loadProject(id); }
    catch (error) { if (error.status !== 404) throw error; }
  }
  const directory = path.join(mediaDir, id);
  let persisted = false;
  try {
    await fs.mkdir(directory, { recursive: true });
    let probe;
    try { probe = JSON.parse(await run(ffprobe.path, ['-v','error','-show_format','-show_streams','-of','json',file.path], { job: task })); }
    catch { throw httpError(400, 'Không đọc được file âm thanh. Kiểm tra định dạng hoặc thử xuất lại bản thu.'); }
    const stream = probe.streams?.find(item => item.codec_type === 'audio');
    const declaredDuration = Number(probe.format?.duration || stream?.duration);
    if (!stream || Number.isFinite(declaredDuration) && (declaredDuration < .5 || declaredDuration > 7200)) throw httpError(400, 'Chọn file có âm thanh, dài từ 0,5 giây đến 2 giờ.');
    const extension = path.extname(file.originalname).toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 10) || '.audio';
    const originalFile = `original${extension}`;
    if (preserveInput) await fs.copyFile(file.path, path.join(directory, originalFile));
    else await fs.rename(file.path, path.join(directory, originalFile));
    // MediaRecorder WebM/OGG may omit container duration. Measure decoded audio,
    // capped just beyond the limit so an unknown duration cannot bypass it.
    await run(ffmpeg, ['-v','error','-y','-i',path.join(directory,originalFile),'-t','7200.5','-map','0:a:0','-vn','-ac','1','-ar','16000','-c:a','pcm_s16le',path.join(directory,'source.wav')], { timeout: 300000, job: task });
    const normalizedProbe = JSON.parse(await run(ffprobe.path, ['-v','error','-show_format','-of','json',path.join(directory,'source.wav')], { job: task }));
    const duration = Number(normalizedProbe.format?.duration);
    if (!Number.isFinite(duration) || duration < .5 || duration > 7200) throw httpError(400, 'Chọn file có âm thanh, dài từ 0,5 giây đến 2 giờ.');
    await run(ffmpeg, ['-v','error','-y','-i',path.join(directory,originalFile),'-map','0:a:0','-vn','-c:a','libmp3lame','-q:a','3',path.join(directory,'playback.mp3')], { timeout: 300000, job: task });
    const metrics = await worker({ mode: 'inspect', file: path.join(directory,'source.wav') }, task);
    if (task.cancelled) throw httpError(400, 'Đã huỷ nhập file.');
    const now = new Date().toISOString();
    const project = {
      id, name: file.originalname.replace(/\.[^/.]+$/, '').slice(0,150) || 'Bản thu mới',
      fileName: file.originalname.slice(0,255), format: stream.codec_name?.toUpperCase() || 'AUDIO',
      sampleRate: Number(stream.sample_rate), channels: Number(stream.channels), size: file.size,
      duration, createdAt: now, updatedAt: now, language: null,
      processed: { noise: false, transcript: false, speakers: false },
      speakers: [], transcript: [], notes: [], words: [], metrics,
      files: { original: originalFile, source: 'source.wav', playback: 'playback.mp3', clean: 'clean.mp3' },
    };
    await persist(project); persisted = true;
    if (task.cancelled) throw httpError(400, 'Đã huỷ nhập file.');
    return project;
  } catch (error) {
    if (!preserveInput) await fs.unlink(file.path).catch(() => {});
    // Both IDs are server-generated UUIDs. A durable queue import keeps any
    // committed result; only its incomplete, unexposed media can be discarded.
    if (!persisted || !preserveInput) await fs.rm(directory, { recursive: true, force: true });
    if (persisted && !preserveInput) await fs.unlink(path.join(projectsDir, `${id}.json`)).catch(() => {});
    throw error;
  }
}
app.post('/api/projects', upload.single('audio'), async (req, res) => {
  if (!req.file) throw httpError(400, 'Chưa chọn file âm thanh.');
  const task = { cancelled: false };
  const cancel = () => { if (!res.writableEnded) { task.cancelled = true; void stopProcess(task.child); } };
  res.on('close', cancel);
  try {
    if (activeJob || activeClip || activeImport || shuttingDown) throw httpError(409, 'Đợi tác vụ hiện tại hoàn tất trước khi nhập bản thu.');
    activeImport = task;
    req.file.originalname = uploadedFilename(req.file.originalname);
    res.status(201).json(publicProject(await importAudio(req.file, task)));
  } catch (error) { if (!task.cancelled) throw error; }
  finally {
    await fs.unlink(req.file.path).catch(() => {});
    res.off('close', cancel); if (activeImport === task) activeImport = null; queue?.wake();
  }
});
app.get('/api/projects/:id/audio/:variant', async (req, res) => {
  const project = await loadProject(req.params.id);
  const variant = req.params.variant;
  if (!['original','clean','download'].includes(variant)) throw httpError(404, 'Không có bản âm thanh này.');
  if (variant === 'clean' && !project.processed.noise) throw httpError(404, 'Bản thu chưa được lọc ồn.');
  const file = mediaPath(project, variant === 'original' ? 'playback' : variant === 'download' ? 'original' : 'clean');
  if (variant === 'download' || req.query.download === '1') return res.download(file, variant === 'download' ? project.fileName : `${project.name}-clean.mp3`);
  res.sendFile(file);
});
app.post('/api/projects/:id/clips', async (req, res) => {
  const project = await loadProject(req.params.id);
  const options = validateClip(project, req.body);
  if (activeJob || activeClip || activeImport || shuttingDown) throw httpError(409, 'Đợi tác vụ hiện tại hoàn tất rồi xuất clip.');
  const id = randomUUID();
  const file = path.join(clipDir, `${id}.${options.format}`);
  const task = { projectId: project.id, file, cancelled: false };
  activeClip = task;
  const cancel = () => { if (!res.writableEnded) { task.cancelled = true; void stopProcess(task.child); } };
  res.on('close', cancel);
  try {
    // Re-encode after seeking so cuts are accurate even between codec frames.
    const codec = options.format === 'mp3' ? ['-c:a', 'libmp3lame', '-q:a', '2'] : ['-c:a', 'pcm_s16le'];
    await run(ffmpeg, ['-v', 'error', '-nostdin', '-y', '-ss', String(options.start), '-i', mediaPath(project, options.variant === 'clean' ? 'clean' : 'original'),
      '-t', String(options.end - options.start), '-map', '0:a:0', '-vn', '-map_metadata', '-1', ...codec, file], { timeout: 10 * 60 * 1000, job: task });
    if (task.cancelled) throw httpError(400, 'Đã huỷ xuất clip.');
    const stat = await fs.stat(file);
    const filename = clipFilename(project.name, options);
    const expiresAt = Date.now() + clipLifetime;
    clips.set(id, { file, filename, expiresAt });
    res.status(201).json({ url: `/api/clips/${id}`, filename, size: stat.size, duration: options.end - options.start, expiresAt: new Date(expiresAt).toISOString() });
  } catch (error) {
    await fs.unlink(file).catch(() => {});
    if (!task.cancelled) throw error;
  } finally { res.off('close', cancel); if (activeClip === task) activeClip = null; queue?.wake(); }
});
app.get('/api/clips/:id', async (req, res) => {
  idSchema.parse(req.params.id);
  const clip = clips.get(req.params.id);
  if (!clip || clip.expiresAt <= Date.now()) throw httpError(404, 'Clip tạm đã hết hạn. Mở lại trình cắt và xuất clip mới.');
  res.download(clip.file, clip.filename);
});
function jobView(job) {
  const { child, cancelled, ...view } = job; return view;
}
async function performJob(job, options, resumeItemId = null) {
  try {
    let project = await loadProject(job.projectId);
    const kinds = options.kind === 'all' ? ['noise','transcript','speakers'] : [options.kind];
    const checkpoint = (latest, kind) => resumeItemId ? { queueCheckpoint: { itemId: resumeItemId,
      completed: [...new Set([...(latest.queueCheckpoint?.itemId === resumeItemId ? latest.queueCheckpoint.completed : []), kind])] } } : {};
    for (const kind of kinds) {
      if (job.cancelled) throw new Error('Đã huỷ tác vụ.');
      if (resumeItemId && project.queueCheckpoint?.itemId === resumeItemId && project.queueCheckpoint.completed.includes(kind) && project.processed[kind]) continue;
      job.stage = kind; job.progress = null;
      if (kind === 'noise') {
        job.message = 'Đang lọc nền ồn và cân âm lượng…';
        const reduction = { gentle: 6, standard: 12, strong: 20 }[options.noiseStrength];
        const destination = path.join(mediaDir, project.id, 'clean.pending.mp3');
        await run(ffmpeg, ['-v','error','-y','-i',mediaPath(project,'original'),'-map','0:a:0','-vn','-af',`highpass=f=70,afftdn=nr=${reduction}:nf=-30:tn=1,loudnorm=I=-16:TP=-1.5:LRA=11`,'-c:a','libmp3lame','-q:a','2',destination], { timeout: 30*60*1000, job });
        if (job.cancelled) throw new Error('Đã huỷ tác vụ.');
        await fs.rename(destination, mediaPath(project,'clean'));
        project = await mutate(project.id, latest => ({ ...latest, processed: { ...latest.processed, noise: true }, ...checkpoint(latest, kind) }));
      } else {
        project = await mutate(project.id, latest => latest, { reason: kind, checkpoint: true });
        job.message = kind === 'transcript' ? 'Đang tải bộ nhận diện hoặc tạo transcript…' : 'Đang phân tách giọng nói…';
        const result = await worker({
          mode: kind, file: mediaPath(project,'source'), duration: project.duration,
          model: options.model, language: options.language, numSpeakers: options.numSpeakers,
          words: project.words, transcript: project.transcript, transcriptEdited: project.transcriptEdited, turns: project.turns || [], speakers: project.speakers,
        }, job);
        if (job.cancelled) throw new Error('Đã huỷ tác vụ.');
        job.message = 'Đang tóm tắt và chia chương từ transcript…';
        project = await mutate(project.id, latest => {
          const next = { ...latest, ...result, processed: { ...latest.processed, [kind]: true }, ...checkpoint(latest, kind) };
          if (next.transcript.some(line => /[\p{L}\p{N}]/u.test(line.text))) next.insights = buildInsights(next);
          return next;
        }, { reason: kind });
      }
    }
    job.status = 'completed'; job.progress = 1; job.message = 'Đã xử lý xong bản thu.';
  } catch (error) {
    job.status = job.interrupted ? 'interrupted' : job.cancelled ? 'cancelled' : 'failed';
    job.message = job.cancelled ? 'Đã huỷ. Kết quả các bước đã xong vẫn được giữ.' : error.message;
  } finally { delete job.child; job.finishedAt = new Date().toISOString(); }
}
function claimJob(projectId, options, queueItemId) {
  if (activeJob || activeClip || activeImport || shuttingDown || backupLocks.has(projectId)) return null;
  const job = { id: randomUUID(), projectId, kind: options.kind, ...(queueItemId ? { queueItemId } : {}),
    status: 'running', stage: 'preparing', progress: null, message: 'Đang chuẩn bị…', createdAt: new Date().toISOString() };
  if (jobs.size >= 100) jobs.delete(jobs.keys().next().value);
  jobs.set(job.id, job); activeJob = job.id; return job;
}
function releaseJob(job) { if (activeJob === job.id) activeJob = null; queue?.wake(); }

queue = await DurableQueue.open({ directory: data,
  hasProject: async id => { try { await loadProject(id); return true; } catch (error) { if (error.status === 404) return false; throw error; } },
  acquire: item => claimJob(item.projectId, item.options || queue.state.options, item.id),
  stop: task => stopProcess(task.child), release: releaseJob,
  execute: async (item, job, imported) => {
    job.stage = 'importing'; job.message = 'Đang nhập và chuẩn hoá âm thanh đã lưu…';
    await importAudio({ path: item.path, originalname: item.name, size: item.size }, job, { id: item.projectId, preserveInput: true });
    await imported();
    if (job.cancelled) throw new Error('Đã huỷ tác vụ.');
    await performJob(job, item.options, item.id);
    if (job.status !== 'completed') throw new Error(job.message);
  },
});
app.get('/api/queue', (req, res) => res.json(queue.view()));
app.post('/api/queue/items', async (req, res) => res.status(201).json(await queue.reserve(req.body)));
app.put('/api/queue/items/:id/audio', (req, res, next) => {
  queue.find(queue.state, req.params.id); next();
}, upload.single('audio'), async (req, res) => {
  if (!req.file) throw httpError(400, 'Chưa chọn file âm thanh.');
  try {
    const item = queue.find(queue.state, req.params.id);
    if (uploadedFilename(req.file.originalname) !== item.name) throw httpError(400, 'Tên file không khớp. Chọn lại đúng file ban đầu.');
    res.status(200).json(await queue.attach(req.params.id, req.file.path, req.file.size));
  } finally { await fs.unlink(req.file.path).catch(() => {}); }
});
app.post('/api/queue/start', async (req, res) => res.status(202).json(await queue.start(req.body)));
app.post('/api/queue/recover', async (req, res) => res.json(await queue.retryStorage()));
app.post('/api/queue/items/:id/cancel', async (req, res) => res.json(await queue.cancel(req.params.id)));
app.post('/api/queue/items/:id/retry', async (req, res) => res.json(await queue.retry(req.params.id)));
app.delete('/api/queue/items/:id', async (req, res) => res.json(await queue.remove(req.params.id)));
app.delete('/api/queue', async (req, res) => res.json(await queue.clear()));

app.post('/api/projects/:id/jobs', async (req, res) => {
  const project = await loadProject(req.params.id);
  if (project.id === 'demo') throw httpError(400, 'Mẫu đã được chuẩn bị sẵn. Nhập file hoặc tạo bản sao mẫu để chạy AI.');
  const options = optionsSchema.parse(req.body);
  const job = claimJob(project.id, options);
  if (!job) throw httpError(409, 'Đang có một tác vụ chạy. Đợi hoàn tất hoặc huỷ tác vụ hiện tại.');
  res.status(202).json(jobView(job));
  void performJob(job, options).finally(() => releaseJob(job));
});
app.get('/api/jobs/:id', (req, res) => { const job = jobs.get(req.params.id); if (!job) throw httpError(404,'Không tìm thấy tác vụ.'); res.json(jobView(job)); });
app.delete('/api/jobs/:id', async (req, res) => {
  const job = jobs.get(req.params.id); if (!job) throw httpError(404,'Không tìm thấy tác vụ.');
  if (job.queueItemId) { await queue.cancel(job.queueItemId); return res.json(jobView(job)); }
  if (job.status === 'running') { job.cancelled = true; void stopProcess(job.child); job.message = 'Đang huỷ tác vụ…'; }
  res.json(jobView(job));
});
app.use(express.static(path.join(root,'public'), { dotfiles: 'deny' }));
app.use((error, req, res, next) => {
  const validation = error instanceof z.ZodError;
  const uploadError = error instanceof multer.MulterError;
  const tooLarge = uploadError && error.code === 'LIMIT_FILE_SIZE';
  const status = tooLarge ? 413 : validation || uploadError ? 400 : error.status || 500;
  if (status >= 500) console.error(error.message);
  const subtitlePath = req.path.includes('/subtitles');
  const message = tooLarge ? req.path.startsWith('/api/backups') ? 'File sao lưu vượt quá 1,5 GB.' : subtitlePath ? 'File phụ đề vượt quá 25 MB.' : 'File vượt quá 250 MB.' : uploadError ? 'Chọn đúng một file cho thao tác này.' : validation ? req.path.startsWith('/api/backups') ? 'Cấu trúc hoặc nội dung bản sao lưu không hợp lệ. Chọn ZIP được tạo bằng Audio Toolkit.' : subtitlePath ? 'Dữ liệu phụ đề không hợp lệ. Kiểm tra mốc thời gian và nội dung.' : 'Dữ liệu không hợp lệ. Kiểm tra thời gian và nội dung nhập.' : error.message;
  if (res.headersSent) return next(error);
  res.status(status).json({ error: message });
});
const server = app.listen(port, '127.0.0.1', () => console.log(`Audio Toolkit: http://127.0.0.1:${port}`));
queue.startWorker();
function shutdown() {
  if (shuttingDown) return; shuttingDown = true; clearInterval(clipCleanup); clearInterval(backupCleanup); clearInterval(subtitleCleanup); subtitles.clear();
  for (const task of [activeImport, activeClip, activeJob ? jobs.get(activeJob) : null]) if (task) { task.interrupted = true; task.cancelled = true; void stopProcess(task.child); }
  void queue.close().finally(() => server.close());
}
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
