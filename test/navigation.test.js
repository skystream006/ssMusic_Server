import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'vite';

let server;
let createNavigationHistory;

before(async () => {
  server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  ({ createNavigationHistory } = await server.ssrLoadModule('/src/navigation.js'));
});

after(async () => { await server?.close(); });

function setup(url = '/job/one/player?song=Song.mp3&play=1') {
  const entries = [{ url, state: { existing: 'preserved' } }];
  const listeners = new Set();
  const pending = [];
  let index = 0;
  let backCalls = 0;
  let leftPage = false;
  let scrolls = 0;
  const popstate = () => { for (const listener of listeners) listener(); };
  const go = (delta) => pending.push(() => {
    if (index + delta < 0) { leftPage = true; return; }
    if (index + delta >= entries.length) return;
    index += delta;
    popstate();
  });
  const browser = {
    get location() { return new URL(entries[index].url, 'https://music.example'); },
    history: {
      get state() { return structuredClone(entries[index].state); },
      pushState(state, _, destination = entries[index].url) {
        entries.splice(index + 1, Infinity, { state: structuredClone(state), url: destination });
        index++;
      },
      replaceState(state, _, destination = entries[index].url) {
        entries[index] = { state: structuredClone(state), url: destination };
      },
      back() { backCalls++; go(-1); },
      forward() { go(1); }
    },
    addEventListener(type, listener) { assert.equal(type, 'popstate'); listeners.add(listener); },
    removeEventListener(type, listener) { assert.equal(type, 'popstate'); listeners.delete(listener); },
    scrollTo() { scrolls++; }
  };
  const navigation = createNavigationHistory(browser);
  const events = [];
  const unsubscribe = navigation.subscribe((event) => events.push(event));
  return {
    browser, navigation, events, entries, listeners, unsubscribe, popstate,
    flush() { while (pending.length) pending.shift()(); },
    get url() { return entries[index].url; },
    get backCalls() { return backCalls; },
    get leftPage() { return leftPage; },
    get scrolls() { return scrolls; },
    get routeChanges() { return events.filter((event) => event.routeChanged).length; },
    get playerPanel() { return events.at(-1).playerPanel; },
    get lyricsOpen() { return events.at(-1).lyricsOpen; }
  };
}

test('expanded player tabs share one history entry and Forward restores the selected tab', () => {
  const app = setup('/');
  for (const panel of ['player', 'lyrics', 'queue', 'player', 'queue']) {
    app.navigation.setPlayerPanel(panel);
    assert.equal(app.playerPanel, panel);
    assert.equal(app.lyricsOpen, panel === 'lyrics');
    assert.equal(app.entries.length, 2);
  }
  app.browser.history.back();
  app.flush();
  assert.equal(app.playerPanel, null);
  assert.equal(app.routeChanges, 0);
  assert.equal(app.scrolls, 0);
  app.browser.history.forward();
  app.flush();
  assert.equal(app.playerPanel, 'queue');
  assert.equal(app.routeChanges, 0);
});

test('expanded player rapid close and tab changes preserve the latest intent', () => {
  const app = setup('/');
  app.navigation.setPlayerPanel('player');
  app.navigation.setPlayerPanel(null);
  app.navigation.setPlayerPanel('lyrics');
  app.navigation.setPlayerPanel('queue');
  app.popstate();
  app.flush();
  assert.equal(app.playerPanel, 'queue');
  assert.equal(app.entries.length, 2);
  assert.equal(app.backCalls, 1);
  app.navigation.setPlayerPanel(null);
  app.flush();
  app.browser.history.back();
  app.flush();
  assert.equal(app.leftPage, true);
});

test('route navigation replaces the expanded player without leaving a stale panel', () => {
  const app = setup('/');
  app.navigation.setPlayerPanel('queue');
  app.navigation.navigate('/settings');
  assert.equal(app.playerPanel, null);
  app.browser.history.back();
  app.flush();
  assert.equal(app.url, '/');
  assert.equal(app.playerPanel, null);
});

test('Back dismisses lyrics on a directly loaded player without remounting or scrolling the route', () => {
  const app = setup();
  const url = app.url;
  app.navigation.setLyricsOpen(true);
  assert.equal(app.browser.history.state.existing, 'preserved');
  assert.equal(app.url, url);
  app.browser.history.back();
  app.flush();
  assert.equal(app.lyricsOpen, false);
  assert.equal(app.leftPage, false);
  assert.equal(app.routeChanges, 0);
  assert.equal(app.scrolls, 0);
  assert.equal(app.url, url);
  app.browser.history.back();
  app.flush();
  assert.equal(app.leftPage, true);
});

test('Forward reopens lyrics and a second Back dismisses them without routing', () => {
  const app = setup();
  app.navigation.setLyricsOpen(true);
  app.browser.history.back();
  app.flush();
  app.browser.history.forward();
  app.flush();
  assert.equal(app.lyricsOpen, true);
  app.browser.history.back();
  app.flush();
  assert.equal(app.lyricsOpen, false);
  assert.equal(app.routeChanges, 0);
});

test('explicit dismissal consumes the lyrics entry, so the next Back reaches the previous route', () => {
  const app = setup('/');
  app.navigation.navigate('/settings');
  app.navigation.setLyricsOpen(true);
  app.navigation.setLyricsOpen(false);
  assert.equal(app.lyricsOpen, false);
  app.flush();
  assert.equal(app.routeChanges, 1);
  app.browser.history.back();
  app.flush();
  assert.equal(app.url, '/');
  assert.equal(app.routeChanges, 2);
});

test('repeated closes and synthetic popstate events do not enqueue extra Back traversals', () => {
  const app = setup();
  app.navigation.setLyricsOpen(true);
  app.navigation.setLyricsOpen(false);
  app.popstate();
  app.navigation.setLyricsOpen(false);
  assert.equal(app.backCalls, 1);
  app.flush();
  assert.equal(app.leftPage, false);
  assert.equal(app.lyricsOpen, false);
  assert.equal(app.routeChanges, 0);
});

test('rapid close/reopen waits for Back and does not accumulate duplicate entries', () => {
  const app = setup();
  for (let i = 0; i < 5; i++) {
    app.navigation.setLyricsOpen(true);
    app.navigation.setLyricsOpen(false);
    app.navigation.setLyricsOpen(true);
    app.flush();
    assert.equal(app.lyricsOpen, true);
    assert.equal(app.entries.length, 2);
  }
  app.browser.history.back();
  app.flush();
  assert.equal(app.lyricsOpen, false);
  assert.equal(app.routeChanges, 0);
  app.browser.history.back();
  app.flush();
  assert.equal(app.leftPage, true);
});

test('rapid close/reopen/close honors the last intent with only one pending Back', () => {
  const app = setup();
  app.navigation.setLyricsOpen(true);
  app.navigation.setLyricsOpen(false);
  app.navigation.setLyricsOpen(true);
  app.navigation.setLyricsOpen(false);
  app.flush();
  assert.equal(app.backCalls, 1);
  assert.equal(app.lyricsOpen, false);
  assert.equal(app.routeChanges, 0);
});

test('navigation while lyrics are open replaces the overlay, not the underlying page', () => {
  const app = setup('/');
  app.navigation.setLyricsOpen(true);
  app.navigation.navigate('/health');
  assert.equal(app.lyricsOpen, false);
  assert.equal(app.routeChanges, 1);
  assert.equal(app.url, '/health');
  app.browser.history.back();
  app.flush();
  assert.equal(app.url, '/');
  assert.equal(app.lyricsOpen, false);
  assert.equal(app.routeChanges, 2);
});

test('navigation during an explicit close waits for Back instead of popping the new route', () => {
  const app = setup('/');
  app.navigation.setLyricsOpen(true);
  app.navigation.setLyricsOpen(false);
  app.navigation.navigate('/health');
  app.popstate();
  assert.equal(app.routeChanges, 0);
  app.flush();
  assert.equal(app.url, '/health');
  assert.equal(app.lyricsOpen, false);
  assert.equal(app.routeChanges, 1);
  app.browser.history.back();
  app.flush();
  assert.equal(app.url, '/');
  assert.equal(app.routeChanges, 2);
});

test('same-URL route navigation still remounts, but synthetic popstate does not', () => {
  const app = setup('/');
  app.navigation.navigate('/');
  assert.equal(app.routeChanges, 1);
  app.popstate();
  assert.equal(app.routeChanges, 1);
  app.browser.history.back();
  app.flush();
  assert.equal(app.routeChanges, 2);
});

test('playlist URL replacements retain the route identity for overlay Back', () => {
  const app = setup('/');
  const page = app.browser.history.state.ssMusicNavigation.page;
  app.navigation.replaceURL('/?playlist=one');
  assert.equal(app.browser.history.state.ssMusicNavigation.page, page);
  assert.equal(app.browser.history.state.existing, 'preserved');
  app.popstate();
  assert.equal(app.routeChanges, 0);
  app.navigation.setLyricsOpen(true);
  app.browser.history.back();
  app.flush();
  assert.equal(app.url, '/?playlist=one');
  assert.equal(app.routeChanges, 0);
  app.browser.history.forward();
  app.flush();
  assert.equal(app.lyricsOpen, true);
  app.navigation.setLyricsOpen(false);
  app.flush();
  assert.equal(app.routeChanges, 0);
  assert.equal(app.scrolls, 0);
});

test('Forward restores the playlist route if selection changed after dismissing lyrics', () => {
  const app = setup('/?playlist=one');
  app.navigation.setLyricsOpen(true);
  app.navigation.setLyricsOpen(false);
  app.flush();
  app.navigation.replaceURL('/?playlist=two');
  assert.equal(app.routeChanges, 0);
  assert.equal(app.url, '/?playlist=two');
  app.browser.history.forward();
  app.flush();
  assert.equal(app.url, '/?playlist=one');
  assert.equal(app.lyricsOpen, true);
  assert.equal(app.routeChanges, 1);
  app.browser.history.back();
  app.flush();
  assert.equal(app.url, '/?playlist=two');
  assert.equal(app.lyricsOpen, false);
  assert.equal(app.routeChanges, 2);
  app.popstate();
  assert.equal(app.routeChanges, 2);
  assert.equal(app.scrolls, 0);
});

test('subscription replay does not push history and removes its listeners', () => {
  const app = setup();
  app.unsubscribe();
  assert.equal(app.listeners.size, 0);
  const unsubscribe = app.navigation.subscribe((event) => app.events.push(event));
  assert.equal(app.listeners.size, 1);
  app.navigation.setLyricsOpen(true);
  unsubscribe();
  assert.equal(app.listeners.size, 0);
  const replay = app.navigation.subscribe((event) => app.events.push(event));
  assert.equal(app.lyricsOpen, true);
  assert.equal(app.entries.length, 2);
  assert.equal(app.backCalls, 0);
  replay();
  assert.equal(app.listeners.size, 0);
});

test('an in-flight close finishes safely even if subscribers unmount', () => {
  const app = setup();
  app.navigation.setLyricsOpen(true);
  app.navigation.setLyricsOpen(false);
  app.unsubscribe();
  assert.equal(app.listeners.size, 1);
  app.flush();
  assert.equal(app.listeners.size, 0);
  assert.equal(app.leftPage, false);
});
