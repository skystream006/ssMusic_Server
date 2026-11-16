import assert from 'node:assert/strict';
import test from 'node:test';
import { adaptiveVideoSource, attachAdaptiveVideo } from '../frontend/src/adaptiveVideo.js';

function media(native = true) {
  return {
    src: '', canPlayType: () => native ? 'maybe' : '',
    removeAttribute() { this.src = ''; }, load() {}
  };
}

test('adaptive source preserves library scopes and public share tokens', () => {
  for (const source of ['/api/jobs/id/video/Song.mp3?userId=owner&v=1', '/api/public/media/token/stream']) {
    const url = new URL(adaptiveVideoSource(source), 'https://music.example');
    assert.equal(url.searchParams.get('format'), 'hls');
    assert.equal(url.pathname, new URL(source, 'https://music.example').pathname);
    if (source.includes('userId')) assert.equal(url.searchParams.get('userId'), 'owner');
  }
});

test('native HLS waits through generation and cancellation cannot attach a stale source', async () => {
  const statuses = [];
  let calls = 0;
  const video = media();
  const playback = attachAdaptiveVideo(video, '/stream?format=hls', {
    browser: { ...globalThis, clearTimeout, setTimeout: (callback) => setTimeout(callback, 0),
      fetch: async () => new Response(++calls === 1 ? '{}' : '#EXTM3U', { status: calls === 1 ? 202 : 200 }) },
    onStatus: (value) => statuses.push(value)
  });
  await playback.ready;
  assert.equal(calls, 2);
  assert.equal(video.src, '/stream?format=hls');
  assert.deepEqual(statuses, [true, false]);
  playback.destroy();
  assert.equal(video.src, '');
  const gate = Promise.withResolvers();
  const changed = media();
  const stale = attachAdaptiveVideo(changed, '/old?format=hls', {
    browser: { fetch: () => gate.promise, clearTimeout, setTimeout }
  });
  stale.destroy();
  gate.resolve(new Response('#EXTM3U'));
  await stale.ready;
  assert.equal(changed.src, '');
});

test('hls.js uses automatic quality selection, reports fatal failures, and releases playback', async () => {
  const handlers = new Map();
  let instance;
  class Hls {
    static Events = { MANIFEST_PARSED: 'manifest', ERROR: 'error' };
    static isSupported() { return true; }
    constructor(options) { this.options = options; instance = this; }
    on(event, handler) { handlers.set(event, handler); }
    attachMedia(element) { this.media = element; }
    loadSource(source) { this.source = source; handlers.get('manifest')(); }
    destroy() { this.destroyed = true; }
  }
  const errors = [];
  const playback = attachAdaptiveVideo(media(false), '/stream?format=hls', {
    browser: { fetch: async () => new Response('#EXTM3U'), clearTimeout, setTimeout },
    loadHls: async () => Hls, onError: (error) => errors.push(error.message)
  });
  await playback.ready;
  assert.equal(instance.options.startLevel, 0);
  assert.equal(instance.options.capLevelToPlayerSize, true);
  assert.equal(instance.source, '/stream?format=hls');
  handlers.get('error')('error', { fatal: true, details: 'fragment revoked' });
  assert.equal(errors.length, 1);
  assert.equal(playback.failed, true);
  playback.destroy();
  assert.equal(instance.destroyed, true);
});

test('encoder/preparation errors are visible and marked retryable by the playback controller', async () => {
  const playback = attachAdaptiveVideo(media(), '/stream?format=hls', {
    browser: { fetch: async () => Response.json({ error: 'FFmpeg unavailable' }, { status: 503 }), clearTimeout, setTimeout }
  });
  await assert.rejects(playback.ready, /FFmpeg unavailable/);
  assert.equal(playback.failed, true);
  playback.destroy();
});

for (const status of ['disabled', 'original']) {
  test(`${status} playback uses the scoped original without loading HLS or polling and releases it on cancellation`, async () => {
    const video = media(false);
    const statuses = [];
    const streamUrl = '/api/jobs/job/video/Song.mp3?userId=owner&v=123';
    let requests = 0;
    const playback = attachAdaptiveVideo(video, `${streamUrl}&format=hls`, {
      browser: { fetch: async () => { requests++; return Response.json({ status, streamUrl }); }, clearTimeout, setTimeout },
      loadHls: () => { throw new Error('HLS must not load'); },
      onStatus: (value) => statuses.push(value)
    });
    await playback.ready;
    assert.equal(video.src, streamUrl);
    assert.equal(playback.failed, false);
    assert.equal(requests, 1);
    assert.deepEqual(statuses, [true, false]);
    playback.destroy();
    assert.equal(video.src, '');
  });
}

test('cancellation cannot attach a stale original while background preparation continues', async () => {
  const gate = Promise.withResolvers();
  const video = media();
  const playback = attachAdaptiveVideo(video, '/stream?format=hls', {
    browser: { fetch: () => gate.promise, clearTimeout, setTimeout }
  });
  playback.destroy();
  gate.resolve(Response.json({ status: 'original', streamUrl: '/stream' }));
  await playback.ready;
  assert.equal(video.src, '');
});
