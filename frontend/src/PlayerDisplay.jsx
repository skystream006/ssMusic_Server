import { useEffect, useRef, useState } from 'react';
import { Disc3, Film, Radio, RefreshCw } from 'lucide-react';

export function createAudioAnalyser(browser = globalThis) {
  let context = null;
  let analyser = null;
  let connected = null;
  let connectedMedia = null;
  let disposed = false;
  let revision = 0;
  const sources = new WeakMap();

  function disconnect() {
    if (!connected) return;
    connectedMedia.pause();
    connected.disconnect();
    connected = null;
    connectedMedia = null;
  }

  function release() {
    revision++;
    disconnect();
  }

  async function resume() {
    if (!context || disposed) return;
    if (context.state !== 'running') await context.resume();
    if (!disposed && context.state !== 'running') throw new Error('Audio output is suspended. Press Play to resume.');
  }

  return {
    resume,
    release,
    async attach(media) {
      const AudioContext = browser.AudioContext || browser.webkitAudioContext;
      if (!AudioContext) throw new Error('This browser does not support the audio visualizer.');
      if (!media) throw new Error('Select a song before starting the audio visualizer.');
      const requested = ++revision;
      context ||= new AudioContext();
      await resume();
      if (disposed || requested !== revision) return null;
      if (!analyser) {
        analyser = context.createAnalyser();
        analyser.fftSize = 2048;
      }
      let source = sources.get(media);
      if (!source) {
        source = context.createMediaElementSource(media);
        sources.set(media, source);
      }
      if (connected !== source) {
        disconnect();
        // Keep this path connected across display changes, but release replaced media elements.
        source.connect(context.destination);
        source.connect(analyser);
        connected = source;
        connectedMedia = media;
      }
      return analyser;
    },
    async dispose() {
      disposed = true;
      release();
      analyser?.disconnect();
      if (context && context.state !== 'closed') await context.close();
    }
  };
}

export function synchronizeSongVideo(audio, video, clock, { onError, page = document } = {}) {
  let disposed = false;
  let pendingPlay = null;
  let buffering = false;
  let failed = false;
  const pause = () => { pendingPlay = null; video.pause(); };
  const fail = () => {
    if (disposed || failed) return;
    failed = true;
    pause();
    onError('The linked video could not be played. Song audio is unchanged.');
  };
  const sync = (event) => {
    if (disposed || failed || video.error) return;
    if (event?.target === audio) {
      if (['waiting', 'stalled'].includes(event.type)) buffering = true;
      else if (['playing', 'canplay', 'seeked'].includes(event.type)) buffering = false;
    }
    const time = clock.currentTime;
    const end = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : Infinity;
    video.muted = true;
    video.playbackRate = audio.playbackRate;
    if (video.readyState >= 1 && Number.isFinite(time)
      && (['seeking', 'seeked', 'loadedmetadata'].includes(event?.type) || Math.abs(video.currentTime - time) > 0.2)) {
      try { video.currentTime = Math.max(0, Math.min(time, end)); }
      catch { fail(); return; }
    }
    if (audio.paused || audio.ended || audio.seeking || audio.readyState < 3 || buffering || page.hidden || time >= end) {
      pause();
    } else if (video.paused && !pendingPlay) {
      const attempt = {};
      pendingPlay = attempt;
      try {
        Promise.resolve(video.play()).catch(() => {
          if (pendingPlay === attempt) fail();
        }).finally(() => { if (pendingPlay === attempt) pendingPlay = null; });
      } catch { fail(); }
    }
  };
  const events = ['play', 'playing', 'pause', 'ended', 'timeupdate', 'seeking', 'seeked', 'ratechange', 'waiting', 'stalled', 'canplay'];
  for (const event of events) audio.addEventListener(event, sync);
  video.addEventListener('loadedmetadata', sync);
  video.addEventListener('canplay', sync);
  video.addEventListener('error', fail);
  page.addEventListener('visibilitychange', sync);
  sync();
  return () => {
    disposed = true;
    for (const event of events) audio.removeEventListener(event, sync);
    video.removeEventListener('loadedmetadata', sync);
    video.removeEventListener('canplay', sync);
    video.removeEventListener('error', fail);
    page.removeEventListener('visibilitychange', sync);
    pause();
  };
}

export function LinkedSongVideo({ song, mediaRef, clock, artwork }) {
  const videoRef = useRef(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const source = song.linkedVideo.streamUrl;
  useEffect(() => {
    const audio = mediaRef.current;
    const video = videoRef.current;
    setError('');
    video.src = source;
    if (!audio) { setError('Select a song before playing its linked video.'); return; }
    const stop = synchronizeSongVideo(audio, video, clock, { onError: setError });
    return () => {
      stop();
      video.removeAttribute('src');
      video.load();
    };
  }, [source, song.jobId, song.name, mediaRef, clock, retry]);

  return <>
    <div className="expanded-video linked-song-video"><video ref={videoRef} muted playsInline preload="metadata"
      poster={artwork || undefined} aria-label={`Video for ${song.title || song.name}`} /></div>
    {error && <div className="notice error" role="alert"><span>{error}</span>
      <button className="music-icon-button" type="button" title="Retry linked video" aria-label="Retry linked video"
        onClick={() => setRetry((value) => value + 1)}><RefreshCw size={18} /></button></div>}
  </>;
}

export function drawCircularWaveform(context, samples, size) {
  const center = size / 2;
  const radius = size * 0.25;
  const spikes = Math.min(128, samples.length);
  context.beginPath();
  for (let index = 0; index < spikes; index++) {
    const start = Math.floor(index * samples.length / spikes);
    const end = Math.floor((index + 1) * samples.length / spikes);
    let peak = 0;
    for (let sample = start; sample < end; sample++) peak = Math.max(peak, Math.abs(samples[sample]));
    const angle = index / spikes * Math.PI * 2 - Math.PI / 2;
    const x = Math.cos(angle);
    const y = Math.sin(angle);
    const tip = radius + size * (0.01 + Math.min(1, peak) * 0.12);
    context.moveTo(center + x * radius, center + y * radius);
    context.lineTo(center + x * tip, center + y * tip);
  }
  context.stroke();
}

export function CircularWaveform({ analyser, playing }) {
  const canvasRef = useRef(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas.getContext('2d');
    if (!context) { setError('This browser cannot draw the audio visualizer.'); return; }
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const samples = new Float32Array(analyser?.fftSize || 2048);
    let frame = null;
    let size = 1;
    let color = getComputedStyle(canvas).color;
    function draw(active) {
      if (active) analyser.getFloatTimeDomainData(samples);
      else samples.fill(0);
      context.clearRect(0, 0, size, size);
      context.strokeStyle = color;
      context.lineWidth = Math.max(1, size / 240);
      context.lineCap = 'round';
      drawCircularWaveform(context, samples, size);
    }
    function tick() {
      frame = null;
      const active = Boolean(analyser && playing && !document.hidden);
      draw(active);
      if (active && !motion.matches) frame = window.requestAnimationFrame(tick);
    }
    function refresh() {
      if (frame !== null) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(tick);
    }
    function resize() {
      size = Math.max(1, canvas.getBoundingClientRect().width);
      const scale = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(size * scale);
      canvas.height = Math.round(size * scale);
      context.setTransform(scale, 0, 0, scale, 0, 0);
      color = getComputedStyle(canvas).color;
      refresh();
    }
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    motion.addEventListener('change', refresh);
    document.addEventListener('visibilitychange', refresh);
    resize();
    return () => {
      if (frame !== null) window.cancelAnimationFrame(frame);
      observer.disconnect();
      motion.removeEventListener('change', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [analyser, playing]);

  return <div className="expanded-artwork circular-waveform">
    <canvas ref={canvasRef} role="img" aria-label="Circular spike audio waveform" />
    <Radio className="circular-waveform-icon" size={44} aria-hidden="true" />
    <span className="circular-waveform-label" role={error ? 'alert' : 'status'}>{error || (!analyser ? 'Preparing visualizer...' : playing ? 'Circular spikes' : 'Paused')}</span>
  </div>;
}

export default function PlayerDisplay({ song, artwork, mode, onModeChange, mediaRef, clock, analyser, playing, visualizerError, active = true }) {
  const [failedArtwork, setFailedArtwork] = useState(null);
  const hasVideo = song?.linkedVideo?.status === 'completed' && Boolean(song.linkedVideo.streamUrl);
  const display = !active || (mode === 'video' && !hasVideo) ? 'artwork' : mode;
  const modes = [{ id: 'artwork', label: 'Album art', Icon: Disc3 },
    { id: 'visualizer', label: 'Audio visualizer', Icon: Radio }, { id: 'video', label: 'Video', Icon: Film }];
  return <>
    <div className="player-display-modes" role="group" aria-label="Player display">
      {modes.map(({ id, label, Icon }) => <button key={id} type="button" aria-label={label}
        title={id === 'video' && !hasVideo ? 'Download this song\'s video from its action menu first' : label}
        aria-pressed={display === id} disabled={id === 'video' && !hasVideo} onClick={() => onModeChange(id)}>
        <Icon size={18} /><span>{label}</span></button>)}
    </div>
    {display === 'video' ? <LinkedSongVideo song={song} mediaRef={mediaRef} clock={clock} artwork={artwork} />
      : display === 'visualizer' ? <CircularWaveform analyser={analyser} playing={playing} />
        : <div className="expanded-artwork">{artwork && artwork !== failedArtwork
          ? <img src={artwork} alt={`${song.album || song.title || song.name} cover`} draggable={false} onError={() => setFailedArtwork(artwork)} />
          : <Disc3 size={96} strokeWidth={1} />}</div>}
    {display === 'visualizer' && visualizerError && <div className="notice error" role="alert"><span>{visualizerError}</span>
      <button className="music-icon-button" type="button" title="Retry audio visualizer" aria-label="Retry audio visualizer"
        onClick={() => onModeChange('visualizer')}><RefreshCw size={18} /></button></div>}
  </>;
}
