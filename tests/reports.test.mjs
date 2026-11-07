import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { buildInsights } from '../public/insights.js';
import { REPORT_LAYOUTS, reportFilename, reportSnapshot, reportStatus, reportTimestampUrl, transcriptTurns } from '../public/reports.js';
import { createReport, reportRequestSchema } from '../server/report.mjs';

const project = {
  id: 'demo', name: 'Phỏng vấn “Nghề dạy học”', fileName: 'bài giảng & phỏng vấn.wav', duration: 75,
  createdAt: '2026-10-24T02:30:00.000Z', language: 'vi', format: 'WAV', sampleRate: 16000, channels: 1,
  speakers: [{ id: 's1', name: 'Cô Hương', color: '#7472e9' }, { id: 's2', name: 'Minh & An', color: '#ec8068' }],
  transcript: [
    { id: 'a', time: 0, end: 10, speaker: 's1', text: 'Bài giảng hôm nay nói về tiếng Việt.\nVí dụ: ă â đ ê ô ơ ư ắ ằ ặ ễ ỗ ỡ ự.', confidence: null },
    { id: 'b', time: 10.5, end: 15, speaker: 's1', text: 'Cần giữ nguyên chữ <mở> & dấu nháy khi xuất.', confidence: 95 },
    { id: 'c', time: 15, end: 35, speaker: 's2', text: 'Chúng em muốn hỏi cách chuẩn bị một cuộc phỏng vấn.', confidence: 95 },
    { id: 'd', time: 40, end: 60, speaker: 's1', text: 'Hãy chọn câu hỏi mở để người trả lời chia sẻ trải nghiệm cụ thể.', confidence: 95 },
    { id: 'e', time: 65, end: 75, speaker: 's1', text: 'Cảm ơn các bạn đã lắng nghe bài giảng.', confidence: 95 },
  ],
  notes: [{ id: 'n2', time: 45, text: 'Ý chính: giữ nguyên tiếng Việt và ngữ cảnh.' }, { id: 'n1', time: 10.5, text: 'Trích dẫn: “Học từ một ví dụ cụ thể”.' }],
};
project.insights = buildInsights(project);
const options = { exportedAt: '2026-10-24T04:00:00.000Z', baseUrl: 'http://127.0.0.1:4188' };
const xmlFrom = async report => (await JSZip.loadAsync(report.buffer)).file('word/document.xml').async('string');

test('report snapshots keep the current draft and omit audio, file paths and word data', () => {
  const snapshot = reportSnapshot({ ...project, files: { original: 'private.wav' }, words: ['private'], audioUrl: '/private-audio' });
  assert.equal(snapshot.files, undefined); assert.equal(snapshot.words, undefined); assert.equal(snapshot.audioUrl, undefined);
  snapshot.transcript[0].text = 'Đã sửa bản nháp';
  assert.notEqual(snapshot.transcript[0].text, project.transcript[0].text);
  assert.equal(reportStatus(project), 'current');
  assert.equal(reportStatus(snapshot), 'stale');
  assert.equal(reportStatus({ ...project, insights: null }), 'missing');
});

test('turn grouping keeps chronological dialogue, each source line, and long pauses', () => {
  const turns = transcriptTurns({ ...project, transcript: [...project.transcript].reverse() });
  assert.deepEqual(turns.map(turn => turn.lines.map(line => line.id)), [['a', 'b'], ['c'], ['d'], ['e']]);
  assert.equal(turns[0].end, 15);
  assert.deepEqual(turns.flatMap(turn => turn.lines), project.transcript);
});

test('DOCX contains all sections, Vietnamese, names, timing links and safe XML in every layout', async () => {
  for (const layout of Object.keys(REPORT_LAYOUTS)) {
    const report = await createReport(project, 'docx', { ...options, layout });
    assert.equal(report.buffer.subarray(0, 2).toString(), 'PK');
    assert.match(report.mime, /wordprocessingml/);
    const zip = await JSZip.loadAsync(report.buffer), xml = await zip.file('word/document.xml').async('string');
    for (const value of ['Cô Hương', 'Minh &amp; An', 'ă â đ ê ô ơ ư ắ ằ ặ ễ ỗ ỡ ự', '&lt;mở&gt; &amp;', '00:10', '00:15', project.notes[0].text, project.notes[1].text, 'File nguồn', 'Ngày xuất']) assert.ok(xml.includes(value), value);
    for (const item of project.insights.summary) assert.ok(xml.includes(item.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')));
    const labels = { summary: 'Tóm tắt nội dung', chapters: 'Chương nội dung', highlights: 'Ý chính có mốc thời gian', transcript: 'Transcript theo người nói', notes: 'Ghi chú' };
    const positions = REPORT_LAYOUTS[layout].sections.map(key => xml.indexOf(`>${labels[key]}<`));
    assert.ok(positions.every(value => value > 0));
    assert.deepEqual([...positions].sort((a, b) => a - b), positions);
    const rels = await zip.file('word/_rels/document.xml.rels').async('string');
    assert.match(rels, /project=demo&amp;t=10\.5/);
    assert.match(rels, /TargetMode="External"/);
    assert.match(xml, /w:pStyle w:val="Title"/);
    assert.match(xml, /w:keepNext/);
    assert.match(xml, /w:br\//, 'User-authored paragraph breaks are retained.');
  }
});

test('stale summaries are marked and missing content is explicit without invented summaries', async () => {
  const stale = reportSnapshot(project); stale.transcript[0].text = 'Nội dung đã sửa sau khi tạo tóm tắt.';
  const xml = await xmlFrom(await createReport(stale, 'docx', options));
  assert.ok(xml.includes(stale.transcript[0].text)); assert.match(xml, /Tóm tắt chưa cập nhật/);
  const empty = { ...project, transcript: [], notes: [], speakers: [], insights: null };
  const emptyXml = await xmlFrom(await createReport(empty, 'docx', options));
  for (const message of ['Chưa tạo tóm tắt', 'Chưa có chương', 'Chưa có ý chính', 'Chưa có transcript', 'Chưa có ghi chú']) assert.ok(emptyXml.includes(message));
});

test('PDF embeds Unicode fonts, timestamp links and page numbers and handles long passages', async () => {
  const long = { ...project, insights: null, transcript: [{ ...project.transcript[0], end: 75, text: ('Lời giảng tiếng Việt có dấu và ngữ cảnh đầy đủ. ').repeat(95) }] };
  const report = await createReport(long, 'pdf', { ...options, layout: 'interview' });
  const source = report.buffer.toString('latin1');
  assert.equal(source.slice(0, 5), '%PDF-'); assert.equal(report.mime, 'application/pdf');
  assert.match(source, /\/FontFile2/); assert.match(source, /\/ToUnicode/);
  assert.match(source, /\/URI \(http:\/\/127\.0\.0\.1:4188\/\?project=demo&t=0\)/);
  assert.ok((source.match(/\/Type \/Page\b/g) || []).length >= 2);
  const empty = await createReport({ ...project, transcript: [], notes: [], insights: null }, 'pdf', options);
  assert.equal((empty.buffer.toString('latin1').match(/\/Type \/Page\b/g) || []).length, 1, 'Footers must not create extra blank pages.');
});

test('report input validation rejects unknown formats, bad references, times and malformed insights', () => {
  assert.equal(reportRequestSchema.parse({ format: 'pdf' }).layout, 'podcast');
  for (const patch of [{ format: 'html' }, { layout: 'custom' }, { path: '../secret' }, { project: { ...project, transcript: [{ ...project.transcript[0], end: 100 }] } },
    { project: { ...project, transcript: [{ ...project.transcript[0], speaker: 'unknown' }] } }, { project: { ...project, insights: { summary: 'not-an-array' } } },
    { project: { ...project, notes: [{ ...project.notes[0], time: Infinity }] } }]) {
    assert.equal(reportRequestSchema.safeParse({ format: 'docx', ...patch }).success, false);
  }
});

test('unsupported PDF glyphs produce a useful error while DOCX retains the source text', async () => {
  const otherLanguage = { ...project, insights: null, transcript: [{ ...project.transcript[0], text: '日本語のインタビュー' }] };
  await assert.rejects(createReport(otherLanguage, 'pdf', options), error => error.status === 400 && /Chọn DOCX/.test(error.message));
  assert.ok((await xmlFrom(await createReport(otherLanguage, 'docx', options))).includes('日本語のインタビュー'));
});

test('download names and timestamp URLs preserve Vietnamese and reject path or header controls', () => {
  assert.equal(reportFilename('Bài giảng / phỏng vấn\r\n"1"', 'pdf'), 'Bài giảng - phỏng vấn---1--bao-cao.pdf');
  assert.equal(reportFilename('', 'docx'), 'audio-toolkit-bao-cao.docx');
  assert.equal(reportTimestampUrl(options.baseUrl, 'demo', 10.5), 'http://127.0.0.1:4188/?project=demo&t=10.5');
  assert.equal(new URL(reportTimestampUrl(options.baseUrl, 'demo', -5)).searchParams.get('t'), '0');
});
