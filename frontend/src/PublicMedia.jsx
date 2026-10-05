import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Download, Headphones, ListMusic, Maximize2, Music2, Play, SkipBack, SkipForward, X } from 'lucide-react';
import LyricTimeline from './LyricTimeline.jsx';
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

export function PublicLyrics({ lines, plainLyrics, title, position, canSeek, onSeek }) {
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
      {hasLyrics && <button ref={fullscreenButtonRef} className="secondary-button compact-button" type="button" aria-haspopup="dialog"
        onClick={showFullscreen}><Maximize2 size={17} aria-hidden="true" />Fullscreen lyrics</button>}
    </div>
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
  embedded = false, autoPlay = false, onEnded, navigation
}) {
  const Container = embedded ? 'section' : 'main';
  const Heading = embedded ? 'h2' : 'h1';
  const title = displayText(media?.title, displayText(media?.name, 'Shared audio'));
  const knownDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const position = Math.min(knownDuration, Math.max(0, Number.isFinite(elapsed) ? elapsed : 0));
  const canSeek = Boolean(media?.streamUrl && knownDuration && !playbackError);
  const lines = useMemo(() => (Array.isArray(media?.sylt) ? media.sylt : [])
    .filter((line) => Number.isFinite(line?.time) && line.time >= 0 && typeof line.text === 'string')
    .sort((a, b) => a.time - b.time), [media?.sylt]);
  const plainLyrics = typeof media?.uslt === 'string' ? media.uslt : '';
  const rating = Number(media?.rating);

  return <Container className={`public-media-page${embedded ? ' public-media-embedded' : ''}`} aria-busy={loading}>
    {!embedded && <header className="public-media-masthead">
      <span className="public-media-brand"><img src={appIcon} alt="" width="34" height="34" />ssMusic</span>
      <span className="public-media-badge"><Headphones size={14} aria-hidden="true" />Shared listening</span>
    </header>}

    {loading ? <section className="public-media-state" role="status">
      <Music2 size={32} aria-hidden="true" />
      <Heading>Loading shared audio…</Heading>
      <p>Getting the track and its details ready.</p>
    </section> : error || !media ? <section className="public-media-state" role="alert">
      <Heading>Shared audio unavailable</Heading>
      <p>{error || 'This link may have expired, been revoked, or the file is no longer available.'}</p>
      {onRetry && <button className="secondary-button public-media-retry" type="button" onClick={onRetry}>Try again</button>}
    </section> : <>
      <section className="public-media-hero" aria-labelledby="public-media-title">
        <div className="public-media-artwork">
          {media.artwork ? <img src={media.artwork} alt={`Album artwork for ${title}`} />
            : <Music2 size={72} strokeWidth={1} aria-hidden="true" />}
        </div>
        <div className="public-media-summary">
          <p className="public-media-eyebrow">A track shared with you</p>
          <Heading id="public-media-title">{title}</Heading>
          <p className="public-media-artist">{displayText(media.artist, 'Unknown artist')}</p>
          <p className="public-media-album">{displayText(media.album, 'Unknown album')}</p>
          <p className="public-media-file"><span>{displayText(media.name, 'Audio file')}</span><span>{formatSize(media.sizeBytes)}</span></p>
          {media.downloadUrl && <a className="primary-button public-media-download" href={media.downloadUrl} download={media.name || true}>
            <Download size={17} aria-hidden="true" />Save file
          </a>}
        </div>
      </section>

      <section className="public-media-player public-media-panel" aria-labelledby="public-media-listen">
        <div className="public-media-section-heading">
          <h2 id="public-media-listen">Listen</h2>
          {navigation || <span>Press play when you’re ready</span>}
        </div>
        {media.streamUrl ? <audio ref={audioRef} controls preload="metadata" src={media.streamUrl} autoPlay={autoPlay || undefined}
          aria-label={`Audio player for ${title}`}
          onLoadedMetadata={onProgress} onDurationChange={onProgress} onTimeUpdate={onProgress}
          onSeeked={onProgress} onEnded={onEnded || onProgress} onError={onPlaybackError}
          onCanPlay={onPlaybackReady} onPlaying={onPlaybackReady}>
          Your browser does not support audio playback. Use Save file to listen locally.
        </audio> : <p className="public-media-error" role="alert">Audio playback is unavailable. You can still save the file.</p>}
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
          canSeek={canSeek} onSeek={onSeek} />
      </div>
    </>}
    {!embedded && <footer className="public-media-footer">Shared for listening. No account needed.</footer>}
  </Container>;
}

function PublicMediaPage({ token, request, endpoint, embedded = false, autoPlay = false, onEnded, navigation, playbackRef }) {
  const [state, setState] = useState({ loading: true, media: null, error: '' });
  const [attempt, setAttempt] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackError, setPlaybackError] = useState('');
  const internalAudioRef = useRef(null);
  const audioRef = playbackRef || internalAudioRef;

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
      setPlaybackError('Could not seek this audio. Try the audio controls or save the file to listen locally.');
    }
  }

  return <PublicMediaView {...state} audioRef={audioRef} elapsed={elapsed} duration={duration} playbackError={playbackError}
    embedded={embedded} autoPlay={autoPlay} onEnded={onEnded} navigation={navigation}
    onProgress={updateProgress} onSeek={seek}
    onPlaybackError={() => setPlaybackError('This audio could not be played. The link may no longer be available, or your browser may not support this format. Try saving the file to listen locally.')}
    onPlaybackReady={() => setPlaybackError('')} onRetry={token || endpoint ? () => setAttempt((value) => value + 1) : undefined} />;
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
