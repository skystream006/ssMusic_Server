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
  const handle = event.target.closest('.song-drag, .library-entry-select, .library-entry-drag');
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

export function initializeTouchControls() {
  dragDrop.polyfill({
    forceApply: true,
    holdToDrag: 300,
    tryFindDraggableTarget: findTouchDraggable,
    dragImageTranslateOverride: scroll.scrollBehaviourDragImageTranslateOverride
  });
  window.addEventListener('touchmove', () => {}, { passive: false });
  const clearDrag = () => {
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