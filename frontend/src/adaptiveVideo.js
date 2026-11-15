export function adaptiveVideoSource(source, base = 'http://localhost/') {
  if (!source) return source;
  const url = new URL(source, base);
  if (!['http:', 'https:'].includes(url.protocol)) return source;
  url.searchParams.set('format', 'hls');
  return /^https?:/i.test(source) ? url.href : `${url.pathname}${url.search}`;
}

export function isAdaptiveVideoSource(source, base = 'http://localhost/') {
  return Boolean(source && new URL(source, base).searchParams.get('format') === 'hls');
}

export function attachAdaptiveVideo(media, source, { browser = globalThis, onStatus = () => {}, onError = () => {},
  loadHls = () => import('hls.js').then((module) => module.default) } = {}) {
  const controller = new AbortController();
  let hls;
  let attached = false;
  let waitTimer;
  let failed = false;
  const abort = () => {
    browser.clearTimeout(waitTimer);
    hls?.destroy();
    if (attached) {
      media.removeAttribute('src');
      media.load();
    }
  };
  controller.signal.addEventListener('abort', abort, { once: true });

  const ready = (async () => {
    onStatus(true);
    while (true) {
      const response = await browser.fetch(source, { credentials: 'same-origin', signal: controller.signal, cache: 'no-store' });
      if (response.status === 202) {
        await response.body?.cancel();
        await new Promise((resolve, reject) => {
          const cancelled = () => reject(controller.signal.reason);
          controller.signal.addEventListener('abort', cancelled, { once: true });
          waitTimer = browser.setTimeout(() => {
            controller.signal.removeEventListener('abort', cancelled);
            resolve();
          }, 2000);
          if (controller.signal.aborted) cancelled();
        });
        continue;
      }
      if (!response.ok) {
        const detail = await response.json();
        throw new Error(detail.error || `Video preparation failed (${response.status})`);
      }
      await response.body?.cancel();
      break;
    }
    controller.signal.throwIfAborted();
    const Hls = await loadHls();
    controller.signal.throwIfAborted();
    if (Hls.isSupported()) {
      hls = new Hls({ startLevel: 0, capLevelToPlayerSize: true, maxBufferLength: 30, backBufferLength: 30 });
      await new Promise((resolve, reject) => {
        const cancelled = () => reject(controller.signal.reason);
        controller.signal.addEventListener('abort', cancelled, { once: true });
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          controller.signal.removeEventListener('abort', cancelled);
          resolve();
        });
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (!data.fatal || controller.signal.aborted) return;
          const error = new Error(`Adaptive video playback failed (${data.details}). Retry playback.`);
          failed = true;
          controller.signal.removeEventListener('abort', cancelled);
          reject(error);
          onError(error);
        });
        attached = true;
        hls.attachMedia(media);
        hls.loadSource(source);
      });
    } else if (media.canPlayType('application/vnd.apple.mpegurl')) {
      attached = true;
      media.src = source;
    } else throw new Error('Adaptive video is not supported in this browser. Download the original file to watch it.');
    onStatus(false);
  })().catch((error) => {
    if (!controller.signal.aborted) {
      failed = true;
      onStatus(false);
      hls?.destroy();
      throw error;
    }
  });
  return { ready, get failed() { return failed; }, destroy() { controller.abort(); } };
}
