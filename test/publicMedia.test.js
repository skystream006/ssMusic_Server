import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { after, before, test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';

let server;
let PublicMedia;
let PublicMediaView;
let PublicPlaylist;
let PublicPlaylistView;
let seekPublicAudio;
let createPublicLyricsLoader;
let PublicLibraryDialog;
let sharedImportDestinations;
let AdminMediaSharesView;
let AdminArtworkThumbnails;
let AdminArtworkThumbnailsView;
let watchArtworkThumbnails;
let LyricTimeline;
let scrollToActiveLyric;
let appIcon;

before(async () => {
  server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  ({ default: PublicMedia, PublicMediaView, PublicPlaylist, PublicPlaylistView, seekPublicAudio, createPublicLyricsLoader, PublicLibraryDialog, sharedImportDestinations } = await server.ssrLoadModule('/src/PublicMedia.jsx'));
  ({ AdminMediaSharesView, AdminArtworkThumbnails, AdminArtworkThumbnailsView, watchArtworkThumbnails } = await server.ssrLoadModule('/src/AdminMediaShares.jsx'));
  ({ default: LyricTimeline, scrollToActiveLyric } = await server.ssrLoadModule('/src/LyricTimeline.jsx'));
  ({ default: appIcon } = await server.ssrLoadModule('/src/assets/ic_launcher.png'));
});

after(async () => { await server?.close(); });

const media = {
  name: 'Evening song.mp3', sizeBytes: 4 * 1024 * 1024, title: 'Evening song', artist: 'The Quartet',
  album: 'After Hours', performerInfo: 'The Ensemble', genre: 'Jazz', year: '2026', trackNumber: '2/8',
  partOfSet: '1/2', rating: 4, artwork: 'data:image/png;base64,aGVsbG8=',
  sylt: [{ time: 0, text: 'First line' }, { time: 12.5, text: 'Second line' }],
  uslt: 'First line\nSecond line\n\nLast verse',
  streamUrl: '/api/public/media/token/stream', downloadUrl: '/api/public/media/token/download',
  lyricsUrl: '/api/public/media/token/lyrics'
};

function render(props = {}) {
  return renderToStaticMarkup(createElement(PublicMediaView, {
    media, lyricsExpanded: true, lyrics: props.media || media, ...props
  }));
}

test('public lyrics stay collapsed and exclude embedded lyric data until explicitly opened', () => {
  let requests = 0;
  const html = renderToStaticMarkup(createElement(PublicMediaView, { media }));
  const loader = createPublicLyricsLoader(() => { requests += 1; }, media.lyricsUrl, () => {});
  assert.match(html, /aria-expanded="false" aria-controls="public-media-lyrics-content"/);
  assert.match(html, />Show lyrics<\/button>/);
  assert.doesNotMatch(html, /First line|Second line|No lyrics are available|Loading lyrics/);
  assert.equal(requests, 0);
  loader.stop();
});

test('public lyrics fetch only when opened, deduplicate requests and reuse loaded results', async () => {
  for (const url of [media.lyricsUrl, '/api/public/playlists/token/tracks/track/lyrics']) {
    const calls = [];
    const updates = [];
    const deferred = Promise.withResolvers();
    const loader = createPublicLyricsLoader((endpoint, options) => {
      calls.push({ endpoint, options });
      return deferred.promise;
    }, url, (state) => updates.push(state));
    assert.equal(calls.length, 0);
    const pending = loader.load();
    await loader.load();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].endpoint, url);
    assert.equal(updates.at(-1).loading, true);
    deferred.resolve({ sylt: media.sylt, uslt: media.uslt });
    await pending;
    assert.deepEqual(updates.at(-1).lyrics, { sylt: media.sylt, uslt: media.uslt });
    await loader.load();
    assert.equal(calls.length, 1);
    loader.stop();
  }
});

test('public lyrics show loading, error, retry and empty states without changing playback', async () => {
  const updates = [];
  let fail = true;
  const loader = createPublicLyricsLoader(async () => {
    if (fail) throw new Error('Revoked');
    return { sylt: [], uslt: '' };
  }, media.lyricsUrl, (state) => updates.push(state));
  await loader.load();
  assert.match(updates.at(-1).error, /could not be loaded/);
  const failed = render({ lyrics: null, lyricsError: updates.at(-1).error });
  assert.match(failed, /role="alert"/);
  assert.match(failed, />Retry lyrics<\/button>/);
  assert.match(failed, /<audio/);
  assert.match(render({ lyrics: null, lyricsLoading: true }), /role="status">Loading lyrics/);
  fail = false;
  await loader.load();
  assert.equal(updates.at(-1).error, '');
  assert.match(render({ lyrics: updates.at(-1).lyrics }), /No lyrics are available/);
  loader.stop();
});

test('changing public tracks aborts lyric requests and ignores stale success and failure', async () => {
  for (const reject of [false, true]) {
    const deferred = Promise.withResolvers();
    const updates = [];
    let signal;
    const loader = createPublicLyricsLoader((_url, options) => {
      signal = options.signal;
      return deferred.promise;
    }, media.lyricsUrl, (state) => updates.push(state));
    const pending = loader.load();
    loader.stop();
    assert.equal(signal.aborted, true);
    if (reject) deferred.reject(new Error('Late error'));
    else deferred.resolve({ sylt: media.sylt, uslt: media.uslt });
    await pending;
    await loader.load();
    assert.equal(updates.length, 1);
  }
});

test('public playlists render ordered read-only songs, downloads and bounded page controls', () => {
  const playlist = { title: 'Evening collection', page: 1, pageSize: 50, total: 51, totalPages: 2,
    tracks: [{ id: 'first', name: 'Evening.mp3', title: 'Evening', artist: 'Quartet', downloadUrl: '/api/public/playlists/token/tracks/first/download' }] };
  const html = renderToStaticMarkup(createElement(PublicPlaylistView, { playlist, selectedId: 'first' },
    createElement(PublicMediaView, { media, embedded: true })));
  assert.match(html, /Shared playlist/);
  assert.match(html, /Evening collection/);
  assert.match(html, /aria-label="Play Evening"/);
  assert.match(html, /aria-current="true"/);
  assert.match(html, /download="Evening.mp3"/);
  assert.match(html, /aria-label="Previous playlist page" disabled=""/);
  assert.doesNotMatch(html.match(/<button[^>]*aria-label="Next playlist page"[^>]*>/)[0], /disabled/);
  assert.equal((html.match(/<main\b/g) || []).length, 1);
  assert.equal((html.match(/<audio\b/g) || []).length, 1);
  assert.equal((html.match(/public-media-brand/g) || []).length, 1);
  assert.doesNotMatch(html, /autoPlay|autoplay|Edit playlist|Make private|\/api\/auth|<form\b/);
});

test('public playlist loading, empty and revoked states do not require authentication', () => {
  const loading = renderToStaticMarkup(createElement(PublicPlaylist, { token: 'token', request() { assert.fail('SSR does not fetch'); } }));
  assert.match(loading, /Loading shared playlist/);
  const empty = renderToStaticMarkup(createElement(PublicPlaylistView, { playlist: { title: 'Empty', total: 0, tracks: [] } }));
  assert.match(empty, /No public songs/);
  const unavailable = renderToStaticMarkup(createElement(PublicPlaylistView, { error: 'Revoked' }));
  assert.match(unavailable, /role="alert"/);
  assert.match(unavailable, /Playlist unavailable/);
  assert.doesNotMatch(unavailable, /Sign in|Log in|<audio/);
});

test('admin shared links identify playlist capabilities, including playlists without a backing job', () => {
  const html = renderToStaticMarkup(createElement(AdminMediaSharesView, { data: { page: 1, totalPages: 1, total: 1,
    shares: [{ id: 'a'.repeat(64), kind: 'playlist', name: 'Individual Songs', jobId: null, creatorName: 'Owner' }] } }));
  assert.match(html, /Playlist link/);
  assert.match(html, /aria-label="Delete shared link for Individual Songs"/);
  assert.doesNotMatch(html, /href="\/job\/null"/);
});

test('browser and touch icons use the bundled app logo', async () => {
  const html = await fs.readFile(new URL('../frontend/index.html', import.meta.url), 'utf8');
  for (const rel of ['icon', 'apple-touch-icon']) {
    const link = html.match(new RegExp(`<link\\b[^>]*rel="${rel}"[^>]*>`))?.[0];
    assert.ok(link?.includes(`href="${appIcon}"`));
    assert.match(link, /sizes="192x192"/);
  }
  const image = await fs.readFile(new URL('../frontend/src/assets/ic_launcher.png', import.meta.url));
  assert.equal(image.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(image.readUInt32BE(16), 192);
  assert.equal(image.readUInt32BE(20), 192);
});

test('public branding uses the app logo in loaded, loading and unavailable states', () => {
  for (const props of [{}, { loading: true }, { media: null, error: 'Unavailable' }]) {
    const html = render(props);
    assert.ok(html.includes(`<span class="public-media-brand"><img src="${appIcon}" alt="" width="34" height="34"/>ssMusic</span>`));
  }
});

test('public media renders a complete, read-only track without an authenticated provider', () => {
  const html = render();
  for (const value of ['Evening song', 'The Quartet', 'After Hours', 'The Ensemble', 'Jazz', '2026', '2/8', '1/2', '4 of 5 stars', '4.0 MB']) {
    assert.ok(html.includes(value), value);
  }
  assert.match(html, /<h1 id="public-media-title">Evening song<\/h1>/);
  assert.match(html, /<dt>Album artist<\/dt><dd>The Ensemble<\/dd>/);
  assert.match(html, /<dt>File name<\/dt><dd>Evening song.mp3<\/dd>/);
  assert.match(html, /<img[^>]*src="data:image\/png;base64,aGVsbG8="[^>]*alt="Album artwork for Evening song"/);
  assert.match(html, /Synchronized lyrics/);
  assert.match(html, /Plain text lyrics/);
  assert.match(html, /First line\nSecond line\n\nLast verse/);
  assert.match(html, /No account needed/);
});

test('share library action is opt-in for authenticated writable accounts with pending, success and error states', () => {
  assert.doesNotMatch(render(), /Add to my library|Added to library/);
  const signedIn = render({ canAddToLibrary: true });
  assert.match(signedIn, />Add to my library<\/button>/);
  assert.match(signedIn, /Read only/);
  assert.doesNotMatch(signedIn, /Edit metadata|Transcribe song/);
  assert.match(render({ canAddToLibrary: true, addingToLibrary: true }), /disabled="">.*?Adding to library\.\.\.<\/button>/s);
  assert.match(render({ canAddToLibrary: true, addedToLibrary: true }), /role="status">Added to your library/);
  assert.match(render({ canAddToLibrary: true, libraryError: 'Link revoked' }), /role="alert">Link revoked/);
});

test('share import destinations include personal and owned playlists but exclude folders and contributed playlists', () => {
  const destinations = sharedImportDestinations({
    entries: [{ id: 'folder', type: 'folder' }, { id: 'owned', type: 'playlist' }, { id: 'contributed', type: 'playlist' },
      { id: 'individual-songs', type: 'playlist' }],
    jobs: [{ id: 'owned', playlistTitle: 'Favorites', initiatedBy: { id: 'recipient' } },
      { id: 'contributed', playlistTitle: 'Other library', initiatedBy: { id: 'owner' }, contributors: [{ id: 'recipient' }] }]
  }, 'recipient');
  assert.deepEqual(destinations, [{ id: 'owned', title: 'Favorites' }, { id: 'individual-songs', title: 'Individual Songs' },
    { id: 'individual-videos', title: 'Individual Videos' }]);
});

test('share library dialog loads playlists before allowing a destination and preserves accessible controls', () => {
  const html = renderToStaticMarkup(createElement(PublicLibraryDialog, { media, userId: 'recipient', request() { assert.fail('SSR must not fetch'); } }));
  assert.match(html, /<dialog[^>]*aria-labelledby=/);
  assert.match(html, /Add to my library/);
  assert.match(html, /Evening song/);
  assert.match(html, /role="status">Loading playlists/);
  assert.match(html, />Cancel<\/button>/);
  assert.match(html, /type="submit" disabled=""/);
});

test('playback and saving use only the public URLs, without autoplay', () => {
  const html = render();
  const audio = html.match(/<audio[^>]*>/)?.[0];
  assert.match(audio, /controls=""/);
  assert.match(audio, /preload="metadata"/);
  assert.match(audio, /src="\/api\/public\/media\/token\/stream"/);
  assert.match(audio, /aria-label="Audio player for Evening song"/);
  assert.doesNotMatch(audio, /autoPlay|autoplay/);
  assert.match(html, /<a[^>]*href="\/api\/public\/media\/token\/download"[^>]*download="Evening song.mp3"/);
  assert.match(html, />Save file<\/a>/);
});

test('public videos use responsive native video controls and public download links', () => {
  for (const name of ['Movie.mp4', 'Movie.M4V', 'Movie.webm', 'Movie.mov', 'Movie.ogv']) {
    const html = render({ media: { ...media, name }, duration: 180, elapsed: 15 });
    const video = html.match(/<video[^>]*>/)?.[0];
    assert.match(video, /controls=""/);
    assert.match(video, /preload="metadata"/);
    assert.match(video, /playsInline=""/i);
    assert.match(video, /src="\/api\/public\/media\/token\/stream"/);
    assert.match(video, /aria-label="Video player for Evening song"/);
    assert.doesNotMatch(video, /autoplay/i);
    assert.doesNotMatch(html, /<audio\b/);
    assert.match(html, />Watch<\/h2>/);
    assert.match(html, /Shared video/);
    assert.ok(html.includes(`download="${name}"`));
    assert.match(html, /No account needed/);
  }
});

test('shared playback retains native controls without a duplicate position slider', () => {
  const html = render({ duration: 180, elapsed: 15 });
  assert.equal((html.match(/<audio\b/g) || []).length, 1);
  assert.match(html, /<audio[^>]*controls=""/);
  assert.doesNotMatch(html, /Playback position|public-media-seek|public-media-times|type="range"/);
});

test('public media exposes no editing, rating, account or other mutation controls', () => {
  const html = render();
  const inputs = html.match(/<input\b[^>]*>/g) || [];
  assert.equal(inputs.length, 0);
  const buttons = html.match(/<button\b[^>]*>/g) || [];
  assert.equal(buttons.length, 4);
  assert.match(buttons[0], /aria-expanded="true"/);
  assert.match(buttons[1], /aria-haspopup="dialog"/);
  for (const button of buttons.slice(2)) assert.match(button, /aria-label="Seek to/);
  assert.doesNotMatch(html, /<form\b|<textarea\b|<select\b|contentEditable|type="radio"|type="file"|aria-pressed/);
  assert.doesNotMatch(html, /Edit metadata|Save metadata|Rate |Clear rating|Delete|Replace File|Transcribe|Log in|Sign in|\/api\/auth/);
});

test('timed lines expose accessible positions and the active line', () => {
  const html = render({ duration: 180, elapsed: 15 });
  assert.doesNotMatch(html, /<button[^>]*disabled/);
  assert.match(html, /<button[^>]*aria-current="true"[^>]*aria-label="Seek to 0:12: Second line"/);
  assert.equal((html.match(/aria-current="true"/g) || []).length, 1);
  assert.doesNotMatch(html.match(/<button[^>]*aria-label="Seek to 0:00: First line"[^>]*>/)[0], /aria-current/);
});

test('unknown durations disable lyric seeking', () => {
  for (const duration of [0, NaN, Infinity, -3]) {
    const html = render({ duration, elapsed: 15 });
    assert.equal((html.match(/<button[^>]*disabled=""/g) || []).length, 2);
    assert.match(html, /aria-current="true" aria-label="Seek to 0:00: First line"/);
    assert.doesNotMatch(html, /NaN|Infinity/);
  }
});

test('lyric timestamps are hour-aware and playback positions are bounded', () => {
  const props = { duration: 3700, media: { ...media, sylt: [
    { time: 0, text: 'Start' }, { time: 3661, text: 'Later' }, { time: 3701, text: 'Beyond duration' }
  ] } };
  for (const elapsed of [3661, 9999]) {
    assert.match(render({ ...props, elapsed }), /aria-current="true" aria-label="Seek to 1:01:01: Later"/);
  }
  for (const elapsed of [-1, NaN, Infinity]) {
    assert.match(render({ ...props, elapsed }), /aria-current="true" aria-label="Seek to 0:00: Start"/);
  }
});

test('missing metadata, artwork and lyrics have readable fallbacks, retaining save and playback', () => {
  const html = render({ media: { name: 'Unknown.mp3', sizeBytes: 0, streamUrl: media.streamUrl, downloadUrl: media.downloadUrl } });
  assert.match(html, /<h1[^>]*>Unknown.mp3<\/h1>/);
  assert.match(html, /Unknown artist/);
  assert.match(html, /Unknown album/);
  assert.match(html, /<dt>Title<\/dt><dd>Not provided<\/dd>/);
  assert.match(html, /<dt>Rating<\/dt><dd>Unrated<\/dd>/);
  assert.match(html, /0 bytes/);
  assert.match(html, /No lyrics are available for this track/);
  assert.match(html, /<audio /);
  assert.match(html, /download="Unknown.mp3"/);
  assert.doesNotMatch(html, /undefined|null/);
  assert.equal((html.match(/<button\b/g) || []).length, 1);
  assert.equal((html.match(/<img\b/g) || []).length, 1, 'only the app logo should render without artwork');
});

test('timed and plain lyrics render independently and reject malformed timed entries', () => {
  const timedOnly = render({ duration: 180, elapsed: 13, media: { ...media, uslt: '', sylt: [
    { time: 12.5, text: 'Later' }, null, { time: -1, text: 'Negative' }, { time: NaN, text: 'Invalid' },
    { time: 1, text: 'Earlier' }, { time: 20, text: '' }, { time: 30, text: {} }
  ] } });
  assert.ok(timedOnly.indexOf('Earlier') < timedOnly.indexOf('Later'));
  assert.match(timedOnly, /aria-current="true" aria-label="Seek to 0:12: Later"/);
  assert.match(timedOnly, /Seek to 0:20: Instrumental/);
  assert.doesNotMatch(timedOnly, /Plain text lyrics|No lyrics|Negative|Invalid|\[object Object\]/);
  const plainOnly = render({ media: { ...media, sylt: [] } });
  assert.match(plainOnly, /Plain text lyrics/);
  assert.doesNotMatch(plainOnly, /Synchronized lyrics|aria-label="Seek to/);
  assert.match(plainOnly, />Fullscreen lyrics<\/button>/);
  assert.match(render({ media: { ...media, sylt: null, uslt: '   ' } }), /No lyrics are available/);
});

test('shared lyrics reuse the music timeline and offer a closed fullscreen dialog', () => {
  const html = render({ duration: 180, elapsed: 15 });
  const timeline = renderToStaticMarkup(createElement(LyricTimeline, { lines: media.sylt, position: 15 }));
  assert.ok(html.includes(timeline), 'shared lyrics must use the same timeline markup as the music player');
  assert.match(html, /<button[^>]*aria-haspopup="dialog"[^>]*>.*Fullscreen lyrics<\/button>/);
  const dialog = html.match(/<dialog\b[^>]*>/)?.[0];
  assert.match(dialog, /class="lyrics-overlay public-lyrics-overlay"/);
  assert.match(dialog, /aria-label="Fullscreen lyrics"/);
  assert.doesNotMatch(dialog, /\bopen=/);
  assert.equal((html.match(/<audio\b/g) || []).length, 1);
});

test('the shared timeline follows forward and backward seeks, including equal timestamps and the intro', () => {
  const lines = [{ time: 2, text: 'First' }, { time: 12, text: 'Second' }, { time: 12, text: 'Same timestamp' }];
  for (const [position, activeText] of [[0, null], [2, 'First'], [20, 'Same timestamp'], [5, 'First']]) {
    const html = renderToStaticMarkup(createElement(LyricTimeline, { lines, position }));
    const active = html.match(/<button[^>]*aria-current="true"[^>]*>/g) || [];
    assert.equal(active.length, activeText ? 1 : 0);
    if (activeText) assert.ok(active[0].includes(activeText));
  }
  const plain = renderToStaticMarkup(createElement(LyricTimeline, { lines, mode: 'uslt', uslt: media.uslt }));
  assert.match(plain, /aria-label="Unsynchronized lyrics"/);
  assert.match(plain, /class="plain-lyrics">First line\nSecond line\n\nLast verse/);
  assert.doesNotMatch(plain, /aria-current|<button/);
  const empty = renderToStaticMarkup(createElement(LyricTimeline));
  assert.match(empty, /No SYLT lyrics embedded/);
  const loading = renderToStaticMarkup(createElement(LyricTimeline, { lines }, createElement('p', { role: 'status' }, 'Loading lyrics...')));
  assert.match(loading, /role="status">Loading lyrics/);
  assert.doesNotMatch(loading, /<button/);
});

test('lyric autoscrolling centers only the lyric container and respects reduced motion', () => {
  let active = { offsetTop: 800, clientHeight: 80 };
  const calls = [];
  const container = {
    clientHeight: 400,
    querySelector(selector) { assert.equal(selector, '[aria-current="true"]'); return active; },
    scrollTo(options) { calls.push(options); }
  };
  scrollToActiveLyric(container);
  assert.deepEqual(calls.pop(), { top: 640, behavior: 'smooth' });
  container.clientHeight = 600;
  scrollToActiveLyric(container, { reducedMotion: true });
  assert.deepEqual(calls.pop(), { top: 540, behavior: 'instant' });
  active = null;
  scrollToActiveLyric(container);
  assert.deepEqual(calls.pop(), { top: 0, behavior: 'smooth' });
  scrollToActiveLyric(null);
});

test('plain lyrics retain manual scroll positions when playback crosses synchronized timestamps', () => {
  for (const active of [null, { offsetTop: 800, clientHeight: 80 }]) {
    const container = {
      clientHeight: 400,
      querySelector() { return active; },
      scrollTo() { assert.fail('USLT must not autoscroll'); }
    };
    scrollToActiveLyric(container, { mode: 'uslt' });
    scrollToActiveLyric(container, { mode: 'uslt', reducedMotion: true });
  }
});

test('metadata, filenames and both lyric formats are escaped React text', () => {
  const untrusted = '<script>alert("x")</script><img src=x onerror="boom">&';
  const html = render({ media: {
    ...media, title: untrusted, artist: untrusted, name: untrusted, artwork: null,
    sylt: [{ time: 1, text: untrusted }], uslt: untrusted
  } });
  assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
  assert.match(html, /&lt;img src=x onerror=&quot;boom&quot;&gt;&amp;/);
  assert.doesNotMatch(html, /<script\b|onerror="boom"/);
  assert.equal((html.match(/<img\b/g) || []).length, 1, 'untrusted text must not create images alongside the logo');
});

test('loading, unavailable and playback failures have accessible non-authenticated states', () => {
  let requests = 0;
  const loading = renderToStaticMarkup(createElement(PublicMedia, { token: 'shared-token', request() { requests++; } }));
  assert.match(loading, /aria-busy="true"/);
  assert.match(loading, /role="status"/);
  assert.match(loading, /Loading shared media/);
  assert.doesNotMatch(loading, /<audio\b|<form\b/);
  assert.equal(requests, 0);

  const unavailable = render({ media: null, error: 'The file is no longer available.', onRetry() {} });
  assert.match(unavailable, /role="alert"/);
  assert.match(unavailable, /Shared media unavailable/);
  assert.match(unavailable, /The file is no longer available/);
  assert.match(unavailable, />Try again<\/button>/);
  assert.doesNotMatch(unavailable, /<audio\b|type="range"|Log in|Sign in/);
  assert.match(render({ media: null }), /expired, been revoked/);

  const failed = render({ duration: 180, playbackError: 'Audio could not be played. Save the file to listen locally.' });
  assert.match(failed, /role="alert">Audio could not be played/);
  assert.equal((failed.match(/<button[^>]*disabled=""/g) || []).length, 2);
  assert.match(failed, />Save file<\/a>/);
});

test('admin shared link list identifies creators and links, and handles loading, errors and pagination', () => {
  const data = { shares: [{ id: 'a'.repeat(64), jobId: 'job', name: 'Evening song.mp3', creatorName: 'Owner', playlistTitle: 'Jazz' }], page: 1, totalPages: 2, total: 51 };
  const renderAdmin = (props = {}) => renderToStaticMarkup(createElement(AdminMediaSharesView, { data, ...props }));
  const html = renderAdmin();
  for (const text of ['Evening song.mp3', 'Owner', 'Jazz', 'Link ID', 'Page 1 of 2', 'a'.repeat(64)]) assert.ok(html.includes(text));
  assert.match(html, /href="\/job\/job"/);
  assert.match(html, /aria-label="Delete shared link for Evening song.mp3"/);
  assert.match(html, /aria-label="Previous shared links page" disabled=""/);
  assert.doesNotMatch(html.match(/<button[^>]*aria-label="Next shared links page"[^>]*>/)[0], /disabled/);
  assert.doesNotMatch(html, /href="\/share\//);
  assert.match(renderAdmin({ loading: true }), /role="status">Loading shared links/);
  assert.match(renderAdmin({ error: 'Failed to load' }), /role="alert"/);
  assert.match(renderAdmin({ deleting: data.shares[0].id }), /disabled=""[^>]*title="Delete shared link/);
  assert.match(renderAdmin({ data: { ...data, shares: [], total: 0, totalPages: 1 } }), /No shared links/);
});

test('seeking changes only the playback position, clamps boundaries and never starts playback', () => {
  const audio = { duration: 180, currentTime: 0, play() { assert.fail('Seeking must not autoplay'); } };
  assert.equal(seekPublicAudio(audio, 12.5), 12.5);
  assert.equal(audio.currentTime, 12.5);
  assert.equal(seekPublicAudio(audio, -4), 0);
  assert.equal(audio.currentTime, 0);
  assert.equal(seekPublicAudio(audio, 500), 180);
  assert.equal(audio.currentTime, 180);
  for (const seconds of [NaN, Infinity, undefined, '3']) assert.equal(seekPublicAudio(audio, seconds), null);
  for (const duration of [0, -1, Infinity, NaN]) {
    audio.duration = duration;
    assert.equal(seekPublicAudio(audio, 1), null);
    assert.equal(audio.currentTime, 180);
  }
  assert.equal(seekPublicAudio(null, 1), null);
});

const thumbnailStatus = {
  running: false, processed: 0, generated: 0, missing: 0, failed: 0,
  startedAt: null, completedAt: null, error: null
};

test('admin artwork thumbnails describe the non-destructive cache rebuild and guard unavailable or busy starts', () => {
  const renderThumbnails = (props = {}) => renderToStaticMarkup(createElement(AdminArtworkThumbnailsView, props));
  const button = (html) => html.match(/<button[^>]*>/)[0];
  const loading = renderToStaticMarkup(createElement(AdminArtworkThumbnails, {
    request() { assert.fail('SSR must not request thumbnail status'); }
  }));
  assert.match(loading, /Album artwork thumbnails/);
  assert.match(loading, /192px AVIF images on disk/);
  assert.match(loading, /Original album artwork and media files remain unchanged/);
  assert.match(loading, /Regenerate all thumbnails/);
  assert.match(loading, /role="status" aria-live="polite"/);
  assert.match(loading, /Loading thumbnail status/);
  assert.match(button(loading), /disabled=""/);
  assert.doesNotMatch(button(renderThumbnails({ status: thumbnailStatus })), /disabled/);
  assert.match(button(renderThumbnails({ status: thumbnailStatus, starting: true })), /disabled=""/);
  assert.match(button(renderThumbnails({ status: { ...thumbnailStatus, running: true } })), /disabled=""/);
  const unavailable = renderThumbnails({ error: 'Status request failed' });
  assert.match(button(unavailable), /disabled=""/);
  assert.match(unavailable, /Thumbnail status unavailable. Retrying automatically/);
  assert.match(unavailable, /role="alert".*Status request failed/);
});

test('admin artwork thumbnails expose progress, completion, failures and escaped errors', () => {
  const status = {
    ...thumbnailStatus, running: true, processed: 12, generated: 8, missing: 3, failed: 1,
    startedAt: '2026-10-04T20:00:00.000Z'
  };
  const renderThumbnails = (changes = {}) => renderToStaticMarkup(createElement(AdminArtworkThumbnailsView, { status: { ...status, ...changes } }));
  const running = renderThumbnails();
  assert.match(running, /Regenerating thumbnails/);
  for (const [label, value] of [['Processed', 12], ['Generated', 8], ['Missing artwork', 3], ['Failed', 1]]) {
    assert.ok(running.includes(`<dt>${label}</dt><dd>${value}</dd>`));
  }
  assert.match(running, /Started: <time dateTime="2026-10-04T20:00:00.000Z"/);
  const completed = renderThumbnails({ running: false, completedAt: '2026-10-04T20:02:00.000Z' });
  assert.match(completed, /completed with failures/);
  assert.match(completed, /Completed: <time dateTime="2026-10-04T20:02:00.000Z"/);
  assert.doesNotMatch(completed.match(/<button[^>]*>/)[0], /disabled/);
  assert.match(renderThumbnails({ running: false, failed: 0, completedAt: '2026-10-04T20:02:00.000Z' }), /Thumbnail regeneration completed\./);
  const failed = renderThumbnails({ running: false, error: '<script>failure</script>' });
  assert.match(failed, /Thumbnail regeneration failed/);
  assert.match(failed, /role="alert".*&lt;script&gt;failure&lt;\/script&gt;/);
  assert.doesNotMatch(failed, /<script\b/i);
});

function thumbnailWatcher(context, hidden = false) {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const browserDocument = new EventTarget();
  browserDocument.hidden = hidden;
  const browser = { document: browserDocument, setTimeout, clearTimeout };
  const calls = [];
  const updates = [];
  const watcher = watchArtworkThumbnails((url, options) => {
    const deferred = Promise.withResolvers();
    calls.push({ url, options, ...deferred });
    return deferred.promise;
  }, (state) => updates.push(state), browser);
  context.after(() => watcher.stop());
  return { watcher, calls, updates, latest: () => updates.at(-1),
    visibility(value) { browserDocument.hidden = value; browserDocument.dispatchEvent(new Event('visibilitychange')); }
  };
}

test('thumbnail polling remains active while idle and running, and prevents stale polls or duplicate starts', async (context) => {
  const { watcher, calls, latest } = thumbnailWatcher(context);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, '/api/admin/artwork-thumbnails');
  await watcher.start();
  assert.equal(calls.length, 1, 'starting is blocked until status is available');
  calls[0].resolve(thumbnailStatus);
  await new Promise(setImmediate);
  context.mock.timers.tick(1999);
  assert.equal(calls.length, 1);
  context.mock.timers.tick(1);
  assert.equal(calls.length, 2, 'idle status is polled after two seconds');
  context.mock.timers.tick(2000);
  assert.equal(calls.length, 2, 'slow polls must not overlap');
  const started = watcher.start();
  assert.equal(latest().starting, true);
  assert.equal(calls[1].options.signal.aborted, true);
  assert.equal(calls[2].url, '/api/admin/artwork-thumbnails');
  assert.equal(calls[2].options.method, 'POST');
  assert.equal(calls[2].options.body, undefined);
  await watcher.start();
  assert.equal(calls.length, 3, 'double clicks must not start a second POST');
  context.mock.timers.tick(4000);
  assert.equal(calls.length, 3, 'polling pauses during POST');
  calls[2].resolve({ ...thumbnailStatus, running: true });
  await started;
  calls[1].resolve(thumbnailStatus);
  await new Promise(setImmediate);
  assert.equal(latest().status.running, true, 'a late pre-start poll cannot reset running status');
  assert.equal(latest().starting, false);
  await watcher.start();
  assert.equal(calls.length, 3, 'running jobs cannot be started again');
  context.mock.timers.tick(2000);
  assert.equal(calls.length, 4);
  calls[3].resolve({ ...thumbnailStatus, processed: 2, generated: 1, failed: 1, completedAt: '2026-10-04T20:02:00.000Z' });
  await new Promise(setImmediate);
  assert.equal(latest().status.processed, 2);
  assert.equal(latest().status.failed, 1);
  assert.equal(latest().status.running, false);
});

test('thumbnail conflicts reload authoritative progress and failed requests recover without hiding start errors', async (context) => {
  const { watcher, calls, latest } = thumbnailWatcher(context);
  calls[0].reject(new Error('Status unavailable'));
  await new Promise(setImmediate);
  assert.equal(latest().status, null);
  assert.equal(latest().error, 'Status unavailable');
  await watcher.start();
  assert.equal(calls.length, 1);
  context.mock.timers.tick(2000);
  calls[1].resolve(thumbnailStatus);
  await new Promise(setImmediate);
  assert.equal(latest().error, '');
  const conflict = watcher.start();
  calls[2].reject(Object.assign(new Error('Already running'), { status: 409 }));
  await conflict;
  assert.equal(calls.length, 4, 'a conflict immediately refreshes status');
  assert.equal(latest().status, null);
  await watcher.start();
  assert.equal(calls.length, 4);
  calls[3].resolve({ ...thumbnailStatus, running: true });
  await new Promise(setImmediate);
  assert.equal(latest().status.running, true);
  assert.equal(latest().error, '');
  context.mock.timers.tick(2000);
  calls[4].resolve(thumbnailStatus);
  await new Promise(setImmediate);
  const failure = watcher.start();
  calls[5].reject(new Error('Unable to start regeneration'));
  await failure;
  assert.equal(latest().error, 'Unable to start regeneration');
  calls[6].resolve(thumbnailStatus);
  await new Promise(setImmediate);
  assert.equal(latest().error, 'Unable to start regeneration', 'successful polling must not hide a POST failure');
  assert.equal(latest().starting, false);
});

test('stopping thumbnail polling aborts requests and ignores late responses', async (context) => {
  const { watcher, calls, updates } = thumbnailWatcher(context);
  watcher.stop();
  assert.equal(calls[0].options.signal.aborted, true);
  const count = updates.length;
  calls[0].resolve(thumbnailStatus);
  await new Promise(setImmediate);
  context.mock.timers.tick(10000);
  await watcher.start();
  assert.equal(calls.length, 1);
  assert.equal(updates.length, count);
});

test('stopping thumbnail regeneration monitoring cancels scheduled polls and ignores an in-flight POST', async (context) => {
  const { watcher, calls, updates } = thumbnailWatcher(context);
  calls[0].resolve(thumbnailStatus);
  await new Promise(setImmediate);
  const started = watcher.start();
  watcher.stop();
  assert.equal(calls[1].options.signal.aborted, true);
  const count = updates.length;
  calls[1].reject(new Error('Aborted'));
  await started;
  context.mock.timers.tick(10000);
  assert.equal(calls.length, 2);
  assert.equal(updates.length, count);
});

test('thumbnail polling starts only when visible and stops again after hiding', async (context) => {
  const { calls, latest, visibility } = thumbnailWatcher(context, true);
  context.mock.timers.tick(20000);
  assert.equal(calls.length, 0);
  visibility(false);
  assert.equal(calls.length, 1);
  calls[0].resolve(thumbnailStatus);
  await new Promise(setImmediate);
  assert.deepEqual(latest().status, thumbnailStatus);
  visibility(true);
  context.mock.timers.tick(20000);
  assert.equal(calls.length, 1);
});

test('thumbnail polling ignores hidden responses and refreshes on return without overlapping', async (context) => {
  const { watcher, calls, latest, visibility } = thumbnailWatcher(context);
  calls[0].resolve(thumbnailStatus);
  await new Promise(setImmediate);
  context.mock.timers.tick(2000);
  assert.equal(calls.length, 2);
  visibility(true);
  calls[1].resolve({ ...thumbnailStatus, processed: 12 });
  await new Promise(setImmediate);
  assert.deepEqual(latest().status, thumbnailStatus);
  context.mock.timers.tick(20000);
  assert.equal(calls.length, 2);
  visibility(false);
  assert.equal(calls.length, 3);
  context.mock.timers.tick(2000);
  assert.equal(calls.length, 3);
  calls[2].resolve({ ...thumbnailStatus, processed: 7 });
  await new Promise(setImmediate);
  assert.equal(latest().status.processed, 7);
  watcher.stop();
  visibility(true);
  visibility(false);
  context.mock.timers.tick(20000);
  assert.equal(calls.length, 3);
});

test('thumbnail regeneration can finish starting while hidden without restarting polls', async (context) => {
  const { watcher, calls, latest, visibility } = thumbnailWatcher(context);
  calls[0].resolve(thumbnailStatus);
  await new Promise(setImmediate);
  const started = watcher.start();
  visibility(true);
  calls[1].resolve({ ...thumbnailStatus, running: true });
  await started;
  context.mock.timers.tick(20000);
  assert.equal(calls.length, 2);
  assert.equal(latest().starting, false);
  visibility(false);
  assert.equal(calls.length, 3);
});
