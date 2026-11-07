import test from 'node:test';
import assert from 'node:assert/strict';
import { buildInsights, insightsAreCurrent, transcriptFingerprint } from '../public/insights.js';
import { createExport } from '../public/exports.js';

const sentences = [
  'Xin chào các bạn.',
  'Để ghi âm podcast rõ hơn, chúng ta cần chọn một căn phòng yên tĩnh.',
  'Micro nên đặt cách miệng khoảng 15 cm để giảm tiếng bật hơi.',
  'Hãy thu thử 30 giây và nghe lại trước khi bắt đầu cuộc phỏng vấn.',
  'Một bản thu dự phòng sẽ giúp tránh mất cuộc trò chuyện khi thiết bị gặp lỗi.',
  'Micro nên đặt cách miệng khoảng 15 cm để giảm tiếng bật hơi.',
  'Tiếp theo, chúng ta chuyển sang cách chuẩn bị câu hỏi phỏng vấn.',
  'Câu hỏi mở giúp khách mời kể câu chuyện bằng trải nghiệm của họ.',
  'Người phỏng vấn cần lắng nghe và hỏi tiếp từ câu trả lời của khách mời.',
  'Hãy hỏi về một ví dụ cụ thể thay vì chỉ yêu cầu những nhận xét chung.',
  'Cuối cùng, biên tập podcast cần giữ nguyên ngữ cảnh của lời nói.',
  'Không nên cắt bỏ phần giải thích làm thay đổi ý nghĩa câu trả lời.',
  'Kiểm tra sự đồng ý của khách mời trước khi xuất bản bản thu.',
  'Cảm ơn các bạn đã lắng nghe.'
];
const project = { name: 'Phỏng vấn tiếng Việt', duration: 210, language: 'vi',
  speakers: [{ id: 's1', name: 'Người dẫn', color: '#7472e9' }, { id: 's2', name: 'Khách mời', color: '#ec8068' }],
  transcript: sentences.map((text, index) => ({ id: `line-${index}`, time: index * 15, end: index * 15 + 12,
    text, speaker: index % 2 ? 's1' : 's2', confidence: 95 })),
  notes: [{ id: 'note-1', time: 45, text: 'Nhớ thu thử trước buổi phỏng vấn.' }] };

test('Vietnamese passages keep exact source text, source timing and anonymous speaker IDs', () => {
  const result = buildInsights(project);
  assert.ok(result.summary.length > 0 && result.summary.length <= 3);
  assert.ok(result.highlights.length > 2 && result.highlights.length <= 8);
  for (const passage of [...result.summary, ...result.highlights]) {
    const source = project.transcript.find(line => line.id === passage.sourceIds[0]);
    assert.ok(source.text.includes(passage.text));
    assert.equal(passage.time, source.time); assert.equal(passage.end, source.end);
    assert.equal(passage.speaker, source.speaker);
    assert.ok(result.chapters.some(chapter => chapter.id === passage.chapterId));
  }
  assert.equal(new Set(result.highlights.map(point => point.text)).size, result.highlights.length);
  assert.ok(result.highlights.some(point => /15 cm|30 giây/.test(point.text)), 'Concrete recording advice is represented');
  assert.ok(result.highlights.some(point => /câu hỏi|lắng nghe|câu trả lời/i.test(point.text)), 'Interview topic is represented');
});

test('chapters cover the recording with ordered, nonempty ranges and exactly one reference per line', () => {
  const chapters = buildInsights(project).chapters;
  assert.ok(chapters.length >= 2 && chapters.length <= 12);
  assert.equal(chapters[0].start, 0); assert.equal(chapters.at(-1).end, project.duration);
  for (let index = 0; index < chapters.length; index++) {
    assert.ok(chapters[index].end > chapters[index].start);
    assert.ok(chapters[index].sourceIds.length);
    if (index) assert.equal(chapters[index - 1].end, chapters[index].start);
  }
  const ids = chapters.flatMap(chapter => chapter.sourceIds);
  assert.equal(new Set(ids).size, project.transcript.length);
  assert.deepEqual(ids, project.transcript.map(line => line.id));
});

test('freshness depends on transcript text, timestamps and speaker assignments, not notes or display names', () => {
  const complete = { ...project, insights: buildInsights(project) };
  assert.equal(insightsAreCurrent(complete), true);
  assert.equal(insightsAreCurrent({ ...complete, notes: [], speakers: [] }), true);
  for (const patch of [{ text: 'Nội dung đã sửa' }, { time: .1 }, { end: 13 }, { speaker: 'new-person' }]) {
    const transcript = [{ ...complete.transcript[0], ...patch }, ...complete.transcript.slice(1)];
    assert.equal(insightsAreCurrent({ ...complete, transcript }), false);
  }
  assert.notEqual(transcriptFingerprint([]), transcriptFingerprint(project.transcript));
});

test('empty, punctuation-only and brief recordings produce honest bounded output', () => {
  assert.throws(() => buildInsights({ ...project, transcript: [] }), /transcript/);
  const brief = { ...project, duration: .5, transcript: [{ ...project.transcript[0], time: 0, end: .5, text: 'Đồng ý.' }] };
  const result = buildInsights(brief);
  assert.equal(result.chapters.length, 1); assert.equal(result.chapters[0].end, .5);
  assert.equal(result.highlights[0].text, 'Đồng ý.');
  assert.throws(() => buildInsights({ ...brief, transcript: [{ ...brief.transcript[0], text: '...' }] }), /transcript/);
});

test('long recordings use a bounded graph and retain material near the end', () => {
  const long = { ...project, duration: 7200,
    transcript: Array.from({ length: 2400 }, (_, index) => ({ id: `long-${index}`, time: index * 3, end: index * 3 + 2.5,
      text: index > 1800 ? `Cuối buổi họp cần giao nhiệm vụ ngân sách ${index} triệu đồng cho nhóm tài chính.` : `${sentences[index % sentences.length]} Nội dung ${index}.`, speaker: `s${index % 2 + 1}` })) };
  const result = buildInsights(long);
  assert.ok(result.highlights.some(point => point.time > 5400));
  assert.equal(result.chapters.at(-1).end, 7200);
  assert.ok(result.highlights.length <= 8);
});

test('TXT and JSON include summary, chapters, highlights, Unicode and stale status; subtitles remain transcript only', () => {
  const complete = { ...project, insights: buildInsights(project), audioUrl: '/private-audio', files: { original: 'private' }, words: ['private'] };
  const text = createExport(complete, 'txt').content;
  for (const label of ['TÓM TẮT', 'CHƯƠNG NỘI DUNG', 'Ý CHÍNH', 'TRANSCRIPT', 'GHI CHÚ', project.notes[0].text]) assert.ok(text.includes(label));
  const json = JSON.parse(createExport(complete, 'json').content);
  assert.equal(json.schemaVersion, 2); assert.equal(json.insights.stale, false);
  assert.equal(json.audioUrl, undefined); assert.equal(json.files, undefined); assert.equal(json.words, undefined);
  const stale = { ...complete, transcript: [{ ...complete.transcript[0], text: 'Đã sửa' }, ...complete.transcript.slice(1)] };
  assert.equal(JSON.parse(createExport(stale, 'json').content).insights.stale, true);
  assert.match(createExport(stale, 'txt').content, /CHƯA CẬP NHẬT/);
  for (const type of ['srt', 'vtt']) {
    const content = createExport(complete, type).content;
    assert.equal((content.match(/ --> /g) || []).length, complete.transcript.length);
    assert.ok(!content.includes('TÓM TẮT'));
  }
});
