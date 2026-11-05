import dragDrop from 'mobile-drag-drop';
import scroll from 'mobile-drag-drop/scroll-behaviour.js';
import 'mobile-drag-drop/default.css';

export function createMediaSwipeHandlers(onSwipe, getSelection = () => undefined) {
  let gesture = null;
  let suppressClickUntil = 0;

  function matches(event) {
    return gesture && gesture.pointerId === event.pointerId && gesture.surface === event.currentTarget
      && gesture.selection === getSelection();
  }

  return {
    onPointerDown(event) {
      gesture = null;
      suppressClickUntil = 0;
      if (event.pointerType === 'mouse' || event.isPrimary === false || event.button !== 0) return;
      const control = event.target.closest('button, a, input, select, textarea, [role="slider"], [contenteditable="true"], summary');
      if (control && !control.matches('.dock-expand')) return;
      const video = event.target.closest('video');
      if (video?.controls && event.clientY >= video.getBoundingClientRect().bottom - 48) return;
      gesture = { pointerId: event.pointerId, surface: event.currentTarget, selection: getSelection(),
        startX: event.clientX, startY: event.clientY, startedAt: event.timeStamp, axis: null };
    },
    onPointerMove(event) {
      if (!matches(event) || gesture.axis === 'vertical') return;
      const horizontal = Math.abs(event.clientX - gesture.startX);
      const vertical = Math.abs(event.clientY - gesture.startY);
      if (!gesture.axis && vertical > 12 && vertical > horizontal) gesture.axis = 'vertical';
      else if (horizontal > 12 && horizontal > vertical * 1.5) gesture.axis = 'horizontal';
      if (gesture.axis === 'horizontal') {
        if (!event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.setPointerCapture?.(event.pointerId);
        event.preventDefault();
      }
    },
    onPointerUp(event) {
      if (!matches(event)) return;
      const finished = gesture;
      gesture = null;
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      const horizontal = event.clientX - finished.startX;
      const vertical = Math.abs(event.clientY - finished.startY);
      const elapsed = event.timeStamp - finished.startedAt;
      if (finished.axis === 'vertical' || Math.abs(horizontal) < 56 || Math.abs(horizontal) <= vertical * 1.5
        || elapsed < 0 || elapsed > 900) return;
      suppressClickUntil = event.timeStamp + 500;
      event.preventDefault();
      onSwipe(horizontal < 0 ? 'next' : 'previous');
    },
    onPointerCancel() { gesture = null; suppressClickUntil = 0; },
    onLostPointerCapture(event) {
      if (matches(event) && event.target === gesture.surface && !event.currentTarget.hasPointerCapture?.(event.pointerId)) gesture = null;
    },
    onClickCapture(event) {
      const suppress = suppressClickUntil > 0 && event.timeStamp <= suppressClickUntil && event.detail !== 0;
      suppressClickUntil = 0;
      if (suppress) { event.preventDefault(); event.stopPropagation(); }
    }
  };
}

export function findTouchDraggable(event) {
  if (event.touches.length !== 1) return;
  const handle = event.target.closest('.song-drag, .queue-drag, .library-entry-select, .library-entry-drag');
  const draggable = handle?.closest('[draggable="true"]');
  return handle && !handle.disabled ? draggable || undefined : undefined;
}

export function allowDrop(event, allowed) {
  if (!allowed) return;
  event.preventDefault();
  event.stopPropagation();
  event.dataTransfer.dropEffect = 'move';
  event.currentTarget.dataset.dragOver = 'true';
}

export function leaveDrop(event) {
  if (!event.currentTarget.contains(event.relatedTarget)) {
    delete event.currentTarget.dataset.dragOver;
    delete event.currentTarget.dataset.dropPosition;
  }
}

export function createSongDragAutoScroll(browser = window) {
  let surface = null;
  let scrollTarget = browser;
  let pointer = null;
  let frame = null;
  let previousTime = null;

  function stop() {
    if (frame !== null) browser.cancelAnimationFrame(frame);
    surface = null;
    pointer = null;
    frame = null;
    previousTime = null;
  }

  function tick(time) {
    frame = null;
    if (!surface?.isConnected || browser.document.hidden) { stop(); return; }
    const elapsed = previousTime === null ? 16 : Math.min(50, time - previousTime);
    previousTime = time;
    if (pointer) {
      const bounds = surface.getBoundingClientRect();
      const topbar = browser.document.querySelector('.topbar')?.getBoundingClientRect();
      const dock = browser.document.querySelector('.player-dock')?.getBoundingClientRect();
      const top = Math.max(0, bounds.top, topbar?.bottom || 0);
      const bottom = Math.min(browser.innerHeight, bounds.bottom, dock?.top ?? browser.innerHeight);
      const edge = Math.min(64, (bottom - top) / 3);
      if (edge > 0 && pointer.x >= bounds.left && pointer.x <= bounds.right
        && pointer.y >= top && pointer.y <= bottom) {
        const direction = pointer.y < top + edge ? -Math.min(1, (top + edge - pointer.y) / edge)
          : pointer.y > bottom - edge ? Math.min(1, (pointer.y - bottom + edge) / edge) : 0;
        if (direction) scrollTarget.scrollBy({ top: direction * 600 * elapsed / 1000, behavior: 'instant' });
      }
    }
    frame = browser.requestAnimationFrame(tick);
  }

  return {
    onDragStart(event) {
      stop();
      const handle = event.target.closest?.('.song-drag, .queue-drag');
      if (!handle || handle.disabled || handle.getAttribute('draggable') !== 'true') return;
      surface = handle.closest('.playback-queue, .library-songs');
      scrollTarget = surface?.matches?.('.playback-queue') ? surface : browser;
      if (surface) frame = browser.requestAnimationFrame(tick);
    },
    onDragOver(event) {
      if (surface) pointer = { x: event.clientX, y: event.clientY };
    },
    stop
  };
}

export function initializeTouchControls() {
  dragDrop.polyfill({
    forceApply: true,
    holdToDrag: 300,
    tryFindDraggableTarget: findTouchDraggable,
    dragImageTranslateOverride: scroll.scrollBehaviourDragImageTranslateOverride
  });
  window.addEventListener('touchmove', () => {}, { passive: false });
  const songScroll = createSongDragAutoScroll();
  document.addEventListener('dragstart', songScroll.onDragStart, true);
  document.addEventListener('dragover', songScroll.onDragOver, true);
  window.addEventListener('blur', songScroll.stop);
  document.addEventListener('visibilitychange', () => { if (document.hidden) songScroll.stop(); });
  const clearDrag = () => {
    songScroll.stop();
    document.querySelectorAll('[data-drag-over], [data-dragging]').forEach((element) => {
      delete element.dataset.dragOver;
      delete element.dataset.dragging;
      delete element.dataset.dropPosition;
    });
  };
  document.addEventListener('dragend', clearDrag);
  document.addEventListener('drop', clearDrag);
  document.addEventListener('touchcancel', clearDrag);
}