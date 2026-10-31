export function runWhenVisible(callback, page = document) {
  if (!page.hidden) { callback(); return () => {}; }
  const visible = () => {
    if (page.hidden) return;
    page.removeEventListener('visibilitychange', visible);
    callback();
  };
  page.addEventListener('visibilitychange', visible);
  return () => page.removeEventListener('visibilitychange', visible);
}

export function startVisiblePolling(load, interval, browser = window) {
  let active = true;
  let pending = false;
  let refreshRequested = false;
  let timer = null;
  const visible = () => !browser.document.hidden;
  const clear = () => { if (timer !== null) browser.clearTimeout(timer); timer = null; };

  async function run() {
    if (!active || !visible()) return;
    if (pending) { refreshRequested = true; return; }
    clear();
    pending = true;
    refreshRequested = false;
    try { await load(); }
    catch {}
    finally {
      pending = false;
      if (active && visible()) {
        if (refreshRequested) run();
        else timer = browser.setTimeout(run, interval);
      }
    }
  }

  function visibilityChanged() {
    clear();
    if (visible()) run();
  }

  browser.document.addEventListener('visibilitychange', visibilityChanged);
  run();
  return () => {
    active = false;
    clear();
    browser.document.removeEventListener('visibilitychange', visibilityChanged);
  };
}