import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

let server;
let SongActions;
let SongRating;
let ListSongRating;
let TranscriptionDialog;
let TranscriptionStatus;
let SongGroups;
let findNoVocals;
let queueSongNext;
let formatLyricsForCopy;
let ExportLibraryDialog;
let ImportMusic;
let canRunJobAction;

before(async () => {
  server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  ({ SongActions, SongRating, ListSongRating, TranscriptionDialog, TranscriptionStatus, canRunJobAction } = await server.ssrLoadModule('/src/SongActions.jsx'));
  ({ SongGroups, findNoVocals, queueSongNext, formatLyricsForCopy } = await server.ssrLoadModule('/src/MusicPlayer.jsx'));
  ({ ExportLibraryDialog } = await server.ssrLoadModule('/src/MusicLibrary.jsx'));
  ({ default: ImportMusic } = await server.ssrLoadModule('/src/ImportMusic.jsx'));
});

after(async () => { await server?.close(); });

test('job action eligibility respects owners, contributors, administrators, active jobs and imports', () => {
  const owner = { id: 'owner', role: 'user' };
  const contributor = { id: 'contributor', role: 'user' };
  const admin = { id: 'admin', role: 'admin' };
  const viewer = { id: 'viewer', role: 'user' };
  const job = { id: 'job', initiatedBy: owner, contributors: [contributor], status: 'completed' };
  for (const user of [owner, contributor, admin]) assert.equal(canRunJobAction(user, job, 'rerun'), true);
  for (const user of [owner, admin]) assert.equal(canRunJobAction(user, job, 'delete'), true);
  assert.equal(canRunJobAction(contributor, job, 'delete'), false);
  for (const action of ['rerun', 'delete']) {
    for (const user of [viewer, null]) assert.equal(canRunJobAction(user, job, action), false);
    assert.equal(canRunJobAction(owner, null, action), false);
    for (const status of ['queued', 'running']) {
      for (const user of [owner, contributor, admin]) assert.equal(canRunJobAction(user, { ...job, status }, action), false);
    }
    for (const status of ['completed', 'partially_completed', 'failed']) assert.equal(canRunJobAction(owner, { ...job, status }, action), true);
  }
  for (const source of ['files', 'itunes']) {
    assert.equal(canRunJobAction(admin, { ...job, source }, 'rerun'), false);
    assert.equal(canRunJobAction(owner, { ...job, source }, 'delete'), true);
  }
  assert.equal(canRunJobAction(owner, job, 'unknown'), false);
});

function renderExportDialog() {
  return renderToStaticMarkup(createElement(ExportLibraryDialog, { onClose() {} }));
}

test('song ratings show embedded stars and provide an accessible editable and clearable choice', () => {
  const display = renderToStaticMarkup(createElement(SongRating, { value: 3 }));
  assert.match(display, /role="img" aria-label="3 of 5 stars"/);
  assert.equal((display.match(/fill="currentColor"/g) || []).length, 3);
  assert.equal((display.match(/fill="none"/g) || []).length, 2);
  assert.match(renderToStaticMarkup(createElement(SongRating)), /aria-label="Unrated"/);
  const editor = renderToStaticMarkup(createElement(SongRating, { value: 4, onChange() {} }));
  assert.match(editor, /<legend>Rating<\/legend>/);
  assert.equal((editor.match(/type="radio"/g) || []).length, 6);
  assert.match(editor, /aria-label="No rating"/);
  assert.match(editor.match(/<input[^>]*aria-label="4 of 5 stars"[^>]*>/)[0], /checked=""/);
});

test('inline song ratings use five labeled buttons with a clearable selection and disabled state', () => {
  const props = { value: 3, onChange() {}, inline: true, songName: 'Song.mp3' };
  const html = renderToStaticMarkup(createElement(SongRating, props));
  assert.match(html, /role="group" aria-label="Rating for Song.mp3"/);
  assert.equal((html.match(/type="button"/g) || []).length, 5);
  assert.equal((html.match(/fill="currentColor"/g) || []).length, 3);
  assert.match(html, /aria-label="3 of 5 stars" aria-pressed="true" title="Clear rating"/);
  assert.match(html, /aria-label="4 of 5 stars" aria-pressed="false" title="Rate 4 of 5 stars"/);
  const disabled = renderToStaticMarkup(createElement(SongRating, { ...props, disabled: true }));
  assert.equal((disabled.match(/disabled=""/g) || []).length, 5);
  const unrated = renderToStaticMarkup(createElement(SongRating, { ...props, value: 0 }));
  assert.doesNotMatch(unrated, /aria-pressed="true"|title="Clear rating"/);
  const readOnly = renderToStaticMarkup(createElement(SongRating, { inline: true, value: 3 }));
  assert.match(readOnly, /role="img" aria-label="3 of 5 stars"/);
  assert.doesNotMatch(readOnly, /<button/);
});

test('list song ratings respect edit permission, busy files and supported formats', () => {
  const props = { file: { name: 'Song.mp3', rating: 2 }, jobId: 'job', canModify: true };
  const html = renderToStaticMarkup(createElement(ListSongRating, props));
  assert.equal((html.match(/type="button"/g) || []).length, 5);
  assert.match(html, /aria-label="2 of 5 stars" aria-pressed="true"/);
  const readOnly = renderToStaticMarkup(createElement(ListSongRating, { ...props, canModify: false }));
  assert.match(readOnly, /role="img" aria-label="2 of 5 stars"/);
  assert.doesNotMatch(readOnly, /<button/);
  const busy = renderToStaticMarkup(createElement(ListSongRating, { ...props, disabled: true }));
  assert.equal((busy.match(/disabled=""/g) || []).length, 5);
  for (const name of ['movie.mp4', 'song.wav', 'cover.jpg']) {
    const unsupported = renderToStaticMarkup(createElement(ListSongRating, { ...props, file: { name } }));
    assert.doesNotMatch(unsupported, /<button|<svg/);
  }
});

test('media import offers audio and movie uploads to playlists', () => {
  const html = renderToStaticMarkup(createElement(ImportMusic, { request() {}, onClose() {}, onImported() {} }));
  assert.match(html, />Import media<\/h2>/);
  assert.match(html, /Audio and movie files/);
  const input = html.match(/<input[^>]*type="file"[^>]*>/)[0];
  for (const extension of ['.mp3', '.wav', '.mp4', '.m4v', '.webm', '.mov', '.ogv']) assert.ok(input.includes(extension));
  assert.match(input, /multiple=""/);
  assert.match(html, /Create New Playlist/);
});

test('library export uses a native GET download in a separate tab', () => {
  const html = renderExportDialog();
  const form = html.match(/<form[^>]*>/)[0];
  for (const attribute of ['action="/api/library/export"', 'method="get"', 'target="_blank"', 'rel="noopener"']) {
    assert.ok(form.includes(attribute));
  }
  assert.match(html, /<select [^>]*name="format"/);
  assert.match(html, /<option value="itunes" selected="">iTunes XML<\/option>/);
  assert.match(html, /<option value="android">Android M3U8 \(compatible players\)<\/option>/);
  assert.match(html, /type="submit"[^>]*disabled=""[^>]*>.*Create export<\/button>/);
  assert.match(html, /name="source"/);
  assert.match(html, /value="latest" disabled="">Latest export \(backup\)/);
  assert.match(html, /value="new" selected="">New export/);
  assert.match(html, /role="tab" aria-selected="false"[^>]*>.*Schedule<\/button>/);
  assert.match(html, /Loading backup/);
  assert.match(html, /Export errors open in a separate tab/);
});

test('library export dialog labels its controls and download instructions', () => {
  const html = renderExportDialog();
  const heading = html.match(/<dialog[^>]*aria-labelledby="([^"]+)"/)?.[1];
  assert.ok(heading);
  assert.ok(html.includes(`<h2 id="${heading}">Export library</h2>`));
  for (const name of ['format', 'destination']) {
    const control = html.match(new RegExp(`<(?:input|select)[^>]*name="${name}"[^>]*>`))?.[0];
    assert.ok(control);
    const id = control.match(/id="([^"]+)"/)[1];
    const description = control.match(/aria-describedby="([^"]+)"/)[1];
    assert.ok(html.includes(`<label for="${id}">`));
    assert.ok(html.includes(`id="${description}"`));
  }
  assert.match(html, /aria-label="Close export library"/);
  assert.match(html, /type="button">Cancel<\/button>/);
});

test('iTunes destination requires an absolute local path rather than a URL or UNC path', () => {
  const html = renderExportDialog();
  const input = html.match(/<input[^>]*name="destination"[^>]*>/)[0];
  assert.match(input, /required=""/);
  assert.doesNotMatch(input, /disabled=/);
  const pattern = new RegExp(`^(?:${input.match(/pattern="([^"]+)"/)[1]})$`, 'v');
  for (const path of ['C:\\Users\\Name\\Music\\Export', 'D:/Music/Export', '/Users/Name/Music/Export', '/Users/Nguyễn/Music & more']) {
    assert.ok(pattern.test(path), path);
  }
  for (const path of ['', 'Music/Export', 'C:Music', 'file:///Users/Name/Music', '\\\\server\\share', '//server/share', '/Users/Name\nMusic']) {
    assert.ok(!pattern.test(path), path);
  }
});

test('library export explains extraction layout and format compatibility honestly', () => {
  const html = renderExportDialog();
  assert.match(html, /Song order within each playlist is retained/);
  assert.match(html, /Music\/<\/strong> and <strong>Library.xml<\/strong> are at its root/);
  assert.match(html, /Add the Music folder to your app library first/);
  assert.match(html, /File &gt; Library &gt; Import Playlist/);
  assert.match(html, /correct file URLs in Library.xml/);
  assert.match(html, /root <strong>.m3u8<\/strong> playlists beside the <strong>Music\/<\/strong> folder/);
  assert.match(html, /UTF-8 M3U8 with relative paths/);
  assert.match(html, /does not import into a universal Android system music database/);
});

test('karaoke groups NoVocals songs in a collapsed section', () => {
  const tracks = [{ name: 'Song.mp3' }, { name: '[NoVocals]/Song.mp3' }];
  const html = renderToStaticMarkup(createElement(SongGroups, { tracks },
    (group) => createElement('ol', null, group.map((track) => createElement('li', { key: track.name }, track.name)))));
  assert.match(html, /<ol><li>Song.mp3<\/li><\/ol><details class="no-vocals-section">/);
  assert.match(html, /<summary>\[NoVocals\]/);
  assert.ok(!html.includes(' open=""'));
  assert.match(html, /<li>\[NoVocals\]\/Song.mp3<\/li>/);
});

test('karaoke matches only an unambiguous version from the same job', () => {
  const original = { jobId: 'one', name: 'Song.mp3' };
  const version = { jobId: 'one', name: '[NoVocals]/Song [NoVocals].mp3' };
  const other = { ...version, jobId: 'two' };
  assert.equal(findNoVocals(original, [other, version]), version);
  assert.equal(findNoVocals(original, [other]), null);
  assert.equal(findNoVocals(version, [version]), null);
  assert.equal(findNoVocals(original, [version, { ...version, name: '[NoVocals]/Song.wav' }]), null);
  const named = { jobId: 'one', name: '[NoVocals]/instrumental.wav' };
  assert.equal(findNoVocals({ ...original, noVocalsName: named.name }, [named, version]), named);
});

test('karaoke inserts next without duplicates and preserves the rest of the queue', () => {
  const original = { jobId: 'one', name: 'Song.mp3' };
  const version = { jobId: 'one', name: '[NoVocals]/Song.mp3' };
  const other = { jobId: 'two', name: 'Other.mp3' };
  const queue = [version, original, other];
  const selected = JSON.stringify([original.jobId, original.name]);
  assert.deepEqual(queueSongNext(queue, selected, version), [original, version, other]);
  assert.deepEqual(queue, [version, original, other]);
  assert.deepEqual(queueSongNext(null, null, version), [version]);
  assert.deepEqual(queueSongNext([original, other], selected, version), [original, version, other]);
  const activeQueue = [original, version, other];
  assert.deepEqual(queueSongNext(activeQueue, JSON.stringify([version.jobId, version.name]), version), activeQueue);
});

test('copying SYLT preserves timestamps while USLT stays plain text', () => {
  const metadata = { sylt: [
    { time: 0, text: 'Opening' },
    { time: 9.007, text: 'Early line' },
    { time: 59.9996, text: 'Minute boundary' },
    { time: 65.123, text: 'First line\nSecond line' },
    { time: 65.123, text: 'Same timestamp' },
    { time: 3600.007, text: 'After an hour' }
  ], uslt: 'Plain lyrics\n\nWithout timestamps' };
  assert.equal(formatLyricsForCopy(metadata, 'sylt'), [
    '[00:00.000] Opening', '[00:09.007] Early line', '[01:00.000] Minute boundary',
    '[01:05.123] First line\nSecond line', '[01:05.123] Same timestamp', '[60:00.007] After an hour'
  ].join('\n'));
  assert.equal(formatLyricsForCopy(metadata, 'uslt'), metadata.uslt);
  for (const mode of ['sylt', 'uslt']) {
    assert.equal(formatLyricsForCopy(null, mode), '');
    assert.equal(formatLyricsForCopy({ sylt: [], uslt: '' }, mode), '');
  }
});

test('transcription status distinguishes supplied lyrics from AI transcription', () => {
  for (const [lyricsIncluded, label] of [[true, 'Lyrics included'], [false, 'AI transcription'], [undefined, 'AI transcription']]) {
    const html = renderToStaticMarkup(createElement(TranscriptionStatus, {
      transcription: { status: 'transcribed', lyricsIncluded, requestedAt: '2026-09-28T10:00:00Z', completedAt: '2026-09-28T10:01:00Z' }
    }));
    assert.ok(html.includes(`<span>${label}</span>`));
    assert.match(html, /song-transcription-transcribed/);
    assert.match(html, /Requested:/);
    assert.match(html, /Finished:/);
    assert.doesNotMatch(html, />Transcribed</);
    assert.doesNotMatch(html, /Language:|Multilingual:|Lyrics mode:/);
  }
});

test('transcription status preserves pending, failed and interrupted labels', () => {
  for (const [status, label] of [['sent', 'Transcription request sent'], ['failed', 'Transcription failed'], ['interrupted', 'Interrupted']]) {
    const html = renderToStaticMarkup(createElement(TranscriptionStatus, {
      transcription: { status, lyricsIncluded: true, requestedAt: '2026-09-28T10:00:00Z' }
    }));
    assert.ok(html.includes(`<span>${label}</span>`));
    assert.doesNotMatch(html, /Lyrics included|AI transcription/);
  }
  assert.equal(renderToStaticMarkup(createElement(TranscriptionStatus)), '');
});

test('transcription status tooltips show saved settings without lyric text', () => {
  for (const [status, mode, label] of [['sent', 'prompt', 'Prompt'], ['transcribed', 'align', 'Align'], ['failed', 'correct', 'Correct'], ['interrupted', 'align', 'Align']]) {
    const html = renderToStaticMarkup(createElement(TranscriptionStatus, {
      transcription: {
        status, requestedAt: '2026-09-28T10:00:00Z', lyricsIncluded: true,
        options: { language: 'vi', Multilingual: true, NoVocals: false, VietLyricsFallback: true, lyrics_mode: mode, lyrics: 'Private lyric text' }
      }
    }));
    const tooltip = html.match(/title="([^"]*)"/)[1];
    for (const detail of ['Language: Vietnamese', 'Multilingual: On', 'No vocals (karaoke): Off', 'Viet Lyrics Fallback: On', 'Add lyrics: Yes', `Lyrics mode: ${label}`]) {
      assert.ok(tooltip.includes(detail), detail);
    }
    assert.doesNotMatch(html, /Private lyric text/);
  }
});

test('transcription status tooltips distinguish unchecked options from service defaults', () => {
  for (const [options, label] of [[{ Multilingual: false, NoVocals: false, VietLyricsFallback: false }, 'Off'], [{}, 'Service default']]) {
    const html = renderToStaticMarkup(createElement(TranscriptionStatus, {
      transcription: { status: 'transcribed', requestedAt: '2026-09-28T10:00:00Z', lyricsIncluded: false, options }
    }));
    const tooltip = html.match(/title="([^"]*)"/)[1];
    for (const detail of ['Language: Auto-detect', `Multilingual: ${label}`, `No vocals (karaoke): ${label}`, `Viet Lyrics Fallback: ${label}`, 'Add lyrics: No']) {
      assert.ok(tooltip.includes(detail), detail);
    }
    assert.doesNotMatch(tooltip, /Lyrics mode:/);
  }
});

test('transcription dialog exposes upstream options with unchecked defaults', () => {
  const html = renderToStaticMarkup(createElement(TranscriptionDialog, {
    file: { name: 'Song.mp3', sizeBytes: 1024 }, onClose() {}, onSubmit() {}
  }));
  for (const label of ['Multilingual', 'Create no-vocals version [Karaoke version]', 'Viet Lyrics Fallback', 'Add lyrics']) {
    assert.ok(html.includes(`/>${label}</label>`));
  }
  assert.equal((html.match(/type="checkbox"/g) || []).length, 4);
  assert.ok(!html.includes('checked=""'));
  assert.ok(html.includes('<option value="" selected="">Auto-detect</option>'));
  assert.ok(html.includes('<option value="vi">Vietnamese</option>'));
});

test('transcription options have linked help buttons and descriptions', () => {
  const html = renderToStaticMarkup(createElement(TranscriptionDialog, {
    file: { name: 'Song.mp3', sizeBytes: 1024 }, onClose() {}, onSubmit() {}
  }));
  for (const label of ['Language', 'Multilingual', 'No Vocals', 'Viet Lyrics Fallback', 'Add lyrics']) {
    const descriptionId = html.match(new RegExp(`type="button" aria-label="About ${label}" aria-describedby="([^"]+)"`))?.[1];
    assert.ok(descriptionId, `Missing help button for ${label}`);
    assert.ok(html.includes(`role="tooltip" id="${descriptionId}">`));
    assert.equal(html.split(`aria-describedby="${descriptionId}"`).length - 1, 2);
  }
  assert.match(html, /opening retry triggers/);
  assert.match(html, /Automatically selects Vietnamese/);
  assert.match(html, /\[NoVocals\] folder/);
});

function renderActions(canModify = true) {
  return renderToStaticMarkup(createElement(SongActions, { name: 'Song.mp3', className: 'song-order-actions' },
    canModify && createElement('button', { title: 'Edit song metadata', disabled: true }, 'Edit'),
    createElement('button', { title: 'Transcribe song' }, 'Transcribe'),
    canModify && createElement('button', { title: 'Delete song' }, 'Delete'),
    createElement('a', { title: 'Download song', href: '/download/song.mp3' }, 'Download')
  ));
}

test('song actions retain labels, disabled states and download URLs in both layouts', () => {
  const html = renderActions();
  assert.equal((html.match(/title="Edit song metadata" disabled=""/g) || []).length, 2);
  assert.equal((html.match(/href="\/download\/song.mp3"/g) || []).length, 2);
  for (const label of ['Edit song metadata', 'Transcribe song', 'Delete song', 'Download song']) {
    assert.ok(html.includes(`<span>${label}</span>`));
  }
});

test('song actions do not expose restricted controls in the overflow menu', () => {
  const html = renderActions(false);
  assert.ok(!html.includes('Edit song metadata'));
  assert.ok(!html.includes('Delete song'));
  assert.ok(html.includes('<span>Transcribe song</span>'));
  assert.ok(html.includes('<span>Download song</span>'));
});

test('song action trigger identifies its popover and starts collapsed', () => {
  const html = renderActions();
  const target = html.match(/popoverTarget="([^"]+)"/i)?.[1];
  assert.ok(target);
  assert.ok(html.includes(`id="${target}"`));
  assert.ok(html.includes(`aria-controls="${target}"`));
  assert.ok(html.includes('aria-expanded="false"'));
  assert.ok(html.includes('popover="auto"'));
  assert.ok(html.includes('aria-label="Actions for Song.mp3"'));
});
