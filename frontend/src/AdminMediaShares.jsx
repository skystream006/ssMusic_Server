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
            <a href={`/job/${encodeURIComponent(share.jobId)}`}><ExternalLink size={13} />{share.playlistTitle || share.jobId}</a>
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
        message: `Revoke the shared link for "${share.name}" created by ${share.creatorName || 'a deleted user'}? New playback and download requests through this link will stop working. The media file and other shared links will remain. Already downloaded copies cannot be revoked.` })) return;
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