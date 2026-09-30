import crypto from 'node:crypto';

const INVALID_FOLDER_CHARS = /[<>:"/\\|?*\x00-\x1F]/g;

export function isYouTubeUrl(value) {
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol)
      && ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'].includes(parsed.hostname)
      && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

export function isYouTubeMusicUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.hostname === 'music.youtube.com';
  } catch {
    return false;
  }
}

export function isPlaylistUrl(value) {
  if (!isYouTubeUrl(value)) {
    return false;
  }

  const parsed = new URL(value);
  return parsed.searchParams.has('list');
}

export function normalizeJobUrl(value) {
  const trimmed = value.trim();
  if (!isPlaylistUrl(trimmed)) return trimmed;
  const source = new URL(trimmed);
  const playlist = new URL('https://music.youtube.com/playlist');
  playlist.searchParams.set('list', source.searchParams.get('list'));
  return playlist.href;
}

export function sanitizeFolderName(name) {
  return String(name || 'playlist')
    .trim()
    .replace(/\s+/g, '_')
    .replace(INVALID_FOLDER_CHARS, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) || 'playlist';
}

export function randomSongFolderName() {
  return `song_${crypto.randomUUID()}`;
}
