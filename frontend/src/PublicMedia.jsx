import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Download, Headphones, LibraryBig, ListMusic, Maximize2, Music2, Play, RefreshCw, SkipBack, SkipForward, X } from 'lucide-react';
import LyricTimeline from './LyricTimeline.jsx';
import { mediaType } from '../../src/media.js';
import { individualPlaylistNames } from '../../src/library.js';
import { sortSelectOptions } from './selectOptions.js';
import appIcon from './assets/ic_launcher.png';
import './publicMedia.css';

const metadataFields = [
  ['title', 'Title'], ['artist', 'Artist'], ['album', 'Album'], ['performerInfo', 'Album artist'],
  ['genre', 'Genre'], ['year', 'Year'], ['trackNumber', 'Track number'], ['partOfSet', 'Disc number']
];

function displayText(value, fallback = 'Not provided') {
  return (typeof value === 'string' && value.trim()) || (typeof value === 'number' && Number.isFinite(value))
    ? String(value) : fallback;
}

function formatTime(value) {
  const seconds = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  const minutes = Math.floor(seconds / 60);
  return minutes >= 60
    ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`
    : `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'Size unavailable';
  if (bytes < 1024) return `${bytes} bytes`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)) - 1, units.length - 1);
  return `${(bytes / (1024 ** (index + 1))).toFixed(1)} ${units[index]}`;
}

export function seekPublicAudio(audio, seconds) {
  if (!audio || !Number.isFinite(seconds) || !Number.isFinite(audio.duration) || audio.duration <= 0) return null;
  const position = Math.min(audio.duration, Math.max(0, seconds));
  audio.currentTime = position;
  return position;
}

export function createPublicLyricsLoader(request, url, onChange) {
  let active = true;
  let loaded = false;
  let pending = false;
  let controller;
  return {
    async load() {
      if (!active || loaded || pending) return;
      pending = true;
      controller = new AbortController();
      onChange({ loading: true, lyrics: null, error: '' });
      try {
        if (!url) throw new Error('Missing lyrics link');
        const lyrics = await request(url, { signal: controller.signal });
        if (!lyrics || !Array.isArray(lyrics.sylt) || typeof lyrics.uslt !== 'string') throw new Error('Invalid lyrics');
        if (active) {
          loaded = true;
          onChange({ loading: false, lyrics, error: '' });
        }
      } catch {
        if (active) onChange({ loading: false, lyrics: null, error: 'Lyrics could not be loaded. Please try again.' });
      } finally {
        pending = false;
      }
    },
    stop() {
      active = false;
      controller?.abort();
    }
  };
}

export function PublicLyrics({ lines, plainLyrics, title, position, canSeek, onSeek,
  expanded = false, loading = false, error = '', onToggle, onRetry }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState('sylt');
  const dialogRef = useRef(null);
  const fullscreenRef = useRef(null);
  const fullscreenButtonRef = useRef(null);
  const hasLyrics = lines.length > 0 || Boolean(plainLyrics.trim());

  useEffect(() => {
    if (!open) return;
    const dialog = dialogRef.current;
    const content = fullscreenRef.current;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog.querySelector('[aria-label="Close lyrics"]')?.focus();
    let enteredFullscreen = document.fullscreenElement === content;
    const fullscreenChanged = () => {
      if (document.fullscreenElement === content) enteredFullscreen = true;
      else if (enteredFullscreen) dialog.close();
    };
    document.addEventListener('fullscreenchange', fullscreenChanged);
    return () => {
      document.body.style.overflow = overflow;
      document.removeEventListener('fullscreenchange', fullscreenChanged);
      if (document.fullscreenElement === content) document.exitFullscreen().catch(() => {});
    };
  }, [open]);

  function showFullscreen() {
    setMode(lines.length ? 'sylt' : 'uslt');
    dialogRef.current.showModal();
    setOpen(true);
    // Keep the viewport overlay available if native fullscreen is unsupported or denied.
    fullscreenRef.current.requestFullscreen?.().catch(() => {});
  }

  async function closeLyrics() {
    if (document.fullscreenElement === fullscreenRef.current) await document.exitFullscreen().catch(() => {});
    dialogRef.current?.close();
  }

  return <section className="public-media-panel public-media-lyrics" aria-labelledby="public-media-lyrics">
    <div className="public-media-section-heading">
      <h2 id="public-media-lyrics">Lyrics</h2>
      <button className="secondary-button compact-button" type="button" aria-expanded={expanded}
        aria-controls="public-media-lyrics-content" onClick={onToggle}>{expanded ? 'Hide lyrics' : 'Show lyrics'}</button>
      {expanded && hasLyrics && <button ref={fullscreenButtonRef} className="secondary-button compact-button" type="button" aria-haspopup="dialog"
        onClick={showFullscreen}><Maximize2 size={17} aria-hidden="true" />Fullscreen lyrics</button>}
    </div>
    <div id="public-media-lyrics-content" hidden={!expanded} aria-busy={loading}>
      {expanded && (loading ? <p role="status">Loading lyrics…</p> : error ? <div role="alert">
        <p>{error}</p><button className="secondary-button" type="button" onClick={onRetry}>Retry lyrics</button>
      </div> : <>
        {lines.length > 0 && <section aria-labelledby="public-media-timed-heading">
          <h3 id="public-media-timed-heading">Synchronized lyrics</h3>
          <p className="public-media-help">Choose a line to seek to that moment in the track.</p>
          <LyricTimeline lines={lines} position={position} disabled={!canSeek} onSeek={onSeek} formatTime={formatTime} />
        </section>}
        {plainLyrics.trim() && <section className="public-media-plain-section" aria-labelledby="public-media-plain-heading">
          <h3 id="public-media-plain-heading">Plain text lyrics</h3>
          <p className="public-media-plain-lyrics">{plainLyrics}</p>
        </section>}
        {!hasLyrics && <p className="public-media-empty">No lyrics are available for this track.</p>}
      </>)}
    </div>
    <dialog ref={dialogRef} className="lyrics-overlay public-lyrics-overlay" aria-label="Fullscreen lyrics"
      onCancel={(event) => { event.preventDefault(); closeLyrics(); }}
      onClose={() => { setOpen(false); fullscreenButtonRef.current?.focus(); }}>
      <div ref={fullscreenRef} className="lyrics-overlay-content">
        {open && <section className="music-lyrics" aria-label="Lyrics">
          <div className="section-title">
            <div><h2>Lyrics — {title}</h2></div>
            <div className="lyrics-actions">
              <div className="lyrics-tabs" role="group" aria-label="Lyrics type">
                <button type="button" aria-pressed={mode === 'sylt'} onClick={() => setMode('sylt')}>SYLT</button>
                <button type="button" aria-pressed={mode === 'uslt'} onClick={() => setMode('uslt')}>USLT</button>
              </div>
              <button className="music-icon-button" type="button" title="Close lyrics" aria-label="Close lyrics"
                onClick={closeLyrics}><X size={20} /></button>
            </div>
          </div>
          <LyricTimeline lines={lines} position={position} mode={mode} uslt={plainLyrics}
            disabled={!canSeek} onSeek={onSeek} formatTime={formatTime} />
        </section>}
      </div>
    </dialog>
  </section>;
}

export function PublicMediaView({
  media, loading = false, error = '', playbackError = '', elapsed = 0, duration = 0,
  audioRef, onProgress, onPlaybackError, onPlaybackReady, onSeek, onRetry,
  embedded = false, autoPlay = false, onEnded, navigation,
  canAddToLibrary = false, addingToLibrary = false, addedToLibrary = false, libraryError = '', onAddToLibrary,
  lyrics, lyricsExpanded = false, lyricsLoading = false, lyricsError = '', onToggleLyrics, onRetryLyrics
}) {
  const Container = embedded ? 'section' : 'main';
  const Heading = embedded ? 'h2' : 'h1';
  const isVideo = mediaType(media?.name) === 'video';
  const MediaElement = isVideo ? 'video' : 'audio';
  const title = displayText(media?.title, displayText(media?.name, 'Shared media'));
  const knownDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const position = Math.min(knownDuration, Math.max(0, Number.isFinite(elapsed) ? elapsed : 0));
  const canSeek = Boolean(media?.streamUrl && knownDuration && !playbackError);
  const lines = useMemo(() => (Array.isArray(lyrics?.sylt) ? lyrics.sylt : [])
    .filter((line) => Number.isFinite(line?.time) && line.time >= 0 && typeof line.text === 'string')
    .sort((a, b) => a.time - b.time), [lyrics?.sylt]);
  const plainLyrics = typeof lyrics?.uslt === 'string' ? lyrics.uslt : '';
  const rating = Number(media?.rating);

  return <Container className={`public-media-page${embedded ? ' public-media-embedded' : ''}`} aria-busy={loading}>
    {!embedded && <header className="public-media-masthead">
      <span className="public-media-brand"><img src={appIcon} alt="" width="34" height="34" />ssMusic</span>
      <span className="public-media-badge"><Headphones size={14} aria-hidden="true" />{isVideo ? 'Shared video' : 'Shared listening'}</span>
    </header>}

    {loading ? <section className="public-media-state" role="status">
      <Music2 size={32} aria-hidden="true" />
      <Heading>Loading shared media…</Heading>
      <p>Getting the track and its details ready.</p>
    </section> : error || !media ? <section className="public-media-state" role="alert">
      <Heading>Shared media unavailable</Heading>
      <p>{error || 'This link may have expired, been revoked, or the file is no longer available.'}</p>
      {onRetry && <button className="secondary-button public-media-retry" type="button" onClick={onRetry}>Try again</button>}
    </section> : <>
      <section className="public-media-hero" aria-labelledby="public-media-title">
        <div className="public-media-artwork">
          {media.artwork ? <img src={media.artwork} alt={`Album artwork for ${title}`} />
            : <Music2 size={72} strokeWidth={1} aria-hidden="true" />}
        </div>
        <div className="public-media-summary">
          <p className="public-media-eyebrow">{isVideo ? 'A video shared with you' : 'A track shared with you'}</p>
          <Heading id="public-media-title">{title}</Heading>
          <p className="public-media-artist">{displayText(media.artist, 'Unknown artist')}</p>
          <p className="public-media-album">{displayText(media.album, 'Unknown album')}</p>
          <p className="public-media-file"><span>{displayText(media.name, 'Media file')}</span><span>{formatSize(media.sizeBytes)}</span></p>
          {media.downloadUrl && <a className="primary-button public-media-download" href={media.downloadUrl} download={media.name || true}>
            <Download size={17} aria-hidden="true" />Save file
          </a>}
          {canAddToLibrary && <button className="secondary-button public-media-download" type="button"
            aria-haspopup="dialog" disabled={addingToLibrary || addedToLibrary} onClick={onAddToLibrary}>
            {addedToLibrary ? <Check size={17} aria-hidden="true" /> : <LibraryBig size={17} aria-hidden="true" />}
            {addedToLibrary ? 'Added to library' : addingToLibrary ? 'Adding to library...' : 'Add to my library'}
          </button>}
          {addedToLibrary && <p role="status">Added to your library.</p>}
          {libraryError && <p className="public-media-error" role="alert">{libraryError}</p>}
        </div>
      </section>

      <section className="public-media-player public-media-panel" aria-labelledby="public-media-listen">
        <div className="public-media-section-heading">
          <h2 id="public-media-listen">{isVideo ? 'Watch' : 'Listen'}</h2>
          {navigation || <span>Press play when you’re ready</span>}
        </div>
        {media.streamUrl ? <MediaElement ref={audioRef} controls preload="metadata" src={media.streamUrl} autoPlay={autoPlay || undefined}
          playsInline={isVideo || undefined} aria-label={`${isVideo ? 'Video' : 'Audio'} player for ${title}`}
          onLoadedMetadata={onProgress} onDurationChange={onProgress} onTimeUpdate={onProgress}
          onSeeked={onProgress} onEnded={onEnded || onProgress} onError={onPlaybackError}
          onCanPlay={onPlaybackReady} onPlaying={onPlaybackReady}>
          Your browser does not support {isVideo ? 'video' : 'audio'} playback. Use Save file to play it locally.
        </MediaElement> : <p className="public-media-error" role="alert">Playback is unavailable. You can still save the file.</p>}
        {playbackError && <p className="public-media-error" role="alert">{playbackError}</p>}
      </section>

      <div className="public-media-columns">
        <section className="public-media-panel" aria-labelledby="public-media-details">
          <div className="public-media-section-heading"><h2 id="public-media-details">Track details</h2><span>Read only</span></div>
          <dl className="public-media-metadata">
            {metadataFields.map(([field, label]) => <div key={field}><dt>{label}</dt><dd>{displayText(media[field])}</dd></div>)}
            <div><dt>Rating</dt><dd>{rating > 0 && rating <= 5 ? `${rating} of 5 stars` : 'Unrated'}</dd></div>
            <div><dt>File name</dt><dd>{displayText(media.name)}</dd></div>
            <div><dt>File size</dt><dd>{formatSize(media.sizeBytes)}</dd></div>
          </dl>
        </section>

        <PublicLyrics lines={lines} plainLyrics={plainLyrics} title={title} position={position}
          canSeek={canSeek} onSeek={onSeek} expanded={lyricsExpanded} loading={lyricsLoading}
          error={lyricsError} onToggle={onToggleLyrics} onRetry={onRetryLyrics} />
      </div>
    </>}
    {!embedded && <footer className="public-media-footer">Shared for {isVideo ? 'viewing' : 'listening'}. No account needed.</footer>}
  </Container>;
}

export function sharedImportDestinations(library, userId) {
  const jobs = new Map(library.jobs.map((job) => [job.id, job]));
  return sortSelectOptions([
    ...Object.entries(individualPlaylistNames).map(([id, title]) => ({ id, title })),
    ...library.entries.filter((entry) => entry.type === 'playlist' && !Object.hasOwn(individualPlaylistNames, entry.id)
      && jobs.get(entry.id)?.initiatedBy?.id === userId)
      .map((entry) => ({ id: entry.id, title: jobs.get(entry.id).playlistTitle || entry.name || 'Playlist' }))
  ], (playlist) => playlist.title);
}

export function PublicLibraryDialog({ media, userId, request, endpoint, onAdded, onClose }) {
  const dialogRef = useRef(null);
  const busyRef = useRef(false);
  const headingId = useId();
  const destinationId = useId();
  const nameId = useId();
  const [destinations, setDestinations] = useState(null);
  const [destination, setDestination] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    dialog.showModal();
    return () => { dialog.close(); if (previousFocus?.isConnected) previousFocus.focus(); };
  }, []);

  useEffect(() => {
    let active = true;
    setError('');
    request('/api/library').then((library) => {
      const options = sharedImportDestinations(library, userId);
      if (active) setDestinations(options);
    }).catch((loadError) => { if (active) setError(loadError.message || 'Unable to load playlists.'); });
    return () => { active = false; };
  }, [request, userId, attempt]);

  async function submit(event) {
    event.preventDefault();
    if (busyRef.current || !destinations || !destination || (destination === 'new' && !name.trim())) return;
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      let playlistId = destination;
      if (destination === 'new') {
        const result = await request('/api/library/playlists', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ playlistTitle: name.trim() })
        });
        playlistId = result.job.id;
        setDestinations((current) => sortSelectOptions([...current, { id: playlistId, title: result.job.playlistTitle || name.trim() }], (playlist) => playlist.title));
        setDestination(playlistId);
        setName('');
      }
      await request(endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ playlistId })
      });
      onAdded();
      onClose();
    } catch (submitError) { setError(submitError.message || 'Unable to add this song. Please try again.'); }
    finally { busyRef.current = false; setBusy(false); }
  }

  return <dialog ref={dialogRef} className="confirmation-dialog folder-dialog" aria-labelledby={headingId}
    onCancel={(event) => { event.preventDefault(); if (!busyRef.current) onClose(); }}>
    <form onSubmit={submit}>
      <div className="folder-dialog-heading"><h2 id={headingId}>Add to my library</h2>
        <button className="music-icon-button" type="button" title="Close" aria-label="Close add to library" disabled={busy} onClick={onClose}><X size={18} /></button></div>
      <p>{displayText(media.title, media.name)}</p>
      {!destinations && !error && <p role="status">Loading playlists...</p>}
      {destinations && <><label htmlFor={destinationId}>Destination playlist</label>
        <select id={destinationId} required value={destination} disabled={busy} onChange={(event) => setDestination(event.target.value)}>
          <option value="" disabled>Choose a playlist</option>
          {destinations.map((playlist) => <option key={playlist.id} value={playlist.id}>{playlist.title}</option>)}
          <option value="new">Create new playlist...</option>
        </select>
        {destination === 'new' && <><label htmlFor={nameId}>Playlist name</label>
          <input id={nameId} required maxLength={200} value={name} disabled={busy} onChange={(event) => setName(event.target.value)} /></>}
      </>}
      {error && <p className="notice error" role="alert">{error}</p>}
      {!destinations && error && <button className="secondary-button" type="button" onClick={() => setAttempt((value) => value + 1)}><RefreshCw size={17} />Retry playlists</button>}
      <div className="dialog-actions"><button className="secondary-button" type="button" disabled={busy} onClick={onClose}>Cancel</button>
        <button className="primary-button" type="submit" disabled={busy || !destinations || !destination || (destination === 'new' && !name.trim())}>
          {busy ? <RefreshCw className="spin" size={17} /> : <LibraryBig size={17} />}{busy ? 'Adding...' : 'Add song'}
        </button></div>
    </form>
  </dialog>;
}

function PublicMediaPage({ token, request, endpoint, embedded = false, autoPlay = false, onEnded, navigation, playbackRef }) {
  const [state, setState] = useState({ loading: true, media: null, error: '' });
  const [attempt, setAttempt] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackError, setPlaybackError] = useState('');
  const [lyricsState, setLyricsState] = useState({ lyrics: null, loading: false, error: '' });
  const [lyricsExpanded, setLyricsExpanded] = useState(false);
  const lyricsLoaderRef = useRef(null);
  const internalAudioRef = useRef(null);
  const audioRef = playbackRef || internalAudioRef;
  const [user, setUser] = useState(null);
  const [addedToLibrary, setAddedToLibrary] = useState(false);
  const [showLibraryDialog, setShowLibraryDialog] = useState(false);

  useEffect(() => {
    let active = true;
    request('/api/auth/me').then((result) => { if (active) setUser(result.user); })
      .catch(() => { if (active) setUser(null); });
    return () => { active = false; };
  }, [request]);

  useEffect(() => {
    let active = true;
    setState({ loading: true, media: null, error: '' });
    setElapsed(0);
    setDuration(0);
    setPlaybackError('');
    async function load() {
      try {
        if (!token && !endpoint) throw new Error('Missing link');
        const media = await request(endpoint || `/api/public/media/${encodeURIComponent(token)}`);
        if (!media || typeof media !== 'object' || !media.streamUrl || !media.downloadUrl) throw new Error('Unavailable media');
        if (active) setState({ loading: false, media, error: '' });
      } catch {
        if (active) setState({ loading: false, media: null,
          error: 'This link may have expired, been revoked, or the file is no longer available. Check your connection or ask the sender for a new link.' });
      }
    }
    load();
    return () => { active = false; };
  }, [token, endpoint, request, attempt]);

  useEffect(() => {
    setLyricsExpanded(false);
    setLyricsState({ lyrics: null, loading: false, error: '' });
    const loader = createPublicLyricsLoader(request, state.media?.lyricsUrl, setLyricsState);
    lyricsLoaderRef.current = loader;
    return () => { loader.stop(); };
  }, [request, state.media]);

  function toggleLyrics() {
    if (!lyricsExpanded) lyricsLoaderRef.current?.load();
    setLyricsExpanded(!lyricsExpanded);
  }

  function updateProgress(event) {
    const audio = event.currentTarget;
    setElapsed(Number.isFinite(audio.currentTime) ? audio.currentTime : 0);
    setDuration(Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : 0);
  }

  function seek(seconds) {
    try {
      const position = seekPublicAudio(audioRef.current, seconds);
      if (position !== null) setElapsed(position);
    } catch {
      setPlaybackError('Could not seek this media. Try the playback controls or save the file to play it locally.');
    }
  }

  return <><PublicMediaView {...state} audioRef={audioRef} elapsed={elapsed} duration={duration} playbackError={playbackError}
    canAddToLibrary={Boolean(user?.status === 'approved' && !['shared', 'catalog'].includes(user.role))}
    addedToLibrary={addedToLibrary} onAddToLibrary={() => setShowLibraryDialog(true)}
    lyrics={lyricsState.lyrics} lyricsExpanded={lyricsExpanded} lyricsLoading={lyricsState.loading}
    lyricsError={lyricsState.error} onToggleLyrics={toggleLyrics} onRetryLyrics={() => lyricsLoaderRef.current?.load()}
    embedded={embedded} autoPlay={autoPlay} onEnded={onEnded} navigation={navigation}
    onProgress={updateProgress} onSeek={seek}
    onPlaybackError={() => setPlaybackError('This media could not be played. The link may no longer be available, or your browser may not support this format. Try saving the file to play it locally.')}
    onPlaybackReady={() => setPlaybackError('')} onRetry={token || endpoint ? () => setAttempt((value) => value + 1) : undefined} />
    {showLibraryDialog && state.media && user && <PublicLibraryDialog media={state.media} userId={user.id} request={request}
      endpoint={(endpoint || `/api/public/media/${encodeURIComponent(token)}`).replace('/api/public/', '/api/library/shares/')}
      onAdded={() => setAddedToLibrary(true)} onClose={() => setShowLibraryDialog(false)} />}
  </>;
}

export function PublicPlaylistView({ playlist, loading, error, selectedId, onSelect, onPage, onRetry, children }) {
  return <main className="public-media-page public-playlist-page" aria-busy={loading}>
    <header className="public-media-masthead">
      <span className="public-media-brand"><img src={appIcon} alt="" width="34" height="34" />ssMusic</span>
      <span className="public-media-badge"><ListMusic size={16} aria-hidden="true" />Shared playlist</span>
    </header>
    <header className="public-playlist-heading"><h1>{displayText(playlist?.title, 'Shared playlist')}</h1>
      {playlist && <span>{playlist.total.toLocaleString()} {playlist.total === 1 ? 'song' : 'songs'}</span>}
    </header>
    {loading ? <p className="public-media-empty" role="status">Loading shared playlist...</p>
      : error ? <section className="public-media-state" role="alert"><h2>Playlist unavailable</h2><p>{error}</p>
        <button className="secondary-button" type="button" onClick={onRetry}>Try again</button></section>
        : playlist?.tracks.length ? <div className="public-playlist-layout">
          <section className="public-playlist-tracks" aria-label="Playlist songs">
            <ol start={(playlist.page - 1) * playlist.pageSize + 1}>
              {playlist.tracks.map((track, index) => <li key={track.id}>
                <button className="public-playlist-track" type="button" aria-current={track.id === selectedId ? 'true' : undefined}
                  aria-label={`Play ${displayText(track.title, track.name)}`} title={displayText(track.title, track.name)} onClick={() => onSelect(track)}>
                  <span className="public-playlist-number">{track.id === selectedId ? <Play size={16} aria-hidden="true" /> : (playlist.page - 1) * playlist.pageSize + index + 1}</span>
                  <span><strong>{displayText(track.title, track.name)}</strong><small>{displayText(track.artist, 'Unknown artist')}</small></span>
                </button>
                <a className="music-icon-button" href={track.downloadUrl} download={track.name} title={`Save ${track.name}`} aria-label={`Save ${track.name}`}><Download size={17} /></a>
              </li>)}
            </ol>
            <nav className="track-pagination" aria-label="Playlist pages">
              <span>Page {playlist.page} of {playlist.totalPages}</span><div>
                <button className="music-icon-button" type="button" title="Previous page" aria-label="Previous playlist page" disabled={playlist.page <= 1} onClick={() => onPage(playlist.page - 1)}><ChevronLeft size={18} /></button>
                <button className="music-icon-button" type="button" title="Next page" aria-label="Next playlist page" disabled={playlist.page >= playlist.totalPages} onClick={() => onPage(playlist.page + 1)}><ChevronRight size={18} /></button>
              </div>
            </nav>
          </section>
          <div className="public-playlist-current">{children}</div>
        </div> : <p className="public-media-empty" role="status">No public songs are available in this playlist.</p>}
    <footer className="public-media-footer">Shared for listening. No account needed.</footer>
  </main>;
}

export function PublicPlaylist({ token, request }) {
  const [page, setPage] = useState(1);
  const [state, setState] = useState({ playlist: null, loading: true, error: '' });
  const [selectedId, setSelectedId] = useState(null);
  const [autoPlay, setAutoPlay] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const selectLast = useRef(false);
  const playbackRef = useRef(null);

  useEffect(() => {
    let active = true;
    setState({ playlist: null, loading: true, error: '' });
    request(`/api/public/playlists/${encodeURIComponent(token)}?page=${page}`).then((playlist) => {
      if (!Array.isArray(playlist?.tracks)) throw new Error('Unavailable playlist');
      if (!active) return;
      setState({ playlist, loading: false, error: '' });
      const preferLast = selectLast.current;
      selectLast.current = false;
      setSelectedId((current) => playlist.tracks.some((track) => track.id === current) ? current
        : (preferLast ? playlist.tracks.at(-1)?.id : playlist.tracks[0]?.id) || null);
    }).catch(() => {
      if (active) setState({ playlist: null, loading: false,
        error: 'This playlist is no longer available. Check your connection or ask the sender for a new link.' });
    });
    return () => { active = false; };
  }, [token, request, page, attempt]);

  const playlist = state.playlist;
  const index = playlist?.tracks.findIndex((track) => track.id === selectedId) ?? -1;
  const selected = playlist?.tracks[index];
  const hasPrevious = Boolean(selected && (index > 0 || playlist.page > 1));
  const hasNext = Boolean(selected && (index < playlist.tracks.length - 1 || playlist.page < playlist.totalPages));

  function choose(track) {
    if (track.id === selectedId) playbackRef.current?.play().catch(() => {});
    else { setAutoPlay(true); setSelectedId(track.id); }
  }

  function advance(direction) {
    if (!selected || (direction < 0 ? !hasPrevious : !hasNext)) return;
    setAutoPlay(true);
    const next = playlist.tracks[index + direction];
    if (next) setSelectedId(next.id);
    else {
      selectLast.current = direction < 0;
      setSelectedId(null);
      setPage(playlist.page + direction);
    }
  }

  return <PublicPlaylistView {...state} selectedId={selectedId} onSelect={choose}
    onPage={(next) => { selectLast.current = false; setAutoPlay(false); setSelectedId(null); setPage(next); }}
    onRetry={() => setAttempt((value) => value + 1)}>
    {selected && <PublicMediaPage key={selected.id} endpoint={selected.metadataUrl} request={request}
      embedded autoPlay={autoPlay} playbackRef={playbackRef} onEnded={() => advance(1)} navigation={<div className="public-playlist-transport">
        <button className="music-icon-button" type="button" title="Previous song" aria-label="Previous playlist song" disabled={!hasPrevious} onClick={() => advance(-1)}><SkipBack size={19} /></button>
        <button className="music-icon-button" type="button" title="Next song" aria-label="Next playlist song" disabled={!hasNext} onClick={() => advance(1)}><SkipForward size={19} /></button>
      </div>} />}
  </PublicPlaylistView>;
}

export default function PublicMedia({ token, request }) {
  return <PublicMediaPage key={token} token={token} request={request} />;
}
