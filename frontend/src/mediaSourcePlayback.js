export function getMediaSourceDescriptor(source, browser = globalThis) {
  if (!source || typeof browser.URL?.createObjectURL !== 'function' || typeof browser.fetch !== 'function') return null;
  let url;
  try { url = new URL(source, browser.location?.href || 'http://localhost/'); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  const compatible = url.searchParams.get('format') === 'aac'
    && /^\/api\/jobs\/[^/]+\/stream\/[^/]+\/?$/.test(url.pathname);
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { return null; }
  const mime = compatible ? 'audio/mp4; codecs="mp4a.40.2"' : /\.mp3$/i.test(pathname) ? 'audio/mpeg' : null;
  if (!mime) return null;
  for (const Constructor of [browser.MediaSource, browser.ManagedMediaSource]) {
    try {
      if (typeof Constructor !== 'function' || !Constructor.isTypeSupported(mime)) continue;
      if (compatible) url.searchParams.set('mse', '1');
      return { Constructor, mime, url: url.href, managed: Constructor === browser.ManagedMediaSource };
    } catch {}
  }
  return null;
}

export function createMediaSourcePlayback({ browser = globalThis, chunkBytes = 256 * 1024, maxBytes = 16 * 1024 * 1024 } = {}) {
  const warm = new Map();
  const failed = new Set();
  let active = null;

  async function readPart(url, offset, signal, previous = null) {
    const headers = { Range: `bytes=${offset}-${offset + chunkBytes - 1}` };
    if (previous?.modified) headers['If-Range'] = previous.modified;
    const response = await browser.fetch(url, { headers, signal, credentials: 'same-origin' });
    if (!response.ok) throw new Error(`Media request failed (${response.status})`);
    const range = response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/i);
    const length = Number(response.headers.get('content-length'));
    const total = range ? Number(range[3]) : length;
    if (!Number.isSafeInteger(total) || total <= 0 || total > maxBytes
      || (offset && !range) || (range && Number(range[1]) !== offset)
      || (!range && (!length || length > chunkBytes))) {
      await response.body?.cancel();
      throw new Error('Media requires native range playback');
    }
    const etag = response.headers.get('etag');
    if (previous && (previous.total !== total || (previous.etag && etag !== previous.etag))) {
      await response.body?.cancel();
      throw new Error('Media changed during buffering');
    }
    const parts = [];
    let size = 0;
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Streaming responses are unavailable');
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > chunkBytes) throw new Error('Media response exceeded the buffer limit');
        parts.push(value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const expected = range ? Number(range[2]) - offset + 1 : total;
    if (size !== expected || !size) throw new Error('Incomplete media response');
    const bytes = new Uint8Array(size);
    let position = 0;
    for (const part of parts) { bytes.set(part, position); position += part.byteLength; }
    return { bytes, next: offset + size, total, etag, modified: response.headers.get('last-modified') };
  }

  function preload(source) {
    const descriptor = getMediaSourceDescriptor(source, browser);
    if (!descriptor || failed.has(source) || active?.source === source) return Promise.resolve(false);
    if (warm.has(source)) return warm.get(source).promise;
    const controller = new AbortController();
    const entry = { controller, promise: null };
    entry.promise = readPart(descriptor.url, 0, controller.signal).catch((error) => {
      if (warm.get(source) === entry) warm.delete(source);
      throw error;
    });
    warm.set(source, entry);
    while (warm.size > 2) {
      const [oldest, value] = warm.entries().next().value;
      warm.delete(oldest);
      value.controller.abort();
    }
    return entry.promise;
  }

  function release(state) {
    if (!state || state.closed) return;
    state.closed = true;
    state.controller.abort();
    state.prefetched?.controller.abort();
    state.media.removeEventListener('error', state.mediaError, true);
    state.media.removeEventListener('seeking', state.checkBuffered);
    state.buffer?.removeEventListener('bufferedchange', state.evicted);
    state.mediaSource.removeEventListener('sourceopen', state.open);
    state.media.disableRemotePlayback = state.remotePlaybackDisabled;
    browser.URL.revokeObjectURL(state.objectUrl);
    state.finish();
    if (active === state) active = null;
  }

  function append(state, bytes) {
    return new Promise((resolve, reject) => {
      const buffer = state.buffer;
      const cleanup = () => {
        buffer.removeEventListener('updateend', complete);
        buffer.removeEventListener('error', error);
        state.controller.signal.removeEventListener('abort', aborted);
      };
      const complete = () => { cleanup(); resolve(); };
      const error = () => { cleanup(); reject(new Error('SourceBuffer could not decode media')); };
      const aborted = () => { cleanup(); reject(new DOMException('Playback changed', 'AbortError')); };
      buffer.addEventListener('updateend', complete, { once: true });
      buffer.addEventListener('error', error, { once: true });
      state.controller.signal.addEventListener('abort', aborted, { once: true });
      try { buffer.appendBuffer(bytes); } catch (failure) { cleanup(); reject(failure); }
    });
  }

  function waitForStreaming(state) {
    if (!state.managed || state.mediaSource.streaming !== false) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        state.mediaSource.removeEventListener('startstreaming', start);
        state.controller.signal.removeEventListener('abort', abort);
      };
      const start = () => { cleanup(); resolve(); };
      const abort = () => { cleanup(); reject(new DOMException('Playback changed', 'AbortError')); };
      state.mediaSource.addEventListener('startstreaming', start, { once: true });
      state.controller.signal.addEventListener('abort', abort, { once: true });
      if (state.controller.signal.aborted) abort();
    });
  }

  function attach(media, source, onFallback) {
    release(active);
    const descriptor = getMediaSourceDescriptor(source, browser);
    if (!descriptor || failed.has(source)) { media.setAttribute?.('data-playback-engine', 'native'); return null; }
    let mediaSource;
    let objectUrl;
    try { mediaSource = new descriptor.Constructor(); objectUrl = browser.URL.createObjectURL(mediaSource); }
    catch { return null; }
    const state = { media, source, mediaSource, objectUrl, controller: new AbortController(), closed: false, managed: descriptor.managed,
      remotePlaybackDisabled: media.disableRemotePlayback, prefetched: warm.get(source) };
    warm.delete(source);
    const completion = new Promise((resolve) => { state.finish = resolve; });
    const fallback = () => {
      if (state.closed) return;
      const position = Number.isFinite(media.currentTime) ? media.currentTime : 0;
      failed.add(source);
      if (failed.size > 32) failed.delete(failed.values().next().value);
      release(state);
      onFallback({ media, source, position });
    };
    state.mediaError = (event) => { if (!state.closed) { event.stopImmediatePropagation(); fallback(); } };
    state.checkBuffered = () => {
      if (state.closed || (!state.complete && !state.hadEviction) || !state.buffer?.buffered) return;
      const ranges = state.buffer.buffered;
      for (let index = 0; index < ranges.length; index++) {
        if (media.currentTime >= ranges.start(index) - 0.25 && media.currentTime <= ranges.end(index)) return;
      }
      fallback();
    };
    state.evicted = (event) => {
      if (event.removedRanges?.length) { state.hadEviction = true; state.checkBuffered(); }
    };
    state.open = async () => {
      if (state.closed) return;
      try {
        state.buffer = mediaSource.addSourceBuffer(descriptor.mime);
        state.buffer.addEventListener('bufferedchange', state.evicted);
        await waitForStreaming(state);
        let part = state.prefetched ? await state.prefetched.promise : await readPart(descriptor.url, 0, state.controller.signal);
        while (!state.closed) {
          await append(state, part.bytes);
          if (part.next === part.total) break;
          await waitForStreaming(state);
          part = await readPart(descriptor.url, part.next, state.controller.signal, part);
        }
        if (!state.closed && mediaSource.readyState === 'open') { state.complete = true; mediaSource.endOfStream(); state.finish(); }
      } catch { if (!state.closed) fallback(); }
    };
    active = state;
    if (descriptor.managed) media.disableRemotePlayback = true;
    media.addEventListener('error', state.mediaError, true);
    media.addEventListener('seeking', state.checkBuffered);
    mediaSource.addEventListener('sourceopen', state.open, { once: true });
    media.setAttribute?.('data-playback-engine', descriptor.managed ? 'managed-mediasource' : 'mediasource');
    media.src = objectUrl;
    return { completion };
  }

  return { preload, attach, reset() { release(active); }, dispose() {
    release(active);
    for (const entry of warm.values()) entry.controller.abort();
    warm.clear();
    failed.clear();
  } };
}