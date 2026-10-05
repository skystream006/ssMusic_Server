import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { ZipArchive } from 'archiver';
import { getPlaylistIds, getPlaylistTracks, songKey } from './library.js';
import { readSongMetadata } from './music.js';
import { isPlayableFile } from './media.js';
import { isSongFile } from './transcription.js';

function failure(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function xml(value) {
  return String(value).replace(/[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu, '')
    .replace(/[<>&"']/g, (character) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[character]);
}

function text(key, value) {
  return `<key>${key}</key><string>${xml(value)}</string>`;
}

function integer(key, value) {
  return `<key>${key}</key><integer>${value}</integer>`;
}

function safeName(value) {
  return String(value).replace(/[^a-z0-9 _-]/gi, '_').slice(0, 80).trim() || 'Untitled';
}

function persistentId(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 16).toUpperCase();
}

export function exportOptions(format, destination) {
  if (!['itunes', 'android'].includes(format)) throw failure('Choose iTunes or Android library format.');
  if (format === 'android') return { format };
  if (typeof destination !== 'string' || !destination.trim() || destination.length > 2048
    || /[\u0000-\u001f]/.test(destination)) {
    throw failure('Enter the absolute folder where you will extract the iTunes ZIP.');
  }
  const directory = destination.trim().replace(/\\/g, '/');
  const windows = /^[a-z]:\//i.test(directory);
  if ((!windows && !directory.startsWith('/')) || directory.startsWith('//')
    || directory.split('/').some((part, index) => part === '.' || part === '..'
      || (windows && index > 0 && /[<>:"|?*]/.test(part)))) {
    throw failure('Use an absolute local Windows or macOS folder, without . or .. path segments.');
  }
  const encoded = directory.replace(/\/+$/, '').split('/').map((part, index) => (
    windows && index === 0 ? part : encodeURIComponent(part)
  )).join('/');
  return { format, destination: directory, baseUrl: `file://${windows ? '/' : ''}${encoded}/` };
}

function inside(directory, file) {
  const relative = path.relative(directory, file);
  return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function resolveSong(job, name) {
  if (!job?.outputDir || typeof name !== 'string' || path.isAbsolute(name) || name.includes('\\')) {
    throw failure('A library song has an invalid path.', 409);
  }
  const root = path.resolve(job.outputDir);
  const candidate = path.resolve(root, name);
  if (!inside(root, candidate)) throw failure('A library song has an invalid path.', 409);
  try {
    const [realRoot, realFile] = await Promise.all([fs.realpath(root), fs.realpath(candidate)]);
    if (!inside(realRoot, realFile) || !(await fs.stat(realFile)).isFile()) throw new Error('Not a library file');
    return realFile;
  } catch {
    throw failure('A library song is missing or unsafe to export. Refresh the library and try again.', 409);
  }
}

function itunesLibrary(library, tracks, playlists, baseUrl) {
  const trackXml = tracks.map((track) => {
    const metadata = track.metadata;
    return `<key>${track.id}</key><dict>${integer('Track ID', track.id)}${text('Name', metadata.title)}`
      + text('Artist', metadata.artist) + text('Album', metadata.album) + text('Genre', metadata.genre)
      + text('Track Type', 'File') + text('Location', baseUrl + track.archivePath.split('/').map(encodeURIComponent).join('/'))
      + '</dict>';
  }).join('\n');
  const playlistMap = new Map(playlists.map((playlist) => [playlist.id, playlist]));
  const playlistXml = library.entries.map((entry, index) => {
    const playlist = playlistMap.get(entry.id);
    return `<dict>${text('Name', entry.type === 'folder' ? entry.name : playlist.title)}`
      + integer('Playlist ID', index + 1) + text('Playlist Persistent ID', persistentId(entry.id))
      + (entry.parentId ? text('Parent Persistent ID', persistentId(entry.parentId)) : '')
      + (entry.type === 'folder' ? '<key>Folder</key><true/>' : '<key>All Items</key><true/><key>Playlist Items</key><array>'
        + playlist.tracks.map((track) => `<dict>${integer('Track ID', track.id)}</dict>`).join('') + '</array>')
      + '</dict>';
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
${integer('Major Version', 1)}${integer('Minor Version', 1)}${text('Application Version', '12.0')}
${text('Music Folder', `${baseUrl}Music/`)}
<key>Tracks</key><dict>${trackXml}</dict>
<key>Playlists</key><array>${playlistXml}</array>
</dict></plist>
`;
}

export async function prepareLibraryExport(library, jobs, options) {
  const jobMap = new Map(jobs.map((job) => [job.id, job]));
  const entryMap = new Map(library.entries.map((entry) => [entry.id, entry]));
  const selected = options.playlistId === undefined ? null : entryMap.get(options.playlistId);
  if (options.playlistId !== undefined && selected?.type !== 'playlist') throw failure('Playlist not found', 404);
  const entries = selected ? [{ ...selected, parentId: null }] : library.entries;
  const playlistTracks = getPlaylistTracks(library, jobs);
  const tracks = new Map();
  const playlists = [];
  for (const id of getPlaylistIds(entries)) {
    const playlist = { id, title: entryMap.get(id).name || jobMap.get(id)?.playlistTitle || id, tracks: [] };
    for (const song of playlistTracks.get(id)) {
      if (options.format === 'playlist' ? !isPlayableFile(song.name) : !isSongFile(song.name)) continue;
      const key = songKey(song);
      if (!tracks.has(key)) {
        const extension = path.extname(song.name).toLowerCase();
        if (options.format === 'itunes' && !['.mp3', '.m4a', '.aac', '.wav', '.aif', '.aiff'].includes(extension)) {
          throw failure('This library contains audio that iTunes cannot import. Convert it to MP3 or AAC before exporting.');
        }
        const filePath = await resolveSong(jobMap.get(song.jobId), song.name);
        const { title, artist, album, genre } = await readSongMetadata(filePath, { bounded: options.format === 'playlist' });
        const trackId = tracks.size + 1;
        tracks.set(key, { id: trackId, filePath, metadata: { title, artist, album, genre },
          archivePath: `${options.format === 'playlist' ? 'Media' : 'Music'}/${trackId}-${safeName(path.basename(song.name, path.extname(song.name)))}${extension}` });
      }
      playlist.tracks.push(tracks.get(key));
    }
    playlists.push(playlist);
  }
  const files = [...tracks.values()];
  const documents = options.format === 'itunes'
    ? [{ name: 'Library.xml', content: itunesLibrary({ ...library, entries }, files, playlists, options.baseUrl) }]
    : playlists.map((playlist, index) => ({
      name: `${index + 1}-${safeName(playlist.title)}.m3u8`,
      content: '#EXTM3U\n' + `#PLAYLIST:${playlist.title.replace(/[\r\n]/g, ' ')}\n`
        + playlist.tracks.map((track) => `#EXTINF:-1,${[track.metadata.artist, track.metadata.title].filter(Boolean).join(' - ').replace(/[\r\n]/g, ' ')}\n${track.archivePath}\n`).join('')
    }));
  documents.push({ name: 'IMPORT.txt', content: options.format === 'playlist'
    ? 'Extract the entire ZIP into one folder. Keep the .m3u8 playlist beside the Media folder. Open the playlist in a player that supports UTF-8 M3U8 playlists with relative paths. Use playlist order, with shuffle off, to retain the saved track order. Original media files, metadata and artwork are retained. No media is transcoded.\n'
    : options.format === 'itunes'
    ? `Extract all ZIP contents directly into:\n${options.destination}\n\nKeep Library.xml beside the Music folder. In iTunes (Windows) or Music (macOS), add the extracted Music folder to your library first, then use File > Library > Import Playlist and select Library.xml. The XML uses absolute file URLs for the destination above; extracting elsewhere requires a new export with the correct destination. Select playlist order (not artist/title sorting) to see the saved song order. Audio tags and artwork are retained in the original files. No audio is transcoded.\n`
    : 'Extract the entire ZIP into one folder on your Android device. Keep the .m3u8 files beside the Music folder. In a player that supports UTF-8 M3U8 playlists with relative paths, grant access to this folder, scan the audio, then import each .m3u8 playlist. Use playlist order, with shuffle off, to retain saved song order. Android has no universal library import format: support, empty playlists and playlist names depend on the player. Folder hierarchy is not imported. Audio tags and artwork are retained in the original files. No audio is transcoded.\n' });
  return { files, documents };
}

export async function writeLibraryExport(filePath, prepared, onProgress = () => {}) {
  const handle = await fs.open(filePath, 'wx', 0o600);
  const output = handle.createWriteStream();
  const archive = new ZipArchive({ zlib: { level: 6 } });
  const pendingSongs = new Set(prepared.files.map((file) => file.archivePath));
  let processedSongs = 0;
  archive.on('entry', (entry) => {
    if (pendingSongs.delete(entry.name)) onProgress(++processedSongs);
  });
  archive.on('warning', (error) => archive.destroy(error));
  const writing = pipeline(archive, output);
  try {
    for (const document of prepared.documents) archive.append(document.content, { name: document.name });
    for (const file of prepared.files) archive.file(file.filePath, { name: file.archivePath });
    await Promise.all([writing, archive.finalize()]);
  } catch (error) {
    archive.destroy();
    output.destroy();
    await writing.catch(() => {});
    await fs.rm(filePath, { force: true });
    throw error;
  }
}
