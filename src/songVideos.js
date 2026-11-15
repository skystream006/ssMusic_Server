import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { songKey } from './library.js';
import { normalizeVideoUrl } from './utils.js';

export function songVideoPath(outputDir, jobId, name) {
  const key = createHash('sha256').update(songKey({ jobId, name })).digest('hex');
  return path.join(outputDir, '.videos', `${key}.mp4`);
}

export function songVideoMetadata(jobId, name, metadata, ownerId) {
  const videoUrl = normalizeVideoUrl(metadata?.videoUrl);
  const video = videoUrl && metadata?.linkedVideo?.sourceUrl === videoUrl ? metadata.linkedVideo : null;
  const query = new URLSearchParams();
  if (video?.updatedAt) query.set('v', video.updatedAt);
  if (ownerId !== undefined) query.set('userId', ownerId);
  return {
    videoUrl,
    linkedVideo: video ? { ...video, streamUrl: video.status === 'completed'
      ? `/api/jobs/${encodeURIComponent(jobId)}/video/${encodeURIComponent(name)}?${query}` : null } : null
  };
}

export async function readSongVideo(job, name) {
  if (!job) return null;
  const { linkedVideo } = songVideoMetadata(job.id, name, job.songMetadata?.[name]);
  if (!job.outputDir || linkedVideo?.status !== 'completed') return null;
  try {
    const outputDir = await fs.realpath(job.outputDir);
    const filePath = songVideoPath(outputDir, job.id, name);
    const realPath = await fs.realpath(filePath);
    if (realPath !== filePath) throw Object.assign(new Error('Invalid linked video path'), { statusCode: 400 });
    const stat = await fs.stat(realPath);
    return stat.isFile() && stat.size > 0 ? realPath : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

export async function removeSongVideo(job, name) {
  if (!job.outputDir) return;
  let outputDir;
  try { outputDir = await fs.realpath(job.outputDir); }
  catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  const filePath = songVideoPath(outputDir, job.id, name);
  try {
    if (await fs.realpath(path.dirname(filePath)) !== path.dirname(filePath)) {
      throw new Error('Invalid linked video directory');
    }
    await fs.unlink(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
