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
  for (const status of ['running', 'completed', 'failed', 'partially_completed']) {
    const badge = renderToStaticMarkup(createElement(StatusBadge, { status, queuePosition: 2 }));
    assert.ok(!badge.includes('Current Position'));
    assert.ok(badge.includes(status.replaceAll('_', ' ')));
  }
  assert.ok(!renderToStaticMarkup(createElement(StatusBadge, { status: 'queued' })).includes('#undefined'));
  const render = (props) => renderToStaticMarkup(createElement(AdminJobQueue, props));
  assert.match(render({ data: null }), /Loading job queue/);
  const unavailable = render({ data: null, error: 'Offline' });
  assert.match(unavailable, /role="alert"/);
  assert.match(unavailable, /Queue status unavailable: Offline/);
  assert.ok(!unavailable.includes('Loading job queue'));
  const empty = render({ data: { running: null, queued: [] } });
  assert.match(empty, /No jobs running/);
  assert.match(empty, /No jobs queued/);

  const job = { id: 'first', url: 'https://music.youtube.com/playlist?list=first', playlistTitle: 'Running collection',
    status: 'running', isPlaylist: true, playlistSongCount: 101, downloadType: 'audio',
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
  const hidden = render({ data: { running: null, queued: [{ hidden: true, status: 'queued', queuePosition: 1 }] } });
  assert.match(hidden, /Private job/);
  assert.match(hidden, /Queued - Current Position #1/);
  assert.ok(!hidden.includes('href="/job/'));
  assert.ok(!hidden.includes('Submitted by'));
  assert.match(render({ data: { ...data, maintenance: true } }), /Runtime maintenance in progress/);
  assert.match(render({ data: { ...data, rateLimit: { limited: true, message: 'Downloads paused' } } }), /Downloads paused/);
});