export function batchProgress(job) {
  if (job.status === 'completed') return 1;
  const stages = job.kind === 'all' ? ['noise', 'transcript', 'speakers'] : [job.kind];
  const index = Math.max(0, stages.indexOf(job.stage));
  return job.progress == null ? null : Math.min(1, (index + Math.max(0, Math.min(1, job.progress))) / stages.length);
}
