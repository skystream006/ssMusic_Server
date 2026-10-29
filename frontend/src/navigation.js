import { useEffect, useState } from 'react';

const historyKey = 'ssMusicNavigation';

export function createNavigationHistory(browser) {
  const listeners = new Set();
  let listening = false;
  let closing = false;
  let destinationAfterClose = null;

  function pageState() {
    let state = browser.history.state?.[historyKey];
    if (!state) {
      state = { page: `${Date.now()}-${Math.random()}`, lyrics: false };
      browser.history.replaceState({ ...browser.history.state, [historyKey]: state }, '');
    }
    return state;
  }

  let currentPage = pageState().page;
  let currentURL = browser.location.href;
  const savedPanel = (state = pageState()) => state.panel ?? (state.lyrics ? 'lyrics' : null);
  let playerPanel = savedPanel();

  function notify(routeChanged = false) {
    for (const listener of listeners) listener({ routeChanged, lyricsOpen: playerPanel === 'lyrics', playerPanel });
  }

  function updateListener() {
    const needed = listeners.size > 0 || closing;
    if (needed === listening) return;
    browser[needed ? 'addEventListener' : 'removeEventListener']('popstate', onPopState);
    listening = needed;
  }

  function writePanel(method = 'pushState') {
    browser.history[method]({
      ...browser.history.state,
      [historyKey]: { ...pageState(), lyrics: playerPanel === 'lyrics', panel: playerPanel }
    }, '');
  }

  function navigate(destination) {
    playerPanel = null;
    if (closing) {
      // Wait for our asynchronous Back before pushing a new route.
      destinationAfterClose = destination;
      notify();
      return;
    }
    const replace = Boolean(savedPanel());
    currentPage = `${Date.now()}-${Math.random()}`;
    browser.history[replace ? 'replaceState' : 'pushState']({
      [historyKey]: { page: currentPage, lyrics: false }
    }, '', destination);
    currentURL = browser.location.href;
    notify(true);
    browser.scrollTo(0, 0);
  }

  function onPopState() {
    const state = pageState();
    const panel = savedPanel(state);
    // Synthetic popstate events must not complete a pending history.back().
    if (closing && state.page === currentPage && panel && browser.location.href === currentURL) return;
    const routeChanged = state.page !== currentPage || browser.location.href !== currentURL;
    currentPage = state.page;
    currentURL = browser.location.href;
    if (closing) {
      closing = false;
      if (destinationAfterClose !== null) {
        const destination = destinationAfterClose;
        destinationAfterClose = null;
        navigate(destination);
        updateListener();
        return;
      }
      // A rapid reopen must wait until Back has consumed the old overlay entry.
      if (playerPanel && !routeChanged && !panel) writePanel();
      else playerPanel = panel;
    } else playerPanel = panel;
    notify(routeChanged);
    updateListener();
  }

  function setPlayerPanel(panel) {
    playerPanel = panel;
    if (!closing) {
      if (panel) writePanel(savedPanel() ? 'replaceState' : 'pushState');
      else if (savedPanel()) {
        closing = true;
        updateListener();
        browser.history.back();
      }
    }
    notify();
  }

  return {
    navigate,
    replaceURL(destination) {
      // Selection changes are already rendered by the caller, not a new route.
      browser.history.replaceState(browser.history.state, '', destination);
      currentURL = browser.location.href;
    },
    setLyricsOpen(open) { setPlayerPanel(open ? 'lyrics' : null); },
    setPlayerPanel,
    subscribe(listener) {
      if (!listening) {
        currentPage = pageState().page;
        currentURL = browser.location.href;
        playerPanel = savedPanel();
      }
      listeners.add(listener);
      updateListener();
      listener({ routeChanged: false, lyricsOpen: playerPanel === 'lyrics', playerPanel });
      return () => { listeners.delete(listener); updateListener(); };
    }
  };
}

let history;
export function navigationHistory() {
  return history ||= createNavigationHistory(window);
}

export function navigate(destination) { navigationHistory().navigate(destination); }
export function replaceURL(destination) { navigationHistory().replaceURL(destination); }

export function useNavigation() {
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const unsubscribe = navigationHistory().subscribe(({ routeChanged }) => {
      if (routeChanged) setRevision((current) => current + 1);
    });
    const followLink = (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target.closest('a[href]');
      if (!link || link.hasAttribute('download') || (link.target && link.target !== '_self')) return;
      const url = new URL(link.href, window.location.href);
      if (url.origin !== window.location.origin || !/^\/(?:job(?:\/[^/]+(?:\/player)?)?|health|settings|admin(?:\/users\/[^/]+)?)?\/?$/.test(url.pathname) || url.hash) return;
      event.preventDefault();
      navigate(url.pathname + url.search);
    };
    document.addEventListener('click', followLink);
    return () => {
      unsubscribe();
      document.removeEventListener('click', followLink);
    };
  }, []);
  return revision;
}