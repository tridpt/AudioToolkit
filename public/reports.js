import { insightsAreCurrent } from './insights.js';

export const REPORT_LAYOUTS = {
  podcast: { name: 'Podcast', sections: ['summary', 'chapters', 'highlights', 'notes', 'transcript'] },
  lesson: { name: 'Bài giảng', sections: ['summary', 'highlights', 'notes', 'chapters', 'transcript'] },
  interview: { name: 'Phỏng vấn', sections: ['summary', 'transcript', 'highlights', 'notes', 'chapters'] },
};

export function reportSnapshot(project) {
  const keys = ['id', 'name', 'fileName', 'duration', 'format', 'sampleRate', 'channels', 'createdAt', 'language', 'speakers', 'transcript', 'notes', 'insights'];
  return structuredClone(Object.fromEntries(keys.filter(key => project[key] !== undefined).map(key => [key, project[key]])));
}

export function reportFilename(name, format) {
  const base = String(name || '').replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || 'audio-toolkit';
  return `${base}-bao-cao.${format}`;
}

export function reportStatus(project) {
  return !project.insights ? 'missing' : insightsAreCurrent(project) ? 'current' : 'stale';
}

export function reportTimestampUrl(baseUrl, projectId, time) {
  const url = new URL('/', baseUrl);
  url.searchParams.set('project', projectId);
  url.searchParams.set('t', String(Math.max(0, Number(time) || 0)));
  return url.href;
}

// Group consecutive turns only, preserving dialogue order and each source segment.
export function transcriptTurns(project) {
  const turns = [];
  const lines = [...project.transcript].sort((a, b) => a.time - b.time || a.end - b.end);
  for (const line of lines) {
    const previous = turns.at(-1);
    if (previous?.speaker === line.speaker && line.time <= previous.end + 2) {
      previous.lines.push(line); previous.end = Math.max(previous.end, line.end);
    } else turns.push({ speaker: line.speaker, time: line.time, end: line.end, lines: [line] });
  }
  return turns;
}
