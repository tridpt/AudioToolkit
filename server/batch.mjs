import JSZip from 'jszip';
import { z } from 'zod';
import { createExport } from '../public/exports.js';
import { reportFilename, reportSnapshot } from '../public/reports.js';
import { createReport, reportProjectSchema } from './report.mjs';

export const batchFormatSchema = z.enum(['docx', 'pdf', 'txt', 'json', 'srt', 'vtt']);
export const batchItemSchema = z.object({
  project: reportProjectSchema,
  formats: z.array(batchFormatSchema).min(1).max(6),
}).strict();
export const batchExportRequestSchema = z.object({
  items: z.array(batchItemSchema).min(1).max(20),
  layout: z.enum(['podcast', 'lesson', 'interview']).default('podcast'),
}).strict();

function safeFolder(name) {
  return reportFilename(name, 'txt').replace(/-bao-cao\.txt$/i, '') || 'audio-toolkit';
}

function uniquePath(path, used) {
  if (!used.has(path)) {
    used.add(path);
    return path;
  }
  const extension = path.match(/\.[^./]+$/)?.[0] || '';
  const stem = extension ? path.slice(0, -extension.length) : path;
  let index = 2;
  let candidate = `${stem}-${index}${extension}`;
  while (used.has(candidate)) candidate = `${stem}-${++index}${extension}`;
  used.add(candidate);
  return candidate;
}

export async function createBatchArchive(input, { baseUrl = 'http://127.0.0.1:4188', exportedAt = new Date().toISOString() } = {}) {
  const request = batchExportRequestSchema.parse(input);
  const zip = new JSZip();
  const used = new Set();
  const files = [];

  for (const [index, item] of request.items.entries()) {
    const project = reportProjectSchema.parse(reportSnapshot(item.project));
    const folder = `${String(index + 1).padStart(2, '0')} - ${safeFolder(project.name)}`;
    for (const format of [...new Set(item.formats)]) {
      let filename;
      let content;
      if (format === 'docx' || format === 'pdf') {
        const report = await createReport(project, format, { layout: request.layout, baseUrl, exportedAt });
        filename = report.filename;
        content = report.buffer;
      } else {
        const exported = createExport(project, format);
        filename = exported.filename;
        content = Buffer.from(exported.content, 'utf8');
      }
      filename = filename.replace(/[\x00-\x1f\x7f]/g, '-');
      const archivePath = uniquePath(`${folder}/${filename}`, used);
      zip.file(archivePath, content);
      files.push({ project: project.name, format, path: archivePath, bytes: content.length });
    }
  }

  zip.file('audio-toolkit-manifest.json', JSON.stringify({ schemaVersion: 1, exportedAt, files }, null, 2));
  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  return {
    buffer,
    filename: `audio-toolkit-${new Date(exportedAt).toISOString().replace(/[:.]/g, '-')}.zip`,
    mime: 'application/zip',
    files,
  };
}

