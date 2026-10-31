import assert from 'node:assert/strict';
import test from 'node:test';
import { runWhenVisible, startVisiblePolling } from '../frontend/src/polling.js';

function environment(hidden = false) {
  const document = new EventTarget();
  document.hidden = hidden;
  const timers = new Map();
  let nextTimer = 0;
  return { document, timers,
    setTimeout(callback, interval) { const id = ++nextTimer; timers.set(id, { callback, interval }); return id; },
    clearTimeout(id) { timers.delete(id); },
    visibility(value) { document.hidden = value; document.dispatchEvent(new Event('visibilitychange')); },
    async tick() {
      const [id, timer] = timers.entries().next().value;
      timers.delete(id);
      await timer.callback();
    }
  };
}

test('hidden UI responses wait for visibility and cancelled responses cannot overwrite a newer view', () => {
  const browser = environment(true);
  const values = [];
  const cancel = runWhenVisible(() => values.push('stale'), browser.document);
  cancel();
  runWhenVisible(() => values.push('current'), browser.document);
  assert.deepEqual(values, []);
  browser.visibility(false);
  assert.deepEqual(values, ['current']);
  browser.visibility(false);
  assert.deepEqual(values, ['current']);
  runWhenVisible(() => values.push('immediate'), browser.document);
  assert.deepEqual(values, ['current', 'immediate']);
});

test('UI polling stops in the background and refreshes on visibility without changing its interval', async () => {
  const browser = environment();
  let calls = 0;
  const stop = startVisiblePolling(async () => { calls++; }, 5000, browser);
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(browser.timers.size, 1);
  assert.equal([...browser.timers.values()][0].interval, 5000);
  await browser.tick();
  assert.equal(calls, 2);
  browser.visibility(true);
  assert.equal(browser.timers.size, 0);
  browser.visibility(false);
  await Promise.resolve();
  assert.equal(calls, 3);
  assert.equal(browser.timers.size, 1);
  stop();
  assert.equal(browser.timers.size, 0);
  browser.visibility(true);
  browser.visibility(false);
  assert.equal(calls, 3);
});

test('hidden pages do not begin UI polls until visible', async () => {
  const browser = environment(true);
  let calls = 0;
  const stop = startVisiblePolling(async () => { calls++; }, 5000, browser);
  assert.equal(calls, 0);
  assert.equal(browser.timers.size, 0);
  browser.visibility(false);
  await Promise.resolve();
  assert.equal(calls, 1);
  stop();
});

test('slow UI polls never overlap and a hidden completion cannot restart polling', async () => {
  const browser = environment();
  const releases = [];
  let calls = 0;
  const stop = startVisiblePolling(() => { calls++; return new Promise((resolve) => releases.push(resolve)); }, 5000, browser);
  browser.visibility(true);
  browser.visibility(false);
  browser.visibility(false);
  assert.equal(calls, 1);
  assert.equal(browser.timers.size, 0);
  releases.shift()();
  await Promise.resolve();
  assert.equal(calls, 2);
  browser.visibility(true);
  releases.shift()();
  await Promise.resolve();
  assert.equal(browser.timers.size, 0);
  stop();
});