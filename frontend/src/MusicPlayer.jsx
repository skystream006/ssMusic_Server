import { createContext, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowLeft, ArrowRightLeft, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Copy, Disc3, Folder, GripVertical, Info, Link, ListChecks, ListMusic, Lock, LockOpen, Mic, Mic2, MicVocal, Music2, Pause, Pencil, Play, Plus, RefreshCw, Repeat, Repeat1, Save, Search, Share2, Shuffle, SkipBack, SkipForward, Trash2, Upload, Volume2, VolumeX, X } from 'lucide-react';
import { canEditSong, getFilePrivacy, ListSongRating, SongActions, transcriptionInactiveMessage, TranscriptionStatus } from './SongActions.jsx';
import { allowDrop, leaveDrop } from './touchControls.js';
import { navigationHistory, replaceURL } from './navigation.js';
import { findNoVocals, isNoVocals, normalizeSearchText, songKey, songSearchText } from '../../src/library.js';
import { mediaType } from '../../src/media.js';
import { buildLyricsUpdate, formatSyltForEdit } from './lyricsEditing.js';
import LyricTimeline from './LyricTimeline.jsx';
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

export function nextRepeatMode(mode) {
  return mode === 'off' ? 'all' : mode === 'all' ? 'one' : 'off';
}

export function nextPlaybackSong(songs, selected, { shuffle = false, repeatMode = 'off', ended = false } = {}) {
  if (!songs?.length) return null;
  const index = songs.findIndex((track) => songKey(track) === selected);
  if (ended && repeatMode === 'one' && index >= 0) return songs[index];
  if (shuffle && songs.length > 1) {
    const others = songs.filter((track) => songKey(track) !== selected);
    if (others.length) return others[Math.floor(Math.random() * others.length)];
  }
  return songs[index + 1] || (repeatMode === 'all' ? songs[0] : null);
}

export function queueSongNext(songs, selected, track) {
  const key = (item) => JSON.stringify([item.jobId, item.name]);
  if (selected === key(track)) return songs || [track];
  const queue = (songs || []).filter((item) => key(item) !== key(track));
  const index = queue.findIndex((item) => key(item) === selected);
  queue.splice(index + 1, 0, track);
  return queue;
}

export async function loadPlaybackQueue(request, query, tracks, pagination) {
  if (!pagination || tracks.length === pagination.total) return tracks;
  const parameters = new URLSearchParams(query);
  parameters.set('pageSize', '1000');
  const queue = [];
  let page = 1;
  let total = pagination.total;
  while (queue.length < total) {
    parameters.set('page', String(page));
    const result = pagination.page === page && pagination.pageSize === 1000
      ? { files: tracks, total: pagination.total, page }
      : await request(`/api/library/tracks?${parameters}`);
    if (!result.files.length || result.page !== page) throw new Error('The playlist changed while loading. Please try again.');
    queue.push(...result.files);
    total = result.total;
    page++;
  }
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

function KaraokeButton({ track, tracks, onPlay, showLabel = false }) {
  const version = track && mediaType(track.name) !== 'video' && !isNoVocals(track) && (track.noVocalsVersion || findNoVocals(track, tracks || []));
  return version ? <button className="music-icon-button karaoke-button" type="button" title="Play karaoke (NoVocals)"
    aria-label={`Play karaoke version of ${track.title || track.name}`} onClick={() => onPlay(version)}><MicVocal size={18} />{showLabel && <span>Play karaoke (NoVocals)</span>}</button> : null;
}

export function SongArtwork({ track }) {
  const [failedUrl, setFailedUrl] = useState(null);
  const isVideo = mediaType(track.name) === 'video';
  return <span className="song-artwork" aria-hidden="true">
    {!isVideo && track.artworkUrl && track.artworkUrl !== failedUrl
      ? <img key={track.artworkUrl} src={track.artworkUrl} alt="" loading="lazy" decoding="async"
        onError={() => setFailedUrl(track.artworkUrl)} />
      : isVideo ? <Film size={20} /> : <Music2 size={20} />}
  </span>;
}

function TrackPagination({ pagination, position, label = 'Track' }) {
  const { page, pageSize, total, totalPages, loading, onChange, onPageSizeChange } = pagination;
  return <nav className="track-pagination" aria-label={`${label} pages ${position}`}>
    <span role="status">{total ? `${(page - 1) * pageSize + 1}-${Math.min(page * pageSize, total)} of ${total}` : '0 tracks'}</span>
    <label>Items per page<select aria-label="Items per page" value={pageSize} disabled={loading} onChange={(event) => onPageSizeChange(Number(event.target.value))}>
      {[50, 100, 200, 500, 1000].map((size) => <option key={size} value={size}>{size}</option>)}
    </select></label>
    <div>
      <button className="music-icon-button" type="button" title="Previous page" aria-label={`Previous ${label.toLowerCase()} page`} disabled={loading || page <= 1} onClick={() => onChange(page - 1)}><ChevronLeft size={18} /></button>
      <label>Page<select aria-label={`${label} page`} value={page} disabled={loading || totalPages <= 1} onChange={(event) => onChange(Number(event.target.value))}>
        {Array.from({ length: totalPages }, (_, index) => <option key={index + 1} value={index + 1}>{index + 1}</option>)}
      </select><span>of {totalPages}</span></label>
      <button className="music-icon-button" type="button" title="Next page" aria-label={`Next ${label.toLowerCase()} page`} disabled={loading || page >= totalPages} onClick={() => onChange(page + 1)}><ChevronRight size={18} /></button>
    </div>
  </nav>;
}

export function NowPlayingPanel({ panel, onChange, expanded = true, wide = false, isVideo = false, player, lyrics, queue }) {
  const tabsId = useId();
  const activeTab = wide && panel === 'queue' ? 'player' : panel;
  const tabs = [{ id: 'player', label: 'Player', Icon: Disc3 }, { id: 'lyrics', label: 'Lyrics', Icon: Mic2 },
    ...wide ? [] : [{ id: 'queue', label: 'Queue', Icon: ListMusic }]];

  function moveTab(event) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...event.currentTarget.querySelectorAll('[role="tab"]:not(:disabled)')];
    const current = buttons.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : (current + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    event.preventDefault();
    buttons[next]?.click();
    buttons[next]?.focus();
  }

  return <section id="now-playing-expanded" className={`now-playing-expanded${wide ? ' is-wide' : ''}${expanded ? '' : ' is-closing'}`}
    aria-label="Now playing views" inert={!expanded} aria-hidden={!expanded}>
    <header className="now-playing-header">
      <div className="now-playing-tabs" role="tablist" aria-label="Now playing" onKeyDown={moveTab}>
        {tabs.map(({ id, label, Icon }) => <button key={id} id={`${tabsId}-${id}-tab`} type="button" role="tab"
          aria-selected={activeTab === id} aria-controls={`${tabsId}-${id}-panel`} tabIndex={activeTab === id ? 0 : -1}
          disabled={id === 'lyrics' && isVideo} onClick={() => onChange(id)}><Icon size={18} />{label}</button>)}
      </div>
      <button className="music-icon-button" type="button" title="Collapse now playing" aria-label="Collapse now playing"
        onClick={() => onChange(null)}><ChevronDown size={22} /></button>
    </header>
    <div className="now-playing-layout">
      <div className="expanded-primary" hidden={activeTab === 'queue'}>
        <section className="expanded-player-panel" role="tabpanel" id={`${tabsId}-player-panel`}
          aria-labelledby={`${tabsId}-player-tab`} hidden={activeTab !== 'player'}>{activeTab === 'player' && player}</section>
        <section className="expanded-lyrics lyrics-overlay-content" role="tabpanel" id={`${tabsId}-lyrics-panel`}
          aria-labelledby={`${tabsId}-lyrics-tab`} hidden={activeTab !== 'lyrics'}>{activeTab === 'lyrics' && lyrics}</section>
      </div>
      <section className="expanded-queue" role={wide ? 'region' : 'tabpanel'} id={`${tabsId}-queue-panel`}
        aria-labelledby={`${tabsId}-queue-${wide ? 'heading' : 'tab'}`} hidden={!wide && activeTab !== 'queue'}>
        <h2 id={`${tabsId}-queue-heading`}>Queue</h2>
        {queue}
      </section>
    </div>
  </section>;
}

export function PlaybackQueueRow({ track, number, current, user, sourceJob, request, onSelect, onMetadataSaved }) {
  const [ratingError, setRatingError] = useState('');
  const job = track.sourceJob || track.job || sourceJob;
  const canRate = !track.readOnly && canEditSong(user, job);
  const busy = ['queued', 'running'].includes(job?.status)
    || (track.transcription || job?.transcriptions?.[track.name])?.status === 'sent';
  return <li className={`queue-song-row${current ? ' is-current' : ''}`}>
    <button className="queue-song-select" type="button" aria-label={`Play ${track.title || track.name}`}
      aria-current={current ? 'true' : undefined} onClick={() => onSelect(track)}>
      <span className="queue-track-number">{number}</span>
      <SongArtwork track={track} /><span className="queue-track-title"><strong>{track.title || track.name.split('/').at(-1)}</strong><small>{track.artist || track.playlistTitle}</small></span>
    </button>
    {/\.mp3$/i.test(track.name) && <ListSongRating file={track} jobId={track.jobId} request={request}
      canModify={canRate} disabled={busy} onError={setRatingError} onSaved={(result) => onMetadataSaved(track, result)} />}
    {ratingError && <p className="queue-rating-error" role="alert">{ratingError}</p>}
  </li>;
}

export function mergePlaybackMetadata(current, updates, readSnapshot = null) {
  return { ...current, ...updates,
    ...(readSnapshot && current && current.rating !== readSnapshot.rating ? { rating: current.rating } : {}) };
}

function NowPlayingTrack({ song, metadata, artwork, request, updateMetadata }) {
  const [details, setDetails] = useState(null);
  const [metadataError, setMetadataError] = useState('');
  const [ratingError, setRatingError] = useState('');
  const [retry, setRetry] = useState(0);
  const [failedArtwork, setFailedArtwork] = useState(null);
  const supportsRating = /\.mp3$/i.test(song?.name || '');

  useEffect(() => {
    if (!song || !supportsRating) return;
    let active = true;
    const readSnapshot = { rating: song.rating };
    setDetails(null);
    setMetadataError('');
    request(song.metadataUrl || `/api/jobs/${encodeURIComponent(song.jobId)}/files/${encodeURIComponent(song.name)}/metadata`)
      .then((result) => {
        if (!active) return;
        setDetails(result);
        updateMetadata(song.jobId, song.name, result, readSnapshot);
      })
      .catch((error) => { if (active) setMetadataError(error.message); });
    return () => { active = false; };
  }, [song?.jobId, song?.name, song?.metadataUrl, song?.streamUrl, request, retry]);

  if (!song) return <div className="expanded-player"><Disc3 size={64} /><h2>Nothing playing</h2></div>;
  const current = details || metadata || song;
  const cover = details?.artwork === undefined ? artwork : details.artwork;
  return <div className="expanded-player">
    <div className="expanded-artwork">
      {cover && cover !== failedArtwork ? <img src={cover} alt={`${current.album || current.title || song.name} cover`}
        onError={() => setFailedArtwork(cover)} /> : mediaType(song.name) === 'video' ? <Film size={80} /> : <Disc3 size={96} strokeWidth={1} />}
    </div>
    <div className="expanded-track-heading"><h2>{current.title || song.title || song.name.split('/').at(-1).replace(/\.[^.]+$/, '')}</h2>
      {(current.artist || song.artist) && <p>{current.artist || song.artist}</p>}
      {(current.album || song.album) && <p className="expanded-album">{current.album || song.album}</p>}
    </div>
    {supportsRating && <div className="expanded-rating">
      <ListSongRating file={{ ...song, rating: song.rating ?? details?.rating }} jobId={song.jobId} request={request}
        canModify={details?.canEdit === true && !song.readOnly} disabled={song.transcription?.status === 'sent'}
        onError={setRatingError} onSaved={(result) => {
          setDetails((currentDetails) => ({ ...currentDetails, ...result }));
          updateMetadata(song.jobId, song.name, result);
        }} />
      {!details && !metadataError && <p className="expanded-metadata-status" role="status">Loading rating...</p>}
    </div>}
    {metadataError && <div className="notice error" role="alert"><span>{metadataError}</span>
      <button className="music-icon-button" type="button" title="Retry song details" aria-label="Retry song details"
        onClick={() => setRetry((value) => value + 1)}><RefreshCw size={18} /></button></div>}
    {ratingError && <p className="notice error" role="alert">{ratingError}</p>}
  </div>;
}

export function usePlayback() { return useContext(PlaybackContext); }

export function readPlaybackSession(userId, browser = window) {
  try {
    if (!userId) return null;
    const key = `ssMusicPlayback:${userId}`;
    const saved = JSON.parse(browser.localStorage?.getItem(key) ?? browser.sessionStorage?.getItem(key) ?? 'null');
    const url = `${browser.location.pathname}${browser.location.search}`;
    if (typeof saved?.url !== 'string' || !/^\/(?:\?|$|job\/[^/?]+\/player(?:\?|$))/.test(saved.url)
      || (saved.url !== url && url !== '/')
      || !Array.isArray(saved.songs) || !saved.songs.length
      || !saved.songs.every((track) => track && typeof track.jobId === 'string' && typeof track.name === 'string' && typeof track.streamUrl === 'string')
      || !saved.songs.some((track) => songKey(track) === saved.selected)) return null;
    try {
      const progress = JSON.parse(browser.localStorage?.getItem(`ssMusicPlaybackPosition:${userId}`) || 'null');
      if (progress?.selected === saved.selected && Number.isFinite(progress.position) && progress.position >= 0) saved.position = progress.position;
    } catch {}
    return saved;
  } catch { return null; }
}

export function writePlaybackPosition(userId, selected, position, browser = window) {
  try {
    if (userId && selected && Number.isFinite(position) && position >= 0) {
      browser.localStorage.setItem(`ssMusicPlaybackPosition:${userId}`, JSON.stringify({ selected, position }));
    }
  } catch {}
}

export function writePlaybackSession(userId, songs, selected, scope, browser = window, settings = {}) {
  try {
    if (!userId) return;
    const key = `ssMusicPlayback:${userId}`;
    if (!songs?.some((track) => songKey(track) === selected)) {
      browser.localStorage.removeItem(key);
      browser.localStorage.removeItem(`ssMusicPlaybackPosition:${userId}`);
      browser.sessionStorage?.removeItem(key);
      return;
    }
    const url = `${browser.location.pathname}${browser.location.search}`;
    let previous;
    try { previous = JSON.parse(browser.localStorage.getItem(key) || 'null'); } catch {}
    browser.localStorage.setItem(key, JSON.stringify({ ...settings, songs, selected,
      scope: typeof scope === 'string' ? scope : null,
      url: /^\/(?:\?|$|job\/[^/?]+\/player(?:\?|$))/.test(url) ? url : previous?.url || '/' }));
  } catch {}
}

export function PlaybackProvider({ children, request, userId, user = null }) {
  const [restored] = useState(() => {
    const saved = readPlaybackSession(userId);
    if (saved && window.location.pathname === '/' && !window.location.search && saved.url !== '/') replaceURL(saved.url);
    return saved;
  });
  const [songs, setSongs] = useState(restored?.songs || null);
  const [selected, setSelected] = useState(restored?.selected || null);
  const restoredSelectionRef = useRef(restored);
  const selectedRef = useRef(null);
  selectedRef.current = selected;
  const [metadata, setMetadata] = useState(null);
  const [lyricsViewers, setLyricsViewers] = useState(0);
  const [lyricsLoaded, setLyricsLoaded] = useState(false);
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
  const [shuffle, setShuffle] = useState(restored?.shuffle === true);
  const [repeatMode, setRepeatMode] = useState(['all', 'one'].includes(restored?.repeatMode) ? restored.repeatMode : 'off');
  const [queuePage, setQueuePage] = useState(Number.isInteger(restored?.queuePage) && restored.queuePage > 0 ? restored.queuePage : 1);
  const [queuePageSize, setQueuePageSize] = useState([50, 100, 200, 500, 1000].includes(restored?.queuePageSize) ? restored.queuePageSize : 50);
  const [queueLoading, setQueueLoading] = useState(false);
  const queueLoadRef = useRef(0);
  const queueRequestRef = useRef(null);
  const resumePositionRef = useRef(restored);
  const progressSavedAtRef = useRef(0);
  const [videoOpen, setVideoOpen] = useState(true);
  const audioRef = useRef(null);
  const autoPlayRef = useRef(!restored && new URLSearchParams(window.location.search).get('play') === '1');
  const volumeRef = useRef(1);
  const mutedRef = useRef(false);
  const queueScopeRef = useRef(restored ? restored.scope ?? Symbol('restored') : undefined);
  const index = songs?.findIndex((track) => songKey(track) === selected) ?? -1;
  const song = songs?.[index];
  const isVideo = mediaType(song?.name) === 'video';
  const lyricsText = formatLyricsForCopy(metadata, mode);
  const currentCopy = copyResult?.song === selected && copyResult?.mode === mode ? copyResult : null;
  const playingPage = Math.max(1, Math.floor(index / queuePageSize) + 1);
  const playingPageRef = useRef(playingPage);
  const queueTotalPages = Math.max(1, Math.ceil((songs?.length || 0) / queuePageSize));
  const queuePagination = {
    page: Math.min(queuePage, queueTotalPages), pageSize: queuePageSize, total: songs?.length || 0,
    totalPages: queueTotalPages, onChange: setQueuePage,
    onPageSizeChange: (size) => { setQueuePageSize(size); setQueuePage(Math.max(1, Math.floor(index / size) + 1)); }
  };

  useEffect(() => {
    if (playingPageRef.current !== playingPage) setQueuePage(playingPage);
    playingPageRef.current = playingPage;
  }, [playingPage]);

  useEffect(() => {
    const persist = () => writePlaybackSession(userId, songs, selected, queueScopeRef.current, window,
      { shuffle, repeatMode, queuePage, queuePageSize });
    persist();
    window.addEventListener('pagehide', persist);
    return () => window.removeEventListener('pagehide', persist);
  }, [userId, songs, selected, shuffle, repeatMode, queuePage, queuePageSize]);

  useEffect(() => {
    const persist = () => writePlaybackPosition(userId, selected, audioRef.current?.currentTime);
    window.addEventListener('pagehide', persist);
    const onVisibilityChange = () => { if (document.visibilityState === 'hidden') persist(); };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('pagehide', persist);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [userId, selected]);

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
    setMetadata(song ? { title: song.title || song.name.split('/').at(-1).replace(/\.[^.]+$/, ''),
      artist: song.artist || '', album: song.album || '', rating: song.rating } : null);
    setLyricsLoaded(false);
    setLyricError('');
    setPlayError('');
    setPosition(0);
    setDuration(0);
    setPlaying(false);
    if (song && isVideo) {
      setVideoOpen(true);
    }
  }, [song?.jobId, song?.name, song?.streamUrl, song?.lyricsUrl, request]);

  useEffect(() => {
    if (!lyricsViewers || !song || isVideo) return;
    let active = true;
    setLyricsLoaded(false);
    setLyricError('');
    request(song.lyricsUrl || `/api/jobs/${encodeURIComponent(song.jobId)}/lyrics/${encodeURIComponent(song.name)}`)
      .then((result) => { if (active) { setMetadata(result); setLyricsLoaded(true); } })
      .catch((error) => { if (active) setLyricError(error.message); });
    return () => { active = false; };
  }, [Boolean(lyricsViewers), song?.jobId, song?.name, song?.streamUrl, song?.lyricsUrl, request]);

  function selectSong(track, queue = songs, scope = queueScopeRef.current) {
    queueLoadRef.current++;
    setQueueLoading(false);
    autoPlayRef.current = true;
    queueScopeRef.current = scope;
    setSongs(queue);
    const key = songKey(track);
    if (selected === key) {
      if (mediaType(track.name) === 'video') setVideoOpen(true);
      audioRef.current?.play().catch(() => setPlayError('Playback could not start. Press play to retry.'));
    } else setSelected(key);
  }

  async function playLibrary(view, track = null, autoplay = true) {
    const scope = view.queueScope ?? view.selectedId;
    const intent = ++queueLoadRef.current;
    setPlayError('');
    try {
      let queue = songs;
      if (queueScopeRef.current !== scope || !queue?.length) {
        setQueueLoading(true);
        const cacheKey = JSON.stringify([scope, view.queueRevision]);
        if (queueRequestRef.current?.key !== cacheKey) {
          queueRequestRef.current = { key: cacheKey,
            promise: loadPlaybackQueue(request, view.queueQuery, view.tracks, view.pagination) };
        }
        queue = await queueRequestRef.current.promise;
      }
      if (intent !== queueLoadRef.current) return;
      const target = track ? queue.find((item) => songKey(item) === songKey(track)) : queue[0];
      if (!target) throw new Error('This song is no longer in the playlist. Please refresh and try again.');
      const pageSize = view.pagination?.pageSize || queuePageSize;
      setQueuePageSize(pageSize);
      setQueuePage(Math.floor(queue.indexOf(target) / pageSize) + 1);
      if (autoplay) selectSong(target, queue, scope);
      else {
        queueScopeRef.current = scope;
        setSongs(queue);
        setSelected(songKey(target));
      }
      setQueueLoading(false);
    } catch (error) {
      if (intent !== queueLoadRef.current) return;
      queueRequestRef.current = null;
      setQueueLoading(false);
      setPlayError(error.message);
    }
  }

  function nextSong(ended = false) {
    const next = nextPlaybackSong(songs, selected, { shuffle, repeatMode, ended });
    if (next) {
      if (songKey(next) === selected && audioRef.current) {
        audioRef.current.currentTime = 0;
        setPosition(0);
      }
      selectSong(next);
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
      const resume = resumePositionRef.current;
      if (resume?.selected === selected && Number.isFinite(resume.position)) {
        event.currentTarget.currentTime = Math.min(resume.position, Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : resume.position);
        setPosition(event.currentTarget.currentTime);
      }
      resumePositionRef.current = null;
      setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0);
    }}
    onDurationChange={(event) => setDuration(Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : 0)}
    onVolumeChange={(event) => {
      volumeRef.current = event.currentTarget.volume;
      mutedRef.current = event.currentTarget.muted;
      setVolume(event.currentTarget.volume);
      setMuted(event.currentTarget.muted);
    }}
    onTimeUpdate={(event) => {
      setPosition(event.currentTarget.currentTime);
      if (Date.now() - progressSavedAtRef.current >= 5000) {
        writePlaybackPosition(userId, selected, event.currentTarget.currentTime);
        progressSavedAtRef.current = Date.now();
      }
    }}
    onPlay={() => { setPlaying(true); setPlayError(''); }} onPause={(event) => {
      setPlaying(false);
      writePlaybackPosition(userId, selected, event.currentTarget.currentTime);
    }}
    onEnded={() => nextSong(true)} onError={() => setPlayError('This file could not be played. It may be unavailable, or its video/audio codec may be unsupported by this browser.')} />;

  function removeSong(jobId, name) {
    const key = JSON.stringify([jobId, name]);
    setSongs((current) => current?.filter((track) => songKey(track) !== key));
    setSelected((current) => current === key ? null : current);
  }

  function updateMetadata(jobId, name, result, readSnapshot = null) {
    if (selectedRef.current === JSON.stringify([jobId, name])) setMetadata((current) => mergePlaybackMetadata(current, result, readSnapshot));
    setSongs((current) => current?.map((track) => track.jobId === jobId && track.name === name
      ? mergePlaybackMetadata(track, { title: result.title, artist: result.artist, album: result.album, rating: result.rating,
        transcriptionLocked: result.transcriptionLocked }, readSnapshot) : track));
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

  return <PlaybackContext.Provider value={{ user, songs, setSongs, selected, setSelected, metadata, lyricError, lyricsLoaded, setLyricsViewers, playError, setPlayError,
    mode, setMode, copying, currentCopy, lyricsText, copyLyrics, position, setPosition, duration, volume, muted, playing,
    shuffle, setShuffle, repeatMode, setRepeatMode, audioRef, autoPlayRef, queueScopeRef, songKey, index, song,
    isVideo, videoOpen, setVideoOpen, restoredSelectionRef, playLibrary, queueLoading, queuePagination,
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
  const { user, songs, setSongs, selected, setSelected, metadata, lyricError, lyricsLoaded, setLyricsViewers, playError, setPlayError,
    mode, setMode, copying, currentCopy, lyricsText, copyLyrics, position, setPosition, duration, volume, muted, playing,
    shuffle, setShuffle, repeatMode, setRepeatMode, audioRef, autoPlayRef, queueScopeRef, songKey, index, song,
    isVideo, videoOpen, setVideoOpen, restoredSelectionRef, playLibrary, queueLoading, queuePagination,
    selectSong, playKaraoke, nextSong, previousSong, togglePlayback, removeSong, updateMetadata } = usePlayback();
  const [job, setJob] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [search, setSearch] = useState('');
  const [editingLyrics, setEditingLyrics] = useState(null);
  const [{ panel, renderedPanel }, setPanelState] = useState({ panel: null, renderedPanel: null });
  const [widePlayer, setWidePlayer] = useState(false);
  function updatePanel(next) {
    setPanelState((current) => current.panel === next ? current
      : { panel: next, renderedPanel: next || (dockOnly ? current.renderedPanel : null) });
  }
  function setPanel(next) {
    if (next !== 'lyrics') setEditingLyrics(null);
    updatePanel(next);
    if (dockOnly) navigationHistory().setPlayerPanel(next);
  }
  const dockRef = useRef(null);
  const queueListRef = useRef(null);
  const playerRegionRef = useRef(null);
  const expandButtonRef = useRef(null);
  const lines = lyricsLoaded ? metadata?.sylt || [] : [];
  const artwork = metadata?.artwork === undefined ? song?.artworkUrl : metadata.artwork;
  const requestedSong = new URLSearchParams(window.location.search).get('song');
  const requestedPlay = new URLSearchParams(window.location.search).get('play') === '1';
  const libraryScope = libraryView?.queueScope ?? libraryView?.selectedId;
  const canPlayNext = Boolean(song && (index < songs.length - 1 || repeatMode === 'all' || (shuffle && songs.length > 1)));
  const shuffleLabel = shuffle ? 'Shuffle on: turn off' : 'Shuffle off: turn on';
  const repeatLabel = repeatMode === 'off' ? 'Repeat off: repeat queue' : repeatMode === 'all' ? 'Repeat queue: repeat one song' : 'Repeat one song: turn off';
  const RepeatIcon = repeatMode === 'one' ? Repeat1 : Repeat;

  useEffect(() => {
    if (queueListRef.current) queueListRef.current.scrollTop = 0;
  }, [queuePagination.page]);

  useEffect(() => {
    if (panel !== 'lyrics') return;
    setLyricsViewers((count) => count + 1);
    return () => setLyricsViewers((count) => count - 1);
  }, [panel, setLyricsViewers]);

  useEffect(() => {
    if (isVideo && panel === 'lyrics') setPanel(dockOnly ? 'player' : null);
  }, [isVideo, panel]);

  useEffect(() => {
    if (!dockOnly) return;
    return navigationHistory().subscribe(({ playerPanel }) => {
      updatePanel(playerPanel);
      if (playerPanel !== 'lyrics') setEditingLyrics(null);
    });
  }, [dockOnly]);

  useEffect(() => {
    if (!dockOnly) return;
    const query = window.matchMedia('(min-width: 1024px)');
    const resize = () => setWidePlayer(query.matches);
    resize();
    query.addEventListener('change', resize);
    return () => query.removeEventListener('change', resize);
  }, [dockOnly]);

  useEffect(() => {
    if (!id) return;
    let active = true;
    Promise.all([request(`/api/jobs/${encodeURIComponent(id)}`), request(`/api/jobs/${encodeURIComponent(id)}/files`)])
      .then(([loadedJob, result]) => {
        if (!active) return;
        setJob(loadedJob);
        const sourceJob = { id: loadedJob.id, initiatedBy: loadedJob.initiatedBy, status: loadedJob.status };
        const tracks = result.files.filter((file) => file.isPlayable).map((file) => ({ ...file, jobId: id, playlistTitle: loadedJob.playlistTitle, sourceJob }));
        const saved = restoredSelectionRef.current;
        const restoredTrack = saved?.scope === `job:${id}` && saved.url === `${window.location.pathname}${window.location.search}`
          ? tracks.find((file) => songKey(file) === saved.selected) : null;
        restoredSelectionRef.current = null;
        const track = restoredTrack || tracks.find((file) => file.name === requestedSong) || tracks[0];
        if (track && (queueScopeRef.current !== `job:${id}` || requestedSong)) {
          if (requestedPlay && !restoredTrack) selectSong(track, tracks, `job:${id}`);
          else { queueScopeRef.current = `job:${id}`; setSongs(tracks); setSelected(songKey(track)); }
        } else if (queueScopeRef.current === `job:${id}`) {
          setSongs((current) => current?.map((file) => file.jobId === id ? { ...file, sourceJob } : file));
        }
      }).catch((error) => { if (active) setLoadError(error.message); });
    return () => { active = false; };
  }, [id, requestedSong, requestedPlay, request]);

  useEffect(() => {
    const tracks = libraryView?.tracks;
    if (!tracks) return;
    if (queueScopeRef.current === undefined && tracks.length) {
      playLibrary(libraryView, null, false);
    }
  }, [libraryView?.tracks, libraryScope]);

  useEffect(() => {
    if (libraryView?.removedSong) {
      const [jobId, name] = JSON.parse(libraryView.removedSong.key);
      removeSong(jobId, name);
    }
  }, [libraryView?.removedSong]);

  useEffect(() => {
    if (!dockOnly) return;
    const resize = () => document.documentElement.style.setProperty('--dock-height', `${dockRef.current.getBoundingClientRect().height}px`);
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(dockRef.current);
    return () => { observer.disconnect(); document.documentElement.style.removeProperty('--dock-height'); };
  }, [dockOnly]);

  useEffect(() => {
    if (!dockOnly || panel || !renderedPanel) return;
    let active = true;
    const finish = () => {
      if (active) setPanelState((current) => current.panel ? current : { panel: null, renderedPanel: null });
    };
    const animations = playerRegionRef.current?.querySelector('.now-playing-expanded')?.getAnimations?.() || [];
    if (animations.length) Promise.allSettled(animations.map((animation) => animation.finished)).then(finish);
    else finish();
    return () => { active = false; };
  }, [dockOnly, panel, renderedPanel]);

  useEffect(() => {
    if (!dockOnly || !renderedPanel) return;
    const region = playerRegionRef.current;
    const previousFocus = document.activeElement;
    const content = [...document.querySelectorAll('.app-shell, .movie-player')].map((element) => ({ element, inert: element.inert }));
    const overflow = document.body.style.overflow;
    const rootOverflow = document.documentElement.style.overflow;
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
    for (const { element } of content) element.inert = true;
    region?.querySelector('[role="tab"][aria-selected="true"]')?.focus({ preventScroll: true });
    const handleKey = (event) => {
      if (event.key === 'Escape') { event.preventDefault(); setPanel(null); }
      if (event.key !== 'Tab') return;
      const controls = [...region.querySelectorAll('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]')]
        .filter((element) => element.tabIndex >= 0 && element.getClientRects().length && !element.closest('[inert]'));
      const first = controls[0];
      const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', handleKey);
    return () => {
      document.body.style.overflow = overflow;
      document.documentElement.style.overflow = rootOverflow;
      for (const { element, inert } of content) element.inert = inert;
      document.removeEventListener('keydown', handleKey);
      if (region?.contains(document.activeElement) || document.activeElement === document.body) {
        (previousFocus !== document.body && previousFocus?.isConnected ? previousFocus : expandButtonRef.current)?.focus({ preventScroll: true });
      }
    };
  }, [dockOnly, Boolean(renderedPanel)]);

  useEffect(() => {
    if (dockOnly && panel) playerRegionRef.current?.querySelector('[role="tab"][aria-selected="true"]')?.focus({ preventScroll: true });
  }, [dockOnly, Boolean(panel)]);

  const lyricsPanel = <section className="music-lyrics" aria-label="Lyrics">
    <div className="section-title"><div><h2>Lyrics</h2></div>
      <div className="lyrics-actions">
        <div className="lyrics-tabs" role="group" aria-label="Lyrics type">
          <button type="button" aria-pressed={mode === 'sylt'} onClick={() => setMode('sylt')}>SYLT</button>
          <button type="button" aria-pressed={mode === 'uslt'} onClick={() => setMode('uslt')}>USLT</button>
        </div>
        {lyricsLoaded && metadata?.canEdit && !song?.readOnly && !editingLyrics && <button className="lyrics-copy" type="button" title="Edit lyrics" aria-label="Edit lyrics"
          disabled={!song || song.transcription?.status === 'sent'} onClick={() => setEditingLyrics({ song, metadata })}><Pencil size={17} /></button>}
        <button className="lyrics-copy" type="button" title={currentCopy && !currentCopy.error ? 'Lyrics copied' : 'Copy lyrics'} aria-label="Copy lyrics"
          disabled={!lyricsLoaded || Boolean(editingLyrics) || copying || !lyricsText.trim()} onClick={copyLyrics}>
          {copying ? <RefreshCw className="spin" size={17} /> : currentCopy && !currentCopy.error ? <Check size={17} /> : <Copy size={17} />}
        </button>
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
      }} /> : <LyricTimeline lines={lines} position={position} mode={mode} uslt={lyricsLoaded ? metadata?.uslt : ''}
        onSeek={(time) => { if (audioRef.current) audioRef.current.currentTime = time; }}>
        {lyricError ? <p className="notice error" role="alert">{lyricError}</p>
          : !lyricsLoaded ? <p className="music-empty" role="status">{song ? 'Loading lyrics...' : 'No song selected.'}</p> : null}
      </LyricTimeline>}
  </section>;

  if (libraryView || dockOnly) {
    const tracks = libraryView?.tracks || [];
    const trackSort = libraryView?.sort || 'order';
    const canDragSongs = trackSort === 'order' && !libraryView?.readOnly && !libraryView?.saving;
    const trackSearch = libraryView?.search ?? search;
    const visibleTracks = libraryView?.pagination ? tracks : tracks.filter((track) => songSearchText(track).includes(normalizeSearchText(trackSearch.trim())));
    const totalTracks = libraryView?.pagination?.total ?? tracks.length;
    const selection = libraryView?.songSelection;
    const selectedVisible = visibleTracks.filter((track) => selection?.keys.has(songKey(track))).length;
    return <div className={dockOnly ? 'global-player' : 'library-player'} ref={dockOnly ? playerRegionRef : undefined}
      role={dockOnly && renderedPanel ? 'dialog' : undefined} aria-modal={dockOnly && renderedPanel ? true : undefined}
      aria-label={dockOnly && renderedPanel ? 'Now playing' : undefined}>
      {libraryView && <div className="library-layout">
        {libraryView.sidebar}
        <section className="library-songs" aria-label="Playlist songs">
          <header className="library-selection-heading">
            <span className="selection-art">{libraryView.type === 'folder' ? <Folder size={30} /> : <Disc3 size={32} />}</span>
            <div><p className="eyebrow">{libraryView.type === 'folder' ? 'Playlist folder' : libraryView.selectedId ? 'Playlist' : 'Your collection'}</p>
              <h2>{libraryView.title}</h2><p>{totalTracks} track{totalTracks === 1 ? '' : 's'}</p>
              {libraryView.playlistPrivate && <p><Lock size={13} /> Private playlist — owner only</p>}</div>
            <button className="round-play" type="button" aria-label="Play selection" title="Play selection" disabled={!tracks.length || libraryView.loading}
              onClick={() => playLibrary(libraryView)}><Play size={22} fill="currentColor" /></button>
          </header>
          <div className="songs-toolbar"><h3>Tracks</h3>
            <label className="queue-search"><Search size={16} /><input type="search" aria-label="Search tracks" placeholder="Search tracks" maxLength={libraryView.pagination ? 200 : undefined} value={trackSearch} onChange={(event) => (libraryView.onSearch || setSearch)(event.target.value)} /></label>
            <label className="song-sort">Sort by<select aria-label="Sort songs" value={trackSort} disabled={libraryView.saving} onChange={(event) => libraryView.onSort(event.target.value)}>
              <option value="name">Name (A-Z)</option>
              <option value="order">Order number</option>
              <option value="rating">Rating (highest first)</option>
            </select></label>
            {libraryView.type === 'playlist' && libraryView.selectedId && <a className="music-icon-button"
              href={`/api/library/playlists/${encodeURIComponent(libraryView.selectedId)}/download${libraryView.ownerId ? `?${new URLSearchParams({ userId: libraryView.ownerId })}` : ''}`}
              target="_blank" rel="noreferrer" title="Download playlist (ZIP)" aria-label="Download playlist (ZIP)"><ArrowDownToLine size={19} /></a>}
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
            const privacy = action.privacy || getFilePrivacy(track);
            const privacyLabel = privacy.inherited ? 'Inherited privacy' : privacy.private ? 'Make file public' : 'Make file private';
            const acceptSong = (event) => allowDrop(event, canDragSongs && Boolean(libraryView.selectedId) && event.dataTransfer.types.includes('application/x-ssmusic-song'));
            return <li className={`library-song-row ${current ? 'is-current' : ''} ${selection?.active && selection.keys.has(songKey(track)) ? 'is-checked' : ''}`} key={songKey(track)}
              onDragEnter={acceptSong} onDragOver={acceptSong} onDragLeave={leaveDrop}
              onDrop={(event) => {
                event.preventDefault();
                if (!canDragSongs || !libraryView.selectedId) return;
                try {
                  const moved = JSON.parse(event.dataTransfer.getData('application/x-ssmusic-song'));
                  if (moved.playlistId === track.playlistId) libraryView.onReorder(moved, songKey(track));
                  else libraryView.onMove(moved, track.playlistId);
                } catch {}
              }}>
              {selection?.active ? <label className="library-row-check"><input className="library-select-checkbox" type="checkbox" aria-label={`Select song ${track.name}`} checked={selection.keys.has(songKey(track))} disabled={libraryView.saving}
                onChange={(event) => selection.change([songKey(track)], event.target.checked)} /></label> : libraryView.readOnly ? <span aria-hidden="true" /> : <button className="music-icon-button song-drag" type="button" draggable={canDragSongs} disabled={!canDragSongs}
                title={`Drag ${track.name}`} aria-label={`Drag ${track.name}`} onDragStart={(event) => {
                  if (!canDragSongs) { event.preventDefault(); return; }
                  const row = event.currentTarget.closest('.library-song-row');
                  row.dataset.dragging = 'true';
                  event.dataTransfer.setData('application/x-ssmusic-song', JSON.stringify({ jobId: track.jobId, name: track.name, playlistId: track.playlistId }));
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setDragImage(row, 24, 24);
                }}><GripVertical size={16} /></button>}
              <div className="song-title-actions"><button className="song-select" type="button" title={track.name} aria-label={`Play ${track.name}`} aria-current={current ? 'true' : undefined}
                onClick={() => playLibrary(libraryView, track)}>
                <span className="song-number">{mediaType(track.name) === 'video' ? <Film size={15} aria-label="Movie" /> : current && playing ? <Music2 size={15} /> : track.orderNumber ?? trackIndex + 1}</span>
                <SongArtwork track={track} />
                <span><strong>{track.title || track.name.split('/').at(-1).replace(/\.[^.]+$/, '')}</strong><small>{track.artist || (track.name.startsWith('[NoVocals]/') ? 'Instrumental' : track.playlistTitle || 'Original')}</small>
                  {privacy.private && <small><Lock size={12} /> {privacy.inherited ? 'Inherited privacy — owner only' : 'Private file — owner only'}</small>}
                  <TranscriptionStatus transcription={action.transcription} /></span>
              </button></div>
              <button className="song-playlist" type="button" title={track.playlistTitle} onClick={() => libraryView.onSelect(track.playlistId)}>{track.playlistTitle}</button>
              <ListSongRating file={track} jobId={track.jobId} request={request} canModify={action.canRate ?? action.canModify}
                disabled={(action.ratingDisabled ?? action.disabled) || libraryView.saving}
                onSaved={(result) => libraryView.onMetadataSaved(track, result)} onError={libraryView.onRatingError} />
              <SongActions name={track.name} className="song-order-actions" file={track} request={request}>
                <KaraokeButton track={track} tracks={tracks} onPlay={playKaraoke} showLabel />
                {action.canChangePrivacy && !libraryView.readOnly && <button className="music-icon-button" type="button"
                  title={privacy.inherited ? 'Private via source; change the source job or original file privacy first' : privacyLabel} data-action-label={privacyLabel}
                  aria-label={`${privacyLabel}: ${track.name}`} aria-pressed={privacy.private}
                  disabled={action.disabled || libraryView.saving || privacy.inherited} onClick={() => libraryView.onChangePrivacy(track)}>
                  {libraryView.saving ? <RefreshCw className="spin" size={16} /> : privacy.private ? <Lock size={16} /> : <LockOpen size={16} />}
                </button>}
                {action.canModify && !libraryView.readOnly && mediaType(track.name) && <button className="music-icon-button" type="button" title={privacy.private ? 'Private files cannot be shared' : 'Share Media'} data-action-label="Share Media" aria-label={`Share Media ${track.name}`} aria-haspopup="dialog" disabled={action.disabled || libraryView.saving || privacy.private} onClick={() => libraryView.onShareMedia(track)}><Share2 size={16} /></button>}
                {(action.canModify || action.canEditMetadata === false || libraryView.readOnly) && mediaType(track.name) === 'audio' && <button className="music-icon-button" type="button"
                  title={libraryView.readOnly || action.canEditMetadata === false ? 'View song metadata' : 'Edit song metadata'} aria-label={`${libraryView.readOnly || action.canEditMetadata === false ? 'View' : 'Edit'} metadata ${track.name}`}
                  aria-haspopup="dialog" disabled={!libraryView.readOnly && action.canEditMetadata !== false && action.disabled} onClick={() => libraryView.onEditMetadata(track)}>
                  {libraryView.readOnly || action.canEditMetadata === false ? <Info size={16} /> : <Pencil size={16} />}</button>}
                {action.canModify && !libraryView.readOnly && mediaType(track.name) === 'audio' && <button className="music-icon-button" type="button" title="Replace File" aria-label={`Replace File ${track.name}`} disabled={action.disabled || libraryView.saving} onClick={() => libraryView.onReplaceFile(track)}><Upload size={16} /></button>}
                {!libraryView.readOnly && mediaType(track.name) === 'audio' && !track.name.toLowerCase().startsWith('[novocals]/') && <button className="music-icon-button" type="button" data-action-label="Transcribe song" title={libraryView.transcriptionActive ? 'Transcribe song' : transcriptionInactiveMessage} aria-label={`Transcribe ${track.name}`} disabled={(action.metadataDisabled ?? action.disabled) || !libraryView.transcriptionActive} onClick={() => libraryView.onTranscribe(track)}><Mic size={16} /></button>}
                {action.canModify && <button className="music-icon-button" type="button" title="Remove song from playlist" aria-label={`Delete song ${track.name}`} disabled={action.disabled || libraryView.saving} onClick={() => libraryView.onDelete(track)}>{action.deleting ? <RefreshCw className="spin" size={16} /> : <Trash2 size={16} />}</button>}
                {!libraryView.readOnly && <button className="music-icon-button" type="button" title="Add/Move to playlist" aria-label={`Add/Move ${track.name} to playlist`} disabled={libraryView.saving} onClick={() => libraryView.onMove(track)}><ArrowRightLeft size={15} /></button>}
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
        {renderedPanel && <NowPlayingPanel panel={renderedPanel} expanded={Boolean(panel)} onChange={setPanel} wide={widePlayer} isVideo={isVideo}
          player={<NowPlayingTrack key={selected} song={song} metadata={metadata} artwork={artwork} request={request} updateMetadata={updateMetadata} />}
          lyrics={lyricsPanel} queue={<>
            <TrackPagination pagination={queuePagination} position="top" label="Queue" />
            <ol className="playback-queue" ref={queueListRef} start={(queuePagination.page - 1) * queuePagination.pageSize + 1}>
              {songs?.slice((queuePagination.page - 1) * queuePagination.pageSize, queuePagination.page * queuePagination.pageSize).map((track, offset) => <PlaybackQueueRow
                key={songKey(track)} track={track} number={(queuePagination.page - 1) * queuePagination.pageSize + offset + 1}
                current={songKey(track) === selected} user={user} request={request} onSelect={selectSong}
                sourceJob={track.sourceJob || track.job || songs.find((file) => file.jobId === track.jobId && file.sourceJob)?.sourceJob}
                onMetadataSaved={(file, result) => updateMetadata(file.jobId, file.name, result)} />)}
            </ol>
            {!songs?.length && <p className="music-empty" role="status">The queue is empty.</p>}
          </>} />}
      <footer className={`player-dock${panel ? ' is-expanded' : ''}`} aria-label="Music playback" ref={dockRef} onClick={(event) => {
        if (!event.target.closest('button, input, select, a, label')) setPanel(panel ? null : 'player');
      }}>
        <div className="dock-track" inert={Boolean(panel)} aria-hidden={Boolean(panel)}><button className="dock-expand" type="button" ref={expandButtonRef}
          title={panel ? 'Collapse now playing' : 'Expand now playing'} aria-label={panel ? 'Collapse now playing' : 'Expand now playing'}
          aria-expanded={Boolean(panel)} aria-controls={panel ? 'now-playing-expanded' : undefined} onClick={() => setPanel(panel ? null : 'player')}>
          <span className={`dock-artwork ${playing && !isVideo ? 'is-playing' : ''}`}>{isVideo ? <Film size={30} /> : artwork ? <img src={artwork} alt="Album cover" /> : <Disc3 size={30} />}</span>
          <span className="dock-summary"><strong>{metadata?.title || song?.name.split('/').at(-1).replace(/\.[^.]+$/, '') || 'Nothing playing'}</strong><small>{metadata?.artist || song?.playlistTitle || 'ssMusic Player'}</small></span>
          {panel ? <ChevronDown size={18} /> : <ChevronUp size={18} />}
        </button><KaraokeButton track={song} tracks={songs} onPlay={playKaraoke} /></div>
        <div className="dock-controls"><div className="dock-transport">
          <button className="music-icon-button" type="button" title={shuffleLabel} aria-label="Shuffle" aria-pressed={shuffle} onClick={() => setShuffle((current) => !current)}><Shuffle size={17} /></button>
          <button className="music-icon-button" type="button" title="Previous song" aria-label="Previous song" disabled={!song} onClick={previousSong}><SkipBack size={20} /></button>
          <button className="round-play" type="button" title={playing ? 'Pause' : 'Play'} aria-label={playing ? 'Pause' : 'Play'} disabled={!song} onClick={togglePlayback}>{playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}</button>
          <button className="music-icon-button" type="button" title="Next song" aria-label="Next song" disabled={!canPlayNext} onClick={() => nextSong()}><SkipForward size={20} /></button>
          <button className="music-icon-button" type="button" title={repeatLabel} aria-label={repeatLabel} aria-pressed={repeatMode !== 'off'} onClick={() => setRepeatMode(nextRepeatMode)}><RepeatIcon size={17} /></button>
        </div><div className="dock-timeline"><time>{timeLabel(position)}</time><input type="range" aria-label="Seek" min="0" max={duration || 0} step="0.1" value={Math.min(position, duration)} disabled={!duration}
          onChange={(event) => { audioRef.current.currentTime = Number(event.target.value); setPosition(Number(event.target.value)); }} /><time>{timeLabel(duration)}</time></div></div>
        <div className="dock-tools" inert={Boolean(panel)} aria-hidden={Boolean(panel)}>
          {isVideo && <button className="music-icon-button" type="button" title={videoOpen ? 'Hide movie' : 'Show movie'} aria-label={videoOpen ? 'Hide movie' : 'Show movie'} aria-pressed={videoOpen} onClick={() => { setPanel(null); setVideoOpen(!videoOpen); }}><Film size={18} /></button>}
          <button className="music-icon-button" type="button" title="Lyrics" aria-label="Show lyrics" disabled={isVideo} aria-pressed={panel === 'lyrics'} onClick={() => setPanel(panel === 'lyrics' ? null : 'lyrics')}><Mic2 size={18} /></button>
          <button className="music-icon-button" type="button" title="Playback queue" aria-label="Show playback queue" aria-pressed={Boolean(panel && (widePlayer || panel === 'queue'))} onClick={() => setPanel(panel === 'queue' ? null : 'queue')}><ListMusic size={19} /></button>
          <button className="music-icon-button volume-button" type="button" title={muted ? 'Unmute' : 'Mute'} aria-label={muted ? 'Unmute' : 'Mute'} disabled={!song} onClick={() => { audioRef.current.muted = !muted; }}>{muted || volume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}</button>
          <input className="volume-slider" type="range" aria-label="Volume" min="0" max="1" step="0.01" value={muted ? 0 : volume} disabled={!song} onChange={(event) => { audioRef.current.volume = Number(event.target.value); audioRef.current.muted = false; }} />
        </div>
        {queueLoading && <div className="notice playback-error" role="status"><RefreshCw className="spin" size={16} />Loading queue...</div>}
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
          {artwork ? <img src={artwork} alt={`${metadata?.album || song.title || song.name} cover`} /> : <div className="record-art"><Disc3 size={60} strokeWidth={1.2} /></div>}
        </div>
        <div className="playback-main">
          <div className="track-heading"><div><span>{song.name.startsWith('[NoVocals]/') ? 'NoVocals' : 'Original'}</span>
            <h2>{metadata?.title || song.name.split('/').at(-1)}</h2>
            {metadata?.artist && <p>{metadata.artist}{metadata.album ? ` / ${metadata.album}` : ''}</p>}
          </div><span className="track-position">{index + 1} / {songs.length}</span></div>
          <div className="transport-actions">
            <KaraokeButton track={song} tracks={songs} onPlay={playKaraoke} />
            <button type="button" title="Previous song" aria-label="Previous song" onClick={previousSong}><SkipBack size={19} /></button>
            <button type="button" title="Next song" aria-label="Next song" disabled={!canPlayNext} onClick={() => nextSong()}><SkipForward size={19} /></button>
            <button type="button" title={shuffleLabel} aria-label="Shuffle" aria-pressed={shuffle} onClick={() => setShuffle((current) => !current)}><Shuffle size={18} /></button>
            <button type="button" title={repeatLabel} aria-label={repeatLabel} aria-pressed={repeatMode !== 'off'} onClick={() => setRepeatMode(nextRepeatMode)}><RepeatIcon size={18} /></button>
          </div>
          {playError && <div className="notice error" role="alert">{playError}</div>}
        </div>
      </section>
      <div className="music-columns">
        <section className="music-queue" aria-label="Job songs">
          <div className="section-title"><div><ListMusic size={18} /><h2>Queue</h2></div></div>
          <label className="queue-search"><Search size={16} /><input type="search" aria-label="Search songs" placeholder="Search songs" value={search} onChange={(event) => setSearch(event.target.value)} /></label>
          <div className="queue-tracks">
            <SongGroups key={id} tracks={songs.filter((track) => songSearchText(track).includes(normalizeSearchText(search.trim())))}>{(group) => <ol>{group.map((track) => <li key={songKey(track)}><button type="button" aria-current={songKey(track) === selected ? 'true' : undefined} onClick={() => selectSong(track)}>
                  <Music2 size={17} /><span>{track.name.split('/').at(-1)}</span>
                  {songKey(track) === selected && <span className="queue-indicator" aria-label={playing ? 'Playing' : 'Selected'} />}
                </button><KaraokeButton track={track} tracks={songs} onPlay={playKaraoke} /></li>)}</ol>}</SongGroups>
            {!songs.some((track) => songSearchText(track).includes(normalizeSearchText(search.trim()))) && <p className="music-empty">No matching songs.</p>}
          </div>
        </section>
        <section>
          <button className="secondary-button" type="button" aria-pressed={panel === 'lyrics'} disabled={isVideo}
            onClick={() => setPanel(panel === 'lyrics' ? null : 'lyrics')}>{panel === 'lyrics' ? 'Hide lyrics' : 'Show lyrics'}</button>
          {panel === 'lyrics' && lyricsPanel}
        </section>
      </div>
    </>}
  </div>;
}