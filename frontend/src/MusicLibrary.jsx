import { useEffect, useId, useRef, useState } from 'react';
import { ArrowRightLeft, CalendarClock, Check, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, Download, ExternalLink, Folder, FolderOpen, FolderPlus, GripVertical, Library, Link, ListChecks, ListMusic, LockKeyhole, Music2, Pencil, Plus, RefreshCw, Save, Search, Trash2, X } from 'lucide-react';
import MusicPlayer, { replaceSongFile, usePlayback } from './MusicPlayer.jsx';
import ImportMusic from './ImportMusic.jsx';
import { Upload } from 'lucide-react';
import { getPlaylistIds, songKey } from '../../src/library.js';
import { submitJobUrl } from './jobSubmission.js';
import { canManageJob, canModifyJob, formatBytes, MetadataDialog, ReplaceFileDialog, ShareMediaDialog, TranscriptionDialog, useTranscriptionService } from './SongActions.jsx';
import { allowDrop, leaveDrop } from './touchControls.js';
import { replaceURL } from './navigation.js';

export function ExportLibraryDialog({ request, onClose }) {
  const dialogRef = useRef(null);
  const headingId = useId();
  const formatId = useId();
  const destinationId = useId();
  const instructionsId = useId();
  const destinationHelpId = useId();
  const downloadHelpId = useId();
  const [format, setFormat] = useState('itunes');
  const [destination, setDestination] = useState('');
  const [view, setView] = useState('export');
  const [source, setSource] = useState('new');
  const [status, setStatus] = useState(null);
  const [enabled, setEnabled] = useState(false);
  const [frequency, setFrequency] = useState('daily');
  const [time, setTime] = useState('03:00');
  const [weekday, setWeekday] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [notice, setNotice] = useState('');
  const pendingExport = useRef(false);
  const operation = useRef(0);
  const mounted = useRef(false);
  const settingsNeeded = view === 'schedule' ? enabled : source === 'new';
  const locked = busy || !status;
  const running = status?.running;
  const latest = status?.latest;
  const tabsId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    dialog.showModal();
    dialog.querySelector('select').focus();
    const closeOnEscape = (event) => { if (event.key === 'Escape') { event.preventDefault(); onClose(); } };
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('keydown', closeOnEscape);
      dialog.close();
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  useEffect(() => {
    let active = true;
    let timer;
    let initialized = false;
    mounted.current = true;
    async function load() {
      const revision = operation.current;
      try {
        const result = await request('/api/library/backup');
        if (!active || revision !== operation.current) return;
        setStatus(result);
        setLoadError('');
        if (!initialized) {
          initialized = true;
          setEnabled(result.schedule.enabled);
          setFrequency(result.schedule.frequency || 'daily');
          setTime(result.schedule.time || '03:00');
          setWeekday(result.schedule.weekday || 0);
          setFormat(result.schedule.format || result.latest?.format || 'itunes');
          setDestination(result.schedule.destination || result.latest?.destination || '');
          setSource(result.latest ? 'latest' : 'new');
        }
        if (pendingExport.current && !result.running) {
          pendingExport.current = false;
          if (!result.error && result.latest) { setSource('latest'); setNotice('Export ready.'); }
        }
      } catch (requestError) { if (active) setLoadError(requestError.message); }
      finally { if (active) timer = setTimeout(load, 3000); }
    }
    void load();
    return () => { active = false; mounted.current = false; clearTimeout(timer); };
  }, [request]);

  async function mutate(endpoint, body, exporting = false) {
    if (busy || !status) return;
    operation.current += 1;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await request(endpoint, { method: endpoint.endsWith('/schedule') ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!mounted.current) return;
      setStatus(result);
      pendingExport.current = exporting;
      if (endpoint.endsWith('/schedule')) setNotice('Schedule saved.');
    } catch (saveError) { if (mounted.current) setError(saveError.message); }
    finally { operation.current += 1; if (mounted.current) setBusy(false); }
  }

  function submit(event) {
    if (view === 'export' && source === 'latest') return;
    event.preventDefault();
    if (view === 'schedule') void mutate('/api/library/backup/schedule', { enabled, frequency, time, weekday, format, destination });
    else void mutate('/api/library/backup', { format, destination }, true);
  }

  return <dialog ref={dialogRef} className="confirmation-dialog folder-dialog export-library-dialog" aria-labelledby={headingId}
    onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <form action="/api/library/export" method="get" target="_blank" rel="noopener" onSubmit={submit}>
      <div className="folder-dialog-heading"><h2 id={headingId}>Export library</h2>
        <button className="music-icon-button" type="button" title="Close" aria-label="Close export library" onClick={onClose}><X size={18} /></button></div>
      <div className="lyrics-tabs backup-tabs" role="tablist" aria-label="Library export and backups">
        {['export', 'schedule'].map((tab) => <button key={tab} id={`${tabsId}-${tab}`} type="button" role="tab" aria-selected={view === tab}
          aria-controls={`${tabsId}-panel`} tabIndex={view === tab ? 0 : -1}
          onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === 'Home' ? 'export' : event.key === 'End' ? 'schedule' : view === 'export' ? 'schedule' : 'export';
            setView(next);
            setNotice('');
            dialogRef.current.querySelector(`[id="${tabsId}-${next}"]`).focus();
          }} onClick={() => { setView(tab); setNotice(''); }}>
          {tab === 'export' ? <Download size={16} /> : <CalendarClock size={16} />}{tab === 'export' ? 'Export' : 'Schedule'}</button>)}
      </div>
      <div id={`${tabsId}-panel`} role="tabpanel" aria-labelledby={`${tabsId}-${view}`}>
      {!status && !loadError && <p role="status">Loading backup...</p>}
      {latest && <dl className="backup-summary"><dt>Latest backup</dt><dd>{new Date(latest.createdAt).toLocaleString()}</dd>
        <dt>Format</dt><dd>{latest.format === 'itunes' ? 'iTunes XML' : 'Android M3U8'}</dd>
        <dt>Size</dt><dd>{formatBytes(latest.sizeBytes)}</dd>
        {latest.destination && <><dt>Extraction folder</dt><dd>{latest.destination}</dd></>}</dl>}
      {status && !latest && <p>No backup yet.</p>}
      {running && <p className="backup-progress" role="status"><RefreshCw className="spin" size={17} />Creating backup...</p>}
      {view === 'export' ? <>
        <label htmlFor={`${tabsId}-source`}>Export source</label>
        <select id={`${tabsId}-source`} name="source" value={source} disabled={locked} onChange={(event) => { setSource(event.target.value); setNotice(''); }}>
          <option value="latest" disabled={!latest}>Latest export (backup)</option><option value="new">New export</option>
        </select>
      </> : <>
        <label className="backup-enabled"><input type="checkbox" checked={enabled} disabled={locked} onChange={(event) => setEnabled(event.target.checked)} />Scheduled backups</label>
        {enabled && <div className="backup-schedule-fields">
          <label>Frequency<select value={frequency} disabled={locked} onChange={(event) => setFrequency(event.target.value)}><option value="daily">Daily</option><option value="weekly">Weekly</option></select></label>
          {frequency === 'weekly' && <label>Day<select value={weekday} disabled={locked} onChange={(event) => setWeekday(Number(event.target.value))}>
            {['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((day, index) => <option key={day} value={index}>{day}</option>)}
          </select></label>}
          <label>Time (UTC)<input type="time" required value={time} disabled={locked} onChange={(event) => setTime(event.target.value)} /></label>
        </div>}
        {status?.nextRunAt && <p>Next backup: {new Date(status.nextRunAt).toLocaleString()} (local time)</p>}
      </>}
      <fieldset className="backup-format-fields" hidden={!settingsNeeded} disabled={!settingsNeeded || locked}>
      <label htmlFor={formatId}>Export format</label>
      <select id={formatId} name="format" value={format} aria-describedby={instructionsId} onChange={(event) => setFormat(event.target.value)}>
        <option value="itunes">iTunes XML</option>
        <option value="android">Android M3U8 (compatible players)</option>
      </select>
      <div id={instructionsId}>
        <p>Download a ZIP of your library. Song order within each playlist is retained.</p>
        <p hidden={format !== 'itunes'}>Extract the ZIP directly into the destination folder below, so <strong>Music/</strong> and <strong>Library.xml</strong> are at its root.
          Add the Music folder to your app library first, then use <strong>File &gt; Library &gt; Import Playlist</strong> to import Library.xml in iTunes or Music.</p>
        <p hidden={format !== 'android'}>Extract the whole ZIP and keep the root <strong>.m3u8</strong> playlists beside the <strong>Music/</strong> folder.
          Transfer that folder together to your Android device and open the playlists in a player supporting UTF-8 M3U8 with relative paths.
          This does not import into a universal Android system music database.</p>
      </div>
      <div hidden={format !== 'itunes'}>
        <label htmlFor={destinationId}>Absolute extraction folder on your computer</label>
        <input id={destinationId} name="destination" type="text" required={format === 'itunes'} disabled={format !== 'itunes'}
          value={destination} onChange={(event) => setDestination(event.target.value)}
          pattern={String.raw`(?:[A-Za-z]:(?:\\|/)|/(?!/))[^\r\n]*`} aria-describedby={destinationHelpId}
          title="Enter an absolute local path, such as C:\Users\YourName\Music\Export or /Users/YourName/Music/Export. File URLs and network paths are not supported."
          placeholder={'C:\\Users\\YourName\\Music\\Export or /Users/YourName/Music/Export'} />
        <p id={destinationHelpId}>Enter the Windows drive path or macOS absolute path where you will extract the ZIP, not a server path or the Music subfolder.
          This is used to generate the correct file URLs in Library.xml; it does not select or create a folder.
          Do not use file URLs or UNC/network paths. If you move the extracted folder later, export again with the new destination.</p>
      </div>
      </fieldset>
      </div>
      {(error || loadError || status?.error) && <p className="notice error" role="alert">{error || loadError || status.error}</p>}
      {notice && <p role="status">{notice}</p>}
      <p id={downloadHelpId} hidden={view !== 'export' || source !== 'latest'}>Your browser downloads the ZIP directly. Export errors open in a separate tab; check that tab if no download starts.</p>
      <div className="dialog-actions"><button className="secondary-button" type="button" onClick={onClose}>Cancel</button>
        {view === 'schedule' && <button className="secondary-button" type="button" disabled={locked || running || !enabled}
          onClick={(event) => { if (event.currentTarget.form.reportValidity()) void mutate('/api/library/backup', { format, destination }); }}><Save size={17} />Back up now</button>}
        <button className="primary-button" type="submit" aria-describedby={view === 'export' && source === 'latest' ? downloadHelpId : undefined}
          disabled={locked || (view === 'export' && (source === 'new' ? running : !latest))}>
          {busy ? <RefreshCw className="spin" size={17} /> : view === 'schedule' ? <Save size={17} /> : <Download size={17} />}
          {view === 'schedule' ? 'Save schedule' : source === 'latest' ? 'Download ZIP' : 'Create export'}</button></div>
    </form>
  </dialog>;
}

function AddPlaylistDialog({ user, request, confirm, onAdded, onClose }) {
  const dialogRef = useRef(null);
  const headingId = useId();
  const urlId = useId();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    dialog.showModal();
    dialog.querySelector('input').focus();
    return () => { dialog.close(); if (previousFocus?.isConnected) previousFocus.focus(); };
  }, []);

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await submitJobUrl(url, { request, user, confirm, library: true });
      if (result) { await onAdded(result.job); onClose(); }
    } catch (submitError) { setError(submitError.message); }
    finally { setBusy(false); }
  }

  return <dialog ref={dialogRef} className="confirmation-dialog folder-dialog" aria-labelledby={headingId}
    onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <form onSubmit={submit}>
      <div className="folder-dialog-heading"><h2 id={headingId}>Add Playlist</h2><button className="music-icon-button" type="button" title="Close" aria-label="Close Add Playlist" disabled={busy} onClick={onClose}><X size={18} /></button></div>
      <label htmlFor={urlId}>YouTube Music URL</label><input id={urlId} type="url" required autoFocus value={url} disabled={busy} placeholder="https://music.youtube.com/..." onChange={(event) => setUrl(event.target.value)} />
      {error && <p className="notice error" role="alert">{error}</p>}
      <div className="dialog-actions"><button className="secondary-button" type="button" disabled={busy} onClick={onClose}>Cancel</button>
        <button className="primary-button" type="submit" disabled={busy || !url.trim()}>{busy ? <RefreshCw className="spin" size={17} /> : <Plus size={17} />}{busy ? 'Adding...' : 'Add Playlist'}</button></div>
    </form>
  </dialog>;
}

function LibraryDestinationDialog({ title, summary, label, destinations, folder = false, onSave, onClose }) {
  const dialogRef = useRef(null);
  const headingId = useId();
  const destinationId = useId();
  const [destination, setDestination] = useState(folder ? '' : destinations[0]?.id || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    dialog.showModal();
    dialog.querySelector('select').focus();
    return () => { dialog.close(); if (previousFocus?.isConnected) previousFocus.focus(); };
  }, []);
  return <dialog ref={dialogRef} className="confirmation-dialog folder-dialog" aria-labelledby={headingId}
    onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); if (!busy) onClose(); } }}
    onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <form onSubmit={async (event) => {
      event.preventDefault();
      if (busy || (!folder && !destination)) return;
      setBusy(true);
      const result = await onSave(destination || null);
      if (result === true) onClose(); else setError(result || 'Unable to save selection.');
      setBusy(false);
    }}>
      <div className="folder-dialog-heading"><h2 id={headingId}>{title}</h2><button className="music-icon-button" type="button" title="Close" aria-label={`Close ${title.toLowerCase()}`} disabled={busy} onClick={onClose}><X size={18} /></button></div>
      <p>{summary}</p>
      <label htmlFor={destinationId}>Destination {folder ? 'folder' : 'playlist'}</label><select id={destinationId} required={!folder} value={destination} disabled={busy || (!folder && !destinations.length)} onChange={(event) => setDestination(event.target.value)}>
        {folder ? <option value="">Library</option> : !destinations.length && <option value="">No other playlists</option>}
        {destinations.map((destination) => <option key={destination.id} value={destination.id}>{destination.title}</option>)}
      </select>
      {error && <p className="notice error" role="alert">{error}</p>}
      <div className="dialog-actions"><button className="secondary-button" type="button" disabled={busy} onClick={onClose}>Cancel</button>
        <button className="primary-button" type="submit" disabled={busy || (!folder && !destination)}>{busy ? <RefreshCw className="spin" size={17} /> : label.startsWith('Link') ? <Link size={17} /> : <ArrowRightLeft size={17} />}{label}</button></div>
    </form>
  </dialog>;
}

function RenamePlaylistDialog({ playlist, saving, onSave, onClose }) {
  const dialogRef = useRef(null);
  const headingId = useId();
  const nameId = useId();
  const [name, setName] = useState(playlist.playlistTitle || '');
  const [error, setError] = useState('');

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    dialog.showModal();
    dialog.querySelector('input').select();
    return () => { dialog.close(); if (previousFocus?.isConnected) previousFocus.focus(); };
  }, []);

  return <dialog ref={dialogRef} className="confirmation-dialog folder-dialog" aria-labelledby={headingId}
    onCancel={(event) => { event.preventDefault(); if (!saving) onClose(); }}>
    <form onSubmit={async (event) => {
      event.preventDefault();
      if (saving || !name.trim()) return;
      setError('');
      const result = await onSave(playlist.id, name.trim());
      if (result === true) onClose(); else setError(result || 'Unable to rename playlist.');
    }}>
      <div className="folder-dialog-heading"><h2 id={headingId}>Rename playlist</h2>
        <button className="music-icon-button" type="button" title="Close" aria-label="Close rename playlist" disabled={saving} onClick={onClose}><X size={18} /></button></div>
      <label htmlFor={nameId}>Playlist name</label><input id={nameId} autoFocus required maxLength={200} value={name} disabled={saving} onChange={(event) => setName(event.target.value)} />
      {error && <p className="notice error" role="alert">{error}</p>}
      <div className="dialog-actions"><button className="secondary-button" type="button" disabled={saving} onClick={onClose}>Cancel</button>
        <button className="primary-button" type="submit" disabled={saving || !name.trim()}>{saving ? <RefreshCw className="spin" size={16} /> : <Check size={16} />}{saving ? 'Saving...' : 'Save name'}</button></div>
    </form>
  </dialog>;
}

function FolderDialog({ folder, parentId, folders, saving, onSave, onClose }) {
  const dialogRef = useRef(null);
  const headingId = useId();
  const nameId = useId();
  const parentInputId = useId();
  const [names, setNames] = useState(() => [{ id: crypto.randomUUID(), name: folder?.name || '' }]);
  const [focusTarget, setFocusTarget] = useState(null);
  const [location, setLocation] = useState(parentId || '');
  const [error, setError] = useState('');

  useEffect(() => {
    if (focusTarget) document.getElementById(`${nameId}-${focusTarget.id}`)?.focus();
  }, [focusTarget, nameId]);

  useEffect(() => {
    const previousFocus = document.activeElement;
    const dialog = dialogRef.current;
    dialog.showModal();
    return () => { dialog.close(); if (previousFocus?.isConnected) previousFocus.focus(); };
  }, []);

  return <dialog ref={dialogRef} className="confirmation-dialog folder-dialog" aria-labelledby={headingId}
    onCancel={(event) => { event.preventDefault(); if (!saving) onClose(); }}>
    <form onSubmit={async (event) => {
      event.preventDefault();
      if (saving || names.some((item) => !item.name.trim())) return;
      setError('');
      const result = await onSave({ names: names.map((item) => item.name.trim()), parentId: location || null });
      if (result === true) onClose();
      else setError(result || 'Unable to save folders.');
    }}>
      <div className="folder-dialog-heading"><h2 id={headingId}>{folder ? 'Edit folder' : 'New playlist folder'}</h2>
        <button type="button" className="music-icon-button" title="Close" aria-label="Close folder dialog" disabled={saving} onClick={onClose}><X size={18} /></button></div>
      <div className="folder-name-fields">{names.map((item, index) => <div key={item.id}>
        <label htmlFor={`${nameId}-${item.id}`}>Folder name{names.length > 1 ? ` ${index + 1}` : ''}</label>
        <div className="folder-name-row"><input id={`${nameId}-${item.id}`} autoFocus={index === 0} required maxLength={120} value={item.name} disabled={saving}
          onChange={(event) => setNames((current) => current.map((field) => field.id === item.id ? { ...field, name: event.target.value } : field))} />
          {!folder && names.length > 1 && <button className="music-icon-button" type="button" title="Remove folder" aria-label={`Remove folder ${index + 1}`} disabled={saving}
            onClick={() => { setNames((current) => current.filter((field) => field.id !== item.id)); setFocusTarget({ id: names[index === 0 ? 1 : index - 1].id }); }}><X size={18} /></button>}
        </div>
      </div>)}</div>
      {!folder && <button className="secondary-button compact-button folder-add-button" type="button" disabled={saving}
        onClick={() => { const id = crypto.randomUUID(); setNames((current) => [...current, { id, name: '' }]); setFocusTarget({ id }); }}><Plus size={17} />Add folder</button>}
      <label htmlFor={parentInputId}>Location</label><select id={parentInputId} value={location} disabled={saving} onChange={(event) => setLocation(event.target.value)}>
        <option value="">Library</option>{folders.map((item) => <option key={item.id} value={item.id}>{item.path}</option>)}
      </select>
      {error && <p className="notice error" role="alert">{error}</p>}
      <div className="dialog-actions"><button className="secondary-button" type="button" disabled={saving} onClick={onClose}>Cancel</button>
        <button className="primary-button" type="submit" disabled={saving || names.some((item) => !item.name.trim())}>{saving ? <RefreshCw className="spin" size={16} /> : <Check size={16} />}{saving ? 'Saving...' : names.length > 1 ? 'Save folders' : 'Save folder'}</button></div>
    </form>
  </dialog>;
}

export default function MusicLibrary({ user, request, confirm, owner = null }) {
  const readOnly = user.role === 'shared' || Boolean(owner && owner.id !== user.id);
  const transcriptionActive = useTranscriptionService(request, !readOnly);
  const playback = usePlayback();
  const sidebarRef = useRef(null);
  const [editingMetadata, setEditingMetadata] = useState(null);
  const [replacingFile, setReplacingFile] = useState(null);
  const [sharingFile, setSharingFile] = useState(null);
  const [library, setLibrary] = useState(null);
  const [selectedId, setSelectedId] = useState(new URLSearchParams(window.location.search).get('playlist'));
  const [trackResult, setTrackResult] = useState(null);
  const [trackPage, setTrackPage] = useState(1);
  const [trackSearch, setTrackSearch] = useState('');
  const [debouncedTrackSearch, setDebouncedTrackSearch] = useState('');
  const [tracksLoading, setTracksLoading] = useState(true);
  const [error, setError] = useState('');
  const [trackError, setTrackError] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [search, setSearch] = useState('');
  const [collapsed, setCollapsed] = useState(new Set());
  const [folderDialog, setFolderDialog] = useState(null);
  const [renamingPlaylist, setRenamingPlaylist] = useState(null);
  const [addingPlaylist, setAddingPlaylist] = useState(false);
  const [importing, setImporting] = useState(false);
  const [exportingLibrary, setExportingLibrary] = useState(false);
  const [reordering, setReordering] = useState(false);
  const [movingSong, setMovingSong] = useState(null);
  const [selectingPlaylists, setSelectingPlaylists] = useState(false);
  const [selectedPlaylists, setSelectedPlaylists] = useState(new Set());
  const [selectingSongs, setSelectingSongs] = useState(false);
  const [selectedSongs, setSelectedSongs] = useState(new Set());
  const [bulkDialog, setBulkDialog] = useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [transcribingFile, setTranscribingFile] = useState(null);
  const [pendingTranscriptions, setPendingTranscriptions] = useState({});
  const [deletingFiles, setDeletingFiles] = useState({});
  const [actionError, setActionError] = useState('');
  const [transcriptionNotice, setTranscriptionNotice] = useState('');
  const [deletedSongNames, setDeletedSongNames] = useState([]);
  const [removedSong, setRemovedSong] = useState(null);
  const songMutations = useRef(new Set());
  const savingRef = useRef(false);
  const mutationRef = useRef(0);
  const entries = library?.entries || [];
  const jobs = library?.playlists || library?.jobs || [];
  const entryMap = new Map(entries.map((entry) => [entry.id, entry]));
  const jobMap = new Map(jobs.map((job) => [job.id, job]));
  const sourceJobMap = new Map((library?.jobs || []).map((job) => [job.id, job]));
  const selected = entryMap.get(selectedId);
  const selectedJob = sourceJobMap.get(selectedId);
  const title = selected?.type === 'folder' ? selected.name : selectedId ? jobMap.get(selectedId)?.playlistTitle || 'Preparing playlist' : 'All music';
  const allMusic = selectedId === null;
  const paginated = allMusic || library?.serverPagination;
  const searchPending = paginated && trackSearch !== debouncedTrackSearch;
  const tracks = trackResult?.selectedId === selectedId && (!paginated
    || (trackResult.page === trackPage && trackResult.search === debouncedTrackSearch)) ? trackResult.files : null;
  const pagination = paginated ? {
    page: trackPage, pageSize: 50, total: trackResult?.selectedId === selectedId ? trackResult.total : 0,
    totalPages: trackResult?.selectedId === selectedId ? trackResult.totalPages : 1,
    loading: tracksLoading || searchPending, onChange: setTrackPage
  } : null;
  const jobsRevision = JSON.stringify([library?.catalogRevision, (library?.jobs || []).map((job) => [job.id, job.updatedAt, job.songCount])]);
  const playlistSelection = entries.filter((entry) => entry.type === 'playlist' && selectedPlaylists.has(entry.id));
  const songSelection = (tracks || []).filter((track) => selectedSongs.has(songKey(track)));

  useEffect(() => {
    const sidebar = sidebarRef.current;
    const home = sidebar.closest('.music-home');
    const resize = () => {
      if (!sidebar.getClientRects().length) return;
      sidebar.style.setProperty('--playlist-top', `${sidebar.getBoundingClientRect().top + window.scrollY}px`);
    };
    const observer = new ResizeObserver(resize);
    observer.observe(home);
    observer.observe(document.querySelector('.topbar'));
    window.addEventListener('resize', resize);
    resize();
    return () => { observer.disconnect(); window.removeEventListener('resize', resize); };
  }, [sidebarOpen]);

  useEffect(() => {
    if (trackSearch === debouncedTrackSearch) return;
    const timer = window.setTimeout(() => {
      setDebouncedTrackSearch(trackSearch);
      setTrackPage(1);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [trackSearch, debouncedTrackSearch]);

  useEffect(() => {
    let active = true;
    const load = async () => {
      const mutation = mutationRef.current;
      try {
        const result = await request(owner ? `/api/library?${new URLSearchParams({ userId: owner.id })}` : '/api/library');
        if (active && !savingRef.current && mutation === mutationRef.current) {
          setLibrary((current) => current && current.version > result.version ? current : result);
          setError('');
        }
      } catch (loadError) { if (active) setError(loadError.message); }
    };
    load();
    const timer = window.setInterval(load, 10000);
    return () => { active = false; window.clearInterval(timer); };
  }, [request, refresh, owner?.id]);

  useEffect(() => {
    if (!library) return;
    if (selectedId && !library.entries.some((entry) => entry.id === selectedId)) {
      setSelectedId(null);
      setTrackPage(1);
      return;
    }
    if (searchPending) return;
    let active = true;
    const controller = new AbortController();
    setTracksLoading(true);
    setTrackError('');
    const query = new URLSearchParams({ ...(owner ? { userId: owner.id } : {}), ...(selectedId ? { entryId: selectedId } : {}),
      ...(paginated ? { page: trackPage, pageSize: 50, search: debouncedTrackSearch } : {}) });
    request(`/api/library/tracks?${query}`, { signal: controller.signal }).then((result) => {
      if (active) {
        setTrackResult({ ...result, selectedId, search: debouncedTrackSearch });
        if (paginated && result.page !== trackPage) setTrackPage(result.page);
      }
    }).catch((loadError) => { if (active) setTrackError(loadError.message); })
      .finally(() => { if (active) setTracksLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [request, selectedId, library?.version, jobsRevision, refresh, trackPage, debouncedTrackSearch, searchPending, paginated, owner?.id]);

  function selectEntry(id) {
    setSelectedSongs(new Set());
    setSelectingSongs(false);
    setSelectedId(id);
    setTrackPage(1);
    setSidebarOpen(false);
    const query = new URLSearchParams({ ...(id ? { playlist: id } : {}), ...(owner ? { userId: owner.id } : {}) });
    const params = query.size ? `?${query}` : '';
    replaceURL(`/${params}`);
  }

  function songState(track) {
    const job = track.sourceJob || sourceJobMap.get(track.jobId);
    const key = songKey(track);
    const transcription = pendingTranscriptions[key] || track.transcription || job?.transcriptions?.[track.name];
    const canModify = !readOnly && canModifyJob(user, job);
    return { canModify, transcription, deleting: Boolean(deletingFiles[key]),
      disabled: !canModify || ['queued', 'running'].includes(job?.status)
        || songMutations.current.has(key) || transcription?.status === 'sent' };
  }

  function metadataSaved(file, result) {
    playback.updateMetadata(file.jobId, file.name, result);
    setTrackResult((current) => current ? { ...current, files: current.files.map((track) => songKey(track) === songKey(file)
      ? { ...track, title: result.title, artist: result.artist, album: result.album, rating: result.rating,
        transcriptionLocked: result.transcriptionLocked } : track) } : current);
  }

  async function transcribe(track, options) {
    setTranscribingFile(null);
    const locking = typeof options.transcriptionLocked === 'boolean';
    if (songState(track).disabled || (!locking && (!transcriptionActive || (track.transcriptionLocked && options.NoVocalsOnly !== true)))) {
      setActionError('This song cannot be changed right now. Refresh and try again.'); return;
    }
    const key = songKey(track);
    songMutations.current.add(key);
    setPendingTranscriptions((current) => ({ ...current, [key]: { status: locking ? 'locking' : 'sent', requestedAt: new Date().toISOString(),
      options: { NoVocalsOnly: options.NoVocalsOnly === true } } }));
    setTranscriptionNotice('');
    setActionError('');
    try {
      const result = await request(`/api/jobs/${encodeURIComponent(track.jobId)}/files/${encodeURIComponent(track.name)}/${locking ? 'metadata' : 'transcribe'}`, {
        method: locking ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(options)
      });
      if (locking) metadataSaved(track, result);
      setTranscriptionNotice(`${options.NoVocalsOnly ? 'No-vocals version created' : `Transcription ${locking ? (options.transcriptionLocked ? 'locked' : 'unlocked') : 'complete'}`}: ${track.name}`);
    } catch (requestError) {
      setActionError(`Transcription request for ${track.name}: ${requestError.message}`);
    } finally {
      songMutations.current.delete(key);
      setPendingTranscriptions((current) => {
        const remaining = { ...current }; delete remaining[key]; return remaining;
      });
      setRefresh((value) => value + 1);
    }
  }

  async function removeSong(track) {
    if (songState(track).disabled || savingRef.current) return;
    const key = songKey(track);
    songMutations.current.add(key);
    try {
      if (!await confirm({ title: 'Remove song?', message: `Remove ${track.name} from ${track.playlistTitle || 'this playlist'}? The file is kept while other playlist links exist, including other users' libraries. Removing the last link permanently deletes the file.`, action: 'delete', label: 'Remove song' })) return;
      setDeletingFiles((current) => ({ ...current, [key]: true }));
      setActionError('');
      setDeletedSongNames([]);
      await persistLibrary('/api/library/songs/remove', 'POST', {
        version: library.version, jobId: track.jobId, name: track.name, playlistId: track.playlistId
      }, (result) => {
        if (result.fileDeleted) {
          setRemovedSong({ key });
          setDeletedSongNames([track.name]);
        }
      });
    } catch (requestError) { setActionError(requestError.message); }
    finally {
      songMutations.current.delete(key);
      setDeletingFiles((current) => { const remaining = { ...current }; delete remaining[key]; return remaining; });
      setRefresh((value) => value + 1);
    }
  }

  async function removeSelectedSongs() {
    if (savingRef.current || !songSelection.length || songSelection.some((track) => songState(track).disabled)) return;
    const selection = [...songSelection];
    const keys = selection.map(songKey);
    let version = library.version;
    let removed = 0;
    savingRef.current = true;
    setSaving(true);
    keys.forEach((key) => songMutations.current.add(key));
    try {
      if (!await confirm({ title: 'Delete selected songs?', message: `Remove ${selection.length} selected songs from ${title}? Files are kept while other playlist links exist, including other users' libraries. Removing the last link permanently deletes the file.`, action: 'delete', label: 'Delete selected songs' })) return;
      mutationRef.current += 1;
      setSaved(false);
      setError('');
      setActionError('');
      setDeletedSongNames([]);
      setDeletingFiles((current) => ({ ...current, ...Object.fromEntries(keys.map((key) => [key, true])) }));
      for (const track of selection) {
        const result = await request('/api/library/songs/remove', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ version, jobId: track.jobId, name: track.name, playlistId: track.playlistId })
        });
        version = result.version;
        removed += 1;
        setLibrary((current) => ({ ...current, ...result }));
        toggleSongs([songKey(track)], false);
        if (result.fileDeleted) {
          playback.removeSong(track.jobId, track.name);
          setDeletedSongNames((current) => [...current, track.name]);
        }
      }
      setSaved(true);
    } catch (requestError) {
      setActionError(`${removed} of ${selection.length} songs removed. ${requestError.message} Unremoved songs remain selected.`);
      await request('/api/library').then(setLibrary).catch(() => {});
    } finally {
      keys.forEach((key) => songMutations.current.delete(key));
      setDeletingFiles((current) => {
        const remaining = { ...current };
        keys.forEach((key) => { delete remaining[key]; });
        return remaining;
      });
      savingRef.current = false;
      setSaving(false);
      setRefresh((value) => value + 1);
    }
  }

  async function persistLibrary(endpoint, method, body, onSaved) {
    if (savingRef.current || !library) return 'A library change is already being saved.';
    savingRef.current = true;
    mutationRef.current += 1;
    setSaving(true);
    setSaved(false);
    setError('');
    try {
      const result = await request(endpoint, {
        method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      });
      setLibrary((current) => ({ ...current, ...result }));
      onSaved?.(result);
      setSaved(true);
      setRefresh((value) => value + 1);
      return true;
    } catch (saveError) {
      setError(saveError.message);
      await request('/api/library').then(setLibrary).catch(() => {});
      return saveError.message;
    } finally { savingRef.current = false; setSaving(false); }
  }

  function saveEntry(changes) {
    return persistLibrary('/api/library/entries', 'POST', {
      version: library.version, ...changes
    });
  }

  async function renamePlaylist(id, playlistTitle) {
    if (savingRef.current) return 'A library change is already being saved.';
    savingRef.current = true;
    mutationRef.current += 1;
    setSaving(true);
    setSaved(false);
    try {
      const result = await request(`/api/jobs/${encodeURIComponent(id)}/title`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ playlistTitle })
      });
      const updateTitle = (items) => items?.map((item) => item.id === id
        ? { ...item, playlistTitle: result.playlistTitle, updatedAt: result.updatedAt } : item);
      setLibrary((current) => ({ ...current, jobs: updateTitle(current.jobs), playlists: updateTitle(current.playlists) }));
      setTrackResult((current) => current ? { ...current, files: current.files.map((track) => track.playlistId === id
        ? { ...track, playlistTitle: result.playlistTitle } : track) } : current);
      setSaved(true);
      return true;
    } catch (saveError) {
      return saveError.message;
    } finally {
      savingRef.current = false;
      setSaving(false);
      setRefresh((value) => value + 1);
    }
  }

  async function playlistAdded(job) {
    mutationRef.current += 1;
    const result = await request('/api/library/links', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId: job.id })
    });
    const updated = await request('/api/library');
    setLibrary(updated);
    setSearch('');
    setCollapsed(new Set());
    selectEntry(result.selectedId);
    setRefresh((value) => value + 1);
  }

  function moveSong(track, playlistId) {
    if (!playlistId) { setMovingSong(track); return; }
    return persistLibrary('/api/library/songs/move', 'POST', {
      version: library.version, jobId: track.jobId, name: track.name, sourcePlaylistId: track.playlistId, playlistId
    });
  }

  function toggleSongs(keys, checked) {
    setSelectedSongs((current) => {
      const next = new Set(current);
      for (const key of keys) { if (checked) next.add(key); else next.delete(key); }
      return next;
    });
  }

  async function saveBulk(destination) {
    const playlists = bulkDialog.type === 'playlists';
    const result = await persistLibrary(playlists ? '/api/library/playlists/move' : '/api/library/songs/transfer', 'POST', {
      version: bulkDialog.version,
      ...(playlists ? { ids: bulkDialog.ids, parentId: destination }
        : { keys: bulkDialog.keys, sourcePlaylistId: bulkDialog.sourcePlaylistId, playlistId: destination, action: bulkDialog.action })
    });
    if (result === true) {
      if (playlists) { setSelectedPlaylists(new Set()); setSelectingPlaylists(false); setCollapsed(new Set()); }
      else { setSelectedSongs(new Set()); setSelectingSongs(false); }
    } else {
      setBulkDialog(null);
    }
    return result;
  }

  function insideFolder(id, folderId) {
    let entry = entryMap.get(id);
    while (entry) {
      if (entry.id === folderId) return true;
      entry = entryMap.get(entry.parentId);
    }
    return false;
  }

  function folderPath(folder) {
    const names = [folder.name];
    let parent = entryMap.get(folder.parentId);
    while (parent) { names.unshift(parent.name); parent = entryMap.get(parent.parentId); }
    return names.join(' / ');
  }

  const folders = entries.filter((entry) => entry.type === 'folder').map((folder) => ({ ...folder, path: folderPath(folder) }));
  const allFoldersCollapsed = folders.length > 0 && folders.every((folder) => collapsed.has(folder.id));
  const toggleFoldersLabel = allFoldersCollapsed ? 'Expand all folders' : 'Collapse all folders';
  const possibleFolders = (id) => folders.filter((folder) => !insideFolder(folder.id, id));

  function moveEntry(id, parentId, targetId = null, after = false) {
    const entry = entryMap.get(id);
    if (savingRef.current || !entry || id === targetId || (entry.type === 'folder' && insideFolder(parentId, id))) return;
    if (parentId) setCollapsed((current) => { const updated = new Set(current); updated.delete(parentId); return updated; });
    void saveEntry({ action: 'move', id, parentId, targetId, after });
  }

  function reorderEntry(direction, id = selectedId) {
    const entry = entryMap.get(id);
    if (!entry || savingRef.current) return;
    const siblings = entries.filter((item) => item.parentId === entry.parentId);
    const index = siblings.findIndex((item) => item.id === entry.id);
    const neighbor = siblings[index + direction];
    if (!neighbor) return;
    moveEntry(entry.id, entry.parentId, neighbor.id, direction > 0);
  }

  async function saveFolder(changes) {
    const folder = folderDialog.folder;
    const created = changes.names.map((name) => ({ id: folder?.id || `folder-${crypto.randomUUID()}`, name }));
    const result = await saveEntry(folder
      ? { action: 'update-folder', ...created[0], parentId: changes.parentId }
      : { action: 'create-folders', folders: created, parentId: changes.parentId });
    if (result === true) {
      setCollapsed(new Set());
      selectEntry(created[0].id);
    }
    return result;
  }

  async function removeFolder() {
    if (!selected || selected.type !== 'folder' || saving) return;
    if (!await confirm({ title: 'Delete folder?', message: `Delete "${selected.name}"? Its playlists and subfolders will move to ${selected.parentId ? entryMap.get(selected.parentId).name : 'your library'}. No music files will be deleted.`, action: 'delete', label: 'Delete folder' })) return;
    if (await saveEntry({ action: 'delete-folder', id: selected.id }) === true) selectEntry(selected.parentId);
  }

  function reorderSong(track, target) {
    if (!tracks || tracksLoading || allMusic || savingRef.current) return;
    const playlistTracks = tracks.filter((item) => item.playlistId === track.playlistId);
    const names = playlistTracks.map(songKey);
    const from = names.indexOf(songKey(track));
    const destination = typeof target === 'number' ? from + target : names.indexOf(target);
    if (from < 0 || destination < 0 || destination >= names.length || from === destination) return;
    void persistLibrary('/api/library/songs/reorder', 'POST', {
      version: library.version, playlistId: track.playlistId, jobId: track.jobId, name: track.name,
      target: names[destination], after: from < destination
    });
  }

  function entryTitle(entry) { return entry.type === 'folder' ? entry.name : jobMap.get(entry.id)?.playlistTitle || 'Preparing playlist'; }
  function matches(entry) {
    return entryTitle(entry).toLowerCase().includes(search.toLowerCase())
      || entries.some((child) => child.parentId === entry.id && matches(child));
  }

  function renderEntries(parentId = null, depth = 0) {
    const siblings = entries.filter((entry) => entry.parentId === parentId);
    return <ul className="library-tree">{siblings.filter((entry) => reordering || !search || matches(entry)).map((entry) => {
      const folder = entry.type === 'folder';
      const playlist = jobMap.get(entry.id);
      const open = !collapsed.has(entry.id) || Boolean(search);
      const count = folder ? getPlaylistIds(entries, entry.id).length : jobMap.get(entry.id)?.songCount || 0;
      const dropPosition = (event) => {
        if (event.dataTransfer.types.includes('application/x-ssmusic-song')) return 'inside';
        const bounds = event.currentTarget.getBoundingClientRect();
        const offset = (event.clientY - bounds.top) / bounds.height;
        if (folder && !reordering && offset >= .25 && offset <= .75) return 'inside';
        return offset < .5 ? 'before' : 'after';
      };
      const acceptEntry = (event) => {
        const allowed = !readOnly && !saving && (event.dataTransfer.types.includes('application/x-ssmusic-entry')
          || (!folder && event.dataTransfer.types.includes('application/x-ssmusic-song')));
        allowDrop(event, allowed);
        if (allowed) event.currentTarget.dataset.dropPosition = dropPosition(event);
      };
      return <li key={entry.id}>
        <div className={`library-entry ${selectedId === entry.id ? 'is-selected' : ''}`} style={{ paddingLeft: 8 + Math.min(depth, 4) * 12 }}
          draggable={!readOnly && !saving && !selectingPlaylists} onDragStart={(event) => { event.currentTarget.dataset.dragging = 'true'; event.dataTransfer.setData('application/x-ssmusic-entry', entry.id); event.dataTransfer.effectAllowed = 'move'; }}
          onDragEnter={acceptEntry} onDragOver={acceptEntry} onDragLeave={leaveDrop}
          onDrop={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (readOnly || saving) return;
            const songData = event.dataTransfer.getData('application/x-ssmusic-song');
            if (songData) {
              if (!folder) { try { void moveSong(JSON.parse(songData), entry.id); } catch {} }
              return;
            }
            const movedId = event.dataTransfer.getData('application/x-ssmusic-entry');
            const position = dropPosition(event);
            if (movedId !== entry.id) moveEntry(movedId, position === 'inside' ? entry.id : entry.parentId,
              position === 'inside' ? null : entry.id, position === 'after');
          }}>
          {folder ? <button className="folder-expander" type="button" aria-label={`${open ? 'Collapse' : 'Expand'} ${entry.name}`} aria-expanded={open} title={open ? 'Collapse folder' : 'Expand folder'} onClick={() => setCollapsed((current) => {
            const updated = new Set(current); if (updated.has(entry.id)) updated.delete(entry.id); else updated.add(entry.id); return updated;
          })}>{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button> : selectingPlaylists ? <input className="library-select-checkbox" type="checkbox" aria-label={`Select playlist ${entryTitle(entry)}`} checked={selectedPlaylists.has(entry.id)} disabled={saving}
            onChange={(event) => { const checked = event.target.checked; setSelectedPlaylists((current) => { const next = new Set(current); if (checked) next.add(entry.id); else next.delete(entry.id); return next; }); }} /> : <span className="folder-expander" />}
          <button className="library-entry-select" type="button" aria-current={selectedId === entry.id ? 'true' : undefined} title={entryTitle(entry)} onClick={() => { if (!reordering) selectEntry(entry.id); }}>
            {folder ? open ? <FolderOpen size={18} /> : <Folder size={18} /> : <ListMusic size={18} />}<span>{entryTitle(entry)}</span>{entry.protected && <LockKeyhole size={12} aria-label="Permanent playlist" />}<small>{count}</small>
          </button>
          {!reordering && !folder && !entry.protected && canManageJob(user, playlist) && <button
            className="music-icon-button library-entry-rename" type="button" title={`Rename ${entryTitle(entry)}`} aria-label={`Rename playlist ${entryTitle(entry)}`}
            disabled={saving || ['queued', 'running'].includes(playlist.status)} onClick={() => setRenamingPlaylist(playlist)}><Pencil size={16} /></button>}
          {reordering && <button className="music-icon-button library-entry-drag" type="button" title={`Drag to reorder ${entryTitle(entry)}`}
            aria-label={`Reorder ${entryTitle(entry)}`} aria-keyshortcuts="ArrowUp ArrowDown" draggable={!saving} disabled={saving}
            onKeyDown={(event) => {
              if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                event.preventDefault();
                reorderEntry(event.key === 'ArrowUp' ? -1 : 1, entry.id);
              }
            }}><GripVertical size={18} /></button>}
        </div>
        {folder && open && renderEntries(entry.id, depth + 1)}
      </li>;
    })}</ul>;
  }

  const sidebar = <aside ref={sidebarRef} className="library-sidebar" aria-label="Playlists">
    <div className="library-sidebar-heading"><h2>Playlists <small>{jobs.length}</small></h2>
      <div className="library-sidebar-tools"><button className="music-icon-button" type="button"
        title={search ? 'Clear playlist search to collapse or expand folders' : toggleFoldersLabel} aria-label={toggleFoldersLabel}
        disabled={!library || saving || !folders.length || Boolean(search)}
        onClick={() => setCollapsed(allFoldersCollapsed ? new Set() : new Set(folders.map((folder) => folder.id)))}>
        {allFoldersCollapsed ? <ChevronsUpDown size={19} /> : <ChevronsDownUp size={19} />}</button>
      {!readOnly && <><button className="music-icon-button" type="button" title="Select playlists" aria-label="Select playlists" aria-pressed={selectingPlaylists}
        disabled={!library || saving} onClick={() => { setSelectingPlaylists(!selectingPlaylists); setSelectedPlaylists(new Set()); setReordering(false); }}><ListChecks size={19} /></button>
      <button className="music-icon-button" type="button" title="Reorder playlists" aria-label="Reorder playlists" aria-pressed={reordering}
        disabled={!library || saving} onClick={() => { setReordering(!reordering); setSelectingPlaylists(false); setSelectedPlaylists(new Set()); }}><GripVertical size={19} /></button>
      <button className="music-icon-button" type="button" title="New playlist folder" aria-label="New playlist folder" disabled={!library || saving}
        onClick={() => setFolderDialog({ folder: null, parentId: selected?.type === 'folder' ? selected.id : selected?.parentId || null })}><FolderPlus size={19} /></button></>}</div></div>
    <label className="queue-search"><Search size={15} /><input type="search" aria-label="Search playlists" placeholder="Find a playlist" value={search} disabled={reordering} onChange={(event) => setSearch(event.target.value)} /></label>
    {selectingPlaylists && <div className="library-bulk-toolbar">
      <label><input className="library-select-checkbox" type="checkbox" aria-label="Select all matching playlists" disabled={saving}
        ref={(element) => { if (element) { const matching = entries.filter((entry) => entry.type === 'playlist' && matches(entry)); const count = matching.filter((entry) => selectedPlaylists.has(entry.id)).length; element.indeterminate = count > 0 && count < matching.length; } }}
        checked={entries.some((entry) => entry.type === 'playlist' && matches(entry)) && entries.filter((entry) => entry.type === 'playlist' && matches(entry)).every((entry) => selectedPlaylists.has(entry.id))}
        onChange={(event) => { const checked = event.target.checked; setSelectedPlaylists((current) => { const next = new Set(current); for (const entry of entries.filter((item) => item.type === 'playlist' && matches(item))) { if (checked) next.add(entry.id); else next.delete(entry.id); } return next; }); }} /><span>{playlistSelection.length} selected</span></label>
      <button className="music-icon-button" type="button" title="Move selected playlists to folder" aria-label="Move selected playlists to folder" disabled={saving || !playlistSelection.length}
        onClick={() => setBulkDialog({ type: 'playlists', version: library.version, ids: playlistSelection.map((entry) => entry.id) })}><ArrowRightLeft size={18} /></button>
      <button className="music-icon-button" type="button" title="Clear playlist selection" aria-label="Clear playlist selection" disabled={saving} onClick={() => setSelectedPlaylists(new Set())}><X size={18} /></button>
    </div>}
    <button className={`all-music ${selectedId === null ? 'is-selected' : ''}`} type="button" aria-current={selectedId === null ? 'true' : undefined} onClick={() => selectEntry(null)}><Library size={18} /><span>All music</span><small>{library?.songCount ?? 0}</small></button>
    <div className="library-tree-scroll">{!library && !error ? <p className="music-empty" role="status">Loading playlists...</p> : renderEntries()}
      {library && !entries.length && <p className="music-empty">No playlists yet.</p>}
      {!reordering && search && !entries.some(matches) && <p className="music-empty">No matching playlists.</p>}</div>
    {selected && !readOnly && <div className="library-organize">
      <div className="library-organize-heading"><strong title={title}>{title}</strong><div>
        {selected.type === 'folder' ? <>
          <button className="music-icon-button" type="button" title="Edit folder" aria-label="Edit folder" disabled={saving} onClick={() => setFolderDialog({ folder: selected, parentId: selected.parentId })}><Pencil size={16} /></button>
          <button className="music-icon-button" type="button" title="Delete folder" aria-label="Delete folder" disabled={saving} onClick={removeFolder}><Trash2 size={16} /></button>
        </> : !selected.protected && <>
          {canManageJob(user, selectedJob) && <button className="music-icon-button" type="button" title="Rename playlist" aria-label="Rename playlist"
            disabled={saving || ['queued', 'running'].includes(selectedJob.status)} onClick={() => setRenamingPlaylist(selectedJob)}><Pencil size={16} /></button>}
          <a className="music-icon-button" href={`/job/${encodeURIComponent(selected.id)}`} title="Job details" aria-label="Open job details"><ExternalLink size={16} /></a>
        </>}
      </div></div>
      <label className="library-location">Location<select aria-label="Move selection to folder" value={selected.parentId || ''} disabled={saving}
        onChange={(event) => moveEntry(selected.id, event.target.value || null)}><option value="">Library</option>{possibleFolders(selected.id).map((folder) => <option key={folder.id} value={folder.id}>{folder.path}</option>)}</select></label>
    </div>}
  </aside>;

  return <div className={`music-home ${sidebarOpen ? 'sidebar-open' : ''}`}>
    <header className="library-titlebar"><div><p className="eyebrow"><Music2 size={13} />{readOnly ? 'Shared library' : 'Your music, collected'}</p><h1>{owner?.name || user.name}'s Music</h1></div>
      <div className="library-header-actions"><span className="library-save-status" role="status">{saving ? 'Saving...' : saved ? 'Saved' : `${jobs.length} playlists`}</span>
        <button className="music-icon-button" type="button" title="Refresh library" aria-label="Refresh library" disabled={saving} onClick={() => setRefresh((value) => value + 1)}><RefreshCw size={18} /></button>
        {!readOnly && <><button className="music-icon-button" type="button" title="Import media" aria-label="Import media" aria-haspopup="dialog" disabled={!library || saving} onClick={() => setImporting(true)}><Upload size={18} /></button>
        <button className="secondary-button compact-button library-export-button" type="button" title="Export library" aria-label="Export library" aria-haspopup="dialog" disabled={!library || saving} onClick={() => setExportingLibrary(true)}><Download size={17} />Export library</button>
        <button className="primary-button compact-button" type="button" title="Add Playlist" aria-label="Add Playlist" disabled={!library || saving} onClick={() => setAddingPlaylist(true)}><Plus size={17} />Add Playlist</button></>}</div></header>
    {(error || trackError) && <div className="notice error library-notice" role="alert">{error || trackError}<button className="music-icon-button" type="button" title="Retry" aria-label="Retry loading library" onClick={() => setRefresh((value) => value + 1)}><RefreshCw size={16} /></button></div>}
    {actionError && <div className="notice error library-notice" role="alert">{actionError}<button className="music-icon-button" type="button" title="Dismiss error" aria-label="Dismiss song error" onClick={() => setActionError('')}><X size={16} /></button></div>}
    {transcriptionNotice && <div className="notice success library-notice" role="status">{transcriptionNotice}<button className="music-icon-button" type="button" title="Dismiss" aria-label="Dismiss transcription notice" onClick={() => setTranscriptionNotice('')}><X size={16} /></button></div>}
    {deletedSongNames.length > 0 && <div className="notice success library-notice" role="status">
      <span>{deletedSongNames.length === 1 ? 'Song deleted' : 'Songs deleted'} after removing the last playlist link: {deletedSongNames.join(', ')}</span>
      <button className="music-icon-button" type="button" title="Dismiss" aria-label="Dismiss song deletion notice" onClick={() => setDeletedSongNames([])}><X size={16} /></button>
    </div>}
    <div className="library-mobile-tabs" role="group" aria-label="Library view"><button type="button" aria-pressed={sidebarOpen} onClick={() => setSidebarOpen(true)}><Library size={16} />Playlists</button><button type="button" aria-pressed={!sidebarOpen} onClick={() => setSidebarOpen(false)}><Music2 size={16} />Songs</button></div>
    <MusicPlayer request={request} libraryView={{ sidebar, selectedId, title, type: selected?.type, tracks, readOnly, loading: (tracksLoading || searchPending) && !trackError,
      pagination, error: trackError, queueScope: JSON.stringify([owner?.id || user.id, selectedId || 'all', ...(paginated ? [trackPage, debouncedTrackSearch] : [])]),
      search: paginated ? trackSearch : undefined, onSearch: paginated ? setTrackSearch : undefined,
      songSelection: !readOnly && selected?.type === 'playlist' ? { active: selectingSongs, keys: selectedSongs, count: songSelection.length,
        toggle: () => { setSelectingSongs(!selectingSongs); setSelectedSongs(new Set()); }, change: toggleSongs, clear: () => setSelectedSongs(new Set()),
        remove: removeSelectedSongs, canRemove: songSelection.length > 0 && songSelection.every((track) => !songState(track).disabled),
        transfer: (action) => setBulkDialog({ type: 'songs', action, version: library.version, sourcePlaylistId: selectedId, keys: songSelection.map(songKey) }) } : null,
      songState, transcriptionActive, onTranscribe: setTranscribingFile, onDelete: removeSong, removedSong, onEditMetadata: setEditingMetadata,
      onReplaceFile: setReplacingFile, onShareMedia: setSharingFile,
      onMetadataSaved: metadataSaved, onRatingError: setActionError,
      saving: saving || tracksLoading || searchPending, onReorder: reorderSong, onSelect: selectEntry, onMove: moveSong, onAdd: () => setAddingPlaylist(true) }} />
    {transcribingFile && <TranscriptionDialog file={transcribingFile} serviceActive={transcriptionActive} onClose={() => setTranscribingFile(null)} onSubmit={transcribe} />}
    {sharingFile && <ShareMediaDialog file={sharingFile} jobId={sharingFile.jobId} request={request} onClose={() => setSharingFile(null)} />}
    {editingMetadata && <MetadataDialog file={editingMetadata} jobId={editingMetadata.jobId} request={request} readOnly={readOnly} onClose={() => setEditingMetadata(null)} onSaved={(result) => {
      metadataSaved(editingMetadata, result);
      setRefresh((value) => value + 1);
    }} />}
    {replacingFile && <ReplaceFileDialog file={replacingFile} jobId={replacingFile.jobId} request={request} onClose={() => setReplacingFile(null)} onSaved={(result) => {
      playback.replaceFile(replacingFile.jobId, replacingFile.name, result);
      setTrackResult((current) => current ? { ...current,
        files: replaceSongFile(current.files, replacingFile.jobId, replacingFile.name, result.file) } : current);
      setRefresh((value) => value + 1);
    }} />}
    {folderDialog && <FolderDialog folder={folderDialog.folder} parentId={folderDialog.parentId} folders={possibleFolders(folderDialog.folder?.id)} saving={saving} onSave={saveFolder} onClose={() => setFolderDialog(null)} />}
    {renamingPlaylist && <RenamePlaylistDialog playlist={renamingPlaylist} saving={saving} onSave={renamePlaylist} onClose={() => setRenamingPlaylist(null)} />}
    {addingPlaylist && <AddPlaylistDialog user={user} request={request} confirm={confirm} onAdded={playlistAdded} onClose={() => setAddingPlaylist(false)} />}
    {importing && <ImportMusic user={user} request={request} initialPlaylistId={selected?.type === 'playlist' ? selectedId : ''} onClose={() => setImporting(false)} onImported={() => setRefresh((value) => value + 1)} />}
    {exportingLibrary && <ExportLibraryDialog request={request} onClose={() => setExportingLibrary(false)} />}
    {movingSong && <LibraryDestinationDialog title="Move song" summary={movingSong.name} label="Move song" destinations={entries.filter((entry) => entry.type === 'playlist' && entry.id !== movingSong.playlistId).map((entry) => ({
      id: entry.id, title: `${entry.parentId ? `${folderPath(entryMap.get(entry.parentId))} / ` : ''}${entryTitle(entry)}`
    }))} onSave={(destination) => moveSong(movingSong, destination)} onClose={() => setMovingSong(null)} />}
    {bulkDialog && <LibraryDestinationDialog folder={bulkDialog.type === 'playlists'}
      title={bulkDialog.type === 'playlists' ? 'Move playlists' : bulkDialog.action === 'link' ? 'Link songs' : 'Move songs'}
      summary={`${bulkDialog.ids?.length || bulkDialog.keys?.length} ${bulkDialog.type === 'playlists' ? 'playlists' : 'songs'} selected`}
      label={bulkDialog.action === 'link' ? 'Link songs' : bulkDialog.type === 'playlists' ? 'Move playlists' : 'Move songs'}
      destinations={bulkDialog.type === 'playlists' ? folders.map((folder) => ({ id: folder.id, title: folder.path }))
        : entries.filter((entry) => entry.type === 'playlist' && entry.id !== bulkDialog.sourcePlaylistId).map((entry) => ({ id: entry.id,
          title: `${entry.parentId ? `${folderPath(entryMap.get(entry.parentId))} / ` : ''}${entryTitle(entry)}` }))}
      onSave={saveBulk} onClose={() => setBulkDialog(null)} />}
  </div>;
}