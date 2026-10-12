import fs from 'node:fs/promises';
import { ensureKaraokePartyUser } from './authStore.js';
import { createJob, getJob, getJobs, getFilePath, isFileInsideJobFolder, isValidJobFileName } from './jobManager.js';
import { linkLibraryJob } from './libraryStore.js';
import { mediaType } from './media.js';
import { canReadAllFiles } from './privacy.js';
import { normalizeVideoUrl } from './utils.js';

async function jobResponse(job, duplicate) {
  let name = null;
  if (!['queued', 'running'].includes(job.status) && job.outputDir) {
    const outputDir = await fs.realpath(job.outputDir).catch(() => null);
    for (const file of job.files || []) {
      if (!outputDir || !isValidJobFileName(file) || mediaType(file) !== 'video') continue;
      const filePath = await fs.realpath(getFilePath(job, file)).catch(() => null);
      if (filePath && isFileInsideJobFolder({ outputDir }, filePath)
        && (await fs.stat(filePath).catch(() => null))?.isFile()) { name = file; break; }
    }
  }
  const jobId = encodeURIComponent(job.id);
  return { jobId: job.id, status: job.status, duplicate, ready: name !== null,
    statusUrl: `/api/karaoke/jobs/${jobId}`,
    playUrl: name === null ? null : `/api/jobs/${jobId}/stream/${encodeURIComponent(name)}`,
    playerUrl: name === null ? null : `/job/${jobId}/player?${new URLSearchParams({ song: name, play: '1' })}` };
}

export async function submitKaraokeJob(req, res) {
  const url = normalizeVideoUrl(req.body?.videoURL);
  if (!url) return res.status(400).json({ error: 'videoURL must be a valid YouTube video URL' });
  try {
    const owner = await ensureKaraokePartyUser();
    if (!owner) return res.status(503).json({ error: 'An approved administrator is required to provision KaraokeParty' });
    let job;
    let duplicate = false;
    try { job = await createJob(url, owner, { downloadType: 'video' }); }
    catch (error) {
      if (error.code !== 'JOB_ALREADY_EXISTS') throw error;
      job = await getJob(error.existingJob.id);
      duplicate = true;
    }
    if (!job || !canReadAllFiles(job, req.user)) {
      return res.status(409).json({ error: 'This source URL is unavailable' });
    }
    if (!duplicate) await linkLibraryJob(owner.id, job, await getJobs(owner.id));
    const result = await jobResponse(job, duplicate);
    return res.status(!duplicate || ['queued', 'running'].includes(job.status) ? 202 : 200).json(result);
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Unable to submit video job' });
  }
}

export async function getKaraokeJob(req, res) {
  const job = await getJob(req.params.id);
  if (!job || job.downloadType !== 'video' || job.isPlaylist || !canReadAllFiles(job, req.user)) {
    return res.status(404).json({ error: 'Video job not found' });
  }
  return res.json(await jobResponse(job, true));
}