// Shared by the API and the demo. Every selected passage keeps its transcript source.
export const INSIGHTS_VERSION = 1;
const STOP = new Set(`a an and are as at be been but by can could did do does for from had has have he her here him his how i if in into is it its just like me more my no not of on one or our out she so some than that the their them then there these they this those to too us was we were what when where which who why will with would you your about back today thank thanks welcome very also actually
à ạ ai anh ấy bạn bao bây bị bởi các cái cả càng chỉ cho chúng chưa có cô của cũng đã đang đây để đến đều điều đó được em gì hết hơn họ khi không lại là làm lên lúc mà một mình mỗi này nên nếu người nhiều những như nhưng ở ông phải qua ra rằng rất rồi sẽ sự sao sau thôi thì theo thêm thể thế tại tới trên trong từ từng và vẫn vào vậy về vì việc với vừa xin nhé nha vâng ừ`.split(/\s+/));
const TRANSITION = /^(tiếp theo|chuyển sang|bây giờ|về phần|chủ đề tiếp|mặt khác|cuối cùng|next\b|now let|moving on|turning to|finally\b)/iu;
const FILLER = /^(xin chào|chào (bạn|mừng)|cảm ơn|tạm biệt|welcome\b|thank(s| you)\b|i like that\b|okay\b|yes\b)|\bnext episode\b|hẹn gặp lại/iu;
const clean = text => String(text || '').replace(/\s+/gu, ' ').trim();
function excerpt(text, limit) {
  if (text.length <= limit) return text;
  const cut = text.lastIndexOf(' ', limit);
  return text.slice(0, cut > limit / 2 ? cut : limit).trim();
}

export function transcriptFingerprint(transcript = []) {
  let a = 2166136261, b = 5381;
  for (const line of transcript) {
    const value = JSON.stringify([line.id, line.time, line.end, line.speaker, line.text]);
    for (let i = 0; i < value.length; i++) {
      a = Math.imul(a ^ value.charCodeAt(i), 16777619) >>> 0;
      b = (Math.imul(b, 33) ^ value.charCodeAt(i)) >>> 0;
    }
  }
  return `v${INSIGHTS_VERSION}-${transcript.length}-${a.toString(16)}-${b.toString(16)}`;
}
export function insightsAreCurrent(project) {
  return !!project.insights && project.insights.version === INSIGHTS_VERSION &&
    project.insights.sourceFingerprint === transcriptFingerprint(project.transcript);
}

function terms(text) {
  const words = text.normalize('NFC').toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  const counts = new Map();
  const useful = word => word && !STOP.has(word) && (word.length > 1 || /\p{N}/u.test(word));
  const add = (term, weight) => counts.set(term, (counts.get(term) || 0) + weight);
  for (let i = 0; i < Math.min(words.length, 300); i++) {
    if (useful(words[i])) add(words[i], 1);
    if (useful(words[i]) && useful(words[i + 1])) add(`${words[i]} ${words[i + 1]}`, .8);
  }
  return counts;
}
function vector(counts, frequencies, total) {
  const result = new Map(); let norm = 0;
  for (const [term, count] of counts) {
    const weight = Math.sqrt(count) * (1 + Math.log((total + 1) / ((frequencies.get(term) || 0) + 1)));
    result.set(term, weight); norm += weight * weight;
  }
  norm = Math.sqrt(norm) || 1;
  for (const [term, weight] of result) result.set(term, weight / norm);
  return result;
}
function cosine(a, b) {
  if (a.size > b.size) [a, b] = [b, a];
  let score = 0; for (const [term, weight] of a) score += weight * (b.get(term) || 0);
  return score;
}
function combined(units) {
  const counts = new Map();
  for (const unit of units) for (const [term, weight] of unit.vector) counts.set(term, (counts.get(term) || 0) + weight);
  const norm = Math.sqrt([...counts.values()].reduce((sum, value) => sum + value * value, 0)) || 1;
  for (const [term, value] of counts) counts.set(term, value / norm);
  return counts;
}

function splitChapters(units, duration) {
  const span = units.at(-1).end - units[0].time;
  const count = Math.min(12, Math.max(1, Math.round(Math.sqrt(span / 25))), Math.max(1, Math.floor(units.length / 3)));
  const boundaries = [0]; const target = Math.max(1, span / count);
  for (let part = 1; part < count; part++) {
    const expected = units[0].time + part * target;
    let best = -1, score = -Infinity;
    for (let i = boundaries.at(-1) + 1; i < units.length - (count - part - 1); i++) {
      if (Math.abs(units[i].time - expected) > target * .48) continue;
      const before = units[i].time - units[boundaries.at(-1)].time;
      if (before < Math.min(12, target * .45)) continue;
      const contrast = 1 - cosine(combined(units.slice(Math.max(0, i - 3), i)), combined(units.slice(i, i + 3)));
      const gap = Math.max(0, units[i].time - units[i - 1].end);
      const value = contrast + Math.min(.3, gap / 10) + (TRANSITION.test(units[i].text) ? .3 : 0) - .6 * Math.abs(units[i].time - expected) / target;
      if (value > score) { score = value; best = i; }
    }
    if (best > 0) boundaries.push(best);
  }
  boundaries.push(units.length);
  return boundaries.slice(0, -1).map((offset, index) => {
    const group = units.slice(offset, boundaries[index + 1]);
    const representative = group.reduce((best, unit) => unit.salience > best.salience ? unit : best);
    const titleSentence = representative.text.match(/^.*?[.!?。！？](?:\s|$)/u)?.[0] || representative.text;
    const title = excerpt(titleSentence, 78);
    return { id: `chapter-${index + 1}`, start: index ? group[0].time : 0,
      end: index === boundaries.length - 2 ? duration : units[boundaries[index + 1]].time,
      title: title + (title.length < titleSentence.length ? '…' : ''), sourceIds: group.map(unit => unit.sourceIds[0]) };
  });
}

export function buildInsights(project) {
  const duration = Number(project.duration);
  const units = (project.transcript || []).filter(line => /[\p{L}\p{N}]/u.test(clean(line.text)) && Number.isFinite(line.time) &&
    Number.isFinite(line.end) && Math.min(duration, line.end) > line.time && line.time >= 0 && line.end <= duration + .1)
    .map((line, index) => ({ id: `idea-${index + 1}`, text: excerpt(clean(line.text), 1200), time: line.time,
      end: Math.min(duration, line.end), speaker: line.speaker, sourceIds: [line.id] }))
    .sort((a, b) => a.time - b.time || a.end - b.end);
  if (!units.length) throw new Error('Cần transcript có nội dung trước khi tạo tóm tắt.');

  const frequencies = new Map();
  for (const unit of units) {
    unit.terms = terms(unit.text);
    for (const term of unit.terms.keys()) frequencies.set(term, (frequencies.get(term) || 0) + 1);
  }
  for (const unit of units) unit.vector = vector(unit.terms, frequencies, units.length);
  const centroid = combined(units);
  for (const unit of units) {
    unit.salience = cosine(unit.vector, centroid) * (.65 + .35 * Math.min(1, unit.text.length / 100)) * (FILLER.test(unit.text) ? .3 : 1);
    // A small bonus preserves concrete figures and recommendations in otherwise rare topics.
    if (/\d|nên\b|cần\b|hãy\b|should\b|must\b/iu.test(unit.text)) unit.salience += .025;
  }
  const chapters = splitChapters(units, duration);
  const sourceChapters = new Map(chapters.flatMap(chapter => chapter.sourceIds.map(id => [id, chapter.id])));
  for (const unit of units) unit.chapterId = sourceChapters.get(unit.sourceIds[0]);

  // Bound the graph, retaining the strongest passage from each chronological window.
  const candidates = [];
  const width = Math.max(1, Math.ceil(units.length / 280));
  for (let i = 0; i < units.length; i += width) {
    candidates.push(units.slice(i, i + width).reduce((best, unit) => unit.salience > best.salience ? unit : best));
  }
  const n = candidates.length;
  const edges = Array.from({ length: n }, () => []), sums = Array(n).fill(0);
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const weight = cosine(candidates[i].vector, candidates[j].vector);
    if (weight < .06) continue;
    edges[i].push([j, weight]); edges[j].push([i, weight]); sums[i] += weight; sums[j] += weight;
  }
  let rank = Array(n).fill(1 / n);
  for (let iteration = 0; iteration < 18; iteration++) {
    const dangling = rank.reduce((sum, value, index) => sum + (sums[index] ? 0 : value), 0);
    rank = edges.map(neighbors => (1 - .85) / n + .85 * dangling / n + .85 * neighbors.reduce((sum, [j, weight]) => sum + rank[j] * weight / sums[j], 0));
  }
  const maxRank = Math.max(...rank), maxSalience = Math.max(...candidates.map(unit => unit.salience), .001);
  const scored = candidates.map((unit, index) => ({ ...unit,
    score: (.55 * unit.salience / maxSalience + .45 * rank[index] / maxRank) * (.5 + .5 * Math.min(1, unit.text.length / 100)) * (FILLER.test(unit.text) ? .5 : 1) }));
  const target = Math.min(8, Math.max(3, Math.ceil(Math.sqrt(units.length))));
  const selected = [];
  while (selected.length < Math.min(target, scored.length)) {
    let best = null, value = -Infinity;
    for (const unit of scored) {
      if (selected.includes(unit)) continue;
      const duplicate = selected.some(other => other.text.toLocaleLowerCase() === unit.text.toLocaleLowerCase() || cosine(other.vector, unit.vector) > .86);
      if (duplicate) continue;
      const similarity = Math.max(0, ...selected.map(other => cosine(other.vector, unit.vector)));
      const coverage = (selected.some(other => other.chapterId === unit.chapterId) ? 0 : .2) +
        (selected.some(other => other.speaker === unit.speaker) ? 0 : .18);
      const score = unit.score - .65 * similarity + coverage;
      if (score > value) { value = score; best = unit; }
    }
    if (!best) break;
    selected.push(best);
  }
  const passage = ({ id, text, time, end, speaker, sourceIds, chapterId }) => ({ id, text, time, end, speaker, sourceIds, chapterId });
  const order = (a, b) => a.time - b.time || a.end - b.end;
  const highlights = selected.map(passage).sort(order);
  const summary = selected.slice(0, Math.min(3, selected.length)).map(passage).sort(order);
  return { version: INSIGHTS_VERSION, method: 'extractive-textrank', generatedAt: new Date().toISOString(),
    sourceFingerprint: transcriptFingerprint(project.transcript), language: project.language || null,
    summary, chapters, highlights };
}
