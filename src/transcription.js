import fs from 'node:fs/promises';
import { openAsBlob } from 'node:fs';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { fileTypeFromBuffer } from 'file-type';
import { Agent } from 'undici';
import { transcriptionLanguages } from './transcriptionLanguages.js';

const maxResponseBytes = 512 * 1024 * 1024;
const transcriptionTimeout = 60 * 60_000;
const transcriptionAgent = new Agent({ headersTimeout: transcriptionTimeout, bodyTimeout: transcriptionTimeout });
const audioExtensions = new Set(['.mp3', '.wav', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wma']);

export function isSongFile(name) {
  return audioExtensions.has(path.extname(name).toLowerCase());
}

function failure(message, statusCode = 502) {
  return Object.assign(new Error(message), { statusCode });
}

export function validateLyrics(options = {}) {
  const { lyrics, lyrics_mode: mode } = options;
  if (lyrics === undefined && mode === undefined) return {};
  if (typeof lyrics !== 'string' || !lyrics.trim() || lyrics.length > 100_000) {
    throw failure('Lyrics must contain between 1 and 100,000 characters', 400);
  }
  if (!['prompt', 'align', 'correct'].includes(mode)) {
    throw failure('Select a lyrics mode: prompt, align or correct', 400);
  }
  return { lyrics: lyrics.trim(), lyrics_mode: mode };
}

async function checkAudio(data, name) {
  const type = await fileTypeFromBuffer(data).catch(() => null);
  const extension = path.extname(name).toLowerCase();
  const compatible = type && (type.mime.startsWith('audio/') || ['mp4', 'asf'].includes(type.ext));
  const expected = { '.m4a': ['m4a', 'mp4'], '.wma': ['asf'], '.opus': ['opus', 'ogg'] }[extension] || [extension.slice(1)];
  if (!compatible || !expected.includes(type.ext)) {
    throw failure(`Transcription returned invalid or mismatched audio for ${name}`);
  }
}

export function validateTranscriptionOptions(options = {}) {
  if (options.NoVocalsOnly !== undefined && typeof options.NoVocalsOnly !== 'boolean') {
    throw failure('NoVocalsOnly must be a boolean', 400);
  }
  if (options.NoVocalsOnly === true) return { NoVocalsOnly: true };
  const fields = validateLyrics(options);
  for (const key of ['NoVocalsOnly', 'NoVocals', 'VietLyricsFallback', 'Multilingual']) {
    if (options[key] === undefined) continue;
    if (typeof options[key] !== 'boolean') {
      throw failure(`${key} must be a boolean`, 400);
    }
    fields[key] = options[key];
  }
  if (options.language !== undefined) {
    if (!transcriptionLanguages.some(([code]) => code === options.language)) {
      throw failure('Select a valid transcription language code', 400);
    }
    fields.language = options.language;
  }
  if (fields.VietLyricsFallback) fields.language = 'vi';
  return fields;
}

export async function requestTranscription(filePath, options = {}) {
  const fields = validateTranscriptionOptions(options);
  const endpoint = process.env.TRANSCRIPTION_ENDPOINT;
  if (!endpoint) throw failure('TRANSCRIPTION_ENDPOINT is not configured', 503);
  const form = new FormData();
  form.set('file', await openAsBlob(filePath), path.basename(filePath));
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  let response;
  const chunks = [];
  let size = 0;
  try {
    response = await fetch(endpoint, {
      method: 'POST', body: form, dispatcher: transcriptionAgent,
      signal: AbortSignal.timeout(transcriptionTimeout)
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw failure(`Transcription service returned HTTP ${response.status}`);
    }
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maxResponseBytes) throw failure('Transcription response exceeds 512 MB');
      chunks.push(chunk);
    }
  } catch (error) {
    if (error.statusCode) throw error;
    throw failure(error.name === 'TimeoutError' ? 'Transcription timed out' : 'Unable to receive transcription result');
  }
  const data = Buffer.concat(chunks);
  const name = path.basename(filePath);
  if (data.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) {
    let entries;
    try {
      entries = new AdmZip(data).getEntries().filter((entry) => !entry.isDirectory);
    } catch {
      throw failure('Transcription returned an invalid ZIP archive');
    }
    if (entries.length > 100 || entries.reduce((total, entry) => total + entry.header.size, 0) > maxResponseBytes) {
      throw failure('Transcription archive is too large');
    }
    const results = [];
    const names = new Set();
    for (const entry of entries) {
      const parts = entry.entryName.replaceAll('\\', '/').split('/');
      if (parts.some((part) => !part || part === '..' || part === '.' || /[:\0]/.test(part))) {
        throw failure('Transcription archive contains an unsafe path');
      }
      const entryName = parts.at(-1);
      if (!isSongFile(entryName)) continue;
      if (names.has(entryName.toLowerCase())) throw failure('Transcription archive contains duplicate song names');
      names.add(entryName.toLowerCase());
      let audio;
      try {
        audio = entry.getData();
      } catch {
        throw failure('Transcription archive could not be extracted');
      }
      await checkAudio(audio, entryName);
      results.push({ name: entryName, data: audio, original: entryName === name });
    }
    if (!fields.NoVocalsOnly && !results.some((result) => result.original)) throw failure('Transcription archive does not contain the requested song');
    return results;
  }
  if (fields.NoVocalsOnly) {
    const accompanimentName = `[NoVocals] ${path.basename(name, path.extname(name))}.mp3`;
    await checkAudio(data, accompanimentName);
    return [{ name: accompanimentName, data, original: false }];
  }
  await checkAudio(data, name);
  return [{ name, data, original: true }];
}

export async function replaceTranscribedFiles(job, fileName, results, persist) {
  const staging = await fs.mkdtemp(path.join(job.outputDir, '.transcription-'));
  const replacements = [];
  const previousFiles = [...job.files];
  const previousUpdatedAt = job.updatedAt;
  try {
    if (results.some((result) => !result.original)) {
      const folder = path.join(job.outputDir, '[NoVocals]');
      await fs.mkdir(folder, { recursive: true });
      if ((await fs.lstat(folder)).isSymbolicLink()) throw failure('NoVocals folder must not be a symbolic link', 400);
    }
    for (const [index, result] of results.entries()) {
      const name = result.original ? fileName : `[NoVocals]/${result.name}`;
      const target = path.resolve(job.outputDir, name);
      const staged = path.join(staging, `${index}.new`);
      const backup = path.join(staging, `${index}.old`);
      await fs.writeFile(staged, result.data);
      const existing = await fs.lstat(target).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
      if (existing && !existing.isFile()) throw failure('Song target must be a regular file', 400);
      if (existing) await fs.rename(target, backup);
      const replacement = { target, backup: existing ? backup : null, installed: false };
      replacements.push(replacement);
      await fs.rename(staged, target);
      replacement.installed = true;
      if (!job.files.includes(name)) job.files.push(name);
    }
    job.updatedAt = new Date().toISOString();
    await persist(job);
  } catch (error) {
    for (const replacement of replacements.reverse()) {
      if (replacement.installed) await fs.unlink(replacement.target);
      if (replacement.backup) await fs.rename(replacement.backup, replacement.target);
    }
    job.files = previousFiles;
    job.updatedAt = previousUpdatedAt;
    throw error;
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}