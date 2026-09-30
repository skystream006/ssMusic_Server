import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { openDatabase } from './database.js';
import { exportOptions, prepareLibraryExport, writeLibraryExport } from './libraryExport.js';

function failure(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

export function nextBackupTime(schedule, now = new Date()) {
  const [hour, minute] = schedule.time.split(':').map(Number);
  const next = new Date(now);
  next.setUTCHours(hour, minute, 0, 0);
  if (schedule.frequency === 'weekly') next.setUTCDate(next.getUTCDate() + (schedule.weekday - next.getUTCDay() + 7) % 7);
  if (next <= now) next.setUTCDate(next.getUTCDate() + (schedule.frequency === 'weekly' ? 7 : 1));
  return next.toISOString();
}

export async function createLibraryBackupService({ loadLibrary, database = openDatabase(),
  root = process.env.LIBRARY_BACKUP_ROOT || path.resolve('data', 'library-backups'),
  now = () => new Date(), writeArchive = writeLibraryExport }) {
  const active = new Map();
  const readers = new Map();
  const writing = new Set();
  (await database.prepare("UPDATE library_backups SET running = 0, last_error = 'Backup interrupted by a server restart. Try again.' WHERE running = 1").run());

  function directory(userId) {
    return path.resolve(root, createHash('sha256').update(userId).digest('hex'));
  }

  async function getStatus(userId) {
    const row = (await database.prepare('SELECT * FROM library_backups WHERE user_id = $1').get(userId));
    return { schedule: row ? JSON.parse(row.schedule) : { enabled: false }, nextRunAt: row?.next_run_at || null,
      latest: row?.latest ? JSON.parse(row.latest) : null, running: active.has(userId),
      progress: active.get(userId) ? { ...active.get(userId) } : null,
      lastAttemptAt: row?.last_attempt_at || null, error: row?.last_error || null };
  }

  async function requireUser(userId) {
    const user = await database.prepare('SELECT status, role FROM users WHERE id = $1').get(userId);
    if (user?.status !== 'approved' || user.role === 'shared') {
      throw failure('An approved account is required.', 403);
    }
    (await database.prepare('INSERT INTO library_backups (user_id) VALUES ($1) ON CONFLICT DO NOTHING').run(userId));
  }

  async function saveSchedule(userId, value) {
    (await requireUser(userId));
    if (typeof value?.enabled !== 'boolean') throw failure('Choose whether scheduled backups are enabled.');
    let schedule = { ...(await getStatus(userId)).schedule, enabled: false };
    if (value.enabled) {
      if (!['daily', 'weekly'].includes(value.frequency) || typeof value.time !== 'string'
        || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value.time)
        || (value.frequency === 'weekly' && (!Number.isInteger(value.weekday) || value.weekday < 0 || value.weekday > 6))) {
        throw failure('Choose a daily or weekly schedule with a valid UTC time and weekday.');
      }
      const options = exportOptions(value.format, value.destination);
      schedule = { enabled: true, frequency: value.frequency, time: value.time,
        weekday: value.frequency === 'weekly' ? value.weekday : 0, format: options.format,
        ...(options.destination ? { destination: options.destination } : {}) };
    }
    (await database.prepare('UPDATE library_backups SET schedule = $1, next_run_at = $2 WHERE user_id = $3')
      .run(JSON.stringify(schedule), schedule.enabled ? nextBackupTime(schedule, now()) : null, userId));
    return (await getStatus(userId));
  }

  async function cleanup(userId) {
    const folder = directory(userId);
    const files = await fs.readdir(folder).catch(() => []);
    const latest = (await getStatus(userId)).latest?.id;
    await Promise.all(files.filter((name) => /^[a-f0-9-]{36}\.(zip|partial)$/.test(name)
      && name !== `${latest}.zip` && !readers.has(path.join(folder, name)) && !writing.has(path.join(folder, name)))
      .map((name) => fs.rm(path.join(folder, name), { force: true }).catch(() => {})));
  }

  function start(userId, value) {
    const options = exportOptions(value?.format, value?.destination);
    if (active.has(userId)) throw failure('A library backup is already running.', 409);
    if (active.size >= 2) throw failure('The backup service is busy. Try again shortly.', 503);
    const progress = { stage: 'preparing', processedSongs: 0, totalSongs: null, format: options.format };
    active.set(userId, progress);
    const completion = (async () => {
      const id = randomUUID();
      const folder = directory(userId);
      const temporary = path.join(folder, `${id}.partial`);
      const target = path.join(folder, `${id}.zip`);
      writing.add(temporary);
      writing.add(target);
      let authorized = false;
      try {
        await requireUser(userId);
        authorized = true;
        await database.prepare('UPDATE library_backups SET running = 1, last_attempt_at = $1, last_error = NULL WHERE user_id = $2')
          .run(now().toISOString(), userId);
        await fs.mkdir(folder, { recursive: true, mode: 0o700 });
        await cleanup(userId);
        const { library, jobs } = await loadLibrary(userId);
        const prepared = await prepareLibraryExport(library, jobs, options);
        progress.totalSongs = prepared.files.length;
        progress.stage = 'archiving';
        await writeArchive(temporary, prepared, (processedSongs) => { progress.processedSongs = processedSongs; });
        progress.stage = 'finalizing';
        await fs.rename(temporary, target);
        const stat = await fs.stat(target);
        (await requireUser(userId));
        const latest = { id, format: options.format, ...(options.destination ? { destination: options.destination } : {}),
          createdAt: now().toISOString(), sizeBytes: stat.size, songCount: prepared.files.length };
        (await database.prepare('UPDATE library_backups SET latest = $1, running = 0, last_error = NULL WHERE user_id = $2')
          .run(JSON.stringify(latest), userId));
        await cleanup(userId);
        return latest;
      } catch (error) {
        await Promise.all([temporary, target].map((file) => fs.rm(file, { force: true }).catch(() => {})));
        if (authorized) await database.prepare('UPDATE library_backups SET running = 0, last_error = $1 WHERE user_id = $2')
          .run(error.statusCode ? error.message : 'Unable to create library backup. Check server storage and try again.', userId);
        throw error;
      } finally { writing.delete(temporary); writing.delete(target); active.delete(userId); }
    })();
    return completion;
  }

  async function openLatest(userId) {
    (await requireUser(userId));
    const latest = (await getStatus(userId)).latest;
    if (!latest) throw failure('No library backup is available. Create a new export first.', 404);
    const filePath = path.join(directory(userId), `${latest.id}.zip`);
    readers.set(filePath, (readers.get(filePath) || 0) + 1);
    let handle;
    const release = async () => {
      await handle?.close().catch(() => {});
      const count = readers.get(filePath) - 1;
      if (count) readers.set(filePath, count); else readers.delete(filePath);
      if (!active.has(userId)) await cleanup(userId);
    };
    try {
      handle = await fs.open(filePath, 'r');
      return { latest, handle, release };
    } catch (error) {
      await release();
      if (error.code === 'ENOENT') throw failure('The latest backup file is missing. Create a new export.', 404);
      throw error;
    }
  }

  async function runDue() {
    const due = (await database.prepare(`SELECT backup.user_id FROM library_backups backup JOIN users ON users.id = backup.user_id
      WHERE users.status = 'approved' AND users.role <> 'shared' AND backup.next_run_at <= $1 ORDER BY backup.next_run_at`).all(now().toISOString()));
    for (const { user_id: userId } of due) {
      const status = (await getStatus(userId));
      if (!status.schedule.enabled || !status.nextRunAt || status.nextRunAt > now().toISOString() || active.has(userId)) continue;
      if (active.size >= 2) break;
      const completion = start(userId, status.schedule).catch(() => {});
      (await database.prepare('UPDATE library_backups SET next_run_at = $1 WHERE user_id = $2')
        .run(nextBackupTime(status.schedule, now()), userId));
      await completion;
    }
  }

  return { getStatus, saveSchedule, start, openLatest, runDue };
}