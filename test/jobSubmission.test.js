import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { submitJobUrl } from '../frontend/src/jobSubmission.js';

test('job submission sends the chosen format and metadata-only flag, defaulting to audio', async () => {
  for (const downloadType of [undefined, 'audio', 'video']) {
    const job = { id: 'created' };
    const result = await submitJobUrl(' https://youtu.be/video ', {
      downloadType, metadataOnly: true,
      request: async (url, options) => {
        assert.equal(url, '/api/jobs');
        assert.equal(options.method, 'POST');
        assert.deepEqual(JSON.parse(options.body), {
          url: 'https://youtu.be/video', metadataOnly: true, downloadType: downloadType || 'audio'
        });
        return job;
      }
    });
    assert.deepEqual(result, { job, created: true });
  }
});

test('admin live output is admin-only and its full-screen dialog has accessible controls', async (context) => {
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  context.after(() => server.close());
  const { default: LiveJobOutput, LiveOutputDialog } = await server.ssrLoadModule('/src/LiveJobOutput.jsx');
  const job = { id: 'live', status: 'running', playlistTitle: '<Streaming collection>' };
  const request = async () => { throw new Error('Rendering must not fetch output'); };
  for (const role of ['user', 'shared', undefined]) {
    assert.equal(renderToStaticMarkup(createElement(LiveJobOutput, { job, user: { role }, request })), '');
  }
  const button = renderToStaticMarkup(createElement(LiveJobOutput, { job, user: { role: 'admin' }, request }));
  assert.match(button, /Live output/);
  assert.match(button, /aria-haspopup="dialog"/);
  assert.match(button, /aria-expanded="false"/);
  assert.ok(!button.includes('<dialog'));
  const dialog = renderToStaticMarkup(createElement(LiveOutputDialog, { job, request, onClose() {} }));
  assert.match(dialog, /<dialog[^>]*class="confirmation-dialog live-output-dialog"[^>]*aria-labelledby=/);
  assert.match(dialog, /aria-modal="true"/);
  assert.match(dialog, /&lt;Streaming collection&gt;/);
  assert.match(dialog, /aria-label="Close live output"/);
  assert.match(dialog, /type="checkbox" checked=""/);
  assert.match(dialog, /Follow output/);
  assert.match(dialog, /aria-label="Process output"/);
  assert.match(dialog, /Connecting to job output/);
});

test('queued job badges and the admin queue view show positions, ordering and operational states', async (context) => {
  const server = await createServer({ server: { middlewareMode: true }, appType: 'custom' });
  context.after(() => server.close());
  const { default: StatusBadge } = await server.ssrLoadModule('/src/StatusBadge.jsx');
  const { default: AdminJobQueue } = await server.ssrLoadModule('/src/AdminJobQueue.jsx');
  for (const queuePosition of [1, 2, 1234]) {
    const badge = renderToStaticMarkup(createElement(StatusBadge, { status: 'queued', queuePosition }));
    assert.match(badge, new RegExp(`Queued - Current Position #${queuePosition}`));
    assert.match(badge, /status-queued/);
  }
  for (const status of ['running', 'completed', 'failed', 'partially_completed', 'stopped']) {
    const badge = renderToStaticMarkup(createElement(StatusBadge, { status, queuePosition: 2 }));
    assert.ok(!badge.includes('Current Position'));
    assert.ok(badge.includes(status.replaceAll('_', ' ')));
  }
  assert.ok(!renderToStaticMarkup(createElement(StatusBadge, { status: 'queued' })).includes('#undefined'));
  for (const [status, completed] of [['running', 0], ['running', 12], ['completed', 101], ['failed', 12]]) {
    const badge = renderToStaticMarkup(createElement(StatusBadge, { status, commandProgress: { completed, total: 101 } }));
    assert.ok(badge.includes(`Commands: ${completed} / 101`));
  }
  for (const commandProgress of [undefined, {}, { completed: -1, total: 101 }, { completed: 102, total: 101 }, { completed: 0, total: 0 }]) {
    assert.ok(!renderToStaticMarkup(createElement(StatusBadge, { status: 'running', commandProgress })).includes('Commands:'));
  }
  assert.ok(!renderToStaticMarkup(createElement(StatusBadge, { status: 'queued', commandProgress: { completed: 12, total: 101 } })).includes('Commands:'));
  const pausedUntil = '2026-10-28T13:05:00Z';
  const pausedBadge = renderToStaticMarkup(createElement(StatusBadge, { status: 'running', pausedUntil }));
  assert.match(pausedBadge, /status-paused/);
  assert.match(pausedBadge, /Paused - Rate limit/);
  assert.ok(!pausedBadge.includes('status-running'));
  assert.ok(!renderToStaticMarkup(createElement(StatusBadge, { status: 'failed', pausedUntil })).includes('status-paused'));
  const stopped = renderToStaticMarkup(createElement(StatusBadge, { status: 'stopped', pausedUntil, commandProgress: { completed: 12, total: 101 } }));
  assert.match(stopped, /status-stopped/);
  assert.match(stopped, /Commands: 12 \/ 101/);
  assert.ok(!stopped.includes('status-paused'));
  const render = (props) => renderToStaticMarkup(createElement(AdminJobQueue, props));
  assert.match(render({ data: null }), /Loading job queue/);
  const unavailable = render({ data: null, error: 'Offline' });
  assert.match(unavailable, /role="alert"/);
  assert.match(unavailable, /Queue status unavailable: Offline/);
  assert.ok(!unavailable.includes('Loading job queue'));
  const empty = render({ data: { running: null, queued: [] } });
  assert.match(empty, /<h1>Jobs Queue<\/h1>/);
  assert.match(empty, /No jobs running/);
  assert.match(empty, /No jobs queued/);

  const job = { id: 'first', url: 'https://music.youtube.com/playlist?list=first', playlistTitle: 'Running collection',
    status: 'running', isPlaylist: true, playlistSongCount: 101, downloadType: 'audio',
    commandProgress: { completed: 12, total: 101 },
    initiatedBy: { name: 'Owner' }, updatedAt: '2026-10-28T12:00:00Z' };
  const data = { running: job, queued: [
    { ...job, id: 'second', playlistTitle: 'Second collection', status: 'queued', queuePosition: 1 },
    { ...job, id: 'third', playlistTitle: 'Third collection', initiatedBy: null, status: 'queued', queuePosition: 2, metadataOnly: true }
  ] };
  const populated = render({ data });
  assert.ok(populated.indexOf('Running collection') < populated.indexOf('Second collection'));
  assert.ok(populated.indexOf('Second collection') < populated.indexOf('Third collection'));
  assert.match(populated, /Queued - Current Position #1/);
  assert.match(populated, /Queued - Current Position #2/);
  assert.match(populated, /href="\/job\/second"/);
  assert.match(populated, /101 items/);
  assert.match(populated, /Owner/);
  assert.match(populated, /Unknown/);
  assert.match(populated, /Metadata only/);
  assert.match(populated, /aria-label="Refresh job queue"/);
  assert.match(populated, /Commands: 12 \/ 101/);
  assert.equal((populated.match(/job-command-progress/g) || []).length, 1);
  const stoppable = render({ data, onStop() {}, stoppingId: 'first' });
  for (const id of ['first', 'second', 'third']) assert.match(stoppable, new RegExp(`aria-label="Stop job ${id}" disabled=""`));
  const paused = render({ data: { ...data, running: { ...job, pausedUntil } } });
  assert.match(paused, /Paused job/);
  assert.match(paused, /Paused - Rate limit/);
  assert.match(paused, /Resumes <time/);
  assert.match(paused, /Queued - Current Position #1/);
  assert.match(paused, /Commands: 12 \/ 101/);
  const hiddenPaused = render({ data: { running: { hidden: true, status: 'running', pausedUntil }, queued: [] } });
  assert.match(hiddenPaused, /Private job/);
  assert.match(hiddenPaused, /Paused - Rate limit/);
  assert.ok(!hiddenPaused.includes('href="/job/'));
  assert.ok(!hiddenPaused.includes('Submitted by'));
  assert.ok(!hiddenPaused.includes('Commands:'));
  const hiddenStop = render({ data: { running: { hidden: true, status: 'running' }, queued: [] }, onStop() {} });
  assert.ok(!hiddenStop.includes('Stop job'));
  const hidden = render({ data: { running: null, queued: [{ hidden: true, status: 'queued', queuePosition: 1 }] } });
  assert.match(hidden, /Private job/);
  assert.match(hidden, /Queued - Current Position #1/);
  assert.ok(!hidden.includes('href="/job/'));
  assert.ok(!hidden.includes('Submitted by'));
  assert.match(render({ data: { ...data, maintenance: true } }), /Runtime maintenance in progress/);
  assert.match(render({ data: { ...data, rateLimit: { limited: true, message: 'Downloads paused' } } }), /Downloads paused/);
});