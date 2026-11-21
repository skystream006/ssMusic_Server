import { useEffect, useId, useRef, useState } from 'react';
import { Plus, RefreshCw, Save, X } from 'lucide-react';
import { submitJobUrl } from './jobSubmission.js';
import { songKey } from '../../src/library.js';
import { sortSelectOptions } from './selectOptions.js';

export async function saveQueuePlaylist(request, job, tracks, parentId) {
  const library = await request('/api/library/links', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId: job.id })
  });
  const unique = [...new Map(tracks.map((track) => [songKey(track), track])).values()];
  return request(`/api/library/playlists/${encodeURIComponent(job.id)}/queue`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      version: library.version, parentId, keys: unique.map(songKey)
    })
  });
}

export default function AddPlaylistDialog({ user, request, confirm, onAdded, onClose, tracks = null }) {
  const dialogRef = useRef(null);
  const createdJob = useRef(null);
  const headingId = useId();
  const nameId = useId();
  const urlId = useId();
  const folderId = useId();
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [parentId, setParentId] = useState('');
  const [folders, setFolders] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [revision, setRevision] = useState(0);
  const savingQueue = tracks !== null;
  const title = savingQueue ? 'Save As New Playlist' : 'Add Playlist';

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    dialog.showModal();
    dialog.querySelector('input').focus();
    return () => { dialog.close(); if (previousFocus?.isConnected) previousFocus.focus(); };
  }, []);

  useEffect(() => {
    if (!savingQueue) return;
    let active = true;
    request('/api/library').then((library) => {
      if (!active) return;
      const entries = new Map(library.entries.map((entry) => [entry.id, entry]));
      const path = (folder) => folder.parentId ? `${path(entries.get(folder.parentId))} / ${folder.name}` : folder.name;
      setFolders(library.entries.filter((entry) => entry.type === 'folder').map((folder) => ({ ...folder, path: path(folder) })));
      setLoadError('');
    }).catch((requestError) => { if (active) setLoadError(requestError.message); });
    return () => { active = false; };
  }, [savingQueue, request, revision]);

  async function submit(event) {
    event.preventDefault();
    if (busy || (savingQueue && (!folders || !tracks.length))) return;
    setBusy(true);
    setError('');
    try {
      const result = createdJob.current ? { job: createdJob.current } : url.trim()
        ? await submitJobUrl(url, { request, user, confirm, library: true })
        : await request('/api/library/playlists', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ playlistTitle: name.trim() })
        });
      if (result) {
        if (savingQueue) {
          createdJob.current = result.job;
          await saveQueuePlaylist(request, result.job, tracks, parentId || null);
        }
        await onAdded?.(result.job);
        onClose();
      }
    } catch (submitError) {
      setError(createdJob.current
        ? `Playlist created, but the queue could not be saved: ${submitError.message} Retry to finish saving to the same playlist.`
        : submitError.message);
    } finally { setBusy(false); }
  }

  return <dialog ref={dialogRef} className="confirmation-dialog folder-dialog" aria-labelledby={headingId}
    onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <form onSubmit={submit}>
      <div className="folder-dialog-heading"><h2 id={headingId}>{title}</h2><button className="music-icon-button" type="button" title="Close" aria-label={`Close ${title}`} disabled={busy} onClick={onClose}><X size={18} /></button></div>
      <label htmlFor={nameId}>Playlist name</label><input id={nameId} required={!url.trim()} autoFocus maxLength={200} value={name} disabled={busy || Boolean(url.trim()) || Boolean(createdJob.current)} onChange={(event) => setName(event.target.value)} />
      {savingQueue ? <>
        <label htmlFor={folderId}>Destination folder</label>
        <select id={folderId} value={parentId} disabled={busy || !folders} onChange={(event) => setParentId(event.target.value)}>
          <option value="">{folders ? 'Library root' : 'Loading folders...'}</option>
          {sortSelectOptions(folders || [], (folder) => folder.path).map((folder) => <option key={folder.id} value={folder.id}>{folder.path}</option>)}
        </select>
        <p>{tracks.length} queued tracks. Source files and the queue are unchanged.</p>
      </> : <>
        <label htmlFor={urlId}>YouTube Music URL (optional)</label><input id={urlId} type="url" value={url} disabled={busy} placeholder="https://music.youtube.com/..." onChange={(event) => setUrl(event.target.value)} />
      </>}
      {(error || loadError) && <p className="notice error" role="alert">{error || loadError}</p>}
      <div className="dialog-actions"><button className="secondary-button" type="button" disabled={busy} onClick={onClose}>Cancel</button>
        {loadError && <button className="secondary-button" type="button" disabled={busy} onClick={() => { setLoadError(''); setRevision((value) => value + 1); }}><RefreshCw size={17} />Retry</button>}
        <button className="primary-button" type="submit" disabled={busy || (!url.trim() && !name.trim()) || (savingQueue && (!folders || !tracks.length))}>
          {busy ? <RefreshCw className="spin" size={17} /> : savingQueue ? <Save size={17} /> : <Plus size={17} />}{busy ? savingQueue ? 'Saving...' : 'Adding...' : title}</button></div>
    </form>
  </dialog>;
}
