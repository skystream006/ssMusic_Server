import os from 'node:os';
import fs from 'node:fs/promises';
import path from 'node:path';
import si from 'systeminformation';
import { mediaType } from './media.js';

export async function countMediaFiles(jobs) {
  return (await scanMediaFiles(jobs)).totalFiles;
}

export async function scanMediaFiles(jobs) {
  const files = new Map();
  for (const job of jobs) {
    if (!job.outputDir) continue;
    for (const name of job.files || []) {
      if (typeof name !== 'string') continue;
      const type = mediaType(name);
      if (!type) continue;
      const filePath = path.resolve(job.outputDir, name);
      const relative = path.relative(job.outputDir, filePath);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
      const key = process.platform === 'win32' ? filePath.toLowerCase() : filePath;
      if (!files.has(key)) files.set(key, { filePath, type, owners: new Set() });
      const ownerId = job.initiatedBy?.id;
      if (typeof ownerId === 'string' && ownerId) files.get(key).owners.add(ownerId);
    }
  }
  let totalFiles = 0;
  let totalBytes = 0;
  const byUser = new Map();
  for (const { filePath, type, owners } of files.values()) {
    try {
      const stats = await fs.lstat(filePath);
      if (!stats.isFile()) continue;
      totalFiles += 1;
      totalBytes += stats.size;
      for (const ownerId of owners) {
        if (!byUser.has(ownerId)) byUser.set(ownerId, { totalFiles: 0, songFiles: 0, totalBytes: 0 });
        const usage = byUser.get(ownerId);
        usage.totalFiles += 1;
        if (type === 'audio') usage.songFiles += 1;
        usage.totalBytes += stats.size;
      }
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    }
  }
  return { totalFiles, totalBytes, byUser: Object.fromEntries(byUser) };
}

export function createMediaCountMonitor(scan) {
  let state = { totalFiles: null, totalBytes: null, byUser: null, scannedAt: null, scanning: false, error: null };
  async function refresh() {
    if (state.scanning) return;
    state = { ...state, scanning: true };
    try {
      const usage = await scan();
      state = { ...usage, scannedAt: new Date().toISOString(), scanning: false, error: null };
    } catch {
      state = { ...state, scanning: false, error: 'Media count scan failed' };
    }
  }
  const ready = refresh();
  const timer = setInterval(refresh, 24 * 60 * 60 * 1000);
  timer.unref?.();
  return { ready, getStatus: () => ({ ...state }), stop: () => clearInterval(timer) };
}

export async function getTranscriptionHealth() {
  const endpoint = process.env.TRANSCRIPTION_ENDPOINT?.trim();
  if (!endpoint) {
    return { status: 'inactive', message: 'TRANSCRIPTION_ENDPOINT is not configured' };
  }

  try {
    const response = await fetch(endpoint, {
      method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(2000)
    });
    await response.body?.cancel();
    return { status: 'active', message: `Endpoint returned HTTP ${response.status}` };
  } catch (error) {
    return {
      status: 'inactive',
      message: error.name === 'TimeoutError' ? 'Endpoint timed out after 2 seconds' : 'Unable to connect to endpoint'
    };
  }
}

export async function getSystemHealth() {
  const [load, memory, disk, network, transcription] = await Promise.all([
    si.currentLoad(),
    si.mem(),
    si.fsSize(),
    si.networkStats(),
    getTranscriptionHealth()
  ]);

  const diskTotals = disk.reduce(
    (acc, item) => {
      acc.total += item.size;
      acc.free += item.available;
      return acc;
    },
    { total: 0, free: 0 }
  );

  const networkTotals = network.reduce(
    (acc, item) => {
      acc.rxBytes += item.rx_bytes;
      acc.txBytes += item.tx_bytes;
      acc.rxSec += item.rx_sec;
      acc.txSec += item.tx_sec;
      return acc;
    },
    { rxBytes: 0, txBytes: 0, rxSec: 0, txSec: 0 }
  );

  return {
    hostname: os.hostname(),
    transcription,
    cpu: {
      usagePercent: load.currentLoad
    },
    memory: {
      totalBytes: memory.total,
      usedBytes: memory.active,
      freeBytes: memory.available
    },
    network: networkTotals,
    storage: {
      totalBytes: diskTotals.total,
      freeBytes: diskTotals.free
    },
    timestamp: new Date().toISOString()
  };
}
