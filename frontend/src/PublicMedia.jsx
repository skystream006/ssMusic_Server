import { useEffect, useMemo, useRef, useState } from 'react';
import { Download, Headphones, Maximize2, Music2, X } from 'lucide-react';
import LyricTimeline from './LyricTimeline.jsx';
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
  audioRef, onProgress, onPlaybackError, onPlaybackReady, onSeek, onRetry
}) {
  const title = displayText(media?.title, displayText(media?.name, 'Shared audio'));
  const knownDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const position = Math.min(knownDuration, Math.max(0, Number.isFinite(elapsed) ? elapsed : 0));
  const canSeek = Boolean(media?.streamUrl && knownDuration && !playbackError);
  const lines = useMemo(() => (Array.isArray(media?.sylt) ? media.sylt : [])
    .filter((line) => Number.isFinite(line?.time) && line.time >= 0 && typeof line.text === 'string')
    .sort((a, b) => a.time - b.time), [media?.sylt]);
  const plainLyrics = typeof media?.uslt === 'string' ? media.uslt : '';
  const rating = Number(media?.rating);

  return <main className="public-media-page" aria-busy={loading}>
    <header className="public-media-masthead">
      <span className="public-media-brand"><Music2 size={20} aria-hidden="true" />ssYTDLP</span>
      <span className="public-media-badge"><Headphones size={14} aria-hidden="true" />Shared listening</span>
    </header>

    {loading ? <section className="public-media-state" role="status">
      <Music2 size={32} aria-hidden="true" />
      <h1>Loading shared audio…</h1>
      <p>Getting the track and its details ready.</p>
    </section> : error || !media ? <section className="public-media-state" role="alert">
      <h1>Shared audio unavailable</h1>
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
          <h1 id="public-media-title">{title}</h1>
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
          <span>Press play when you’re ready</span>
        </div>
        {media.streamUrl ? <audio ref={audioRef} controls preload="metadata" src={media.streamUrl}
          aria-label={`Audio player for ${title}`}
          onLoadedMetadata={onProgress} onDurationChange={onProgress} onTimeUpdate={onProgress}
          onSeeked={onProgress} onEnded={onProgress} onError={onPlaybackError}
          onCanPlay={onPlaybackReady} onPlaying={onPlaybackReady}>
          Your browser does not support audio playback. Use Save file to listen locally.
        </audio> : <p className="public-media-error" role="alert">Audio playback is unavailable. You can still save the file.</p>}
        <div className="public-media-seek-heading">
          <label htmlFor="public-media-seek">Playback position</label>
          <span id="public-media-times">
            <span aria-label="Elapsed time">{formatTime(position)}</span>
            <span aria-hidden="true"> / </span>
            <span aria-label="Duration">{knownDuration ? formatTime(knownDuration) : '—:—'}</span>
          </span>
        </div>
        <input id="public-media-seek" className="public-media-seek" type="range" min="0" max={knownDuration || 1}
          step="0.1" value={position} disabled={!canSeek} aria-label="Seek audio" aria-describedby="public-media-times"
          aria-valuetext={`${formatTime(position)} of ${knownDuration ? formatTime(knownDuration) : 'unknown duration'}`}
          onChange={(event) => onSeek?.(Number(event.target.value))} />
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
    <footer className="public-media-footer">Shared for listening. No account needed.</footer>
  </main>;
}

function PublicMediaPage({ token, request }) {
  const [state, setState] = useState({ loading: true, media: null, error: '' });
  const [attempt, setAttempt] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackError, setPlaybackError] = useState('');
  const audioRef = useRef(null);

  useEffect(() => {
    let active = true;
    setState({ loading: true, media: null, error: '' });
    setElapsed(0);
    setDuration(0);
    setPlaybackError('');
    async function load() {
      try {
        if (!token) throw new Error('Missing link');
        const media = await request(`/api/public/media/${encodeURIComponent(token)}`);
        if (!media || typeof media !== 'object' || !media.streamUrl || !media.downloadUrl) throw new Error('Unavailable media');
        if (active) setState({ loading: false, media, error: '' });
      } catch {
        if (active) setState({ loading: false, media: null,
          error: 'This link may have expired, been revoked, or the file is no longer available. Check your connection or ask the sender for a new link.' });
      }
    }
    load();
    return () => { active = false; };
  }, [token, request, attempt]);

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
    onProgress={updateProgress} onSeek={seek}
    onPlaybackError={() => setPlaybackError('This audio could not be played. The link may no longer be available, or your browser may not support this format. Try saving the file to listen locally.')}
    onPlaybackReady={() => setPlaybackError('')} onRetry={token ? () => setAttempt((value) => value + 1) : undefined} />;
}

export default function PublicMedia({ token, request }) {
  return <PublicMediaPage key={token} token={token} request={request} />;
}
