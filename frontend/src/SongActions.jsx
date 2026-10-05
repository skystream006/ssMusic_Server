import { Children, cloneElement, useEffect, useId, useRef, useState } from 'react';
import { Check, CircleAlert, Clock3, Copy, ExternalLink, FileAudio, ImagePlus, Info, Lock, LockOpen, Mic, MoreVertical, Music2, RefreshCw, Save, Share2, Star, Trash2, Upload, X } from 'lucide-react';
import { transcriptionLanguages } from '../../src/transcriptionLanguages.js';
import { individualSongsId, individualVideosId } from '../../src/library.js';
import { sortSelectOptions } from './selectOptions.js';

export const transcriptionInactiveMessage = 'Transciption service is currently inactive. Refresh the page when transcription service is available';

export function useTranscriptionService(request, enabled = true) {
  const [active, setActive] = useState(false);
  useEffect(() => {
    let current = true;
    setActive(false);
    if (enabled) request('/api/health').then((health) => {
      if (current) setActive(health.transcription?.status === 'active');
    }).catch(() => {});
    return () => { current = false; };
  }, [request, enabled]);
  return active;
}

function TranscriptionLockButton({ locked, disabled, onChange }) {
  const label = locked ? 'Unlock transcription' : 'Lock transcription';
  return <button className="music-icon-button" type="button" title={label} aria-label={label}
    aria-pressed={locked} disabled={disabled} onClick={() => onChange(!locked)}>
    {locked ? <Lock size={18} /> : <LockOpen size={18} />}
  </button>;
}

export function SongActions({ name, className, children }) {
  const menuId = useId();
  const triggerRef = useRef(null);
  const menuRef = useRef(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const menu = menuRef.current;
    const close = (event) => {
      if (event?.target instanceof Node && menu.contains(event.target)) return;
      if (menu.matches(':popover-open')) menu.hidePopover();
    };
    const observer = new ResizeObserver(close);
    observer.observe(triggerRef.current.closest('li').parentElement);
    window.addEventListener('resize', close);
    document.addEventListener('scroll', close, true);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', close);
      document.removeEventListener('scroll', close, true);
    };
  }, []);

  function positionMenu(event) {
    if (event.newState !== 'open') return;
    const rect = triggerRef.current.getBoundingClientRect();
    const menu = menuRef.current;
    const height = Math.min(320, window.innerHeight - 16);
    menu.style.left = `${Math.max(8, Math.min(rect.right - 240, window.innerWidth - 248))}px`;
    menu.style.top = `${Math.max(8, Math.min(rect.bottom + 4, window.innerHeight - height - 8))}px`;
  }

  return <div className={`${className} song-actions`} onKeyDown={(event) => {
    if (event.key !== 'Escape' || !menuRef.current.matches(':popover-open')) return;
    event.preventDefault();
    menuRef.current.hidePopover();
    triggerRef.current.focus();
  }}>
    <button ref={triggerRef} className="music-icon-button song-actions-trigger" type="button"
      title="Song actions" aria-label={`Actions for ${name}`} aria-expanded={open} aria-controls={menuId}
      popoverTarget={menuId}><MoreVertical size={20} /></button>
    <div ref={menuRef} id={menuId} className={`${className} song-actions-popover`} popover="auto"
      role="group" aria-label={`Actions for ${name}`} onBeforeToggle={positionMenu}
      onToggle={(event) => setOpen(event.newState === 'open')}
      onClickCapture={(event) => {
        const action = event.target.closest('button, a');
        if (!action || action.disabled) return;
        menuRef.current.hidePopover();
        triggerRef.current.focus();
      }}>
      {sortSelectOptions(Children.toArray(children), (child) => child.props['data-action-label'] || child.props.title)
        .map((child) => cloneElement(child, {}, <>
        {child.props.children}<span>{child.props['data-action-label'] || child.props.title}</span>
      </>))}
    </div>
  </div>;
}

export function canManageJob(user, job) {
  return Boolean(user && user.role !== 'shared' && job && (user.role === 'admin' || user.id === job.initiatedBy?.id));
}

export function canChangePrivacy(user, job, readOnly = false) {
  return Boolean(!readOnly && user?.id && user.role !== 'shared' && user.id === job?.initiatedBy?.id);
}

export function canChangePlaylistPrivacy(user, playlist, libraryOwnerId, readOnly = false) {
  const individual = playlist?.protected && [individualSongsId, individualVideosId].includes(playlist.id);
  return canChangePrivacy(user, individual ? { initiatedBy: { id: libraryOwnerId } } : playlist, readOnly);
}

export function getFilePrivacy(file, job = file?.sourceJob || file?.job) {
  const inherited = Boolean(job?.private || (file?.private && Array.isArray(job?.privateFiles) && !job.privateFiles.includes(file.name)));
  return { private: Boolean(inherited || file?.private || job?.privateFiles?.includes(file?.name)), inherited };
}

export function isContributor(user, job) {
  return Boolean(user?.id && job?.contributors?.some((contributor) => contributor.id === user.id));
}

export function canModifyJob(user, job) {
  return user?.role !== 'shared' && (canManageJob(user, job) || isContributor(user, job));
}

export function canRunJobAction(user, job, action) {
  if (!job || job.status === 'queued' || job.status === 'running') return false;
  if (action === 'delete') return canManageJob(user, job);
  if (action === 'rerun') return !job.source && canModifyJob(user, job);
  return false;
}

export function ShareMediaDialog({ file, jobId, playlist, request, onClose }) {
  const dialogRef = useRef(null);
  const linkRef = useRef(null);
  const generatingRef = useRef(false);
  const headingId = useId();
  const [url, setUrl] = useState('');
  const [generating, setGenerating] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const privateFile = playlist ? Boolean(playlist.private) : getFilePrivacy(file).private;

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    dialog.showModal();
    return () => { dialog.close(); if (previousFocus?.isConnected) previousFocus.focus(); };
  }, []);

  async function generate() {
    if (generatingRef.current || url || privateFile) return;
    generatingRef.current = true;
    setGenerating(true);
    setError('');
    try {
      const endpoint = playlist ? `/api/library/playlists/${encodeURIComponent(playlist.id)}/share`
        : `/api/jobs/${encodeURIComponent(jobId)}/files/${encodeURIComponent(file.name)}/share`;
      const result = await request(endpoint, { method: 'POST' });
      setUrl(new URL(result.url, window.location.origin).href);
    } catch (shareError) { setError(shareError.message); }
    finally { generatingRef.current = false; setGenerating(false); }
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setError('');
    } catch {
      linkRef.current?.focus();
      linkRef.current?.select();
      setError('Clipboard unavailable. Copy the selected public link manually.');
    }
  }

  return <dialog ref={dialogRef} className="confirmation-dialog share-media-dialog" aria-labelledby={headingId}
    aria-describedby={`${headingId}-help`} onCancel={(event) => { event.preventDefault(); if (!generatingRef.current) onClose(); }}>
    <h2 id={headingId}>{playlist ? 'Share Playlist' : 'Share Media'}</h2>
    <p className="metadata-filename">{playlist ? playlist.playlistTitle : file.title || file.name}</p>
    <p id={`${headingId}-help`}>Anyone with this link can listen, read lyrics and metadata, and save {playlist ? 'the public songs in this playlist' : 'this file'} without signing in. They cannot edit {playlist ? 'the playlist' : 'it'}. Only share content you have permission to share.</p>
    {privateFile && <p className="notice warning" role="status">{playlist ? 'Private playlists cannot be shared. Only the owner can access this playlist.' : 'Private files cannot be shared. Only the owner can access this file.'}</p>}
    {url && !privateFile && <>
      <label className="sr-only" htmlFor={`${headingId}-link`}>{playlist ? 'Public playlist link' : 'Public media link'}</label>
      <textarea ref={linkRef} id={`${headingId}-link`} readOnly value={url} spellCheck={false} onFocus={(event) => event.target.select()} />
      <p><a href={url} target="_blank" rel="noopener noreferrer"><ExternalLink size={15} /> {playlist ? 'Open playlist page' : 'Open media page'}</a></p>
    </>}
    {error && <p className="notice error" role="alert">{error}</p>}
    <div className="dialog-actions">
      <button className="secondary-button" type="button" disabled={generating} onClick={onClose}>{url ? 'Done' : 'Cancel'}</button>
      {url && !privateFile ? <button className="primary-button" type="button" onClick={copyLink}><Copy size={17} />{copied ? 'Copied' : 'Copy link'}</button>
        : <button className="primary-button" type="button" disabled={generating || privateFile} onClick={generate}>
          {generating ? <RefreshCw className="spin" size={17} /> : <Share2 size={17} />}{generating ? 'Generating...' : 'Generate public link'}
        </button>}
    </div>
    <span className="sr-only" role="status">{copied ? 'Public link copied to clipboard' : url ? 'Public link ready' : generating ? 'Generating public link' : ''}</span>
  </dialog>;
}

export function formatDate(value) {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
  }).format(new Date(value));
}

export function formatBytes(value) {
  if (!Number.isFinite(value)) return '-';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function SongRating({ value = 0, onChange, inline = false, disabled = false, songName = '' }) {
  const name = useId();
  const label = value ? `${value} of 5 stars` : 'Unrated';
  if (!onChange) return <span className="song-rating" role="img" aria-label={label} title={label}>
    {[1, 2, 3, 4, 5].map((rating) => <Star key={rating} size={13} aria-hidden="true" fill={rating <= value ? 'currentColor' : 'none'} />)}
  </span>;
  if (inline) return <span className="song-rating-inline" role="group" aria-label={`Rating for ${songName}`}>
    {[1, 2, 3, 4, 5].map((rating) => <button key={rating} type="button" disabled={disabled}
      aria-label={`${rating} of 5 stars`} aria-pressed={value === rating}
      title={value === rating ? 'Clear rating' : `Rate ${rating} of 5 stars`}
      onClick={() => onChange(value === rating ? 0 : rating)}>
      <Star size={15} aria-hidden="true" fill={rating <= value ? 'currentColor' : 'none'} />
    </button>)}
  </span>;
  return <fieldset className="rating-editor"><legend>Rating</legend><div>
    {[0, 1, 2, 3, 4, 5].map((rating) => <label key={rating} title={rating ? `${rating} of 5 stars` : 'No rating'}>
      <input type="radio" name={name} value={rating} checked={value === rating} aria-label={rating ? `${rating} of 5 stars` : 'No rating'} onChange={() => onChange(rating)} />
      {rating === 0 ? <X size={20} aria-hidden="true" /> : <Star size={22} aria-hidden="true" fill={rating <= value ? 'currentColor' : 'none'} />}
    </label>)}
  </div></fieldset>;
}

export function ListSongRating({ file, jobId, request, canModify, disabled, onSaved, onError }) {
  const [rating, setRating] = useState(file.rating || 0);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);

  useEffect(() => { setRating(file.rating || 0); }, [file.rating, file.name, jobId]);

  async function save(nextRating) {
    if (!canModify || disabled || savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    onError('');
    try {
      const result = await request(`/api/jobs/${encodeURIComponent(jobId)}/files/${encodeURIComponent(file.name)}/metadata`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ rating: nextRating })
      });
      setRating(result.rating);
      onSaved(result);
    } catch (saveError) { onError(`Rating for ${file.name}: ${saveError.message}`); }
    finally { savingRef.current = false; setSaving(false); }
  }

  return <span className="song-rating-cell" aria-busy={saving}>
    {/\.mp3$/i.test(file.name) && <SongRating value={rating} inline songName={file.name}
      disabled={disabled || saving} onChange={canModify ? save : undefined} />}
    {saving && <span className="sr-only" role="status">Saving rating for {file.name}</span>}
  </span>;
}

export function ReplaceFileDialog({ file, jobId, request, onSaved, onClose }) {
  const dialogRef = useRef(null);
  const submittingRef = useRef(false);
  const headingId = useId();
  const [replacement, setReplacement] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const extension = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    dialog.showModal();
    return () => { dialog.close(); if (previousFocus?.isConnected) previousFocus.focus(); };
  }, []);

  async function replace(event) {
    event.preventDefault();
    if (!replacement || submittingRef.current) return;
    setError('');
    if (!replacement.name.toLowerCase().endsWith(extension) || !replacement.size || replacement.size > 512 * 1024 ** 2) {
      setError(`Choose a non-empty ${extension} song file no larger than 512 MB.`);
      return;
    }
    submittingRef.current = true;
    setSaving(true);
    try {
      const body = new FormData();
      body.set('file', replacement);
      const result = await request(`/api/jobs/${encodeURIComponent(jobId)}/files/${encodeURIComponent(file.name)}/replace`, {
        method: 'POST', body
      });
      onSaved(result);
      onClose();
    } catch (saveError) { setError(saveError.message); }
    finally { submittingRef.current = false; setSaving(false); }
  }

  return <dialog ref={dialogRef} className="confirmation-dialog" aria-labelledby={headingId}
    onCancel={(event) => { event.preventDefault(); if (!submittingRef.current) onClose(); }}>
    <form onSubmit={replace} aria-busy={saving}>
      <h2 id={headingId}>Replace File</h2>
      <p className="metadata-filename">{file.name}</p>
      <p>This permanently overwrites the song and its embedded metadata in every playlist that links to it. The server filename and playlist links stay unchanged.</p>
      <label className="import-field import-upload"><span><FileAudio size={18} />Replacement song file</span>
        <input type="file" accept={extension} required disabled={saving} onChange={(event) => {
          setReplacement(event.target.files?.[0] || null);
          setError('');
        }} />
      </label>
      <p>Choose one {extension} file, up to 512 MB. Convert other formats before uploading; renaming the extension is not enough.</p>
      {error && <p className="notice error" role="alert">{error}</p>}
      {saving && <p role="status">Uploading and replacing file...</p>}
      <div className="dialog-actions">
        <button className="secondary-button" type="button" disabled={saving} onClick={onClose}>Cancel</button>
        <button className="primary-button" type="submit" disabled={!replacement || saving}>
          {saving ? <RefreshCw className="spin" size={17} /> : <Upload size={17} />}{saving ? 'Replacing...' : 'Replace File'}
        </button>
      </div>
    </form>
  </dialog>;
}

export function MetadataDialog({ file, jobId, request, onSaved, onClose, readOnly = false }) {
  const dialogRef = useRef(null);
  const uploadRef = useRef(null);
  const headingId = useId();
  const [values, setValues] = useState(null);
  const [initialRating, setInitialRating] = useState(0);
  const [transcriptionLocked, setTranscriptionLocked] = useState(Boolean(file.transcriptionLocked));
  const [artwork, setArtwork] = useState(null);
  const [artworkChanged, setArtworkChanged] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [readingImage, setReadingImage] = useState(false);
  const [error, setError] = useState('');
  const fields = [['title', 'Title'], ['artist', 'Artist'], ['album', 'Album'], ['performerInfo', 'Album artist'],
    ['genre', 'Genre'], ['year', 'Year'], ['trackNumber', 'Track number'], ['partOfSet', 'Disc number']];
  const editableMetadata = /\.mp3$/i.test(file.name);

  useEffect(() => {
    let active = true;
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    dialog.showModal();
    request(file.lyricsUrl || `/api/jobs/${encodeURIComponent(jobId)}/lyrics/${encodeURIComponent(file.name)}`)
      .then((result) => {
        if (!active) return;
        setValues({ ...Object.fromEntries(fields.map(([field]) => [field, result[field] || ''])), rating: result.rating || 0 });
        setInitialRating(result.rating || 0);
        setTranscriptionLocked(Boolean(result.transcriptionLocked));
        setArtwork(result.artwork);
      }).catch((loadError) => { if (active) setError(loadError.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; dialog.close(); if (previousFocus?.isConnected) previousFocus.focus(); };
  }, [jobId, file.name, file.lyricsUrl, request]);

  async function chooseArtwork(event) {
    const image = event.target.files?.[0];
    event.target.value = '';
    if (!image) return;
    setError('');
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(image.type) || image.size > 2 * 1024 * 1024) {
      setError('Choose a JPEG, PNG or WebP image no larger than 2 MB.'); return;
    }
    setReadingImage(true);
    try {
      const data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Unable to read artwork.'));
        reader.readAsDataURL(image);
      });
      await new Promise((resolve, reject) => {
        const preview = new Image();
        preview.onload = resolve;
        preview.onerror = reject;
        preview.src = data;
      });
      setArtwork(data);
      setArtworkChanged(true);
    } catch { setError('Unable to open this image. Choose a different artwork file.'); }
    finally { setReadingImage(false); }
  }

  async function save(event) {
    event.preventDefault();
    if (readOnly || !values || saving || readingImage) return;
    setSaving(true);
    setError('');
    try {
      const { rating, ...metadata } = values;
      const result = await request(`/api/jobs/${encodeURIComponent(jobId)}/files/${encodeURIComponent(file.name)}/metadata`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transcriptionLocked, ...(editableMetadata
          ? { ...metadata, ...(rating !== initialRating ? { rating } : {}), ...(artworkChanged ? { artwork } : {}) } : {}) })
      });
      onSaved(result);
      onClose();
    } catch (saveError) { setError(saveError.message); }
    finally { setSaving(false); }
  }

  return <dialog ref={dialogRef} className="confirmation-dialog metadata-dialog" aria-labelledby={headingId}
    onCancel={(event) => { event.preventDefault(); if (!saving && !readingImage) onClose(); }}>
    <form onSubmit={save}>
      <div className="folder-dialog-heading"><h2 id={headingId}>{readOnly ? 'View song metadata' : 'Edit song metadata'}</h2>
        {readOnly ? <span role="img" aria-label={transcriptionLocked ? 'Transcription locked' : 'Transcription unlocked'}>
          {transcriptionLocked ? <Lock size={18} /> : <LockOpen size={18} />}
        </span> : <TranscriptionLockButton locked={transcriptionLocked} disabled={loading || saving || readingImage} onChange={setTranscriptionLocked} />}
        <button className="music-icon-button" type="button" title="Close" aria-label={readOnly ? 'Close metadata viewer' : 'Close metadata editor'} disabled={saving || readingImage} onClick={onClose}><X size={18} /></button></div>
      <p className="metadata-filename">{file.name}</p>
      {loading && <p role="status">Loading metadata...</p>}
      {values && (editableMetadata || readOnly) && <fieldset disabled={saving || readingImage} className="metadata-fields">
        <SongRating value={values.rating} onChange={readOnly ? undefined : (rating) => setValues((current) => ({ ...current, rating }))} />
        <div className="metadata-artwork"><div className="metadata-artwork-preview">{artwork ? <img src={artwork} alt="Song artwork preview" /> : <Music2 size={40} />}</div>
          {!readOnly && <div><input ref={uploadRef} type="file" accept="image/jpeg,image/png,image/webp" aria-label="Artwork file" hidden onChange={chooseArtwork} />
            <button className="secondary-button compact-button" type="button" onClick={() => uploadRef.current.click()}><ImagePlus size={17} />Choose artwork</button>
            <button className="music-icon-button" type="button" title="Remove artwork" aria-label="Remove artwork" disabled={!artwork} onClick={() => { setArtwork(null); setArtworkChanged(true); }}><Trash2 size={17} /></button></div>}
        </div>
        <div className="metadata-inputs">{fields.map(([field, label]) => <label key={field} htmlFor={`${headingId}-${field}`}>{label}
          <input id={`${headingId}-${field}`} value={values[field]} readOnly={readOnly} maxLength={500} onChange={(event) => setValues((current) => ({ ...current, [field]: event.target.value }))} />
        </label>)}</div>
      </fieldset>}
      {error && <p className="notice error" role="alert">{error}</p>}
      <div className="dialog-actions"><button className="secondary-button" type="button" disabled={saving || readingImage} onClick={onClose}>{readOnly ? 'Close' : 'Cancel'}</button>
        {!readOnly && <button className="primary-button" type="submit" disabled={loading || !values || saving || readingImage}>{saving ? <RefreshCw className="spin" size={17} /> : <Save size={17} />}{saving ? 'Saving...' : 'Save changes'}</button>}</div>
    </form>
  </dialog>;
}

function TranscriptionHelp({ id, label, children }) {
  return <span className="info-helper"><button type="button" aria-label={`About ${label}`} aria-describedby={id}><Info size={16} /></button>
    <span role="tooltip" id={id}>{children}</span>
  </span>;
}

export function TranscriptionDialog({ file, onClose, onSubmit, serviceActive = false }) {
  const dialogRef = useRef(null);
  const languageRef = useRef(null);
  const titleId = useId();
  const [locked, setLocked] = useState(Boolean(file.transcriptionLocked));
  const [noVocalsOnly, setNoVocalsOnly] = useState(Boolean(file.transcriptionLocked));
  const [addLyrics, setAddLyrics] = useState(false);
  const [language, setLanguage] = useState('');
  const [multilingual, setMultilingual] = useState(false);
  const [noVocals, setNoVocals] = useState(false);
  const [vietLyricsFallback, setVietLyricsFallback] = useState(false);
  const [lyrics, setLyrics] = useState('');
  const [mode, setMode] = useState('align');
  const [submitting, setSubmitting] = useState(false);
  const locking = locked !== Boolean(file.transcriptionLocked);
  const modes = [
    ['prompt', 'Prompt', 'Biases recognition toward known words.'],
    ['align', 'Align', 'Maps authoritative lyric lines onto ASR timing.'],
    ['correct', 'Correct', 'Replaces recognized text while preserving ASR segment timing.']
  ];

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    dialog.showModal();
    languageRef.current?.focus();
    return () => {
      dialog.close();
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  function submit(event) {
    event.preventDefault();
    if (submitting || (!locking && !serviceActive)) return;
    setSubmitting(true);
    onSubmit(file, locking ? { transcriptionLocked: locked } : noVocalsOnly ? { NoVocalsOnly: true } : {
      Multilingual: multilingual,
      NoVocals: noVocals,
      VietLyricsFallback: vietLyricsFallback,
      ...(addLyrics ? { lyrics: lyrics.trim(), lyrics_mode: mode } : {}),
      ...(language ? { language } : {})
    });
  }

  return <dialog ref={dialogRef} className={`confirmation-dialog transcription-dialog${addLyrics && !locking && !locked && !noVocalsOnly ? ' transcription-dialog-expanded' : ''}`} aria-labelledby={titleId}
    onCancel={(event) => { event.preventDefault(); if (!submitting) onClose(); }}>
    <form onSubmit={submit}>
      <div className="folder-dialog-heading"><h2 id={titleId}>Transcribe song</h2>
        <TranscriptionLockButton locked={locked} disabled={submitting} onChange={setLocked} /></div>
      <p className="transcription-file"><FileAudio size={22} /><span>{file.name}<small>{formatBytes(file.sizeBytes)}</small></span></p>
      {!locking && <div className="transcription-option">
        <label className="lyrics-toggle"><input type="checkbox" checked={noVocalsOnly} disabled={submitting || Boolean(file.transcriptionLocked)}
          onChange={(event) => setNoVocalsOnly(event.target.checked)} />Generate NoVocals Only</label>
      </div>}
      {!locking && !locked && !noVocalsOnly && <fieldset disabled={submitting} className="transcription-fields">
        <div className="transcription-language">
          <div className="transcription-option"><label htmlFor={`${titleId}-language`}>Language (optional)</label>
            <TranscriptionHelp id={`${titleId}-language-help`} label="Language">Choose the song's language or use Auto-detect. Viet Lyrics Fallback selects Vietnamese and locks this setting while enabled.</TranscriptionHelp>
          </div>
          <select ref={languageRef} autoFocus id={`${titleId}-language`} aria-describedby={`${titleId}-language-help`} value={language} disabled={vietLyricsFallback} onChange={(event) => setLanguage(event.target.value)}>
            {sortSelectOptions([['', 'Auto-detect'], ...transcriptionLanguages], ([, name]) => name)
              .map(([code, name]) => <option key={code} value={code}>{name}</option>)}
          </select>
        </div>
        <div className="transcription-option">
          <label className="lyrics-toggle"><input type="checkbox" aria-describedby={`${titleId}-multilingual-help`} checked={multilingual} onChange={(event) => setMultilingual(event.target.checked)} />Multilingual</label>
          <TranscriptionHelp id={`${titleId}-multilingual-help`} label="Multilingual">Enable multilingual transcription for songs containing more than one language. Unchecking disables multilingual mode for this request.</TranscriptionHelp>
        </div>
        <div className="transcription-option">
          <label className="lyrics-toggle"><input type="checkbox" aria-describedby={`${titleId}-no-vocals-help`} checked={noVocals} onChange={(event) => setNoVocals(event.target.checked)} />Create no-vocals version [Karaoke version]</label>
          <TranscriptionHelp id={`${titleId}-no-vocals-help`} label="No Vocals">Enable vocal separation and save a no-vocals MP3 alongside the transcribed song in the [NoVocals] folder.</TranscriptionHelp>
        </div>
        <div className="transcription-option">
          <label className="lyrics-toggle"><input type="checkbox" aria-describedby={`${titleId}-fallback-help`} checked={vietLyricsFallback} onChange={(event) => {
            setVietLyricsFallback(event.target.checked);
            if (event.target.checked) setLanguage('vi');
          }} />Viet Lyrics Fallback</label>
          <TranscriptionHelp id={`${titleId}-fallback-help`} label="Viet Lyrics Fallback">Enable the Viet Lyrics fallback pass when the service's opening retry triggers. Automatically selects Vietnamese. Unchecking disables fallback for this request.</TranscriptionHelp>
        </div>
        <div className="transcription-option">
          <label className="lyrics-toggle"><input type="checkbox" aria-describedby={`${titleId}-lyrics-help`} checked={addLyrics} onChange={(event) => setAddLyrics(event.target.checked)} />Add lyrics</label>
          <TranscriptionHelp id={`${titleId}-lyrics-help`} label="Add lyrics">Provide known lyrics to guide recognition, align lyric lines, or correct recognized text using the selected lyrics mode.</TranscriptionHelp>
        </div>
        {addLyrics && <>
          <fieldset className="lyrics-mode-options"><legend>Lyrics mode</legend>
            {modes.map(([value, label, description]) => <div className="lyrics-mode-option" key={value}>
              <label><input type="radio" name="lyrics-mode" value={value} checked={mode === value} required onChange={() => setMode(value)} />{label}</label>
              <TranscriptionHelp id={`${titleId}-${value}`} label={label}>{description}</TranscriptionHelp>
            </div>)}
          </fieldset>
          <label className="lyrics-input-label" htmlFor={`${titleId}-lyrics`}>Lyrics</label>
          <textarea id={`${titleId}-lyrics`} value={lyrics} onChange={(event) => setLyrics(event.target.value)} required maxLength={100000} rows={8} />
        </>}
      </fieldset>}
      <div className="dialog-actions">
        <button className="secondary-button" type="button" disabled={submitting} onClick={onClose}>Cancel</button>
        <button className="primary-button" type="submit" title={!locking && !serviceActive ? transcriptionInactiveMessage : undefined}
          disabled={submitting || (!locking && (!serviceActive || (!noVocalsOnly && addLyrics && !lyrics.trim())))}>
          {locking ? <Lock size={17} /> : <Mic size={17} />}{submitting ? 'Submitting' : 'Submit'}</button>
      </div>
    </form>
  </dialog>;
}

export function TranscriptionStatus({ transcription }) {
  const noVocalsOnly = transcription?.options?.NoVocalsOnly === true;
  const states = {
    sent: { label: noVocalsOnly ? 'No-vocals request sent' : 'Transcription request sent', Icon: RefreshCw },
    transcribed: { label: noVocalsOnly ? 'No-vocals version created' : transcription?.lyricsIncluded ? 'Lyrics included' : 'AI transcription', Icon: Check },
    failed: { label: noVocalsOnly ? 'No-vocals generation failed' : 'Transcription failed', Icon: CircleAlert },
    interrupted: { label: 'Interrupted', Icon: Clock3 }
  };
  const state = states[transcription?.status];
  if (!state) return null;
  const { label, Icon } = state;
  const options = transcription.options;
  const optionDetails = noVocalsOnly ? ['Generate NoVocals Only: On'] : options ? [
    `Language: ${transcriptionLanguages.find(([code]) => code === options.language)?.[1] || options.language || 'Auto-detect'}`,
    ...[['Multilingual', 'Multilingual'], ['NoVocals', 'No vocals (karaoke)'], ['VietLyricsFallback', 'Viet Lyrics Fallback']]
      .map(([key, name]) => `${name}: ${options[key] === undefined ? 'Service default' : options[key] ? 'On' : 'Off'}`),
    `Add lyrics: ${transcription.lyricsIncluded ? 'Yes' : 'No'}`,
    options.lyrics_mode && `Lyrics mode: ${{ prompt: 'Prompt', align: 'Align', correct: 'Correct' }[options.lyrics_mode] || options.lyrics_mode}`
  ] : [];
  const details = [
    `Requested: ${formatDate(transcription.requestedAt)}`,
    transcription.completedAt && `Finished: ${formatDate(transcription.completedAt)}`,
    ...optionDetails,
    transcription.error
  ].filter(Boolean).join('\n');
  return <span className={`song-transcription song-transcription-${transcription.status}`} title={details}>
    <Icon size={13} className={transcription.status === 'sent' ? 'spin' : undefined} aria-hidden="true" />
    <span>{label}</span>
  </span>;
}