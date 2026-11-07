import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { openSync } from 'fontkit';
import {
  AlignmentType, Document, ExternalHyperlink, Footer, HeadingLevel, PageNumber,
  Packer, Paragraph, TextRun,
} from 'docx';
import { z } from 'zod';
import { formatTimestamp } from '../public/exports.js';
import { REPORT_LAYOUTS, reportFilename, reportSnapshot, reportStatus, reportTimestampUrl, transcriptTurns } from '../public/reports.js';
import { idSchema, lineSchema, noteSchema, speakerSchema } from './domain.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let pdfCharacters;
const passageSchema = z.object({
  id: z.string().max(70), text: z.string().max(1200),
  time: z.number().finite().min(0).max(7200), end: z.number().finite().positive().max(7200.1),
  speaker: z.string().max(70), sourceIds: z.array(z.string().max(70)).max(20000),
  chapterId: z.string().max(70).optional(),
}).refine(item => item.end > item.time);
const insightsSchema = z.object({
  version: z.number().int().positive(), method: z.string().max(80),
  generatedAt: z.string().max(100), sourceFingerprint: z.string().max(100),
  language: z.string().max(16).nullable().optional(),
  summary: z.array(passageSchema).max(8), highlights: z.array(passageSchema).max(20),
  chapters: z.array(z.object({
    id: z.string().max(70), title: z.string().max(300),
    start: z.number().finite().min(0).max(7200), end: z.number().finite().positive().max(7200.1),
    sourceIds: z.array(z.string().max(70)).max(20000),
  }).refine(item => item.end > item.start)).max(20),
});
export const reportProjectSchema = z.object({
  id: idSchema, name: z.string().trim().min(1).max(150),
  fileName: z.string().max(260).default(''), duration: z.number().finite().positive().max(7200),
  format: z.string().max(30).optional(), sampleRate: z.number().finite().positive().max(768000).optional(),
  channels: z.number().int().min(1).max(64).optional(), createdAt: z.string().max(100).optional(),
  language: z.string().max(16).nullable().optional(),
  speakers: z.array(speakerSchema).max(20), transcript: z.array(lineSchema).max(20000),
  notes: z.array(noteSchema).max(3000), insights: insightsSchema.nullable().optional(),
}).strict().superRefine((project, ctx) => {
  const speakers = new Set(project.speakers.map(person => person.id));
  if (speakers.size !== project.speakers.length || new Set(project.transcript.map(line => line.id)).size !== project.transcript.length ||
      new Set(project.notes.map(note => note.id)).size !== project.notes.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Mã dữ liệu bị trùng.' });
  if (project.transcript.some(line => line.end > project.duration + .1 || !speakers.has(line.speaker)) ||
      project.notes.some(note => note.time > project.duration + .1)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Mốc thời gian hoặc người nói không hợp lệ.' });
});
export const reportRequestSchema = z.object({
  format: z.enum(['docx', 'pdf']), layout: z.enum(['podcast', 'lesson', 'interview']).default('podcast'),
  project: reportProjectSchema.optional(),
}).strict();

const C = { ink: '242838', muted: '6C7284', accent: '5854AD', warning: '934938' };
const sectionNames = { summary: 'Tóm tắt nội dung', chapters: 'Chương nội dung', highlights: 'Ý chính có mốc thời gian', transcript: 'Transcript theo người nói', notes: 'Ghi chú' };
const emptyText = { summary: 'Chưa tạo tóm tắt cho bản thu này.', chapters: 'Chưa có chương nội dung.', highlights: 'Chưa có ý chính được chọn.', transcript: 'Chưa có transcript.', notes: 'Chưa có ghi chú.' };
const languages = { vi: 'Tiếng Việt', en: 'Tiếng Anh', ja: 'Tiếng Nhật', ko: 'Tiếng Hàn', zh: 'Tiếng Trung', fr: 'Tiếng Pháp', de: 'Tiếng Đức', es: 'Tiếng Tây Ban Nha' };
const dateText = value => {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? 'Chưa xác định' : date.toLocaleString('vi-VN');
};
const speakerName = (project, id) => project.speakers.find(person => person.id === id)?.name || 'Chưa gán';

function modelFor(input, { layout = 'podcast', baseUrl = 'http://127.0.0.1:4188', exportedAt = new Date().toISOString() } = {}) {
  const project = reportProjectSchema.parse(reportSnapshot(input));
  const profile = REPORT_LAYOUTS[layout];
  if (!profile) throw new Error('Mẫu báo cáo không hợp lệ.');
  const status = reportStatus(project);
  const point = (item, includeSpeaker = false) => ({ time: item.time, text: item.text, speaker: includeSpeaker ? speakerName(project, item.speaker) : '' });
  const sections = {
    summary: (project.insights?.summary || []).map(item => point(item)),
    chapters: (project.insights?.chapters || []).map((item, index) => ({ time: item.start, end: item.end, text: `${index + 1}. ${item.title}` })),
    highlights: (project.insights?.highlights || []).map(item => point(item, true)),
    notes: [...project.notes].sort((a, b) => a.time - b.time).map(note => ({ time: note.time, text: note.text })),
    transcript: transcriptTurns(project).map(turn => ({ ...turn, speaker: speakerName(project, turn.speaker) })),
  };
  return { project, profile, status, sections, url: time => reportTimestampUrl(baseUrl, project.id, time), metadata: [
    ['File nguồn', project.fileName || 'Bản thu trong workspace'],
    ['Thời lượng', formatTimestamp(project.duration)], ['Ngày nhập', dateText(project.createdAt)],
    ['Ngày xuất', dateText(exportedAt)], ['Ngôn ngữ', languages[project.language] || project.language || 'Chưa nhận diện'],
  ] };
}

const run = (text, options = {}) => new TextRun({ text: String(text ?? ''), font: 'Arial', size: 21, color: C.ink, ...options });
const para = (children, options = {}) => new Paragraph({ spacing: { after: 100, line: 276 }, ...options, children });
const rangeText = item => formatTimestamp(item.time) + (item.end != null ? ` - ${formatTimestamp(item.end)}` : '');
function docxTime(model, item) {
  return new ExternalHyperlink({ link: model.url(item.time), children: [run(`[${rangeText(item)}]`, { size: 18, color: C.accent, underline: {} })] });
}
function docxText(text, options = {}) {
  // Explicit runs preserve user-authored newlines without putting invalid controls in XML.
  return String(text).split(/\r\n?|\n/).flatMap((line, index) => index ? [new TextRun({ break: 1 }), run(line, options)] : [run(line, options)]);
}
function docxBody(model) {
  const children = [
    new Paragraph({ style: 'Title', children: docxText(model.project.name, { size: 36, bold: true, color: '000000' }), spacing: { after: 100 } }),
    para([run(`Báo cáo ${model.profile.name.toLowerCase()}  ·  Audio Toolkit`, { size: 21, color: C.muted })], { spacing: { after: 240 } }),
    ...model.metadata.map(([label, value]) => para([run(`${label}: `, { bold: true, size: 18 }), ...docxText(value, { size: 18 })], { spacing: { after: 65 } })),
    para([run('Báo cáo gồm nội dung bản thu và ghi chú của bạn. Tóm tắt và ý chính được trích từ transcript, giữ ngôn ngữ bản thu.', { size: 19, color: C.muted })], { spacing: { before: 180, after: 100 } }),
    para([run('Nhấn mốc thời gian để mở lại bản thu trên máy này. Cần chạy Audio Toolkit và giữ dự án gốc.', { size: 18, color: C.muted })]),
  ];
  if (model.status === 'stale') children.push(para([run('Tóm tắt chưa cập nhật. Tóm tắt, chương và ý chính có thể chưa khớp với transcript đã sửa.', { bold: true, color: C.warning, size: 20 })]));
  for (const key of model.profile.sections) {
    children.push(new Paragraph({ heading: HeadingLevel.HEADING_1, keepNext: true, spacing: { before: 260, after: 130 }, children: [run(sectionNames[key], { bold: true, size: 26, color: '000000' })] }));
    const items = model.sections[key];
    if (!items.length) { children.push(para([run(emptyText[key], { size: 20, color: C.muted })])); continue; }
    for (const item of items) {
      if (key === 'transcript') {
        children.push(para([docxTime(model, item), run(`  ${item.speaker}`, { bold: true, size: 20 })], { keepNext: true, spacing: { before: 100, after: 50 } }));
        for (const line of item.lines) children.push(para([...(item.lines.length > 1 ? [docxTime(model, { time: line.time }), run('  ')] : []), ...docxText(line.text)], { widowControl: true }));
      } else {
        children.push(para([docxTime(model, item), run('  '), ...(item.speaker ? [run(`${item.speaker}: `, { bold: true })] : []), ...docxText(item.text)], { widowControl: true }));
      }
    }
  }
  return children;
}

async function docxReport(model) {
  const document = new Document({
    creator: 'Audio Toolkit', title: model.project.name, subject: `Báo cáo ${model.profile.name.toLowerCase()}`,
    styles: { default: { document: { run: { font: 'Arial', size: 21, color: C.ink }, paragraph: { spacing: { after: 100, line: 276 } } } },
      paragraphStyles: [{ id: 'Title', name: 'Title', basedOn: 'Normal', next: 'Normal', run: { color: '000000', size: 36, bold: true }, paragraph: { spacing: { after: 100 } } }],
    },
    sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1000, right: 1080, bottom: 1000, left: 1080 } } },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [run('Audio Toolkit  ·  Trang ', { size: 16, color: C.muted }), new TextRun({ children: [PageNumber.CURRENT], font: 'Arial', size: 16, color: C.muted })] })] }) },
      children: docxBody(model),
    }],
  });
  return Packer.toBuffer(document);
}

function pdfReport(model) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const doc = new PDFDocument({ size: 'A4', bufferPages: true, margins: { top: 50, right: 54, bottom: 52, left: 54 }, info: { Title: model.project.name, Author: 'Audio Toolkit', Subject: `Báo cáo ${model.profile.name.toLowerCase()}` } });
    doc.on('data', chunk => chunks.push(chunk)); doc.on('error', reject); doc.on('end', () => resolve(Buffer.concat(chunks)));
    try {
      doc.registerFont('Body', path.join(root, 'server/fonts/BeVietnamPro-Regular.ttf'));
      doc.registerFont('Bold', path.join(root, 'server/fonts/BeVietnamPro-Bold.ttf'));
      const left = doc.page.margins.left, width = doc.page.width - left - doc.page.margins.right;
      const bottom = () => doc.page.height - doc.page.margins.bottom;
      const text = (value, { size = 10, bold = false, color = C.ink, after = 5, ...options } = {}) => {
        doc.font(bold ? 'Bold' : 'Body').fontSize(size).fillColor(`#${color}`).text(String(value).normalize('NFC'), left, doc.y, { width, lineGap: 3, ...options });
        doc.y += after;
      };
      const room = height => { if (doc.y + height > bottom()) doc.addPage(); };
      const measure = (value, size = 10, bold = false) => doc.font(bold ? 'Bold' : 'Body').fontSize(size).heightOfString(String(value || '').normalize('NFC'), { width, lineGap: 3 });
      const firstText = item => item.text ?? item.lines?.[0]?.text ?? '';
      const stampLabel = item => `[${rangeText(item)}]${item.speaker ? `  ${item.speaker}` : ''}`;
      const stampHeight = (item, followingText = firstText(item)) => measure(stampLabel(item), 9, true) + 2 +
        (item.lines?.length > 1 ? measure('[00:00]', 9, true) + 2 : 0) + Math.min(measure(followingText), 34) + 5;
      const stamp = (item, followingText) => {
        // Keep a turn label with at least two following lines; allow long text to split naturally.
        room(stampHeight(item, followingText));
        text(stampLabel(item), { size: 9, color: C.accent, bold: true, link: model.url(item.time), underline: true, after: 2 });
      };
      text(model.project.name, { size: 24, bold: true, color: '000000', after: 8 });
      text(`Báo cáo ${model.profile.name.toLowerCase()}  ·  Audio Toolkit`, { size: 10, color: C.muted, after: 18 });
      for (const [label, value] of model.metadata) text(`${label}: ${value}`, { size: 9, after: 1 });
      doc.y += 10;
      text('Báo cáo gồm nội dung bản thu và ghi chú của bạn. Tóm tắt và ý chính được trích từ transcript, giữ ngôn ngữ bản thu.', { size: 9, color: C.muted, after: 5 });
      text('Nhấn mốc thời gian để mở lại bản thu trên máy này. Cần chạy Audio Toolkit và giữ dự án gốc.', { size: 8, color: C.muted, after: 8 });
      if (model.status === 'stale') text('Tóm tắt chưa cập nhật. Tóm tắt, chương và ý chính có thể chưa khớp với transcript đã sửa.', { size: 9, bold: true, color: C.warning, after: 8 });
      for (const key of model.profile.sections) {
        const items = model.sections[key];
        room(10 + measure(sectionNames[key], 14, true) + 9 + (items.length ? stampHeight(items[0]) : measure(emptyText[key]) + 5));
        doc.y += 10;
        text(sectionNames[key], { size: 14, bold: true, color: '000000', after: 9 });
        if (!items.length) { text(emptyText[key], { color: C.muted }); continue; }
        for (const item of items) {
          stamp(item);
          if (key === 'transcript') for (const line of item.lines) {
            if (item.lines.length > 1) stamp({ time: line.time }, line.text);
            text(line.text);
          }
          else text(item.text);
        }
      }
      const pages = doc.bufferedPageRange();
      for (let index = pages.start; index < pages.start + pages.count; index++) {
        doc.switchToPage(index);
        // PDFKit still wraps text with an explicit width. Temporarily extend the
        // writable area so a footer below the body margin cannot add a blank page.
        const margin = doc.page.margins.bottom;
        doc.page.margins.bottom = 0;
        doc.font('Body').fontSize(8).fillColor(`#${C.muted}`).text(`Audio Toolkit  ·  Trang ${index + 1} / ${pages.count}`, left, doc.page.height - 30, { width, align: 'center', lineBreak: false });
        doc.page.margins.bottom = margin;
      }
      doc.end();
    } catch (error) { doc.destroy(); reject(error); }
  });
}

export async function createReport(input, format, options = {}) {
  if (!['docx', 'pdf'].includes(format)) throw new Error('Định dạng báo cáo không hợp lệ.');
  const model = modelFor(input, options);
  if (format === 'pdf') {
    pdfCharacters ||= new Set(openSync(path.join(root, 'server/fonts/BeVietnamPro-Regular.ttf')).characterSet);
    const values = [model.project.name, ...model.metadata.flatMap(pair => pair), ...Object.values(model.sections).flatMap(items => items.flatMap(item => [item.speaker || '', item.text || '', ...(item.lines || []).map(line => line.text)]))];
    const unsupported = Array.from(values.join('').normalize('NFC')).find(character => character.codePointAt(0) >= 32 && !/[\s\p{Cf}]/u.test(character) && !pdfCharacters.has(character.codePointAt(0)));
    if (unsupported) throw Object.assign(new Error(`PDF chưa hỗ trợ ký tự “${unsupported}” trong báo cáo này. Chọn DOCX để giữ đầy đủ nội dung.`), { status: 400 });
  }
  return { buffer: await (format === 'docx' ? docxReport(model) : pdfReport(model)),
    filename: reportFilename(model.project.name, format),
    mime: format === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/pdf',
  };
}
