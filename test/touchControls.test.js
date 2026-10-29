import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createServer } from 'vite';

let server;
let controls;

before(async () => {
  server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  controls = await server.ssrLoadModule('/src/touchControls.js');
});

after(async () => { await server?.close(); });

function mediaSwipeFixture({ control = null, video = null } = {}) {
  const actions = [];
  let selection = 'first';
  let captured = false;
  let captureCount = 0;
  const surface = { setPointerCapture() { captured = true; captureCount++; }, hasPointerCapture() { return captured; }, releasePointerCapture() { captured = false; } };
  const target = { closest: (selector) => selector === 'video' ? video : control };
  const handlers = controls.createMediaSwipeHandlers((action) => actions.push(action), () => selection);
  const event = (clientX, clientY = 100, timeStamp = 0, overrides = {}) => ({
    pointerId: 1, pointerType: 'touch', isPrimary: true, button: 0, detail: 1, clientX, clientY, timeStamp,
    target, currentTarget: surface, defaultPrevented: false, stopped: false,
    preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...overrides
  });
  return { handlers, event, actions, get captureCount() { return captureCount; }, changeSelection() { selection = 'second'; } };
}

test('media swipes map left and right to transport actions and suppress the following tap', () => {
  const fixture = mediaSwipeFixture();
  const { handlers, event, actions } = fixture;
  handlers.onPointerDown(event(180));
  const movement = event(100, 103, 80);
  handlers.onPointerMove(movement);
  assert.equal(movement.defaultPrevented, true);
  handlers.onLostPointerCapture(event(100, 103, 90, { target: movement.currentTarget }));
  handlers.onPointerMove(event(90, 104, 120));
  assert.equal(fixture.captureCount, 1);
  handlers.onPointerUp(event(70, 104, 160));
  assert.deepEqual(actions, ['next']);
  const click = event(70, 104, 170);
  handlers.onClickCapture(click);
  assert.equal(click.defaultPrevented, true);
  assert.equal(click.stopped, true);
  handlers.onPointerDown(event(70, 100, 300));
  handlers.onPointerMove(event(160, 103, 400));
  handlers.onPointerUp(event(180, 104, 460));
  assert.deepEqual(actions, ['next', 'previous']);
  handlers.onPointerDown(event(100, 100, 500));
  handlers.onPointerUp(event(102, 101, 550));
  const nextTap = event(102, 101, 560);
  handlers.onClickCapture(nextTap);
  assert.equal(nextTap.defaultPrevented, false);
});

test('media swipes ignore scrolling, small drags, slow gestures, cancellation and changed tracks', () => {
  const cases = [
    { end: [155, 102, 100] },
    { move: [175, 160, 80], end: [70, 170, 200] },
    { end: [70, 180, 200] },
    { end: [70, 100, 1000] },
    { down: { pointerType: 'mouse' }, end: [70, 100, 200] },
    { cancel: true, end: [70, 100, 200] },
    { lost: true, end: [70, 100, 200] },
    { multitouch: true, end: [70, 100, 200] },
    { changed: true, end: [70, 100, 200] }
  ];
  for (const scenario of cases) {
    const fixture = mediaSwipeFixture();
    fixture.handlers.onPointerDown(fixture.event(180, 100, 0, scenario.down));
    if (scenario.move) fixture.handlers.onPointerMove(fixture.event(...scenario.move));
    if (scenario.cancel) fixture.handlers.onPointerCancel();
    if (scenario.lost) {
      const lost = fixture.event(180);
      fixture.handlers.onLostPointerCapture({ ...lost, target: lost.currentTarget });
    }
    if (scenario.multitouch) fixture.handlers.onPointerDown(fixture.event(180, 100, 20, { pointerId: 2, isPrimary: false }));
    if (scenario.changed) fixture.changeSelection();
    fixture.handlers.onPointerUp(fixture.event(...scenario.end));
    assert.deepEqual(fixture.actions, [], JSON.stringify(scenario));
  }
});

test('media swipes leave buttons, sliders and native video controls alone but allow the dock track area', () => {
  for (const options of [
    { control: { matches: () => false } },
    { video: { controls: true, getBoundingClientRect: () => ({ bottom: 140 }) } }
  ]) {
    const { handlers, event, actions } = mediaSwipeFixture(options);
    handlers.onPointerDown(event(180));
    handlers.onPointerUp(event(70, 100, 200));
    assert.deepEqual(actions, []);
  }
  for (const options of [
    { control: { matches: (selector) => selector === '.dock-expand' } },
    { video: { controls: true, getBoundingClientRect: () => ({ bottom: 250 }) } }
  ]) {
    const { handlers, event, actions } = mediaSwipeFixture(options);
    handlers.onPointerDown(event(180));
    handlers.onPointerUp(event(70, 100, 200));
    assert.deepEqual(actions, ['next']);
  }
});

test('touch dragging recognizes playlist grips, names and song grips but not other controls', () => {
  for (const selector of ['.library-entry-drag', '.library-entry-select', '.song-drag']) {
    const draggable = {};
    const handle = { disabled: false, closest: () => draggable };
    const event = { touches: [{}], target: { closest: (selectors) => selectors.split(', ').includes(selector) ? handle : null } };
    assert.equal(controls.findTouchDraggable(event), draggable);
    handle.disabled = true;
    assert.equal(controls.findTouchDraggable(event), undefined);
    handle.disabled = false;
    handle.closest = () => null;
    assert.equal(controls.findTouchDraggable(event), undefined);
  }
  assert.equal(controls.findTouchDraggable({ touches: [{}], target: { closest: () => null } }), undefined);
  assert.equal(controls.findTouchDraggable({ touches: [{}, {}] }), undefined);
});

test('drop targets accept allowed drags and remove insertion markers when leaving the row', () => {
  const target = { dataset: {}, contains: (element) => element === 'child' };
  let prevented = false;
  let stopped = false;
  const event = { currentTarget: target, dataTransfer: {},
    preventDefault: () => { prevented = true; }, stopPropagation: () => { stopped = true; } };
  controls.allowDrop(event, false);
  assert.equal(prevented, false);
  controls.allowDrop(event, true);
  assert.equal(prevented, true);
  assert.equal(stopped, true);
  assert.equal(event.dataTransfer.dropEffect, 'move');
  assert.equal(target.dataset.dragOver, 'true');
  target.dataset.dropPosition = 'after';
  controls.leaveDrop({ ...event, relatedTarget: 'child' });
  assert.equal(target.dataset.dropPosition, 'after');
  controls.leaveDrop({ ...event, relatedTarget: null });
  assert.deepEqual(target.dataset, {});
});