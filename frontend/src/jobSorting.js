import { countDownloadedFiles } from '../../src/library.js';

export const jobSortColumns = [
  { key: 'title', label: 'Playlist Title', value: (job) => job.playlistTitle || 'Preparing playlist' },
  { key: 'format', label: 'Format', value: (job) => job.isPlaylist ? 'Playlist' : 'Track' },
  { key: 'status', label: 'Status', value: (job) => job.status?.replaceAll('_', ' ') },
  { key: 'created', label: 'Created', value: (job) => Date.parse(job.createdAt) },
  { key: 'songs', label: 'Songs', value: (job) => job.isPlaylist ? job.playlistSongCount : 1 },
  { key: 'files', label: 'Files', value: (job) => countDownloadedFiles(job.files) },
  { key: 'size', label: 'Total Size', value: (job) => job.totalSizeBytes },
  { key: 'initiator', label: 'Initiated by', value: (job) => job.initiatedBy?.name || 'Unknown' }
];

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
const isMissing = (value) => value == null || (typeof value === 'number' && !Number.isFinite(value));

export function sortJobs(jobs, key = 'created', direction = 'desc') {
  const column = jobSortColumns.find((option) => option.key === key) || jobSortColumns.find((option) => option.key === 'created');
  return jobs.map((job) => ({ job, value: column.value(job) })).sort((left, right) => {
    const leftMissing = isMissing(left.value);
    const rightMissing = isMissing(right.value);
    if (leftMissing || rightMissing) return Number(leftMissing) - Number(rightMissing);
    const comparison = typeof left.value === 'number'
      ? left.value - right.value
      : collator.compare(left.value, right.value);
    return direction === 'desc' ? -comparison : comparison;
  }).map(({ job }) => job);
}