import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, CircleAlert, ExternalLink, RefreshCw, Share2, Trash2 } from 'lucide-react';

export function AdminMediaSharesView({ data, loading, error, deleting, onRefresh, onPage, onDelete }) {
  const busy = loading || Boolean(deleting);
  return <>
    <section className="page-heading admin-heading">
      <div><p className="eyebrow">Administration</p><h1>Shared links</h1></div>
      <button className="music-icon-button" type="button" title="Refresh shared links" aria-label="Refresh shared links" disabled={busy} onClick={onRefresh}>
        <RefreshCw size={20} className={loading ? 'spin' : undefined} />
      </button>
    </section>
    {error && <p className="notice error" role="alert"><CircleAlert size={16} />{error}</p>}
    <section className="admin-shares" aria-label="Generated shared links" aria-busy={busy}>
      <div className="section-title"><div><Share2 size={19} /><h2>All shared links</h2></div><strong>{data?.total ?? '-'}</strong></div>
      {loading && <p role="status">Loading shared links...</p>}
      {!loading && data?.total === 0 && <div className="empty-state compact"><Share2 size={30} /><h3>No shared links</h3></div>}
      {data?.shares.length > 0 && <ul className="admin-share-list">
        {data.shares.map((share) => <li key={share.id} className="admin-share-row">
          <div className="admin-share-song"><strong>{share.name}</strong>
            {share.kind === 'playlist' && <small>Playlist link</small>}
            {share.jobId && <a href={`/job/${encodeURIComponent(share.jobId)}`}><ExternalLink size={13} />{share.playlistTitle || share.jobId}</a>}
            <details><summary>Link ID</summary><code>{share.id}</code></details>
          </div>
          <div className="admin-share-creator"><span>Created by</span><strong>{share.creatorName || 'Deleted user'}</strong></div>
          <button className="music-icon-button admin-share-delete" type="button" disabled={busy}
            title={`Delete shared link for ${share.name}`} aria-label={`Delete shared link for ${share.name}`} onClick={() => onDelete(share)}>
            {deleting === share.id ? <RefreshCw size={18} className="spin" /> : <Trash2 size={18} />}
          </button>
        </li>)}
      </ul>}
      {data && <nav className="track-pagination" aria-label="Shared link pages">
        <span role="status">Page {data.page} of {data.totalPages}</span>
        <div><button className="music-icon-button" type="button" title="Previous page" aria-label="Previous shared links page" disabled={busy || data.page <= 1} onClick={() => onPage(data.page - 1)}><ChevronLeft size={18} /></button>
          <button className="music-icon-button" type="button" title="Next page" aria-label="Next shared links page" disabled={busy || data.page >= data.totalPages} onClick={() => onPage(data.page + 1)}><ChevronRight size={18} /></button></div>
      </nav>}
    </section>
  </>;
}

export default function AdminMediaShares({ request, confirm }) {
  const [data, setData] = useState(null);
  const [page, setPage] = useState(1);
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState('');
  const deletingRef = useRef(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    request(`/api/admin/media-shares?page=${page}`).then((result) => {
      if (active) setData(result);
    }).catch((loadError) => {
      if (active) setError(loadError.message);
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [request, page, revision]);

  async function remove(share) {
    if (deletingRef.current) return;
    deletingRef.current = true;
    try {
      if (!await confirm({ title: 'Delete shared link?', action: 'delete', label: 'Delete shared link',
        message: `Revoke the shared link for "${share.name}" created by ${share.creatorName || 'a deleted user'}? New playback and download requests through this link will stop working. ${share.kind === 'playlist' ? 'The playlist, its songs,' : 'The media file'} and other shared links will remain. Already downloaded copies cannot be revoked.` })) return;
      setDeleting(share.id);
      setError('');
      try { await request(`/api/admin/media-shares/${encodeURIComponent(share.id)}`, { method: 'DELETE' }); }
      catch (deleteError) { if (deleteError.status !== 404) throw deleteError; }
      setData(null);
      setLoading(true);
      setRevision((value) => value + 1);
    } catch (deleteError) { setError(deleteError.message); }
    finally { deletingRef.current = false; setDeleting(''); }
  }

  return <AdminMediaSharesView data={data} loading={loading} error={error} deleting={deleting}
    onRefresh={() => setRevision((value) => value + 1)} onPage={setPage} onDelete={remove} />;
}

export function AdminArtworkThumbnailsView({ status, starting = false, error = '', onRegenerate }) {
  const busy = starting || Boolean(status?.running);
  const message = starting ? 'Starting thumbnail regeneration...'
    : !status ? (error ? 'Thumbnail status unavailable. Retrying automatically...' : 'Loading thumbnail status...')
      : status.running ? 'Regenerating thumbnails...'
        : status.error ? 'Thumbnail regeneration failed.'
          : status.completedAt ? (status.failed ? 'Thumbnail regeneration completed with failures.' : 'Thumbnail regeneration completed.')
            : 'Ready to regenerate all thumbnails.';
  return <section className="users-section admin-artwork-thumbnails" aria-labelledby="admin-artwork-title">
    <div className="section-title"><div><span>03</span><h2 id="admin-artwork-title">Album artwork thumbnails</h2></div></div>
    <p>Regenerate all cached 192px AVIF images on disk. Original album artwork and media files remain unchanged.</p>
    <button className="primary-button compact-button" type="button" disabled={!status || busy} onClick={onRegenerate}>
      <RefreshCw size={16} className={busy ? 'spin' : undefined} />Regenerate all thumbnails
    </button>
    <div role="status" aria-live="polite" aria-atomic="true">
      <p>{message}</p>
      {status && <dl>
        <div><dt>Processed</dt><dd>{status.processed}</dd></div>
        <div><dt>Generated</dt><dd>{status.generated}</dd></div>
        <div><dt>Missing artwork</dt><dd>{status.missing}</dd></div>
        <div><dt>Failed</dt><dd>{status.failed}</dd></div>
      </dl>}
    </div>
    {status?.startedAt && <p>Started: <time dateTime={status.startedAt}>{new Date(status.startedAt).toLocaleString()}</time></p>}
    {status?.completedAt && <p>Completed: <time dateTime={status.completedAt}>{new Date(status.completedAt).toLocaleString()}</time></p>}
    {error && <p className="notice error" role="alert"><CircleAlert size={16} />{error}</p>}
    {status?.error && <p className="notice error" role="alert"><CircleAlert size={16} />{status.error}</p>}
  </section>;
}

export function watchArtworkThumbnails(request, onChange) {
  const endpoint = '/api/admin/artwork-thumbnails';
  let active = true;
  let revision = 0;
  let timer;
  let pendingRequest;
  let startError = '';
  let state = { status: null, starting: false, error: '' };
  const update = (changes) => { state = { ...state, ...changes }; onChange(state); };
  const schedule = () => { timer = setTimeout(poll, 2000); };

  async function poll() {
    const version = revision;
    pendingRequest = new AbortController();
    try {
      const status = await request(endpoint, { signal: pendingRequest.signal });
      if (active && version === revision) update({ status, error: startError });
    } catch (error) {
      if (active && version === revision) update({ status: null, error: error.message || 'Unable to load thumbnail status.' });
    } finally {
      if (active && version === revision) schedule();
    }
  }

  update({});
  void poll();
  return {
    async start() {
      if (!active || state.starting || !state.status || state.status.running) return;
      // Ignore a pre-start poll even if its response arrives after the POST.
      revision++;
      clearTimeout(timer);
      pendingRequest?.abort();
      pendingRequest = new AbortController();
      startError = '';
      update({ starting: true, error: '' });
      try {
        const status = await request(endpoint, { method: 'POST', signal: pendingRequest.signal });
        if (active) update({ status });
      } catch (error) {
        if (active) {
          startError = error.status === 409 ? '' : (error.message || 'Unable to start thumbnail regeneration.');
          update({ status: null, error: startError });
        }
      } finally {
        if (active) {
          update({ starting: false });
          if (state.status) schedule();
          else void poll();
        }
      }
    },
    stop() {
      active = false;
      clearTimeout(timer);
      pendingRequest?.abort();
    }
  };
}

export function AdminArtworkThumbnails({ request }) {
  const [state, setState] = useState({ status: null, starting: false, error: '' });
  const monitor = useRef(null);
  useEffect(() => {
    const watcher = watchArtworkThumbnails(request, setState);
    monitor.current = watcher;
    return () => { monitor.current = null; watcher.stop(); };
  }, [request]);
  return <AdminArtworkThumbnailsView {...state} onRegenerate={() => monitor.current?.start()} />;
}