import { createContext, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowLeft, ArrowRightLeft, Check, ChevronLeft, ChevronRight, Copy, Disc3, Folder, GripVertical, Link, ListChecks, ListMusic, Mic, Mic2, MicVocal, Music2, Pause, Pencil, Play, Plus, RefreshCw, Repeat, Save, Search, Share2, Shuffle, SkipBack, SkipForward, Trash2, Upload, Volume2, VolumeX, X } from 'lucide-react';
import { ListSongRating, SongActions, transcriptionInactiveMessage, TranscriptionStatus } from './SongActions.jsx';
import { allowDrop, leaveDrop } from './touchControls.js';
import { navigationHistory } from './navigation.js';
import { findNoVocals, isNoVocals, songSearchText } from '../../src/library.js';
import { mediaType } from '../../src/media.js';
import { buildLyricsUpdate, formatSyltForEdit } from './lyricsEditing.js';
import { Film, Minimize2 } from 'lucide-react';
export { findNoVocals, isNoVocals } from '../../src/library.js';

function timeLabel(seconds) {
  const total = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function formatLyricsForCopy(metadata, mode) {
  if (mode !== 'sylt') return metadata?.uslt || '';
  return (metadata?.sylt || []).map((line) => {
    const milliseconds = Math.max(0, Math.round(line.time * 1000));
    const minutes = String(Math.floor(milliseconds / 60000)).padStart(2, '0');
    const seconds = String(Math.floor(milliseconds / 1000) % 60).padStart(2, '0');
    const fraction = String(milliseconds % 1000).padStart(3, '0');
    return `[${minutes}:${seconds}.${fraction}] ${line.text}`;
  }).join('\n');
}

export function LyricsEditor({ metadata, name, mode, onSave, onCancel }) {
  const helpId = useId();
  const [sylt, setSylt] = useState(() => formatSyltForEdit(metadata.sylt));
  const [uslt, setUslt] = useState(metadata.uslt || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const { updates, validationError } = useMemo(() => {
    try { return { updates: buildLyricsUpdate(metadata, sylt, uslt), validationError: '' }; }
    catch (validationError) { return { updates: {}, validationError: validationError.message }; }
  }, [metadata, sylt, uslt]);

  function changeText(value) {
    if (mode === 'uslt') setUslt(value);
    else setSylt(value);
    setError('');
  }

  async function save(event) {
    event.preventDefault();
    if (saving || validationError || !Object.keys(updates).length) return;
    setError('');
    setSaving(true);
    try { await onSave(updates); onCancel(); }
    catch (saveError) { setError(saveError.message); }
    finally { setSaving(false); }
  }

  return <form className="lyrics-editor" aria-label="Edit lyrics" onSubmit={save}>
    <p className="metadata-filename">{name}</p>
    <p className="lyrics-editor-help" id={helpId}>{mode === 'uslt'
      ? 'Plain lyrics, up to 100,000 characters. Clear to remove USLT.'
      : 'One [HH:MM:SS.mmm] text per line; edit times/text, add or delete lines. Blank rows are ignored; a timestamp alone keeps an empty lyric. Use \\n for a line break and \\\\ for a backslash. Up to 10,000 lines / 100,000 text characters. Clear to remove SYLT.'}</p>
    <fieldset disabled={saving}>
      <textarea className={`lyrics-text-editor${mode === 'sylt' ? ' lyrics-sylt-editor' : ''}`}
        aria-label={mode === 'uslt' ? 'USLT lyrics' : 'SYLT lyrics'} aria-describedby={helpId}
        value={mode === 'uslt' ? uslt : sylt} maxLength={mode === 'uslt' ? 100000 : undefined}
        spellCheck={mode === 'uslt'} onChange={(event) => changeText(event.target.value)} />
    </fieldset>
    {(validationError || error) && <p className="notice error" role="alert">{validationError || error}</p>}
    <div className="dialog-actions">
      <button className="secondary-button" type="button" disabled={saving || !(mode === 'uslt' ? uslt : sylt)}
        onClick={() => changeText('')}>Clear {mode === 'uslt' ? 'USLT' : 'SYLT'}</button>
      <button className="secondary-button" type="button" disabled={saving} onClick={onCancel}><X size={17} />Cancel</button>
      <button className="primary-button" type="submit" disabled={saving || Boolean(validationError) || !Object.keys(updates).length}>
        {saving ? <RefreshCw className="spin" size={17} /> : <Save size={17} />}{saving ? 'Saving...' : 'Save lyrics'}</button>
    </div>
  </form>;
}

const PlaybackContext = createContext(null);

export function queueSongNext(songs, selected, track) {
  const key = (item) => JSON.stringify([item.jobId, item.name]);
  if (selected === key(track)) return songs || [track];
  const queue = (songs || []).filter((item) => key(item) !== key(track));
  const index = queue.findIndex((item) => key(item) === selected);
  queue.splice(index + 1, 0, track);
  return queue;
}

export function replaceSongFile(tracks, jobId, name, file) {
  const matches = (track) => track?.jobId === jobId && track.name === name;
  const replace = (track) => ({ ...track, ...file, transcription: undefined });
  return tracks?.map((track) => matches(track) ? replace(track)
    : matches(track.noVocalsVersion) ? { ...track, noVocalsVersion: replace(track.noVocalsVersion) } : track);
}

export function SongGroups({ tracks, children }) {
  const originals = tracks.filter((track) => !isNoVocals(track));
  const noVocals = tracks.filter(isNoVocals);
  return <>
    {children(originals)}
    {noVocals.length > 0 && <details className="no-vocals-section">
      <summary>[NoVocals] <span>{noVocals.length}</span></summary>
      {children(noVocals)}
    </details>}
  </>;
}

function KaraokeButton({ track, tracks, onPlay }) {
  const version = track && mediaType(track.name) !== 'video' && !isNoVocals(track) && (track.noVocalsVersion || findNoVocals(track, tracks || []));
  return version ? <button className="music-icon-button karaoke-button" type="button" title="Play karaoke (NoVocals)"
    aria-label={`Play karaoke version of ${track.title || track.name}`} onClick={() => onPlay(version)}><MicVocal size={18} /></button> : null;
}

function TrackPagination({ pagination, position }) {
  const { page, pageSize, total, totalPages, loading, onChange } = pagination;
  return <nav className="track-pagination" aria-label={`Track pages ${position}`}>
    <span role="status">{total ? `${(page - 1) * pageSize + 1}-${Math.min(page * pageSize, total)} of ${total}` : '0 tracks'}</span>
    <div>
      <button className="music-icon-button" type="button" title="Previous page" aria-label="Previous track page" disabled={loading || page <= 1} onClick={() => onChange(page - 1)}><ChevronLeft size={18} /></button>
      <label>Page<select aria-label="Track page" value={page} disabled={loading || totalPages <= 1} onChange={(event) => onChange(Number(event.target.value))}>
        {Array.from({ length: totalPages }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1}</option>)}
      </select><span>of {totalPages}</span></label>
      <button className="music-icon-button" type="button" title="Next page" aria-label="Next track page" disabled={loading || page >= totalPages} onClick={() => onChange(page + 1)}><ChevronRight size={18} /></button>
    </div>
  </nav>;
}

export function usePlayback() { return useContext(PlaybackContext); }

export function PlaybackProvider({ children, request }) {
  const [songs, setSongs] = useState(null);
  const [selected, setSelected] = useState(null);
  const selectedRef = useRef(null);
  selectedRef.current = selected;
  const [metadata, setMetadata] = useState(null);
  const [lyricError, setLyricError] = useState('');
  const [playError, setPlayError] = useState('');
  const [mode, setMode] = useState('sylt');
  const [copying, setCopying] = useState(false);
  const [copyResult, setCopyResult] = useState(null);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState(false);
  const [videoOpen, setVideoOpen] = useState(true);
  const audioRef = useRef(null);
  const autoPlayRef = useRef(new URLSearchParams(window.location.search).get('play') === '1');
  const volumeRef = useRef(1);
  const mutedRef = useRef(false);
  const queueScopeRef = useRef(undefined);
  const songKey = (track) => JSON.stringify([track.jobId, track.name]);
  const index = songs?.findIndex((track) => songKey(track) === selected) ?? -1;
  const song = songs?.[index];
  const isVideo = mediaType(song?.name) === 'video';
  const lyricsText = formatLyricsForCopy(metadata, mode);
  const currentCopy = copyResult?.song === selected && copyResult?.mode === mode ? copyResult : null;

  async function copyLyrics() {
    if (copying || !lyricsText.trim()) return;
    setCopying(true);
    setCopyResult(null);
    try {
      await navigator.clipboard.writeText(lyricsText);
      setCopyResult({ song: selected, mode, message: 'Lyrics copied.', error: false });
    } catch {
      setCopyResult({ song: selected, mode, message: 'Unable to copy lyrics. Check clipboard permissions and try again.', error: true });
    } finally {
      setCopying(false);
    }
  }

  useEffect(() => {
    let active = true;
    setMetadata(null);
    setLyricError('');
    setPlayError('');
    setPosition(0);
    setDuration(0);
    setPlaying(false);
    if (song && isVideo) {
      setMetadata({ title: song.title || song.name.split('/').at(-1).replace(/\.[^.]+$/, ''), artist: song.artist || '', sylt: [], uslt: '' });
      setVideoOpen(true);
    } else if (song) {
      request(`/api/jobs/${encodeURIComponent(song.jobId)}/lyrics/${encodeURIComponent(song.name)}`)
        .then((result) => { if (active) setMetadata(result); })
        .catch((error) => { if (active) setLyricError(error.message); });
    }
    return () => { active = false; };
  }, [song?.jobId, song?.name, song?.streamUrl, request]);

  function selectSong(track, queue = songs, scope = queueScopeRef.current) {
    autoPlayRef.current = true;
    queueScopeRef.current = scope;
    setSongs(queue);
    const key = songKey(track);
    if (selected === key) {
      if (mediaType(track.name) === 'video') setVideoOpen(true);
      audioRef.current?.play().catch(() => setPlayError('Playback could not start. Press play to retry.'));
    } else setSelected(key);
  }

  function nextSong(ended = false) {
    if (!songs?.length) return;
    if (shuffle && songs.length > 1) {
      const others = songs.filter((track) => songKey(track) !== selected);
      selectSong(others[Math.floor(Math.random() * others.length)]);
    } else if (index + 1 < songs.length) selectSong(songs[index + 1]);
    else if (repeat) {
      if (songs.length === 1 && audioRef.current) audioRef.current.currentTime = 0;
      selectSong(songs[0]);
    } else if (ended) setPlaying(false);
  }

  function playKaraoke(track) {
    if (selected === songKey(track) && audioRef.current) audioRef.current.currentTime = 0;
    selectSong(track, queueSongNext(songs, selected, track), Symbol('karaoke'));
  }

  function previousSong() {
    if (audioRef.current?.currentTime > 3 || index === 0) audioRef.current.currentTime = 0;
    else if (index > 0) selectSong(songs[index - 1]);
  }

  function togglePlayback() {
    if (!audioRef.current) return;
    if (audioRef.current.paused) {
      autoPlayRef.current = true;
      audioRef.current.play().catch(() => setPlayError('Playback could not start. Press play to retry.'));
    } else audioRef.current.pause();
  }

  const MediaElement = isVideo ? 'video' : 'audio';
  const media = song && <MediaElement hidden={!isVideo} controls={isVideo} playsInline={isVideo} key={song.streamUrl} ref={audioRef} src={song.streamUrl} autoPlay={autoPlayRef.current} preload="metadata"
    aria-label={`Play ${song.name}`}
    onLoadedMetadata={(event) => {
      event.currentTarget.volume = volumeRef.current;
      event.currentTarget.muted = mutedRef.current;
      setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0);
    }}
    onDurationChange={(event) => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)}
    onVolumeChange={(event) => {
      volumeRef.current = event.currentTarget.volume;
      mutedRef.current = event.currentTarget.muted;
      setVolume(event.currentTarget.volume);
      setMuted(event.currentTarget.muted);
    }}
    onTimeUpdate={(event) => setPosition(event.currentTarget.currentTime)}
    onPlay={() => { setPlaying(true); setPlayError(''); }} onPause={() => setPlaying(false)}
    onEnded={() => nextSong(true)} onError={() => setPlayError('This file could not be played. It may be unavailable, or its video/audio codec may be unsupported by this browser.')} />;

  function removeSong(jobId, name) {
    const key = JSON.stringify([jobId, name]);
    setSongs((current) => current?.filter((track) => songKey(track) !== key));
    setSelected((current) => current === key ? null : current);
  }

  function updateMetadata(jobId, name, result) {
    if (selectedRef.current === JSON.stringify([jobId, name])) setMetadata((current) => ({ ...current, ...result }));
    setSongs((current) => current?.map((track) => track.jobId === jobId && track.name === name
      ? { ...track, title: result.title, artist: result.artist, album: result.album, rating: result.rating,
        transcriptionLocked: result.transcriptionLocked } : track));
  }

  function replaceFile(jobId, name, result) {
    if (selectedRef.current === JSON.stringify([jobId, name])) {
      autoPlayRef.current = Boolean(audioRef.current && !audioRef.current.paused);
    }
    setSongs((current) => replaceSongFile(current, jobId, name, result.file));
  }

  function removeJob(jobId) {
    setSongs((current) => current?.filter((track) => track.jobId !== jobId));
    setSelected((current) => current && JSON.parse(current)[0] === jobId ? null : current);
  }

  return <PlaybackContext.Provider value={{ songs, setSongs, selected, setSelected, metadata, lyricError, playError, setPlayError,
    mode, setMode, copying, currentCopy, lyricsText, copyLyrics, position, setPosition, duration, volume, muted, playing,
    shuffle, setShuffle, repeat, setRepeat, audioRef, autoPlayRef, queueScopeRef, songKey, index, song,
    isVideo, videoOpen, setVideoOpen,
    selectSong, playKaraoke, nextSong, previousSong, togglePlayback, removeSong, removeJob, updateMetadata, replaceFile }}>
    {children}
    <section className="movie-player" aria-label="Movie player" hidden={!isVideo || !videoOpen}>
      <header><Film size={18} /><strong>{metadata?.title || song?.name}</strong>
        <button className="music-icon-button" type="button" title="Minimize movie" aria-label="Minimize movie" onClick={() => setVideoOpen(false)}><Minimize2 size={18} /></button>
      </header>
      {media}
    </section>
    <MusicPlayer request={request} dockOnly />
  </PlaybackContext.Provider>;
}

export default function MusicPlayer({ id, request, libraryView = null, dockOnly = false }) {
  const { songs, setSongs, selected, setSelected, metadata, lyricError, playError, setPlayError,
    mode, setMode, copying, currentCopy, lyricsText, copyLyrics, position, setPosition, duration, volume, muted, playing,
    shuffle, setShuffle, repeat, setRepeat, audioRef, autoPlayRef, queueScopeRef, songKey, index, song,
    isVideo, videoOpen, setVideoOpen,
    selectSong, playKaraoke, nextSong, previousSong, togglePlayback, removeSong, updateMetadata } = usePlayback();
  const [job, setJob] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [search, setSearch] = useState('');
  const [editingLyrics, setEditingLyrics] = useState(null);
  const [panel, updatePanel] = useState(null);
  function setPanel(next) {
    if (next !== 'lyrics') setEditingLyrics(null);
    updatePanel(next);
    if (dockOnly) navigationHistory().setLyricsOpen(next === 'lyrics');
  }
  const lyricRef = useRef(null);
  const dockRef = useRef(null);
  const lyricsOverlayRef = useRef(null);
  const lyricsButtonRef = useRef(null);
  const lines = metadata?.sylt || [];
  const activeLine = lines.findLastIndex((line) => line.time <= position);
  const requestedSong = new URLSearchParams(window.location.search).get('song');
  const requestedPlay = new URLSearchParams(window.location.search).get('play') === '1';
  const libraryScope = libraryView?.queueScope ?? libraryView?.selectedId;

  useEffect(() => {
    if (isVideo && panel === 'lyrics') setPanel(null);
  }, [isVideo, panel]);

  useEffect(() => {
    if (!dockOnly) return;
    return navigationHistory().subscribe(({ lyricsOpen }) => {
      updatePanel((current) => lyricsOpen ? 'lyrics' : current === 'lyrics' ? null : current);
    });
  }, [dockOnly]);

  useEffect(() => {
    if (!id) return;
    let active = true;
    Promise.all([request(`/api/jobs/${encodeURIComponent(id)}`), request(`/api/jobs/${encodeURIComponent(id)}/files`)])
      .then(([loadedJob, result]) => {
        if (!active) return;
        setJob(loadedJob);
        const tracks = result.files.filter((file) => file.isPlayable).map((file) => ({ ...file, jobId: id, playlistTitle: loadedJob.playlistTitle }));
        const track = tracks.find((file) => file.name === requestedSong) || tracks[0];
        if (track && (queueScopeRef.current !== `job:${id}` || requestedSong)) {
          if (requestedPlay) selectSong(track, tracks, `job:${id}`);
          else { queueScopeRef.current = `job:${id}`; setSongs(tracks); setSelected(songKey(track)); }
        }
      }).catch((error) => { if (active) setLoadError(error.message); });
    return () => { active = false; };
  }, [id, requestedSong, requestedPlay, request]);

  useEffect(() => {
    const tracks = libraryView?.tracks;
    if (!tracks) return;
    if (queueScopeRef.current === undefined && tracks.length) {
      queueScopeRef.current = libraryScope;
      setSongs(tracks);
      setSelected(songKey(tracks[0]));
    } else if (queueScopeRef.current === libraryScope && (!libraryView.pagination || tracks.some((track) => songKey(track) === selected))) {
      setSongs((current) => tracks.map((track) => songKey(track) === selected
        ? { ...track, streamUrl: current?.find((item) => songKey(item) === selected)?.streamUrl || track.streamUrl } : track));
      setSelected((current) => tracks.some((track) => songKey(track) === current) ? current : tracks[0] ? songKey(tracks[0]) : null);
    }
  }, [libraryView?.tracks, libraryScope]);

  useEffect(() => {
    if (libraryView?.removedSong) {
      const [jobId, name] = JSON.parse(libraryView.removedSong.key);
      removeSong(jobId, name);
    }
  }, [libraryView?.removedSong]);

  useEffect(() => {
    const container = lyricRef.current;
    const line = container?.querySelector('[aria-current="true"]');
    if (line) container.scrollTo({ top: line.offsetTop - container.clientHeight / 2 + line.clientHeight / 2,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
  }, [activeLine, mode, panel]);

  useEffect(() => {
    if (!dockOnly) return;
    const resize = () => document.documentElement.style.setProperty('--dock-height', `${dockRef.current.getBoundingClientRect().height}px`);
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(dockRef.current);
    return () => { observer.disconnect(); document.documentElement.style.removeProperty('--dock-height'); };
  }, [dockOnly]);

  useEffect(() => {
    if (panel !== 'lyrics') return;
    const overlay = lyricsOverlayRef.current;
    const content = document.querySelector('.app-shell');
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    if (content) content.inert = true;
    overlay?.querySelector('[aria-label="Close lyrics"]').focus();
    const closeOnEscape = (event) => { if (event.key === 'Escape') { event.preventDefault(); setPanel(null); } };
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.body.style.overflow = overflow;
      if (content) content.inert = false;
      document.removeEventListener('keydown', closeOnEscape);
      if (overlay?.contains(document.activeElement) || document.activeElement === document.body) lyricsButtonRef.current?.focus();
    };
  }, [panel]);

  const lyricsPanel = <section className="music-lyrics" aria-label="Lyrics">
    <div className="section-title"><div><h2>Lyrics</h2></div>
      <div className="lyrics-actions">
        <div className="lyrics-tabs" role="group" aria-label="Lyrics type">
          <button type="button" aria-pressed={mode === 'sylt'} onClick={() => setMode('sylt')}>SYLT</button>
          <button type="button" aria-pressed={mode === 'uslt'} onClick={() => setMode('uslt')}>USLT</button>
        </div>
        {metadata?.canEdit && !editingLyrics && <button className="lyrics-copy" type="button" title="Edit lyrics" aria-label="Edit lyrics"
          disabled={!song || song.transcription?.status === 'sent'} onClick={() => setEditingLyrics({ song, metadata })}><Pencil size={17} /></button>}
        <button className="lyrics-copy" type="button" title={currentCopy && !currentCopy.error ? 'Lyrics copied' : 'Copy lyrics'} aria-label="Copy lyrics"
          disabled={Boolean(editingLyrics) || copying || !lyricsText.trim()} onClick={copyLyrics}>
          {copying ? <RefreshCw className="spin" size={17} /> : currentCopy && !currentCopy.error ? <Check size={17} /> : <Copy size={17} />}
        </button>
        {dockOnly && <button className="music-icon-button" type="button" title="Close lyrics" aria-label="Close lyrics" onClick={() => setPanel(null)}><X size={20} /></button>}
      </div>
    </div>
    {currentCopy && <div className={currentCopy.error ? 'notice error' : 'sr-only'} role={currentCopy.error ? 'alert' : 'status'}>{currentCopy.message}</div>}
    {editingLyrics ? <LyricsEditor key={songKey(editingLyrics.song)} name={editingLyrics.song.name} metadata={editingLyrics.metadata} mode={mode}
      onCancel={() => setEditingLyrics((current) => current === editingLyrics ? null : current)}
      onSave={async (updates) => {
        const target = editingLyrics.song;
        const result = await request(`/api/jobs/${encodeURIComponent(target.jobId)}/files/${encodeURIComponent(target.name)}/metadata`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updates)
        });
        updateMetadata(target.jobId, target.name, result);
      }} /> : <div ref={lyricRef} className="lyric-timeline" tabIndex={0} aria-label={mode === 'sylt' ? 'Synchronized lyrics' : 'Unsynchronized lyrics'}>
      {lyricError ? <p className="notice error" role="alert">{lyricError}</p> : !metadata ? <p className="music-empty" role="status">{song ? 'Loading lyrics...' : 'No song selected.'}</p>
        : mode === 'uslt' ? (metadata.uslt ? <p className="plain-lyrics">{metadata.uslt}</p> : <p className="music-empty">No USLT lyrics embedded.</p>)
          : lines.length > 0 ? <ol>{lines.map((line, lineIndex) => <li key={lineIndex}><button type="button"
            aria-current={activeLine === lineIndex ? 'true' : undefined}
            aria-label={`${timeLabel(line.time)} ${line.text}`}
            onClick={() => { if (audioRef.current) audioRef.current.currentTime = line.time; }}>
            <time>{timeLabel(line.time)}</time><span>{line.text}</span>
          </button></li>)}</ol> : <p className="music-empty">No SYLT lyrics embedded.</p>}
    </div>}
  </section>;

  if (libraryView || dockOnly) {
    const tracks = libraryView?.tracks || [];
    const trackSearch = libraryView?.search ?? search;
    const visibleTracks = libraryView?.pagination ? tracks : tracks.filter((track) => songSearchText(track).includes(trackSearch.trim().toLowerCase()));
    const totalTracks = libraryView?.pagination?.total ?? tracks.length;
    const selection = libraryView?.songSelection;
    const selectedVisible = visibleTracks.filter((track) => selection?.keys.has(songKey(track))).length;
    return <div className={dockOnly ? 'global-player' : 'library-player'}>
      {libraryView && <div className="library-layout">
        {libraryView.sidebar}
        <section className="library-songs" aria-label="Playlist songs">
          <header className="library-selection-heading">
            <span className="selection-art">{libraryView.type === 'folder' ? <Folder size={30} /> : <Disc3 size={32} />}</span>
            <div><p className="eyebrow">{libraryView.type === 'folder' ? 'Playlist folder' : libraryView.selectedId ? 'Playlist' : 'Your collection'}</p>
              <h2>{libraryView.title}</h2><p>{totalTracks} track{totalTracks === 1 ? '' : 's'}</p></div>
            <button className="round-play" type="button" aria-label={libraryView.pagination ? 'Play page' : 'Play selection'} title={libraryView.pagination ? 'Play page' : 'Play selection'} disabled={!tracks.length || libraryView.loading}
              onClick={() => selectSong(tracks[0], tracks, libraryScope)}><Play size={22} fill="currentColor" /></button>
          </header>
          <div className="songs-toolbar"><h3>Tracks</h3>
            <label className="queue-search"><Search size={16} /><input type="search" aria-label="Search tracks" placeholder="Search tracks" maxLength={libraryView.pagination ? 200 : undefined} value={trackSearch} onChange={(event) => (libraryView.onSearch || setSearch)(event.target.value)} /></label>
            {selection && <button className="music-icon-button" type="button" title="Select songs" aria-label="Select songs" aria-pressed={selection.active} disabled={libraryView.saving} onClick={selection.toggle}><ListChecks size={19} /></button>}
          </div>
          {selection?.active && <div className="library-bulk-toolbar song-bulk-toolbar">
            <label><input className="library-select-checkbox" type="checkbox" aria-label="Select all matching songs" disabled={libraryView.saving || !visibleTracks.length}
              checked={visibleTracks.length > 0 && selectedVisible === visibleTracks.length}
              ref={(element) => { if (element) element.indeterminate = selectedVisible > 0 && selectedVisible < visibleTracks.length; }}
              onChange={(event) => selection.change(visibleTracks.map(songKey), event.target.checked)} /><span>{selection.count} selected</span></label>
            <button className="music-icon-button" type="button" title="Move selected songs" aria-label="Move selected songs" disabled={libraryView.saving || !selection.count} onClick={() => selection.transfer('move')}><ArrowRightLeft size={18} /></button>
            <button className="music-icon-button" type="button" title="Link selected songs" aria-label="Link selected songs" disabled={libraryView.saving || !selection.count} onClick={() => selection.transfer('link')}><Link size={18} /></button>
            <button className="music-icon-button" type="button" title="Delete selected songs" aria-label="Delete selected songs" disabled={libraryView.saving || !selection.canRemove} onClick={selection.remove}><Trash2 size={18} /></button>
            <button className="music-icon-button" type="button" title="Clear song selection" aria-label="Clear song selection" disabled={libraryView.saving} onClick={selection.clear}><X size={18} /></button>
          </div>}
          {libraryView.pagination && <TrackPagination pagination={libraryView.pagination} position="top" />}
          {libraryView.loading && <div className="loading" role="status"><RefreshCw className="spin" size={20} />Loading songs</div>}
          {!libraryView.loading && <SongGroups key={libraryView.selectedId || 'all'} tracks={visibleTracks}>{(group) => <ol className="library-song-list" aria-label={group.length && isNoVocals(group[0]) ? 'NoVocals songs' : 'Songs'}>{group.map((track) => {
            const playlistTracks = tracks.filter((item) => item.playlistId === track.playlistId);
            const trackIndex = playlistTracks.findIndex((item) => songKey(item) === songKey(track));
            const current = songKey(track) === selected;
            const action = libraryView.songState(track);
            const acceptSong = (event) => allowDrop(event, !libraryView.readOnly && !libraryView.saving && !libraryView.pagination && event.dataTransfer.types.includes('application/x-ssmusic-song'));
            return <li className={`library-song-row ${current ? 'is-current' : ''} ${selection?.active && selection.keys.has(songKey(track)) ? 'is-checked' : ''}`} key={songKey(track)}
              onDragEnter={acceptSong} onDragOver={acceptSong} onDragLeave={leaveDrop}
              onDrop={(event) => {
                event.preventDefault();
                if (libraryView.readOnly || libraryView.saving || libraryView.pagination) return;
                try {
                  const moved = JSON.parse(event.dataTransfer.getData('application/x-ssmusic-song'));
                  if (moved.playlistId === track.playlistId) libraryView.onReorder(moved, songKey(track));
                  else libraryView.onMove(moved, track.playlistId);
                } catch {}
              }}>
              {selection?.active ? <label className="library-row-check"><input className="library-select-checkbox" type="checkbox" aria-label={`Select song ${track.name}`} checked={selection.keys.has(songKey(track))} disabled={libraryView.saving}
                onChange={(event) => selection.change([songKey(track)], event.target.checked)} /></label> : libraryView.readOnly ? <span aria-hidden="true" /> : <button className="music-icon-button song-drag" type="button" draggable={!libraryView.saving} disabled={libraryView.saving}
                title={`Drag ${track.name}`} aria-label={`Drag ${track.name}`} onDragStart={(event) => {
                  const row = event.currentTarget.closest('.library-song-row');
                  row.dataset.dragging = 'true';
                  event.dataTransfer.setData('application/x-ssmusic-song', JSON.stringify({ jobId: track.jobId, name: track.name, playlistId: track.playlistId }));
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setDragImage(row, 24, 24);
                }}><GripVertical size={16} /></button>}
              <div className="song-title-actions"><button className="song-select" type="button" title={track.name} aria-label={`Play ${track.name}`} aria-current={current ? 'true' : undefined}
                onClick={() => selectSong(track, tracks, libraryScope)}>
                <span className="song-number">{mediaType(track.name) === 'video' ? <Film size={15} aria-label="Movie" /> : current && playing ? <Music2 size={15} /> : trackIndex + 1}</span>
                <span><strong>{track.title || track.name.split('/').at(-1).replace(/\.[^.]+$/, '')}</strong><small>{track.artist || (track.name.startsWith('[NoVocals]/') ? 'Instrumental' : track.playlistTitle || 'Original')}</small>
                  <TranscriptionStatus transcription={action.transcription} /></span>
              </button><KaraokeButton track={track} tracks={tracks} onPlay={playKaraoke} /></div>
              <button className="song-playlist" type="button" title={track.playlistTitle} onClick={() => libraryView.onSelect(track.playlistId)}>{track.playlistTitle}</button>
              <ListSongRating file={track} jobId={track.jobId} request={request} canModify={action.canModify}
                disabled={action.disabled || libraryView.saving}
                onSaved={(result) => libraryView.onMetadataSaved(track, result)} onError={libraryView.onRatingError} />
              <SongActions name={track.name} className="song-order-actions">
                {action.canModify && !libraryView.readOnly && mediaType(track.name) === 'audio' && <button className="music-icon-button" type="button" title="Share Media" aria-label={`Share Media ${track.name}`} aria-haspopup="dialog" disabled={action.disabled || libraryView.saving} onClick={() => libraryView.onShareMedia(track)}><Share2 size={16} /></button>}
                {action.canModify && mediaType(track.name) === 'audio' && <button className="music-icon-button" type="button" title="Edit song metadata" aria-label={`Edit metadata ${track.name}`} disabled={action.disabled} onClick={() => libraryView.onEditMetadata(track)}><Pencil size={16} /></button>}
                {action.canModify && !libraryView.readOnly && mediaType(track.name) === 'audio' && <button className="music-icon-button" type="button" title="Replace File" aria-label={`Replace File ${track.name}`} disabled={action.disabled || libraryView.saving} onClick={() => libraryView.onReplaceFile(track)}><Upload size={16} /></button>}
                {!libraryView.readOnly && mediaType(track.name) === 'audio' && !track.name.toLowerCase().startsWith('[novocals]/') && <button className="music-icon-button" type="button" data-action-label="Transcribe song" title={libraryView.transcriptionActive ? 'Transcribe song' : transcriptionInactiveMessage} aria-label={`Transcribe ${track.name}`} disabled={action.disabled || !libraryView.transcriptionActive} onClick={() => libraryView.onTranscribe(track)}><Mic size={16} /></button>}
                {action.canModify && <button className="music-icon-button" type="button" title="Remove song from playlist" aria-label={`Delete song ${track.name}`} disabled={action.disabled || libraryView.saving} onClick={() => libraryView.onDelete(track)}>{action.deleting ? <RefreshCw className="spin" size={16} /> : <Trash2 size={16} />}</button>}
                {!libraryView.readOnly && <button className="music-icon-button" type="button" title="Move to playlist" aria-label={`Move ${track.name} to playlist`} disabled={libraryView.saving} onClick={() => libraryView.onMove(track)}><ArrowRightLeft size={15} /></button>}
                <a className="music-icon-button" href={track.downloadUrl} title="Download song" aria-label={`Download ${track.name}`}><ArrowDownToLine size={15} /></a>
              </SongActions>
            </li>;
          })}</ol>}</SongGroups>}
          {!libraryView.loading && !libraryView.error && !visibleTracks.length && <div className="library-empty"><Music2 size={32} /><h3>{trackSearch ? 'No matching songs' : 'No songs yet'}</h3>
            {!libraryView.readOnly && !trackSearch && <button className="secondary-button compact-button" type="button" onClick={libraryView.onAdd}><Plus size={16} />Add Playlist</button>}</div>}
          {libraryView.pagination && <TrackPagination pagination={libraryView.pagination} position="bottom" />}
        </section>
      </div>}
      {dockOnly && <>
        {panel === 'queue' && <aside className="player-panel" aria-label="Playback queue">
          <div className="player-panel-heading"><h3>Up next</h3><button className="music-icon-button" type="button" title="Close panel" aria-label="Close player panel" onClick={() => setPanel(null)}><X size={18} /></button></div>
          <ol className="playback-queue">{songs?.map((track) => <li key={songKey(track)}><button type="button" aria-current={songKey(track) === selected ? 'true' : undefined} onClick={() => selectSong(track)}>{mediaType(track.name) === 'video' ? <Film size={16} /> : <Music2 size={16} />}<span>{track.name.split('/').at(-1)}<small>{track.playlistTitle}</small></span></button></li>)}</ol>
        </aside>}
      {panel === 'lyrics' && <div className="lyrics-overlay" onClick={(event) => { if (event.target === event.currentTarget) setPanel(null); }}>
        <section className="lyrics-overlay-content" role="dialog" aria-label="Lyrics" ref={lyricsOverlayRef}>
          {lyricsPanel}
        </section>
      </div>}
      <footer className="player-dock" aria-label="Music playback" ref={dockRef}>
        <div className="dock-track"><div className={`dock-artwork ${playing && !isVideo ? 'is-playing' : ''}`}>{isVideo ? <Film size={30} /> : metadata?.artwork ? <img src={metadata.artwork} alt="Album cover" /> : <Disc3 size={30} />}</div>
          <div><strong>{metadata?.title || song?.name.split('/').at(-1).replace(/\.[^.]+$/, '') || 'Nothing playing'}</strong><small>{metadata?.artist || song?.playlistTitle || 'ssMusic Player'}</small></div><KaraokeButton track={song} tracks={songs} onPlay={playKaraoke} /></div>
        <div className="dock-controls"><div className="dock-transport">
          <button className="music-icon-button" type="button" title="Shuffle" aria-label="Shuffle" aria-pressed={shuffle} onClick={() => setShuffle(!shuffle)}><Shuffle size={17} /></button>
          <button className="music-icon-button" type="button" title="Previous song" aria-label="Previous song" disabled={!song} onClick={previousSong}><SkipBack size={20} /></button>
          <button className="round-play" type="button" title={playing ? 'Pause' : 'Play'} aria-label={playing ? 'Pause' : 'Play'} disabled={!song} onClick={togglePlayback}>{playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}</button>
          <button className="music-icon-button" type="button" title="Next song" aria-label="Next song" disabled={!song || (!repeat && !shuffle && index === songs.length - 1)} onClick={() => nextSong()}><SkipForward size={20} /></button>
          <button className="music-icon-button" type="button" title="Repeat queue" aria-label="Repeat queue" aria-pressed={repeat} onClick={() => setRepeat(!repeat)}><Repeat size={17} /></button>
        </div><div className="dock-timeline"><time>{timeLabel(position)}</time><input type="range" aria-label="Seek" min="0" max={duration || 0} step="0.1" value={Math.min(position, duration)} disabled={!duration}
          onChange={(event) => { audioRef.current.currentTime = Number(event.target.value); setPosition(Number(event.target.value)); }} /><time>{timeLabel(duration)}</time></div></div>
        <div className="dock-tools">
          {isVideo && <button className="music-icon-button" type="button" title={videoOpen ? 'Hide movie' : 'Show movie'} aria-label={videoOpen ? 'Hide movie' : 'Show movie'} aria-pressed={videoOpen} onClick={() => { setPanel(null); setVideoOpen(!videoOpen); }}><Film size={18} /></button>}
          <button ref={lyricsButtonRef} className="music-icon-button" type="button" title="Lyrics" aria-label="Show lyrics" disabled={isVideo} aria-pressed={panel === 'lyrics'} onClick={() => setPanel(panel === 'lyrics' ? null : 'lyrics')}><Mic2 size={18} /></button>
          <button className="music-icon-button" type="button" title="Playback queue" aria-label="Show playback queue" aria-pressed={panel === 'queue'} onClick={() => setPanel(panel === 'queue' ? null : 'queue')}><ListMusic size={19} /></button>
          <button className="music-icon-button volume-button" type="button" title={muted ? 'Unmute' : 'Mute'} aria-label={muted ? 'Unmute' : 'Mute'} disabled={!song} onClick={() => { audioRef.current.muted = !muted; }}>{muted || volume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}</button>
          <input className="volume-slider" type="range" aria-label="Volume" min="0" max="1" step="0.01" value={muted ? 0 : volume} disabled={!song} onChange={(event) => { audioRef.current.volume = Number(event.target.value); audioRef.current.muted = false; }} />
        </div>
        {playError && <div className="notice error playback-error" role="alert">{playError}<button className="music-icon-button" type="button" aria-label="Dismiss playback error" title="Dismiss" onClick={() => setPlayError('')}><X size={16} /></button></div>}
      </footer>
      </>}
    </div>;
  }

  return <div className="music-workspace">
    <a className="back-link" href={`/job/${encodeURIComponent(id)}`}><ArrowLeft size={17} />Back to job</a>
    <header className="music-heading"><div><p className="eyebrow">Music player</p><h1>{job?.playlistTitle || 'Job music'}</h1></div>
      {songs && <span>{songs.length} songs</span>}
    </header>
    {loadError && <div className="notice error" role="alert">{loadError}</div>}
    {!songs && !loadError && <div className="loading"><RefreshCw className="spin" />Loading songs</div>}
    {songs?.length === 0 && <div className="empty-files"><Music2 size={24} />No songs available.</div>}
    {song && <>
      <section className="now-playing" aria-label="Now playing">
        <div className={`music-artwork ${playing ? 'is-playing' : ''}`}>
          {metadata?.artwork ? <img src={metadata.artwork} alt={`${metadata.album || metadata.title} cover`} /> : <div className="record-art"><Disc3 size={60} strokeWidth={1.2} /></div>}
        </div>
        <div className="playback-main">
          <div className="track-heading"><div><span>{song.name.startsWith('[NoVocals]/') ? 'NoVocals' : 'Original'}</span>
            <h2>{metadata?.title || song.name.split('/').at(-1)}</h2>
            {metadata?.artist && <p>{metadata.artist}{metadata.album ? ` / ${metadata.album}` : ''}</p>}
          </div><span className="track-position">{index + 1} / {songs.length}</span></div>
          <div className="transport-actions">
            <KaraokeButton track={song} tracks={songs} onPlay={playKaraoke} />
            <button type="button" title="Previous song" aria-label="Previous song" onClick={previousSong}><SkipBack size={19} /></button>
            <button type="button" title="Next song" aria-label="Next song" disabled={!repeat && !shuffle && index === songs.length - 1} onClick={() => nextSong()}><SkipForward size={19} /></button>
            <button type="button" title="Shuffle" aria-label="Shuffle" aria-pressed={shuffle} onClick={() => setShuffle(!shuffle)}><Shuffle size={18} /></button>
            <button type="button" title="Repeat job" aria-label="Repeat job" aria-pressed={repeat} onClick={() => setRepeat(!repeat)}><Repeat size={18} /></button>
          </div>
          {playError && <div className="notice error" role="alert">{playError}</div>}
        </div>
      </section>
      <div className="music-columns">
        <section className="music-queue" aria-label="Job songs">
          <div className="section-title"><div><ListMusic size={18} /><h2>Queue</h2></div></div>
          <label className="queue-search"><Search size={16} /><input type="search" aria-label="Search songs" placeholder="Search songs" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
          <div className="queue-tracks">
            <SongGroups key={id} tracks={songs.filter((track) => songSearchText(track).includes(search.trim().toLowerCase()))}>{(group) => <ol>{group.map((track) => <li key={songKey(track)}><button type="button" aria-current={songKey(track) === selected ? 'true' : undefined} onClick={() => selectSong(track)}>
                  <Music2 size={17} /><span>{track.name.split('/').at(-1)}</span>
                  {songKey(track) === selected && <span className="queue-indicator" aria-label={playing ? 'Playing' : 'Selected'} />}
                </button><KaraokeButton track={track} tracks={songs} onPlay={playKaraoke} /></li>)}</ol>}</SongGroups>
            {!songs.some((track) => songSearchText(track).includes(search.trim().toLowerCase())) && <p className="music-empty">No matching songs.</p>}
          </div>
        </section>
        {lyricsPanel}
      </div>
    </>}
  </div>;
}