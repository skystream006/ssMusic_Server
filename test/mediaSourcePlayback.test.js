import assert from 'node:assert/strict';
import test from 'node:test';
import { createMediaSourcePlayback, getMediaSourceDescriptor } from '../frontend/src/mediaSourcePlayback.js';

function fixture({ managed = false, rejectAppend = false, large = false } = {}) {
  const calls = [];
  const revoked = [];
  const instances = [];
  const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  class Buffer extends EventTarget {
    constructor() { super(); this.parts = []; this.updating = false; }
    appendBuffer(part) {
      assert.equal(this.updating, false);
      if (rejectAppend) throw new DOMException('Quota exceeded', 'QuotaExceededError');
      this.updating = true;
      this.parts.push([...part]);
      queueMicrotask(() => { this.updating = false; this.dispatchEvent(new Event('updateend')); });
    }
  }
  class Source extends EventTarget {
    static isTypeSupported(mime) { return ['audio/mpeg', 'audio/mp4; codecs="mp4a.40.2"'].includes(mime); }
    constructor() { super(); this.readyState = 'closed'; instances.push(this); }
    addSourceBuffer(mime) { this.mime = mime; return this.buffer = new Buffer(); }
    endOfStream() { this.readyState = 'ended'; }
  }
  const browser = { location: { href: 'https://music.example/' },
    [managed ? 'ManagedMediaSource' : 'MediaSource']: Source,
    URL: { createObjectURL(source) { queueMicrotask(() => { source.readyState = 'open'; source.dispatchEvent(new Event('sourceopen')); }); return `blob:source-${instances.length}`; }, revokeObjectURL(url) { revoked.push(url); } },
    async fetch(url, options) {
      calls.push({ url, options });
      const [, first, last] = options.headers.Range.match(/bytes=(\d+)-(\d+)/);
      const start = Number(first); const end = Math.min(Number(last), bytes.length - 1);
      return new Response(bytes.slice(start, end + 1), { status: 206, headers: {
        'content-range': `bytes ${start}-${end}/${large ? 100000000 : bytes.length}`, 'content-length': String(end - start + 1),
        etag: '"fixture"', 'last-modified': 'Fri, 30 Oct 2026 00:00:00 GMT' } });
    } };
  const media = new EventTarget();
  Object.assign(media, { currentTime: 7, disableRemotePlayback: false, attributes: {}, setAttribute(name, value) { this.attributes[name] = value; } });
  return { browser, media, calls, revoked, instances };
}

test('MediaSource selection is codec-aware and preserves authorized AAC query parameters', () => {
  const { browser } = fixture();
  assert.equal(getMediaSourceDescriptor('/api/jobs/job/stream/Song.mp3', browser).mime, 'audio/mpeg');
  const compatible = getMediaSourceDescriptor('/api/jobs/job/stream/Song.mp3?format=aac&userId=owner&v=123', browser);
  const url = new URL(compatible.url);
  assert.equal(compatible.mime, 'audio/mp4; codecs="mp4a.40.2"');
  assert.equal(url.searchParams.get('mse'), '1');
  assert.equal(url.searchParams.get('userId'), 'owner');
  assert.equal(url.searchParams.get('v'), '123');
  for (const source of ['blob:media', 'data:audio/mpeg;base64,AA==', '/Song.wav', '/Movie.mp4', '/Song.m4a']) {
    assert.equal(getMediaSourceDescriptor(source, browser), null);
  }
  assert.equal(getMediaSourceDescriptor('/Song.mp3', {}), null);
});

test('SourceBuffer reuses preloaded bytes and serializes bounded range appends', async () => {
  const { browser, media, calls, instances, revoked } = fixture();
  const playback = createMediaSourcePlayback({ browser, chunkBytes: 4 });
  await Promise.all([playback.preload('/Song.mp3'), playback.preload('/Song.mp3')]);
  assert.equal(calls.length, 1);
  const stream = playback.attach(media, '/Song.mp3', () => assert.fail('Unexpected fallback'));
  await stream.completion;
  assert.equal(calls.length, 3);
  assert.deepEqual(instances[0].buffer.parts, [[1, 2, 3, 4], [5, 6, 7, 8], [9, 10]]);
  assert.equal(instances[0].readyState, 'ended');
  assert.equal(media.attributes['data-playback-engine'], 'mediasource');
  assert.equal(calls[1].options.headers['If-Range'], 'Fri, 30 Oct 2026 00:00:00 GMT');
  playback.dispose();
  assert.deepEqual(revoked, ['blob:source-1']);
});

test('ManagedMediaSource disables remote playback only while attached', async () => {
  const { browser, media } = fixture({ managed: true });
  const playback = createMediaSourcePlayback({ browser });
  const stream = playback.attach(media, '/Song.mp3', () => assert.fail('Unexpected fallback'));
  assert.equal(media.disableRemotePlayback, true);
  await stream.completion;
  assert.equal(media.attributes['data-playback-engine'], 'managed-mediasource');
  playback.dispose();
  assert.equal(media.disableRemotePlayback, false);
});

test('managed buffering waits for streaming permission and recovers evicted seek ranges', async () => {
  const { browser, media, instances, calls } = fixture({ managed: true });
  browser.ManagedMediaSource.prototype.streaming = false;
  const playback = createMediaSourcePlayback({ browser });
  const fallbacks = [];
  const stream = playback.attach(media, '/Song.mp3', (state) => fallbacks.push(state));
  await Promise.resolve();
  assert.equal(calls.length, 0);
  instances[0].streaming = true;
  instances[0].dispatchEvent(new Event('startstreaming'));
  await stream.completion;
  assert.equal(calls.length, 1);
  instances[0].buffer.buffered = { length: 1, start: () => 0, end: () => 20 };
  media.dispatchEvent(new Event('seeking'));
  assert.equal(fallbacks.length, 0);
  instances[0].buffer.buffered = { length: 0 };
  const eviction = new Event('bufferedchange');
  eviction.removedRanges = { length: 1 };
  instances[0].buffer.dispatchEvent(eviction);
  assert.equal(fallbacks.length, 1);
  assert.equal(fallbacks[0].position, 7);
  playback.dispose();
});

test('changing resources and aborted managed waits cannot leave stale appends running', async () => {
  const managed = fixture({ managed: true });
  managed.browser.ManagedMediaSource.prototype.streaming = false;
  const playback = createMediaSourcePlayback({ browser: managed.browser });
  const stream = playback.attach(managed.media, '/Song.mp3', () => assert.fail('Cancelled wait must not fall back'));
  await Promise.resolve();
  playback.dispose();
  await stream.completion;
  assert.equal(managed.calls.length, 0);
  const normal = fixture();
  const originalFetch = normal.browser.fetch;
  normal.browser.fetch = async (...args) => {
    const response = await originalFetch(...args);
    if (normal.calls.length > 1) response.headers.set('etag', '"changed"');
    return response;
  };
  const fallback = [];
  const changed = createMediaSourcePlayback({ browser: normal.browser, chunkBytes: 4 });
  await changed.attach(normal.media, '/Song.mp3', (value) => fallback.push(value)).completion;
  assert.equal(fallback.length, 1);
  assert.equal(normal.instances[0].buffer.parts.length, 1);
  changed.dispose();
});

test('SourceBuffer quota and oversized responses fall back once without losing position', async () => {
  for (const options of [{ rejectAppend: true }, { large: true }]) {
    const { browser, media, revoked } = fixture(options);
    const playback = createMediaSourcePlayback({ browser });
    const fallbacks = [];
    const stream = playback.attach(media, '/Song.mp3', (state) => fallbacks.push(state));
    await stream.completion;
    assert.equal(fallbacks.length, 1);
    assert.equal(fallbacks[0].position, 7);
    assert.equal(fallbacks[0].source, '/Song.mp3');
    assert.equal(playback.attach(media, '/Song.mp3', () => assert.fail('Repeated fallback')), null);
    assert.deepEqual(revoked, ['blob:source-1']);
    playback.dispose();
  }
});

test('switching streams aborts old requests and releases object URLs without invoking fallback', async () => {
  const { browser, media, revoked } = fixture();
  const playback = createMediaSourcePlayback({ browser });
  const first = playback.attach(media, '/First.mp3', () => assert.fail('Cancelled stream must not fall back'));
  const second = playback.attach(media, '/Second.mp3', () => assert.fail('Unexpected fallback'));
  await Promise.all([first.completion, second.completion]);
  assert.deepEqual(revoked, ['blob:source-1']);
  playback.dispose();
  assert.deepEqual(revoked, ['blob:source-1', 'blob:source-2']);
});