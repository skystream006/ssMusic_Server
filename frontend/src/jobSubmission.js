export async function submitJobUrl(url, { request, user, confirm, library = false, metadataOnly = false, downloadType = 'audio' }) {
  if (downloadType === 'video' && !await confirm({
    title: 'Video job',
    message: "Video jobs should be used for movies or series. For song videos, run an Audio job and individually use 'Retrieve song video' to maintain audio rating and metadata features.",
    action: 'video', label: 'Continue'
  })) return null;
  try {
    const job = await request('/api/jobs', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: url.trim(), metadataOnly, downloadType })
    });
    return { job, created: true };
  } catch (error) {
    if (error.code !== 'JOB_ALREADY_EXISTS' || !error.existingJob) throw error;
    const previous = error.existingJob;
    const isMember = user.id === previous.initiatedBy?.id || previous.contributors?.some((contributor) => contributor.id === user.id);
    if (library && !isMember) throw new Error('This URL belongs to another user. Its owner must add you as a contributor before it can appear in your library.');
    const canModify = user.role === 'admin' || user.id === previous.initiatedBy?.id
      || previous.contributors?.some((contributor) => contributor.id === user.id);
    const active = previous.status === 'queued' || previous.status === 'running';
    if (!canModify || active) {
      const accepted = await confirm({ title: active ? 'Job already active' : 'Job already exists',
        message: library ? 'This URL already has a job. Add its playlist to your library?'
          : 'This URL already has a job. Open its details?', action: 'open', label: library ? 'Add Playlist' : undefined });
      return accepted ? { job: previous, created: false } : null;
    }
    if (!await confirm({ title: 'Job already exists',
      message: `This URL was used in job ${previous.playlistTitle || previous.id}. Rerun it, keeping existing files and downloading missing ones?`, action: 'rerun' })) return null;
    const job = await request(`/api/jobs/${encodeURIComponent(previous.id)}/rerun`, { method: 'POST' });
    return { job, created: false };
  }
}