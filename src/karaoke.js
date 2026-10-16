import fs from 'node:fs/promises';
import { openDatabase, withTransaction } from './database.js';
import { ensureKaraokePartyUser } from './authStore.js';
import { createJob, deleteJob, getJob, getJobs, getFilePath, isFileInsideJobFolder, isValidJobFileName, rerunJob } from './jobManager.js';
import { linkLibraryJob } from './libraryStore.js';
import { mediaType } from './media.js';
import { canReadAllFiles } from './privacy.js';
import { normalizeVideoUrl } from './utils.js';

const videoMutations = new Map();

async function mutateVideo(url, operation) {
  const pending = (videoMutations.get(url) || Promise.resolve()).catch(() => {}).then(operation);
  videoMutations.set(url, pending);
  try { return await pending; }
  finally { if (videoMutations.get(url) === pending) videoMutations.delete(url); }
}

async function removePlaylistVideo(url, playlistId, owner, viewer) {
  const database = openDatabase();
  return withTransaction(database, async () => {
    const reference = await database.prepare('SELECT job_id FROM karaoke_playlist_jobs WHERE video_url = $1 AND playlist_id = $2')
      .get(url, playlistId);
    if (!reference) {
      const { count } = await database.prepare('SELECT count(*) AS count FROM karaoke_playlist_jobs WHERE video_url = $1').get(url);
      return { action: 'remove', playlistId, removed: false, videoDeleted: false, playlistCount: count };
    }
    const job = await getJob(reference.job_id);
    if (!job || !canReadAllFiles(job, viewer)) {
      throw Object.assign(new Error('This source URL is unavailable'), { statusCode: 409 });
    }
    const { count } = await database.prepare('SELECT count(*) AS count FROM karaoke_playlist_jobs WHERE job_id = $1').get(job.id);
    let videoDeleted = false;
    let retainedReason = count > 1 ? 'playlist_references' : 'other_owner';
    if (count === 1 && job.initiatedBy?.id === owner.id) {
      const shared = job.contributors?.length || await database.prepare(`SELECT 1 FROM library_memberships
        WHERE job_id = $1 GROUP BY name HAVING count(*) > 1 OR bool_or(user_id <> $2) LIMIT 1`).get(job.id, owner.id);
      if (shared) retainedReason = 'library_references';
      else videoDeleted = await deleteJob(job.id, owner);
    }
    await database.prepare('DELETE FROM karaoke_playlist_jobs WHERE video_url = $1 AND playlist_id = $2').run(url, playlistId);
    return { action: 'remove', playlistId, jobId: job.id, removed: true, videoDeleted, playlistCount: count - 1,
      ...(videoDeleted ? {} : { retainedReason }) };
  });
}

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
  const url = normalizeVideoUrl(req.body?.videoURL ?? req.body?.videoUrl);
  if (!url) return res.status(400).json({ error: 'videoURL must be a valid YouTube video URL' });
  if (req.body?.videoURL !== undefined && req.body?.videoUrl !== undefined && normalizeVideoUrl(req.body.videoUrl) !== url) {
    return res.status(400).json({ error: 'videoURL and videoUrl must identify the same video' });
  }
  const action = req.body?.action === undefined ? 'add'
    : typeof req.body.action === 'string' ? req.body.action.trim().toLowerCase() : null;
  if (!['add', 'remove'].includes(action)) return res.status(400).json({ error: 'action must be add or remove' });
  const playlistId = req.body?.playlistId;
  if (playlistId !== undefined && (typeof playlistId !== 'string' || !playlistId.trim()
    || playlistId.length > 200 || /[\x00-\x1f\x7f]/.test(playlistId))) {
    return res.status(400).json({ error: 'playlistId must be a nonempty string of at most 200 characters' });
  }
  if (action === 'remove' && playlistId === undefined) return res.status(400).json({ error: 'playlistId is required for remove' });
  try {
    return await mutateVideo(url, async () => {
      const owner = await ensureKaraokePartyUser();
      if (!owner) return res.status(503).json({ error: 'An approved administrator is required to provision KaraokeParty' });
      if (action === 'remove') return res.json(await removePlaylistVideo(url, playlistId.trim(), owner, req.user));
      const database = openDatabase();
      const tracked = await database.prepare('SELECT job_id FROM karaoke_playlist_jobs WHERE video_url = $1 LIMIT 1').get(url);
      let job = tracked ? await getJob(tracked.job_id) : null;
      let duplicate = Boolean(job);
      if (!job) {
        try { job = await createJob(url, owner, { downloadType: 'video' }); }
        catch (error) {
          if (error.code !== 'JOB_ALREADY_EXISTS') throw error;
          job = await getJob(error.existingJob.id);
          duplicate = true;
        }
      }
      if (!job || !canReadAllFiles(job, req.user)) {
        return res.status(409).json({ error: 'This source URL is unavailable' });
      }
      if (job.status === 'failed') job = await rerunJob(job.id, owner);
      if (!duplicate) await linkLibraryJob(owner.id, job, await getJobs(owner.id));
      const playlistCount = await withTransaction(database, async () => {
        await database.prepare(`INSERT INTO karaoke_playlist_jobs (playlist_id, video_url, job_id) VALUES ($1, $2, $3)
          ON CONFLICT (playlist_id, video_url) DO NOTHING`).run(playlistId?.trim() ?? '', url, job.id);
        return (await database.prepare('SELECT count(*) AS count FROM karaoke_playlist_jobs WHERE job_id = $1').get(job.id)).count;
      });
      const result = await jobResponse(job, duplicate);
      return res.status(!duplicate || ['queued', 'running'].includes(job.status) ? 202 : 200)
        .json({ ...result, action: 'add', playlistId: playlistId?.trim() ?? null, playlistCount });
    });
  } catch (error) {
    return res.status(error.statusCode || 500).json({ error: error.statusCode ? error.message : 'Unable to update video job' });
  }
}

export async function getKaraokeJob(req, res) {
  const job = await getJob(req.params.id);
  if (!job || job.downloadType !== 'video' || job.isPlaylist || !canReadAllFiles(job, req.user)) {
    return res.status(404).json({ error: 'Video job not found' });
  }
  const { count } = await openDatabase().prepare('SELECT count(*) AS count FROM karaoke_playlist_jobs WHERE job_id = $1').get(job.id);
  return res.json({ ...await jobResponse(job, true), playlistCount: count });
}