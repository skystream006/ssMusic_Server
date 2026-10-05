import { useEffect, useId, useRef, useState } from 'react';
import { ListPlus, RefreshCw, X } from 'lucide-react';
import { sortSelectOptions } from './selectOptions.js';

export default function JobPlaylistDialog({ job, request, onClose, onAdded }) {
  const dialogRef = useRef(null);
  const headingId = useId();
  const destinationId = useId();
  const [library, setLibrary] = useState(null);
  const [destination, setDestination] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const playlists = (library?.playlists || []).filter((playlist) => playlist.id !== job.id);

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    dialog.showModal();
    return () => { dialog.close(); if (previousFocus?.isConnected) previousFocus.focus(); };
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    request('/api/library').then((result) => {
      if (!active) return;
      const options = result.playlists.filter((playlist) => playlist.id !== job.id);
      setLibrary(result);
      setDestination((current) => options.some((playlist) => playlist.id === current) ? current : options[0]?.id || '');
    }).catch((loadError) => { if (active) setError(loadError.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [job.id, request, revision]);

  async function submit(event) {
    event.preventDefault();
    if (saving || loading || !library || !destination) return;
    setSaving(true);
    setError('');
    try {
      const result = await request('/api/library/jobs/add', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: library.version, jobId: job.id, playlistId: destination })
      });
      onAdded(result.addedCount, playlists.find((playlist) => playlist.id === destination)?.playlistTitle || destination);
    } catch (saveError) {
      setError(saveError.message);
      if (saveError.status === 409 || saveError.status === 400) {
        setLibrary(null);
        setRevision((current) => current + 1);
      }
    } finally { setSaving(false); }
  }

  return <dialog ref={dialogRef} className="confirmation-dialog folder-dialog" aria-labelledby={headingId}
    onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); if (!saving) onClose(); } }}
    onCancel={(event) => { event.preventDefault(); if (!saving) onClose(); }}>
    <form onSubmit={submit}>
      <div className="folder-dialog-heading"><h2 id={headingId}>Add all files to playlist</h2>
        <button className="music-icon-button" type="button" title="Close" aria-label="Close add files" disabled={saving} onClick={onClose}><X size={18} /></button></div>
      <p>{job.playlistTitle || job.id}</p>
      <label htmlFor={destinationId}>Playlist</label>
      <select id={destinationId} value={destination} required disabled={loading || saving || !playlists.length} onChange={(event) => setDestination(event.target.value)}>
        {loading ? <option value="">Loading playlists...</option> : !playlists.length && <option value="">No other playlists</option>}
        {!loading && sortSelectOptions(playlists, (playlist) => playlist.playlistTitle || playlist.id)
          .map((playlist) => <option key={playlist.id} value={playlist.id}>{playlist.playlistTitle || playlist.id}</option>)}
      </select>
      {loading && <p className="sr-only" role="status">Loading playlists</p>}
      {error && <p className="notice error" role="alert">{error}</p>}
      <div className="dialog-actions">
        <button className="secondary-button" type="button" disabled={saving} onClick={onClose}>Cancel</button>
        {!loading && !library && <button className="secondary-button" type="button" onClick={() => { setError(''); setRevision((current) => current + 1); }}><RefreshCw size={17} />Retry</button>}
        <button className="primary-button" type="submit" disabled={loading || saving || !destination || !library}>
          {saving ? <RefreshCw className="spin" size={17} /> : <ListPlus size={17} />}{saving ? 'Adding...' : 'Add all files'}
        </button>
      </div>
    </form>
  </dialog>;
}