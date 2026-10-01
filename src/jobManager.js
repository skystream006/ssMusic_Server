import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { isPlaylistUrl, normalizeJobUrl, sanitizeFolderName, randomSongFolderName } from './utils.js';
import { openDatabase, writeJob, withTransaction } from './database.js';
import { deletePostgresJob, indexPostgresSongMetadata, readPostgresJob, readPostgresJobs, updatePostgresSong } from './postgresCatalog.js';
import { isSongFile, replaceTranscribedFiles, requestTranscription, validateTranscriptionOptions } from './transcription.js';
import { isPlayableFile } from './media.js';
import { readSongMetadata, readSongSummary, updateSongMetadata } from './music.js';
import { songMetadataFields } from './library.js';
import { countLibraryFileLinks, lockLibraryFile, removeLibrarySongLink } from './libraryStore.js';

const jobs = new Map();
const jobMutations = new Set();
const transcriptionQueues = new Map();
const deletingFiles = new Map();
const fileMutationTails = new Map();
const downloadArchiveName = '.download-archive.txt';

async function mutateJobFiles(id, mutate) {
  const operation = (fileMutationTails.get(id) || Promise.resolve()).then(mutate);
  const tail = operation.catch(() => {});
  fileMutationTails.set(id, tail);
  try {
    return await operation;
  } finally {
    if (fileMutationTails.get(id) === tail) fileMutationTails.delete(id);
  }
}
const database = openDatabase();
const outputRoot = process.env.YTDLP_OUTPUT_ROOT || path.resolve(process.cwd(), 'output');

const jobEvents = new EventEmitter();
jobEvents.setMaxListeners(0);
let runningJobsCount = 0;
const privateVideoPattern = /\b(?:private video|video is private|video unavailable)\b/i;

// Non-null while a maintenance update (yt-dlp -U / deno upgrade) is running.
// Jobs about to start wait on this promise so they queue behind the update.
let updateGate = null;

async function loadJobs() {
  const storedJobs = (await database.prepare(`SELECT id, data FROM jobs
    WHERE status IN ('queued', 'running', 'failed', 'warning') OR data->>'playlistTitle' IS NULL
    OR EXISTS (SELECT 1 FROM songs WHERE job_id = jobs.id AND transcription->>'status' = 'sent')
    OR EXISTS (SELECT 1 FROM jsonb_each(COALESCE(data->'transcriptions', '{}'::jsonb)) WHERE value->>'status' = 'sent')`).all());
  for (const { id } of storedJobs) {
    const job = await readPostgresJob(database, id);
    let updatedStoredJob = false;
    if (!job.playlistTitle) {
      job.playlistTitle = inferPlaylistTitle(job);
      updatedStoredJob = true;
    }
    if (job.status === 'queued' || job.status === 'running') {
      job.status = 'failed';
      job.error = 'Job was interrupted by a server restart';
      job.updatedAt = new Date().toISOString();
      updatedStoredJob = true;
    } else if (
      (job.status === 'failed' || job.status === 'warning')
      && isPrivateVideoOnlyOutput(job.output)
    ) {
      job.status = 'partially_completed';
      job.error = null;
      job.warning = 'One or more private or unavailable videos were skipped.';
      updatedStoredJob = true;
    }
    for (const transcription of Object.values(job.transcriptions || {})) {
      if (transcription.status !== 'sent') continue;
      transcription.status = 'interrupted';
      transcription.completedAt = new Date().toISOString();
      transcription.error = 'Transcription was interrupted by a server restart';
      job.updatedAt = transcription.completedAt;
      updatedStoredJob = true;
    }
    if (updatedStoredJob) (await writeJob(database, job));
  }
}

async function persistJob(job) {
  (await writeJob(database, job));
  if (job.status === 'queued' || job.status === 'running') jobs.set(job.id, job);
  else jobs.delete(job.id);
}

await loadJobs();
await indexPostgresSongMetadata(database, async (job, name) => {
  await refreshSongMetadata(job, [name]);
  return job.songMetadata[name];
});

async function refreshSongMetadata(job, names = job.files || []) {
  const outputDir = job.outputDir && await fs.realpath(job.outputDir).catch(() => null);
  if (!outputDir) return;
  for (const name of names) {
    if (!isValidJobFileName(name) || !/\.mp3$/i.test(name)) continue;
    const filePath = await fs.realpath(getFilePath(job, name)).catch(() => null);
    if (!filePath || !isFileInsideJobFolder({ outputDir }, filePath)) continue;
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat?.isFile()) continue;
    const summary = await readSongSummary(filePath, stat).catch(() => null);
    if (summary) {
      job.songMetadata ||= {};
      job.songMetadata[name] = { ...job.songMetadata[name], ...summary };
    }
  }
}

function waitForUpdateGate() {
  return updateGate || Promise.resolve();
}

function waitForNoJobsInProgress() {
  if (runningJobsCount === 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const onIdle = () => {
      if (runningJobsCount === 0) {
        jobEvents.off('idle', onIdle);
        resolve();
      }
    };
    jobEvents.on('idle', onIdle);
  });
}

function resolveDenoPath() {
  const fromEnv = process.env.DENO_PATH;
  if (fromEnv) {
    return fromEnv;
  }

  const exe = process.platform === 'win32' ? 'deno.exe' : 'deno';
  return path.resolve(process.cwd(), 'runtime', 'deno', 'bin', exe);
}

function resolveYtDlpPath() {
  const fromEnv = process.env.YTDLP_PATH;
  if (fromEnv) {
    return fromEnv;
  }

  const executable = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
  return path.resolve(process.cwd(), 'runtime', 'yt-dlp', executable);
}

function resolveFfmpegLocation() {
  const fromEnv = process.env.FFMPEG_PATH;
  if (fromEnv) {
    return fromEnv;
  }

  return path.resolve(process.cwd(), 'runtime', 'ffmpeg', 'bin');
}

async function ensureOutputRoot() {
  await fs.mkdir(outputRoot, { recursive: true });
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', (error) => {
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const error = new Error(`Command failed with exit code ${code}`);
        error.exitCode = code;
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      }
    });
  });
}

function isPrivateVideoOnlyOutput(output = '') {
  const errorLines = output
    .split(/\r?\n/)
    .filter((line) => /^(?:ERROR|WARNING):/i.test(line.trim()));
  return errorLines.some((line) => privateVideoPattern.test(line))
    && !errorLines.some((line) => !privateVideoPattern.test(line));
}

export function classifyCommandOutput({ stdout = '', stderr = '' }) {
  const errorLines = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .filter((line) => /^ERROR:/i.test(line.trim()));
  const hasPrivateVideoWarning = errorLines.some((line) => privateVideoPattern.test(line));
  const hasNonPrivateError = errorLines.some((line) => !privateVideoPattern.test(line));

  const normalize = (text) => text.split(/\r?\n/).map((line) => (
    /^ERROR:/i.test(line.trim()) && privateVideoPattern.test(line)
      ? line.replace(/ERROR:/i, 'WARNING:')
      : line
  )).join('\n');

  return {
    stdout: normalize(stdout),
    stderr: normalize(stderr),
    hasPrivateVideoWarning,
    hasNonPrivateError
  };
}

function formatCommandOutput(result) {
  const { stdout, stderr } = classifyCommandOutput(result);
  const sections = [];
  if (stdout.trim()) sections.push(`[stdout]\n${stdout.trimEnd()}`);
  if (stderr.trim()) sections.push(`[stderr]\n${stderr.trimEnd()}`);
  return sections.join('\n\n');
}

async function listDownloadedFiles(folderPath) {
  try {
    const entries = await fs.readdir(folderPath, { withFileTypes: true });
    const files = entries
      .filter((entry) => entry.isFile() && entry.name !== downloadArchiveName)
      .map((entry) => entry.name);
    if (entries.some((entry) => entry.name === '[NoVocals]' && entry.isDirectory())) {
      const accompaniment = await fs.readdir(path.join(folderPath, '[NoVocals]'), { withFileTypes: true });
      files.push(...accompaniment.filter((entry) => entry.isFile() && isSongFile(entry.name))
        .map((entry) => `[NoVocals]/${entry.name}`));
    }
    return files.sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function inferPlaylistTitle(job) {
  const folderTitle = (job.folderName || '').replace(/_song_[0-9a-f-]{36}$/i, '');
  if (folderTitle && !/^song_[0-9a-f-]{36}$/i.test(folderTitle)) return folderTitle.replaceAll('_', ' ');
  const song = (job.files || []).find(isPlayableFile);
  return song ? path.basename(song, path.extname(song)) : 'Untitled playlist';
}

export function parsePlaylistMetadata(output) {
  const metadata = JSON.parse(output);
  const playlistTitle = typeof metadata.title === 'string' && metadata.title.trim() ? metadata.title.trim() : null;
  const playlistSongCount = Number.isSafeInteger(metadata.playlist_count) && metadata.playlist_count >= 0
    ? metadata.playlist_count
    : Array.isArray(metadata.entries) ? metadata.entries.length : null;
  return { playlistTitle, folderName: sanitizeFolderName(playlistTitle || 'playlist'), playlistSongCount };
}

async function getSourceMetadata(url, denoPath, isPlaylist) {
  const args = [
    '--flat-playlist',
    '--dump-single-json',
    '--skip-download',
    '--ignore-errors',
    isPlaylist ? '--yes-playlist' : '--no-playlist',
    '--js-runtimes',
    `deno:${denoPath}`,
    url
  ];

  const { stdout } = await runCommand(resolveYtDlpPath(), args);
  return parsePlaylistMetadata(stdout);
}

function newJob(url, initiatedBy, metadataOnly = false, downloadType = 'audio') {
  const id = randomSongFolderName();
  const now = new Date().toISOString();
  const job = {
    id,
    url,
    metadataOnly,
    downloadType,
    initiatedBy,
    contributors: [],
    isPlaylist: isPlaylistUrl(url),
    playlistTitle: null,
    playlistSongCount: null,
    status: 'queued',
    error: null,
    warning: null,
    folderName: null,
    outputDir: null,
    files: [],
    createdAt: now,
    updatedAt: now,
    command: null,
    output: null
  };

  return job;
}

function startJob(job) {
  executeJob(job).catch((error) => {
    job.status = 'failed';
    job.error = error.message;
    job.updatedAt = new Date().toISOString();
    persistJob(job).catch((persistError) => console.error('Unable to persist job:', persistError.message));
  });
}

function hasJobAccess(job, user, allowContributors = false) {
  return Boolean(user && user.role !== 'shared' && (user.role === 'admin' || (user.id && (
    user.id === job.initiatedBy?.id
    || (allowContributors && job.contributors?.some((contributor) => contributor.id === user.id))
  ))));
}

function assertJobAccess(job, user, allowContributors = false) {
  if (!hasJobAccess(job, user, allowContributors)) {
    const error = new Error('You do not have permission to perform this action on this job');
    error.statusCode = 403;
    throw error;
  }
}

async function assertCanModifyJob(job, user, allowContributors = false) {
  assertJobAccess(job, user, allowContributors);
  if (user.role === 'admin' || !job.outputDir) return;
  const shared = (await database.prepare("SELECT data FROM jobs WHERE data->>'outputDir' = $1 AND id <> $2").all(job.outputDir, job.id))
    .map((row) => JSON.parse(row.data));
  if (shared.some((other) => (
    other.id !== job.id && other.outputDir && !hasJobAccess(other, user, allowContributors)
    && path.relative(job.outputDir, other.outputDir) === ''
  ))) {
    const error = new Error('This output folder is shared with another owner; an administrator must modify it');
    error.statusCode = 403;
    throw error;
  }
}

function assertJobIsIdle(job, action, allowTranscription = false) {
  if (jobMutations.has(job.id) || (!allowTranscription && (transcriptionQueues.has(job.id) || deletingFiles.has(job.id)))) {
    const error = new Error('Another change to this job is in progress');
    error.statusCode = 409;
    throw error;
  }
  if (job.status === 'queued' || job.status === 'running') {
    const error = new Error(`Cannot ${action} a job while it is ${job.status}`);
    error.statusCode = 409;
    throw error;
  }
}

async function removeJobOutput(job) {
  if (!job.outputDir) {
    return;
  }

  const relative = path.relative(outputRoot, job.outputDir);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    await fs.rm(job.outputDir, { recursive: true, force: true });
  }
}

async function executeJob(job) {
  // If a maintenance update is running (or about to run), queue behind it.
  await waitForUpdateGate();

  const denoPath = resolveDenoPath();
  const ytDlpPath = resolveYtDlpPath();
  const ffmpegLocation = resolveFfmpegLocation();

  runningJobsCount += 1;
  job.status = 'running';
  job.updatedAt = new Date().toISOString();
  await persistJob(job);

  let metadataError;
  const sourceMetadata = await getSourceMetadata(job.url, denoPath, job.isPlaylist).catch((error) => {
    metadataError = error;
    return null;
  });
  const folderName = job.folderName || (job.isPlaylist && sourceMetadata?.playlistTitle
    ? `${sourceMetadata.folderName}_${job.id}` : randomSongFolderName());

  job.playlistTitle = job.playlistTitleOverride || sourceMetadata?.playlistTitle || job.playlistTitle;
  job.playlistSongCount = job.isPlaylist ? sourceMetadata?.playlistSongCount ?? null : null;
  job.folderName = folderName;
  job.outputDir = job.outputDir || path.join(outputRoot, folderName);

  await fs.mkdir(job.outputDir, { recursive: true });

  const args = [
    '--ignore-errors',
    '--no-overwrites',
    '--download-archive',
    path.join(job.outputDir, downloadArchiveName),
    ...(job.downloadType === 'video' ? [
      '--format', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/bestvideo+bestaudio/best',
      '--merge-output-format', 'mp4',
      '--remux-video', 'mp4'
    ] : [
      '--format', 'bestaudio',
      '--extract-audio',
      '--audio-format', 'mp3',
      '--audio-quality', '160K'
    ]),
    '--ffmpeg-location',
    ffmpegLocation,
    '--js-runtimes',
    `deno:${denoPath}`,
    '--output',
    path.join(job.outputDir, '%(title)s.%(ext)s')
  ];

  args.push(job.isPlaylist ? '--yes-playlist' : '--no-playlist');
  args.push(job.url);

  job.command = job.metadataOnly ? null : [ytDlpPath, ...args]
    .map((value) => (value.includes(' ') ? `"${value}"` : value))
    .join(' ');

  await persistJob(job);

  let completedStatus;
  try {
    if (job.metadataOnly && metadataError) throw metadataError;
    const result = job.metadataOnly
      ? { stdout: 'Metadata retrieved. Media download skipped.', stderr: '' }
      : await runCommand(ytDlpPath, args);
    const classification = classifyCommandOutput(result);
    job.output = formatCommandOutput(result) || 'Command completed without output.';
    job.files = await listDownloadedFiles(job.outputDir);
    completedStatus = classification.hasPrivateVideoWarning ? 'partially_completed' : 'completed';
    job.warning = classification.hasPrivateVideoWarning ? 'One or more private or unavailable videos were skipped.' : null;
  } catch (error) {
    const classification = classifyCommandOutput(error);
    const privateVideosOnly = classification.hasPrivateVideoWarning && !classification.hasNonPrivateError;
    completedStatus = privateVideosOnly ? 'partially_completed' : 'failed';
    job.error = privateVideosOnly ? null : error.message;
    job.warning = privateVideosOnly ? 'One or more private or unavailable videos were skipped.' : null;
    job.output = formatCommandOutput(error) || error.message;
    job.files = await listDownloadedFiles(job.outputDir);
  } finally {
    try {
      job.playlistTitle ||= inferPlaylistTitle(job);
      await refreshSongMetadata(job);
      job.updatedAt = new Date().toISOString();
      await persistJob({ ...job, status: completedStatus || job.status });
      if (completedStatus) job.status = completedStatus;
    } finally {
      runningJobsCount = Math.max(0, runningJobsCount - 1);
      if (runningJobsCount === 0) jobEvents.emit('idle');
    }
  }
}

/**
 * Runs `yt-dlp -U` and `deno upgrade` to keep the runtimes up to date.
 * Waits for any jobs currently in progress to finish, then blocks new jobs
 * from starting until the update completes.
 */
export async function runMaintenanceUpdate() {
  if (updateGate) {
    return updateGate;
  }

  let releaseGate;
  updateGate = new Promise((resolve) => {
    releaseGate = resolve;
  });

  try {
    await waitForNoJobsInProgress();

    try {
      await runCommand(resolveYtDlpPath(), ['-U']);
    } catch (error) {
      console.error('yt-dlp update failed:', error.message);
    }

    try {
      await runCommand(resolveDenoPath(), ['upgrade']);
    } catch (error) {
      console.error('Deno upgrade failed:', error.message);
    }
  } finally {
    const release = releaseGate;
    updateGate = null;
    release();
  }
}

export function isUpdateInProgress() {
  return updateGate !== null;
}

export async function createJob(url, user = null, { metadataOnly = false, downloadType = 'audio' } = {}) {
  if (metadataOnly !== undefined && typeof metadataOnly !== 'boolean') {
    throw Object.assign(new Error('metadataOnly must be a boolean'), { statusCode: 400 });
  }
  if (downloadType !== 'audio' && downloadType !== 'video') {
    throw Object.assign(new Error('downloadType must be audio or video'), { statusCode: 400 });
  }
  await ensureOutputRoot();
  const sourceUrl = normalizeJobUrl(url);
  const job = (await withTransaction(database, async () => (await createJobRecord(sourceUrl, user, metadataOnly, downloadType))));
  jobs.set(job.id, job);
  startJob(job);
  return job;
}

async function createJobRecord(sourceUrl, user, metadataOnly, downloadType) {
  const existingJob = (await database.prepare(`SELECT id, status, data FROM jobs WHERE url = $1
    AND COALESCE(data->>'downloadType', 'audio') = $2
    ORDER BY created_at DESC LIMIT 1`).get(sourceUrl, downloadType));
  if (existingJob) {
    const error = new Error('This source URL already has a job');
    error.statusCode = 409;
    error.code = 'JOB_ALREADY_EXISTS';
    error.existingJob = {
      id: existingJob.id,
      status: existingJob.status,
      playlistTitle: JSON.parse(existingJob.data).playlistTitle,
      folderName: JSON.parse(existingJob.data).folderName,
      initiatedBy: JSON.parse(existingJob.data).initiatedBy,
      contributors: JSON.parse(existingJob.data).contributors || []
    };
    throw error;
  }
  const job = newJob(sourceUrl, user ? { id: user.id, name: user.name } : null, metadataOnly, downloadType);
  (await writeJob(database, job));
  return job;
}

export async function setJobTitle(id, title, user = null) {
  const job = (await getJob(id));
  if (!job) return null;
  assertJobAccess(job, user);
  assertJobIsIdle(job, 'rename');
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 200 || /[\x00-\x1f\x7f]/.test(title)) {
    throw Object.assign(new Error('Playlist title must be between 1 and 200 characters without control characters'), { statusCode: 400 });
  }
  job.playlistTitle = title.trim();
  job.playlistTitleOverride = job.playlistTitle;
  job.updatedAt = new Date().toISOString();
  await persistJob(job);
  return job;
}

export async function importJobFiles({ files, playlistId, playlistTitle, source = 'files', individual = false, playlistSongCount, downloadType = 'audio' }, user) {
  if (!user?.id) throw Object.assign(new Error('Authentication required'), { statusCode: 401 });
  const linkedPlaylist = source === 'itunes' && !playlistId && !individual
    && Number.isSafeInteger(playlistSongCount) && playlistSongCount > 0;
  if (!Array.isArray(files) || (!files.length && !linkedPlaylist) || files.some((file) => !isPlayableFile(file.name) || !file.path)) {
    throw Object.assign(new Error('Select supported audio or movie files'), { statusCode: 400 });
  }
  const job = playlistId ? (await getJob(playlistId)) : newJob(`import:${source}`, { id: user.id, name: user.name }, false, downloadType);
  if (!job) throw Object.assign(new Error('Playlist not found'), { statusCode: 404 });
  if (playlistId) {
    (await assertCanModifyJob(job, user, true));
    assertJobIsIdle(job, 'import into');
    if (job.isPlaylist === false) throw Object.assign(new Error('Select a playlist'), { statusCode: 400 });
  } else {
    if (typeof playlistTitle !== 'string' || !playlistTitle.trim() || playlistTitle.trim().length > 200 || /[\x00-\x1f\x7f]/.test(playlistTitle)) {
      throw Object.assign(new Error('Playlist name must be between 1 and 200 characters'), { statusCode: 400 });
    }
    job.source = source;
    job.isPlaylist = !individual;
    job.playlistTitle = playlistTitle.trim();
    job.status = 'completed';
  }
  job.folderName ||= job.id;
  job.outputDir ||= path.join(outputRoot, job.folderName);
  jobMutations.add(job.id);
  const added = [];
  try {
    await fs.mkdir(job.outputDir, { recursive: true });
    const names = new Set((await fs.readdir(job.outputDir)).map((name) => name.toLowerCase()));
    const metadata = { ...job.songMetadata };
    for (const file of files) {
      const extension = path.extname(file.name).toLowerCase();
      const base = path.basename(file.name.replaceAll('\\', '/'), path.extname(file.name));
      const stem = base.replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '_').replace(/[. ]+$/g, '').slice(0, 160) || 'Track';
      let name = `${stem}${extension}`;
      let suffix = 2;
      while (names.has(name.toLowerCase())) name = `${stem} (${suffix++})${extension}`;
      await fs.copyFile(file.path, path.join(job.outputDir, name), fs.constants.COPYFILE_EXCL);
      added.push(name);
      names.add(name.toLowerCase());
      if (file.metadata) metadata[name] = file.metadata;
    }
    job.files = [...(job.files || []), ...added];
    job.songMetadata = metadata;
    await refreshSongMetadata(job, added);
    job.playlistSongCount = linkedPlaylist ? playlistSongCount : job.files.filter(isPlayableFile).length;
    job.updatedAt = new Date().toISOString();
    await persistJob(job);
    return job;
  } catch (error) {
    await Promise.all(added.map((name) => fs.rm(path.join(job.outputDir, name), { force: true })));
    if (!playlistId) await removeJobOutput(job);
    throw error;
  } finally {
    jobMutations.delete(job.id);
  }
}

export async function rerunJob(id, user = null) {
  const job = (await getJob(id));
  if (!job) {
    return null;
  }

  (await assertCanModifyJob(job, user, true));
  assertJobIsIdle(job, 'rerun');
  if (job.source) throw Object.assign(new Error('Imported jobs cannot be rerun'), { statusCode: 400 });

  job.metadataOnly = false;
  job.playlistSongCount = null;
  job.status = 'queued';
  job.error = null;
  job.warning = null;
  job.command = null;
  job.output = null;
  job.updatedAt = new Date().toISOString();

  await persistJob(job);
  startJob(job);
  return job;
}

export async function deleteJob(id, user = null) {
  const job = (await getJob(id));
  if (!job) {
    return false;
  }

  (await assertCanModifyJob(job, user));
  assertJobIsIdle(job, 'delete');
  jobMutations.add(id);
  try {
    await removeJobOutput(job);
    await deletePostgresJob(database, id);
    jobs.delete(id);
    return true;
  } finally {
    jobMutations.delete(id);
  }
}

export function isValidJobFileName(fileName) {
  if (typeof fileName !== 'string') return false;
  const parts = fileName.split('/');
  return (parts.length === 1 || (parts.length === 2 && parts[0] === '[NoVocals]'))
    && parts.every((part) => part && part !== '.' && part !== '..' && !/[\\:\0]/.test(part))
    && parts.at(-1) !== downloadArchiveName;
}

export async function transcribeJobFile(id, fileName, options, user = null) {
  const storedJob = await getJob(id);
  if (!storedJob) return null;
  await assertCanModifyJob(storedJob, user, true);
  const existingQueue = transcriptionQueues.get(id);
  const job = existingQueue?.job || storedJob;
  assertJobIsIdle(job, 'transcribe', true);
  if (existingQueue?.files.has(fileName) || deletingFiles.get(id)?.has(fileName)) {
    throw Object.assign(new Error('Another change to this song is in progress'), { statusCode: 409 });
  }
  if (!isValidJobFileName(fileName) || !isSongFile(fileName)) {
    throw Object.assign(new Error('Invalid song path'), { statusCode: 400 });
  }
  if (!job.outputDir || !job.files.includes(fileName)) {
    throw Object.assign(new Error('Song not found'), { statusCode: 404 });
  }
  const fields = validateTranscriptionOptions(options);
  if (job.songMetadata?.[fileName]?.transcriptionLocked && !fields.NoVocalsOnly) {
    throw Object.assign(new Error('Transcription is locked for this song'), { statusCode: 409 });
  }
  const { lyrics, ...savedOptions } = fields;
  const queue = existingQueue || { job, files: new Set(), tail: Promise.resolve() };
  const requestedAt = new Date().toISOString();
  const transcription = { requestedAt, lyricsIncluded: Boolean(lyrics), options: savedOptions };
  job.transcriptions = { ...job.transcriptions, [fileName]: { ...job.transcriptions?.[fileName], ...transcription, status: 'sent' } };
  job.updatedAt = requestedAt;
  queue.files.add(fileName);
  transcriptionQueues.set(id, queue);
  const persisted = updatePostgresSong(database, job, fileName, 'transcription', job.transcriptions[fileName]);
  persisted.catch(() => {});
  const operation = queue.tail.then(async () => {
    await persisted;
    return executeTranscription(job, fileName, fields, transcription);
  });
  queue.tail = operation.catch(() => {});
  try {
    return await operation;
  } finally {
    queue.files.delete(fileName);
    if (queue.files.size === 0) transcriptionQueues.delete(id);
  }
}

async function executeTranscription(job, fileName, options, transcription) {
  try {
    const filePath = getFilePath(job, fileName);
    const realPath = await fs.realpath(filePath).catch(() => null);
    const realFolder = await fs.realpath(job.outputDir);
    if (!realPath || !(await fs.stat(realPath)).isFile()) {
      throw Object.assign(new Error('Song not found'), { statusCode: 404 });
    }
    if (!isFileInsideJobFolder({ outputDir: realFolder }, realPath)) {
      throw Object.assign(new Error('Invalid song path'), { statusCode: 400 });
    }
    const results = await requestTranscription(filePath, options);
    const replacements = options.NoVocalsOnly ? results.filter((result) => !result.original) : results;
    if (options.NoVocalsOnly && !replacements.some((result) => path.extname(result.name).toLowerCase() === '.mp3')) {
      throw Object.assign(new Error('Transcription service did not return a no-vocals MP3'), { statusCode: 502 });
    }
    await mutateJobFiles(job.id, () => replaceTranscribedFiles(job, fileName, replacements, async (updatedJob) => {
      const noVocals = results.find((result) => !result.original);
      updatedJob.transcriptions[fileName] = {
        ...transcription, status: 'transcribed', completedAt: new Date().toISOString(),
        noVocalsName: noVocals ? `[NoVocals]/${noVocals.name}` : updatedJob.transcriptions[fileName]?.noVocalsName
      };
      if (!noVocals) await updatePostgresSong(database, updatedJob, fileName, 'transcription', updatedJob.transcriptions[fileName]);
      else await persistJob(updatedJob);
    }));
    return job;
  } catch (error) {
    job.updatedAt = new Date().toISOString();
    job.transcriptions[fileName] = {
      ...transcription, status: 'failed', completedAt: job.updatedAt, error: error.message,
      noVocalsName: job.transcriptions[fileName]?.noVocalsName
    };
    await updatePostgresSong(database, job, fileName, 'transcription', job.transcriptions[fileName]);
    throw error;
  }
}

export async function setSongMetadata(id, fileName, value, user = null) {
  const storedJob = await getJob(id);
  if (!storedJob) return null;
  await assertCanModifyJob(storedJob, user, true);
  const job = transcriptionQueues.get(id)?.job || storedJob;
  assertJobIsIdle(job, 'edit metadata for', true);
  if (transcriptionQueues.get(id)?.files.has(fileName) || deletingFiles.has(id)) {
    throw Object.assign(new Error('Another change to this song is in progress'), { statusCode: 409 });
  }
  if (!isValidJobFileName(fileName) || !isSongFile(fileName)) {
    throw Object.assign(new Error('Invalid song path'), { statusCode: 400 });
  }
  if (!job.outputDir || !job.files.includes(fileName)) throw Object.assign(new Error('Song not found'), { statusCode: 404 });
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length) {
    throw Object.assign(new Error('Invalid song metadata'), { statusCode: 400 });
  }
  if (Object.hasOwn(value, 'transcriptionLocked') && typeof value.transcriptionLocked !== 'boolean') {
    throw Object.assign(new Error('Transcription lock must be a boolean'), { statusCode: 400 });
  }
  const { transcriptionLocked, ...changes } = value;
  jobMutations.add(id);
  try {
    return await mutateJobFiles(id, async () => {
      const filePath = getFilePath(job, fileName);
      const realPath = await fs.realpath(filePath).catch(() => null);
      if (!realPath || !(await fs.stat(realPath)).isFile()) throw Object.assign(new Error('Song not found'), { statusCode: 404 });
      if (!isFileInsideJobFolder({ outputDir: await fs.realpath(job.outputDir) }, realPath)) {
        throw Object.assign(new Error('Invalid song path'), { statusCode: 400 });
      }
      const metadata = Object.keys(changes).length ? await updateSongMetadata(realPath, changes) : await readSongMetadata(realPath);
      metadata.transcriptionLocked = transcriptionLocked ?? job.songMetadata?.[fileName]?.transcriptionLocked ?? false;
      job.songMetadata = { ...job.songMetadata, [fileName]: { ...job.songMetadata?.[fileName],
        ...Object.fromEntries(songMetadataFields.map((field) => [field, metadata[field]])), rating: metadata.rating,
        transcriptionLocked: metadata.transcriptionLocked } };
      job.updatedAt = new Date().toISOString();
      await updatePostgresSong(database, job, fileName, 'metadata', job.songMetadata[fileName]);
      return metadata;
    });
  } finally { jobMutations.delete(id); }
}

export async function deleteJobFile(id, fileName, user = null, membership = null) {
  const job = (await getJob(id));
  if (!job) return null;

  (await assertCanModifyJob(job, user, true));
  assertJobIsIdle(job, 'remove files from', true);
  if (transcriptionQueues.get(id)?.files.has(fileName) || deletingFiles.get(id)?.has(fileName)) {
    throw Object.assign(new Error('Another change to this song is in progress'), { statusCode: 409 });
  }
  if (!isValidJobFileName(fileName)) {
    const error = new Error('Invalid file path');
    error.statusCode = 400;
    throw error;
  }
  if (!job.outputDir || !job.files.includes(fileName)) {
    const error = new Error('Song not found');
    error.statusCode = 404;
    throw error;
  }
  const filePath = getFilePath(job, fileName);
  if (!isFileInsideJobFolder(job, filePath)) {
    const error = new Error('Invalid file path');
    error.statusCode = 400;
    throw error;
  }

  const pending = deletingFiles.get(id) || new Set();
  pending.add(fileName);
  deletingFiles.set(id, pending);
  let unlock = () => {};
  try {
    return await mutateJobFiles(id, async () => {
      const allJobs = (await getJobs());
      if (membership) {
        const available = allJobs.filter((item) => item.initiatedBy?.id === user.id || item.contributors?.some((contributor) => contributor.id === user.id));
        if ((await removeLibrarySongLink(user.id, { ...membership, jobId: id, name: fileName }, available, allJobs))) {
          return { job: (await getJob(id)), fileDeleted: false };
        }
      } else if ((await countLibraryFileLinks(job, fileName, allJobs)) > 1) {
        throw Object.assign(new Error('This song has other playlist links. Remove it from a playlist first.'), { statusCode: 409 });
      }
      unlock = lockLibraryFile(job, fileName, allJobs);
      await fs.unlink(filePath).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
      const currentJob = transcriptionQueues.get(id)?.job || (await getJob(id));
      currentJob.files = currentJob.files.filter((name) => name !== fileName);
      if (currentJob.transcriptions) delete currentJob.transcriptions[fileName];
      if (currentJob.songMetadata) delete currentJob.songMetadata[fileName];
      currentJob.updatedAt = new Date().toISOString();
      await persistJob(currentJob);
      return membership ? { job: currentJob, fileDeleted: true } : currentJob;
    });
  } finally {
    unlock();
    pending.delete(fileName);
    if (pending.size === 0) deletingFiles.delete(id);
  }
}

export async function getAvailableContributors(id, user = null) {
  const job = (await getJob(id));
  if (!job) return null;
  assertJobAccess(job, user);
  return (await database.prepare("SELECT id, name FROM users WHERE status = 'approved' AND id IS DISTINCT FROM $1 ORDER BY lower(name)")
    .all(job.initiatedBy?.id || null));
}

export async function setJobContributors(id, userIds, user = null) {
  const job = (await getJob(id));
  if (!job) return null;
  assertJobAccess(job, user);
  assertJobIsIdle(job, 'change contributors for');
  if (!Array.isArray(userIds) || userIds.some((userId) => typeof userId !== 'string' || !userId)) {
    const error = new Error('userIds must be an array of user IDs');
    error.statusCode = 400;
    throw error;
  }
  const available = new Map((await getAvailableContributors(id, user)).map((candidate) => [candidate.id, candidate]));
  if (userIds.some((userId) => !available.has(userId))) {
    const error = new Error('Contributors must be approved users other than the job owner');
    error.statusCode = 400;
    throw error;
  }
  job.contributors = [...new Set(userIds)].map((userId) => available.get(userId));
  job.updatedAt = new Date().toISOString();
  await persistJob(job);
  return job;
}

export async function getJobs(userId) {
  return (await readPostgresJobs(database, userId)).map((job) => jobs.get(job.id) || job);
}

export async function getJob(id) {
  if (jobs.has(id)) return jobs.get(id);
  return readPostgresJob(database, id);
}

export function getFilePath(job, fileName) {
  return path.resolve(job.outputDir, fileName);
}

export function isFileInsideJobFolder(job, filePath) {
  const relative = path.relative(job.outputDir, filePath);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}
