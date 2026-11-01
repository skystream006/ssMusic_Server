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

export function createMediaSourcePlayback({ browser = globalThis, chunkBytes = 256 * 1024,
  bufferAheadSeconds = 90, bufferBehindSeconds = 30, requestTimeoutMs = 15000,
  retryDelays = [250, 500], recoveryDelays = [1500, 5000], onEvent = () => {} } = {}) {
  const warm = new Map();
  const failed = new Set();
  let active = null;
  const retryable = (error) => error?.retryable || ['TypeError', 'TimeoutError'].includes(error?.name);
  const notify = (event, details = {}) => { try { onEvent(event, details); } catch {} };

  function waitForRetry(signal, milliseconds) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', abort);
        resolve();
      }, milliseconds);
      const abort = () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', abort);
        reject(new DOMException('Playback changed', 'AbortError'));
      };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }

  async function readPart(url, offset, signal, previous = null) {
    for (let attempt = 0; ; attempt++) {
      signal.throwIfAborted();
      const controller = new AbortController();
      const combined = AbortSignal.any([signal, controller.signal]);
      const timer = setTimeout(() => controller.abort(new DOMException('Media request timed out', 'TimeoutError')), requestTimeoutMs);
      let cancel;
      try {
        return await Promise.race([
          readPartAttempt(url, offset, combined, previous),
          new Promise((resolve, reject) => {
            cancel = () => reject(combined.reason);
            combined.addEventListener('abort', cancel, { once: true });
            if (combined.aborted) cancel();
          })
        ]);
      }
      catch (error) {
        if (signal.aborted) throw error;
        const failure = controller.signal.aborted ? controller.signal.reason : error;
        if (!retryable(failure) || attempt >= retryDelays.length) throw failure;
        notify('request-retry', { offset, attempt: attempt + 1, status: failure.status || 0, reason: failure.name });
        clearTimeout(timer);
        await waitForRetry(signal, Math.max(retryDelays[attempt], failure.retryAfter || 0));
      } finally {
        clearTimeout(timer);
        if (cancel) combined.removeEventListener('abort', cancel);
      }
    }
  }

  async function readPartAttempt(url, offset, signal, previous) {
    const headers = { Range: `bytes=${offset}-${offset + chunkBytes - 1}` };
    if (previous?.modified) headers['If-Range'] = previous.modified;
    const response = await browser.fetch(url, { headers, signal, credentials: 'same-origin' });
    if (!response.ok) {
      const after = response.headers.get('retry-after');
      const seconds = Number(after);
      const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(after) - Date.now();
      await response.body?.cancel().catch(() => {});
      throw Object.assign(new Error(`Media request failed (${response.status})`), { status: response.status,
        retryable: [408, 429, 500, 502, 503, 504].includes(response.status),
        retryAfter: Number.isFinite(delay) ? Math.max(0, Math.min(delay, 60000)) : 0 });
    }
    const range = response.headers.get('content-range')?.match(/^bytes (\d+)-(\d+)\/(\d+)$/i);
    const length = Number(response.headers.get('content-length'));
    const total = range ? Number(range[3]) : length;
    if (!Number.isSafeInteger(total) || total <= 0
      || (offset && !range) || (range && Number(range[1]) !== offset)
      || (range && (Number(range[2]) < offset || Number(range[2]) >= total))
      || (!range && (!length || length > chunkBytes))) {
      await response.body?.cancel().catch(() => {});
      throw new Error('Media requires native range playback');
    }
    const etag = response.headers.get('etag');
    if (previous && (previous.total !== total || (previous.etag && etag !== previous.etag))) {
      await response.body?.cancel().catch(() => {});
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
    const duration = Number(response.headers.get('x-media-duration'));
    return { bytes, next: offset + size, total, etag, modified: response.headers.get('last-modified'),
      duration: Number.isFinite(duration) && duration > 0 ? duration : 0 };
  }

  function preload(source) {
    const descriptor = getMediaSourceDescriptor(source, browser);
    if (!descriptor || failed.has(source) || active?.source === source || active?.next?.source === source) return Promise.resolve(false);
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
    state.current.controller?.abort();
    state.next?.controller.abort();
    state.current.prefetched?.controller.abort();
    state.next?.prefetched?.controller.abort();
    state.prefetched?.controller.abort();
    state.media.removeEventListener('error', state.mediaError, true);
    state.media.removeEventListener('seeking', state.checkBuffered);
    state.media.removeEventListener('timeupdate', state.advance, true);
    state.buffer?.removeEventListener('bufferedchange', state.evicted);
    state.mediaSource.removeEventListener('sourceopen', state.open);
    state.media.disableRemotePlayback = state.remotePlaybackDisabled;
    browser.URL.revokeObjectURL(state.objectUrl);
    state.finish();
    if (active === state) active = null;
  }

  function waitForRecovery(state, segment, offset) {
    return new Promise((resolve, reject) => {
      const signal = segment.controller.signal;
      const cleanup = () => {
        browser.removeEventListener?.('online', resume);
        signal.removeEventListener('abort', abort);
        state.recoveryWaits.delete(resume);
      };
      const resume = () => { cleanup(); notify('request-resume', { offset }); resolve(); };
      const abort = () => { cleanup(); reject(new DOMException('Playback changed', 'AbortError')); };
      state.recoveryWaits.add(resume);
      browser.addEventListener?.('online', resume);
      signal.addEventListener('abort', abort, { once: true });
      notify('recovery-wait', { offset });
      if (signal.aborted) abort();
    });
  }

  async function readRecoverablePart(state, segment, offset, previous = null) {
    let attempt = 0;
    while (!state.closed) {
      segment.controller.signal.throwIfAborted();
      try {
        if (!offset && segment.prefetched && !segment.usedPrefetch) {
          segment.usedPrefetch = true;
          return await segment.prefetched.promise;
        }
        const part = await readPart(segment.descriptor.url, offset, segment.controller.signal, previous);
        notify('request-ready', { offset, bytes: part.bytes.byteLength });
        return part;
      } catch (error) {
        if (segment.controller.signal.aborted || !retryable(error)) throw error;
        notify('buffer-recovery', { offset, attempt: attempt + 1, status: error.status || 0, reason: error.name });
        if (attempt < recoveryDelays.length) {
          await waitForRetry(segment.controller.signal, Math.max(recoveryDelays[attempt++], error.retryAfter || 0));
        } else {
          await waitForRecovery(state, segment, offset);
          attempt = 0;
        }
      }
    }
    throw new DOMException('Playback changed', 'AbortError');
  }

  function updateBuffer(state, update) {
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
      try { update(buffer); } catch (failure) { cleanup(); reject(failure); }
    });
  }

  function waitForStreaming(state, signal = state.controller.signal) {
    if (!state.managed || state.mediaSource.streaming !== false) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        state.mediaSource.removeEventListener('startstreaming', start);
        signal.removeEventListener('abort', abort);
      };
      const start = () => { cleanup(); resolve(); };
      const abort = () => { cleanup(); reject(new DOMException('Playback changed', 'AbortError')); };
      state.mediaSource.addEventListener('startstreaming', start, { once: true });
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    });
  }

  function timing(media) {
    if (!active || active.closed || active.media !== media) return null;
    const { start, end } = active.current;
    const duration = Number.isFinite(end) ? end - start : active.current.duration
      || (Number.isFinite(media.duration) ? media.duration - start : 0);
    return { position: Math.max(0, (Number.isFinite(media.currentTime) ? media.currentTime : 0) - start),
      duration: Math.max(0, duration), offset: start };
  }

  function updateSeekable(state) {
    const duration = state.current.duration;
    if (duration > 0 && state.mediaSource.readyState === 'open') {
      state.mediaSource.setLiveSeekableRange?.(state.current.start, state.current.start + duration);
    }
  }

  async function waitForBufferRoom(state, segment) {
    const signal = segment.controller.signal;
    signal.throwIfAborted();
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        for (const event of ['timeupdate', 'seeking', 'playing']) state.media.removeEventListener(event, check);
        signal.removeEventListener('abort', abort);
      };
      const abort = () => { cleanup(); reject(new DOMException('Playback changed', 'AbortError')); };
      const check = () => {
        const ranges = state.buffer.buffered;
        const ahead = ranges?.length ? ranges.end(ranges.length - 1) - state.media.currentTime : 0;
        if (ahead < bufferAheadSeconds) { cleanup(); resolve(); }
      };
      for (const event of ['timeupdate', 'seeking', 'playing']) state.media.addEventListener(event, check);
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      else check();
    });
    signal.throwIfAborted();
    const ranges = state.buffer.buffered;
    const expired = Math.max(0, state.media.currentTime - bufferBehindSeconds);
    if (ranges?.length && expired > ranges.start(0)) {
      await updateBuffer(state, (buffer) => buffer.remove(0, expired));
    }
  }

  async function readSegment(state, segment) {
    await waitForStreaming(state, segment.controller.signal);
    await waitForBufferRoom(state, segment);
    let part = await readRecoverablePart(state, segment, 0);
    while (!state.closed && !segment.controller.signal.aborted) {
      if (part.duration && segment.duration !== part.duration) {
        segment.duration = part.duration;
        updateSeekable(state);
        state.media.dispatchEvent(new (browser.Event || Event)('durationchange'));
      }
      try { await updateBuffer(state, (buffer) => buffer.appendBuffer(part.bytes)); }
      catch (error) {
        const ranges = state.buffer.buffered;
        if (error.name !== 'QuotaExceededError' || !ranges?.length || state.media.currentTime - 1 <= ranges.start(0)) throw error;
        notify('buffer-trim');
        await updateBuffer(state, (buffer) => buffer.remove(0, state.media.currentTime - 1));
        await updateBuffer(state, (buffer) => buffer.appendBuffer(part.bytes));
      }
      const ranges = state.buffer.buffered;
      if (ranges?.length) segment.bufferedEnd = ranges.end(ranges.length - 1);
      if (part.next === part.total) { segment.end = segment.bufferedEnd; break; }
      await waitForStreaming(state, segment.controller.signal);
      await waitForBufferRoom(state, segment);
      part = await readRecoverablePart(state, segment, part.next, part);
    }
    if (!state.closed) state.media.dispatchEvent(new (browser.Event || Event)('durationchange'));
  }

  async function removeQueued(state) {
    if (!state.queued) return;
    const start = state.queued.start;
    const ranges = state.buffer.buffered;
    if (ranges?.length && ranges.end(ranges.length - 1) > start) {
      await updateBuffer(state, (buffer) => buffer.remove(start, Infinity));
    }
    state.queued = null;
  }

  function queueNext(source, onAdvance = () => {}) {
    const state = active;
    if (!state || state.closed) return Promise.resolve(false);
    const descriptor = getMediaSourceDescriptor(source, browser);
    const supported = descriptor && !failed.has(source) && descriptor.mime === state.descriptor.mime
      && descriptor.Constructor === state.descriptor.Constructor;
    const target = supported ? source : null;
    if (state.next?.source === target) {
      state.next.onAdvance = onAdvance;
      return state.next.promise;
    }
    if (state.next && state.next !== state.current) {
      state.next.controller.abort();
      state.next.prefetched?.controller.abort();
    }
    const next = { source: target, descriptor, onAdvance, controller: new AbortController(), end: null };
    state.next = next;
    next.promise = state.work.then(async () => {
      if (state.closed || state.next !== next) return false;
      await removeQueued(state);
      if (state.closed || state.next !== next) return false;
      const ranges = state.buffer.buffered;
      if (ranges?.length && state.current.start > ranges.start(0)) {
        await updateBuffer(state, (buffer) => buffer.remove(0, state.current.start));
      }
      if (state.closed || state.next !== next) return false;
      if (!target) {
        if (state.mediaSource.readyState === 'open') state.mediaSource.endOfStream();
        return false;
      }
      if (!Number.isFinite(state.current.end)) throw new Error('Media timeline is unavailable');
      next.start = state.current.end;
      state.queued = next;
      if (state.mediaSource.readyState === 'ended') state.buffer.timestampOffset = next.start;
      state.buffer.abort();
      state.buffer.mode = 'sequence';
      state.buffer.timestampOffset = next.start;
      next.prefetched = warm.get(source);
      warm.delete(source);
      await readSegment(state, next);
      return !state.closed && !next.controller.signal.aborted;
    }).catch(async () => {
      if (state.closed || next.controller.signal.aborted) return false;
      if (state.current === next) { state.fallback(); return false; }
      failed.add(source);
      if (failed.size > 32) failed.delete(failed.values().next().value);
      try {
        if (state.queued === next) await removeQueued(state);
        if (state.mediaSource.readyState === 'open') state.mediaSource.endOfStream();
      } catch { state.fallback(); }
      return false;
    });
    state.work = next.promise;
    return next.promise;
  }

  function attach(media, source, onFallback) {
    release(active);
    const descriptor = getMediaSourceDescriptor(source, browser);
    if (!descriptor || failed.has(source)) { media.setAttribute?.('data-playback-engine', 'native'); return null; }
    let mediaSource;
    let objectUrl;
    try { mediaSource = new descriptor.Constructor(); objectUrl = browser.URL.createObjectURL(mediaSource); }
    catch { return null; }
    const state = { media, source, descriptor, mediaSource, objectUrl, controller: new AbortController(), closed: false, managed: descriptor.managed,
      remotePlaybackDisabled: media.disableRemotePlayback, prefetched: warm.get(source), recoveryWaits: new Set() };
    state.current = { source, descriptor, start: 0, end: null, controller: state.controller, prefetched: state.prefetched };
    warm.delete(source);
    const completion = new Promise((resolve) => { state.finish = resolve; });
    state.work = completion;
    const fallback = () => {
      if (state.closed) return;
      const position = timing(media)?.position || 0;
      const currentSource = state.current.source;
      notify('native-fallback', { position });
      failed.add(currentSource);
      if (failed.size > 32) failed.delete(failed.values().next().value);
      release(state);
      onFallback({ media, source: currentSource, position });
    };
    state.fallback = fallback;
    state.advance = () => {
      const next = state.queued;
      if (state.closed || !next || next.controller.signal.aborted || !Number.isFinite(next.bufferedEnd) || media.currentTime < next.start) return;
      state.current = next;
      state.source = next.source;
      state.queued = null;
      if (state.next === next) state.next = null;
      updateSeekable(state);
      notify('track-advance');
      next.onAdvance();
    };
    state.mediaError = (event) => { if (!state.closed) { event.stopImmediatePropagation(); fallback(); } };
    state.checkBuffered = () => {
      if (state.closed || !state.buffer?.buffered) return;
      const ranges = state.buffer.buffered;
      if (!state.complete && !state.hadEviction && (!ranges.length || media.currentTime >= ranges.start(0))) return;
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
        state.buffer.mode = 'sequence';
        state.buffer.addEventListener('bufferedchange', state.evicted);
        await readSegment(state, state.current);
        if (!state.closed && mediaSource.readyState === 'open') {
          state.complete = true;
          if (!state.next?.source) mediaSource.endOfStream();
          state.finish();
        }
      } catch { if (!state.closed) fallback(); }
    };
    active = state;
    if (descriptor.managed) media.disableRemotePlayback = true;
    media.addEventListener('error', state.mediaError, true);
    media.addEventListener('seeking', state.checkBuffered);
    media.addEventListener('timeupdate', state.advance, true);
    mediaSource.addEventListener('sourceopen', state.open, { once: true });
    media.setAttribute?.('data-playback-engine', descriptor.managed ? 'managed-mediasource' : 'mediasource');
    media.src = objectUrl;
    notify('buffer-attach', { managed: descriptor.managed });
    return { completion };
  }

  return { preload, attach, queueNext, timing,
    get blocked() { return Boolean(active?.recoveryWaits.size); },
    recover() {
      if (!active || active.closed) return false;
      for (const resume of [...active.recoveryWaits]) resume();
      return true;
    },
    reset() { release(active); }, dispose() {
    release(active);
    for (const entry of warm.values()) entry.controller.abort();
    warm.clear();
    failed.clear();
  } };
}