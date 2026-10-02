import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

let server;
let SongActions;
let SongRating;
let ListSongRating;
let ReplaceFileDialog;
let TranscriptionDialog;
let TranscriptionStatus;
let SongGroups;
let findNoVocals;
let queueSongNext;
let replaceSongFile;
let formatLyricsForCopy;
let LyricsEditor;
let ExportLibraryDialog;
let ImportMusic;
let canRunJobAction;
let MusicPlayer;
let PlaybackProvider;
let SharedLibraryAccess;
let UsernameForm;
let LibraryAccessList;

before(async () => {
  server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  ({ SongActions, SongRating, ListSongRating, ReplaceFileDialog, TranscriptionDialog, TranscriptionStatus, canRunJobAction } = await server.ssrLoadModule('/src/SongActions.jsx'));
  ({ default: MusicPlayer, PlaybackProvider, SongGroups, findNoVocals, queueSongNext, replaceSongFile, formatLyricsForCopy, LyricsEditor } = await server.ssrLoadModule('/src/MusicPlayer.jsx'));
  ({ ExportLibraryDialog } = await server.ssrLoadModule('/src/MusicLibrary.jsx'));
  ({ default: ImportMusic } = await server.ssrLoadModule('/src/ImportMusic.jsx'));
  ({ SharedLibraryAccess } = await server.ssrLoadModule('/src/SharedLibraries.jsx'));
  ({ UsernameForm, LibraryAccessList } = await server.ssrLoadModule('/src/AccountSettings.jsx'));
});

after(async () => { await server?.close(); });

test('account settings label username editing and keep library access read-only', () => {
  const html = renderToStaticMarkup(createElement(UsernameForm, { user: { id: 'listener', name: 'Listener' }, request() {}, onSaved() {} }));
  assert.match(html, /<label[^>]*>Username<\/label>/);
  assert.match(html, /minLength="2" maxLength="64"/);
  assert.match(html, /value="Listener"/);
  assert.match(html, /<button[^>]*disabled=""/);
  assert.match(html, /Save username/);
  const access = renderToStaticMarkup(createElement(LibraryAccessList, { request() {} }));
  assert.match(access, /Library access/);
  assert.match(access, /Loading library access/);
  assert.doesNotMatch(access, /type="checkbox"|Save access/);
});

test('playlist bulk deletion is available only for an eligible selection while not saving', () => {
  const previousWindow = globalThis.window;
  globalThis.window = { location: { search: '' } };
  try {
    const render = ({ active = true, count = 2, canRemove = true, saving = false } = {}) => renderToStaticMarkup(
      createElement(PlaybackProvider, { request() {} }, createElement(MusicPlayer, {
        libraryView: { tracks: [], title: 'Playlist', selectedId: 'playlist', saving,
          songSelection: { active, keys: new Set(), count, canRemove, remove() {} } }
      })));
    const button = (html) => html.match(/<button[^>]*aria-label="Delete selected songs"[^>]*>/)?.[0];
    assert.ok(button(render()));
    assert.doesNotMatch(button(render()), /disabled/);
    assert.match(button(render({ count: 0, canRemove: false })), /disabled=""/);
    assert.match(button(render({ canRemove: false })), /disabled=""/);
    assert.match(button(render({ saving: true })), /disabled=""/);
    assert.equal(button(render({ active: false })), undefined);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test('job action eligibility respects owners, contributors, administrators, active jobs and imports', () => {
  const owner = { id: 'owner', role: 'user' };
  const contributor = { id: 'contributor', role: 'user' };
  const admin = { id: 'admin', role: 'admin' };
  const viewer = { id: 'viewer', role: 'user' };
  const job = { id: 'job', initiatedBy: owner, contributors: [contributor], status: 'completed' };
  for (const user of [owner, contributor]) {
    for (const action of ['rerun', 'delete']) assert.equal(canRunJobAction({ ...user, role: 'shared' }, job, action), false);
  }
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

test('Shared library grants support multiple checked users and saving states', () => {
  const props = { users: [{ id: 'one', name: 'First Owner' }, { id: 'two', name: 'Second Owner' }, { id: 'three', name: 'Third Owner' }],
    selectedIds: ['one', 'two'], onChange() {}, onSave() {} };
  const html = renderToStaticMarkup(createElement(SharedLibraryAccess, props));
  assert.equal((html.match(/type="checkbox"/g) || []).length, 3);
  assert.equal((html.match(/checked=""/g) || []).length, 2);
  assert.match(html, /Save access/);
  const saving = renderToStaticMarkup(createElement(SharedLibraryAccess, { ...props, saving: true }));
  assert.equal((saving.match(/disabled=""/g) || []).length, 4);
});

test('Shared playlist rows retain playback but omit server mutation controls', () => {
  const previousWindow = globalThis.window;
  globalThis.window = { location: { search: '' } };
  try {
    const track = { jobId: 'job', playlistId: 'playlist', name: 'Song.mp3', playlistTitle: 'Playlist', downloadUrl: '/song' };
    const html = renderToStaticMarkup(createElement(PlaybackProvider, { request() {} }, createElement(MusicPlayer, {
      libraryView: { readOnly: true, tracks: [track], title: 'Playlist', selectedId: 'playlist',
        songState: () => ({ canModify: false, disabled: true }) }
    })));
    assert.match(html, /aria-label="Play Song.mp3"/);
    assert.match(html, /aria-label="Download Song.mp3"/);
    assert.doesNotMatch(html, /aria-label="(?:Drag|Move|Transcribe|Delete|Edit metadata|Replace File|Select songs)/);
    assert.doesNotMatch(html, /draggable="true"/);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test('replacement dialog accepts one matching-format song and warns about overwriting linked copies', () => {
  for (const name of ['Song.mp3', '[NoVocals]/Song.MP3', 'Song.flac']) {
    const html = renderToStaticMarkup(createElement(ReplaceFileDialog, {
      file: { name }, jobId: 'job', request() {}, onSaved() {}, onClose() {}
    }));
    assert.match(html, /<h2[^>]*>Replace File<\/h2>/);
    assert.match(html, /permanently overwrites the song and its embedded metadata in every playlist/);
    assert.match(html, /server filename and playlist links stay unchanged/);
    assert.match(html, /512 MB/);
    const input = html.match(/<input[^>]*type="file"[^>]*>/g);
    assert.equal(input.length, 1);
    assert.ok(input[0].includes(`accept="${name.slice(name.lastIndexOf('.')).toLowerCase()}"`));
    assert.doesNotMatch(input[0], /multiple/);
    assert.match(html, /type="submit" disabled=""/);
    assert.match(html, /type="button">Cancel/);
  }
});

test('song replacement actions respect audio formats, permissions and busy states in both layouts', () => {
  const previousWindow = globalThis.window;
  globalThis.window = { location: { search: '' } };
  try {
    const render = ({ name = 'Song.mp3', canModify = true, disabled = false, saving = false, readOnly = false } = {}) =>
      renderToStaticMarkup(createElement(PlaybackProvider, { request() {} }, createElement(MusicPlayer, {
        libraryView: { tracks: [{ jobId: 'job', name }], title: 'Playlist', selectedId: 'playlist', saving, readOnly,
          songState: () => ({ canModify, disabled }) }
      })));
    const buttons = (html) => html.match(/<button[^>]*aria-label="Replace File [^"]*"[^>]*>/g) || [];
    for (const name of ['Song.mp3', '[NoVocals]/Song.mp3', 'Song.wav', 'Song.flac']) {
      const actions = buttons(render({ name }));
      assert.equal(actions.length, 2, name);
      for (const button of actions) assert.doesNotMatch(button, /disabled/);
    }
    for (const options of [{ disabled: true }, { saving: true }]) {
      for (const button of buttons(render(options))) assert.match(button, /disabled=""/);
    }
    for (const options of [{ canModify: false }, { readOnly: true, canModify: false }, { name: 'Movie.mp4' }]) {
      assert.equal(buttons(render(options)).length, 0);
    }
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test('replacing queued audio also refreshes nested karaoke versions without losing playlist identity', () => {
  const original = { jobId: 'job', name: 'Song.mp3', playlistId: 'playlist', playlistTitle: 'Playlist' };
  const noVocals = { ...original, name: '[NoVocals]/Song.mp3', streamUrl: '/old', title: 'Old title',
    transcription: { status: 'transcribed' } };
  original.noVocalsVersion = { ...noVocals };
  const other = { ...noVocals, jobId: 'other' };
  const queue = [original, noVocals, other];
  const file = { name: noVocals.name, title: 'Replacement', artist: '', streamUrl: '/new', sizeBytes: 123 };
  const updated = replaceSongFile(queue, 'job', file.name, file);
  assert.deepEqual(updated[1], { ...noVocals, ...file, transcription: undefined });
  assert.deepEqual(updated[0].noVocalsVersion, updated[1]);
  assert.equal(updated[0].name, original.name);
  assert.equal(updated[0].playlistId, 'playlist');
  assert.equal(updated[2], other);
  assert.equal(queue[1].streamUrl, '/old');
  assert.equal(queueSongNext(updated, JSON.stringify(['job', original.name]), updated[0].noVocalsVersion)[1].streamUrl, '/new');
  assert.equal(replaceSongFile(null, 'job', file.name, file), undefined);
});

test('track search matches artist, album and other song metadata in unpaged views', () => {
  const previousWindow = globalThis.window;
  globalThis.window = { location: { search: '' } };
  try {
    const track = { jobId: 'job', name: 'Song.mp3', artist: 'Distinct artist', album: 'Distinct album',
      performerInfo: 'Album ensemble', genre: 'Acoustic', year: '2026', trackNumber: '3/9', partOfSet: '1/2' };
    for (const search of ['DISTINCT ARTIST', 'distinct album', 'Album ensemble', 'Acoustic', '2026', '3/9', '1/2']) {
      const html = renderToStaticMarkup(createElement(PlaybackProvider, { request() {} }, createElement(MusicPlayer, {
        libraryView: { readOnly: true, search, tracks: [track], title: 'Playlist', selectedId: 'playlist',
          songState: () => ({ canModify: false, disabled: true }) }
      })));
      assert.match(html, /aria-label="Play Song.mp3"/, search);
      assert.doesNotMatch(html, /No matching songs/, search);
    }
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

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

test('lyrics editor exposes a single timestamped SYLT text field and multiline USLT', () => {
  const metadata = { sylt: [{ time: 1.234, text: 'Timed line' }, { time: 62.345, text: 'Next\nline' }], uslt: 'Plain line\nSecond line' };
  const render = (mode) => renderToStaticMarkup(createElement(LyricsEditor, { metadata, name: 'Song.mp3', mode, onSave() {}, onCancel() {} }));
  const timed = render('sylt');
  assert.match(timed, /aria-label="SYLT lyrics"[^>]*>\[00:00:01\.234\] Timed line\n\[00:01:02\.345\] Next\\nline<\/textarea>/);
  assert.match(timed, /lyrics-sylt-editor/);
  assert.match(timed, /One \[HH:MM:SS\.mmm\] text per line/);
  assert.match(timed, /Clear SYLT/);
  assert.doesNotMatch(timed, /maxLength=/);
  const plain = render('uslt');
  assert.match(plain, /aria-label="USLT lyrics"[^>]*>Plain line\nSecond line<\/textarea>/);
  assert.match(plain, /maxLength="100000"/);
  assert.match(plain, /Clear USLT/);
  assert.doesNotMatch(plain, /lyrics-sylt-editor/);
  for (const html of [timed, plain]) {
    assert.equal((html.match(/<textarea/g) || []).length, 1);
    assert.doesNotMatch(html, /type="number"|Add lyric line|Delete lyric line/);
    const helpId = html.match(/aria-describedby="([^"]+)"/)[1];
    assert.ok(html.includes(`id="${helpId}"`));
    assert.match(html, /Save lyrics/);
    assert.match(html, /Cancel/);
    assert.match(html.match(/<button[^>]*type="submit"[^>]*>/)[0], /disabled/);
    assert.match(html, /Song.mp3/);
  }
});

test('transcription dialog initially focuses the language selector instead of its help button', () => {
  const html = renderToStaticMarkup(createElement(TranscriptionDialog, {
    file: { name: 'Song.mp3', sizeBytes: 1024 }, onClose() {}, onSubmit() {}
  }));
  assert.equal((html.match(/autofocus=""/g) || []).length, 1);
  assert.match(html, /<select[^>]*autofocus=""[^>]*id="[^"]*-language"/);
  assert.match(html, /<button type="button" aria-label="About Language" aria-describedby="[^"]+">/);
});

test('locked transcription offers only NoVocalsOnly and requires an active service', () => {
  const render = (transcriptionLocked, serviceActive = false) => renderToStaticMarkup(createElement(TranscriptionDialog, {
    file: { name: 'Song.mp3', sizeBytes: 1024, transcriptionLocked }, serviceActive, onClose() {}, onSubmit() {}
  }));
  const locked = render(true);
  assert.match(locked, /aria-label="Unlock transcription" aria-pressed="true"/);
  assert.doesNotMatch(locked, /Language \(optional\)|lyrics-mode-options|transcription-fields/);
  assert.match(locked, /<input type="checkbox" disabled="" checked=""\/>Generate NoVocals Only/);
  assert.equal((locked.match(/type="checkbox"/g) || []).length, 1);
  assert.match(locked.match(/<button[^>]*type="submit"[^>]*>/)[0], /disabled/);
  assert.doesNotMatch(render(true, true).match(/<button[^>]*type="submit"[^>]*>/)[0], /disabled/);
  const inactive = render(false);
  assert.match(inactive, /aria-label="Lock transcription" aria-pressed="false"/);
  assert.match(inactive, /Transciption service is currently inactive\. Refresh the page when transcription service is available/);
  assert.match(inactive.match(/<button[^>]*type="submit"[^>]*>/)[0], /disabled/);
  assert.doesNotMatch(render(false, true).match(/<button[^>]*type="submit"[^>]*>/)[0], /disabled/);
});

test('song rows retain locked transcription and gate availability without blocking other edits', () => {
  const previousWindow = globalThis.window;
  globalThis.window = { location: { search: '' } };
  try {
    const render = (transcriptionActive, transcriptionLocked = false) => renderToStaticMarkup(createElement(PlaybackProvider, { request() {} }, createElement(MusicPlayer, {
      libraryView: { transcriptionActive, title: 'Playlist', selectedId: 'playlist',
        tracks: [{ jobId: 'job', name: 'Busy.mp3' }, { jobId: 'job', name: 'Other.mp3', transcriptionLocked }],
        songState: (track) => ({ canModify: true, disabled: track.name === 'Busy.mp3' }) }
    })));
    const inactive = render(false);
    assert.match(inactive.match(/<button[^>]*aria-label="Transcribe Other.mp3"[^>]*>/)[0], /disabled/);
    assert.match(inactive, /Transciption service is currently inactive/);
    assert.doesNotMatch(inactive.match(/<button[^>]*aria-label="Edit metadata Other.mp3"[^>]*>/)[0], /disabled/);
    assert.match(inactive.match(/<button[^>]*aria-label="Edit metadata Busy.mp3"[^>]*>/)[0], /disabled/);
    assert.doesNotMatch(render(true).match(/<button[^>]*aria-label="Transcribe Other.mp3"[^>]*>/)[0], /disabled/);
    assert.doesNotMatch(render(true, true).match(/<button[^>]*aria-label="Transcribe Other.mp3"[^>]*>/)[0], /disabled/);
    assert.match(render(false, true).match(/<button[^>]*aria-label="Transcribe Other.mp3"[^>]*>/)[0], /disabled/);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
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

test('NoVocalsOnly status reports separation instead of AI transcription', () => {
  for (const [status, label] of [['sent', 'No-vocals request sent'], ['transcribed', 'No-vocals version created'], ['failed', 'No-vocals generation failed']]) {
    const html = renderToStaticMarkup(createElement(TranscriptionStatus, {
      transcription: { status, requestedAt: '2026-10-01T10:00:00Z', options: { NoVocalsOnly: true } }
    }));
    assert.ok(html.includes(`<span>${label}</span>`));
    assert.match(html, /Generate NoVocals Only: On/);
    assert.doesNotMatch(html, /AI transcription|Language:|Add lyrics:/);
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
  for (const label of ['Generate NoVocals Only', 'Multilingual', 'Create no-vocals version [Karaoke version]', 'Viet Lyrics Fallback', 'Add lyrics']) {
    assert.ok(html.includes(`/>${label}</label>`));
  }
  assert.equal((html.match(/type="checkbox"/g) || []).length, 5);
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
