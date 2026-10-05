import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const projectRoot = process.cwd();
const installRoot = path.resolve(projectRoot, 'runtime', 'ffmpeg');
const binRoot = path.join(installRoot, 'bin');
const ffmpegPath = path.join(binRoot, 'ffmpeg.exe');
const ffprobePath = path.join(binRoot, 'ffprobe.exe');
const downloadUrl = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip';

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with code ${code}`));
      }
    });
  });
}

async function findFile(directory, fileName) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const match = await findFile(entryPath, fileName);
      if (match) return match;
    } else if (entry.name.toLowerCase() === fileName.toLowerCase()) {
      return entryPath;
    }
  }
  return null;
}

if (process.platform !== 'win32') {
  throw new Error('This installer currently supports Windows only. Set FFMPEG_PATH to an existing FFmpeg installation.');
}

await fs.mkdir(binRoot, { recursive: true });

if (await exists(ffmpegPath) && await exists(ffprobePath)) {
  console.log(`FFmpeg runtime already installed at ${binRoot}`);
  process.exit(0);
}

const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ssmusic-ffmpeg-'));
const archivePath = path.join(temporaryRoot, 'ffmpeg.zip');
const extractRoot = path.join(temporaryRoot, 'extract');

try {
  console.log(`Downloading FFmpeg from ${downloadUrl}`);
  const response = await fetch(downloadUrl);
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }

  await fs.writeFile(archivePath, Buffer.from(await response.arrayBuffer()));
  await fs.mkdir(extractRoot, { recursive: true });
  await run('tar', ['-xf', archivePath, '-C', extractRoot]);

  const extractedFfmpeg = await findFile(extractRoot, 'ffmpeg.exe');
  const extractedFfprobe = await findFile(extractRoot, 'ffprobe.exe');
  if (!extractedFfmpeg || !extractedFfprobe) {
    throw new Error('Downloaded archive did not contain ffmpeg.exe and ffprobe.exe');
  }

  await Promise.all([
    fs.copyFile(extractedFfmpeg, ffmpegPath),
    fs.copyFile(extractedFfprobe, ffprobePath)
  ]);
  console.log(`FFmpeg runtime installed at ${binRoot}`);
} finally {
  await fs.rm(temporaryRoot, { recursive: true, force: true });
}