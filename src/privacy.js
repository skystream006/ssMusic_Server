import path from 'node:path';
import { countDownloadedFiles, isNoVocals, songStem } from './library.js';

const aliases = Symbol('privacy aliases');
const viewerId = (user) => typeof user === 'string' ? user : user?.id;

export function ownsJob(job, user) {
  return Boolean(job?.initiatedBy?.id && job.initiatedBy.id === viewerId(user));
}

export function canReadJob(job, user) {
  return Boolean(job && (job.private !== true || ownsJob(job, user)));
}

function protectsFile(job, name) {
  if (job.private === true) return true;
  const names = Array.isArray(job.privateFiles) ? job.privateFiles : [];
  return names.includes(name) || (isNoVocals({ name }) && names.some((original) => (
    job.transcriptions?.[original]?.noVocalsName === name || songStem(original) === songStem(name)
  )));
}

export function canReadFile(job, name, user) {
  if (!job || typeof name !== 'string' || !canReadJob(job, user)) return false;
  return [job, ...(job[aliases] || [])].every((source) => !protectsFile(source, name) || ownsJob(source, user));
}

export function assertFileAccess(job, name, user) {
  if (!canReadFile(job, name, user)) {
    throw Object.assign(new Error('Song not found'), { statusCode: 404 });
  }
}

export function canReadAllFiles(job, user) {
  return canReadFile(job, '', user) && [job, ...(job[aliases] || [])]
    .every((source) => [...(source.files || []), ...(source.privateFiles || [])]
      .every((name) => canReadFile(job, name, user)));
}

// Alias restrictions are internal and must never be serialized into job responses.
export async function attachPrivacyAliases(database, jobs) {
  if (!jobs.some((job) => job.outputDir || job.private || job.privateFiles?.length || job[aliases]?.length)) return jobs;
  const records = await database.prepare(`SELECT data FROM jobs WHERE
    data->'private' = 'true'::jsonb OR jsonb_array_length(COALESCE(data->'privateFiles', '[]'::jsonb)) > 0`).all();
  const protectedJobs = records.map((record) => JSON.parse(record.data));
  const ids = new Set(jobs.map((job) => job.id));
  const directories = new Set(jobs.filter((job) => job.outputDir).map((job) => path.resolve(job.outputDir)));
  const relevant = protectedJobs.filter((job) => ids.has(job.id) || job.outputDir && directories.has(path.resolve(job.outputDir)));
  if (relevant.length) {
    const rows = await database.prepare(`SELECT job_id, name, transcription FROM songs
      WHERE job_id IN (SELECT jsonb_array_elements_text($1::jsonb)) AND transcription IS NOT NULL`)
      .all(JSON.stringify(relevant.map((job) => job.id)));
    for (const row of rows) {
      const job = relevant.find((candidate) => candidate.id === row.job_id);
      job.transcriptions = { ...job.transcriptions, [row.name]: JSON.parse(row.transcription) };
    }
  }
  for (const job of jobs) {
    Object.defineProperty(job, aliases, { configurable: true, value: relevant.filter((source) => (
      source.id === job.id || source.outputDir && job.outputDir && path.resolve(source.outputDir) === path.resolve(job.outputDir)
    )) });
  }
  return jobs;
}

export function visibleJob(job, user) {
  if (!canReadJob(job, user)) return null;
  const result = structuredClone(job);
  result.private = job.private === true;
  result.privateFiles = (job.privateFiles || []).filter((name) => canReadFile(job, name, user));
  const files = (job.files || []).filter((name) => canReadFile(job, name, user));
  const hidden = files.length !== (job.files || []).length
    || (job.privateFiles || []).some((name) => !canReadFile(job, name, user))
    || (job[aliases] || []).some((source) => !ownsJob(source, user)
      && (source.private === true || source.privateFiles?.length));
  result.files = files;
  for (const field of ['songMetadata', 'transcriptions']) {
    if (!job[field]) continue;
    result[field] = Object.fromEntries(Object.entries(result[field])
      .filter(([name]) => canReadFile(job, name, user)).map(([name, value]) => {
        if (value?.noVocalsName && !canReadFile(job, value.noVocalsName, user)) delete value.noVocalsName;
        return [name, value];
      }));
  }
  if (hidden) {
    for (const field of ['output', 'command', 'error', 'warning', 'logs']) delete result[field];
    result.songCount = countDownloadedFiles(files);
    result.playlistSongCount = result.songCount;
    result.transcriptionPending = Object.values(result.transcriptions || {}).some((record) => record.status === 'sent');
  }
  Object.defineProperty(result, aliases, { configurable: true, value: [job, ...(job[aliases] || [])] });
  return result;
}

// Identifiers/expressions are supplied only by server code; viewer values remain SQL parameters.
export function jobVisibilitySql(job = 'jobs', viewer = '$1') {
  return `(COALESCE(${job}.data->'private', 'false'::jsonb) <> 'true'::jsonb
    OR (${viewer}::text IS NOT NULL AND NULLIF(${job}.data->'initiatedBy'->>'id', '') IS NOT NULL
      AND ${job}.data->'initiatedBy'->>'id' = ${viewer}))`;
}

function stemSql(name) {
  return `lower(btrim(regexp_replace(regexp_replace(regexp_replace(${name}, '^.*/', ''), '\\.[^.]+$', ''),
    '(\\[no[ _-]?vocals\\]|[ _-]+no[ _-]?vocals)', '', 'gi')))`;
}

export function fileVisibilitySql(job = 'jobs', name = 'songs.name', viewer = '$1') {
  return `NOT EXISTS (SELECT 1 FROM jobs privacy_job
    WHERE (privacy_job.data->'private' = 'true'::jsonb
      OR jsonb_array_length(COALESCE(privacy_job.data->'privateFiles', '[]'::jsonb)) > 0)
    AND (privacy_job.id = ${job}.id OR (NULLIF(${job}.data->>'outputDir', '') IS NOT NULL
      AND rtrim(privacy_job.data->>'outputDir', '/') = rtrim(${job}.data->>'outputDir', '/')))
    AND (${viewer}::text IS NULL OR NULLIF(privacy_job.data->'initiatedBy'->>'id', '') IS NULL
      OR privacy_job.data->'initiatedBy'->>'id' <> ${viewer})
    AND (privacy_job.data->'private' = 'true'::jsonb OR EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(COALESCE(privacy_job.data->'privateFiles', '[]'::jsonb)) private_file(name)
      WHERE private_file.name = ${name} OR (lower(${name}) LIKE '[novocals]/%' AND (
        ${stemSql('private_file.name')} = ${stemSql(name)}
        OR EXISTS (SELECT 1 FROM songs privacy_song WHERE privacy_song.job_id = privacy_job.id
          AND privacy_song.name = private_file.name AND privacy_song.transcription->>'noVocalsName' = ${name})
        OR privacy_job.data->'transcriptions'->private_file.name->>'noVocalsName' = ${name}
      )))
    ))`;
}

export function songVisibilitySql(viewer = '$1', job = 'jobs', song = 'songs') {
  return fileVisibilitySql(job, `${song}.name`, viewer);
}

export function entryVisibilitySql(entry = 'entry', viewer = '$2') {
  return `(${entry}.user_id = ${viewer} OR COALESCE(${entry}.data->'private', 'false'::jsonb) <> 'true'::jsonb)
    AND NOT EXISTS (SELECT 1 FROM jobs privacy_playlist WHERE privacy_playlist.id = ${entry}.id
      AND NOT ${jobVisibilitySql('privacy_playlist', viewer)})`;
}
