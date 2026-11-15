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
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.8;
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

export function radioPulseLevel(frequencies) {
  const count = Math.min(24, frequencies.length);
  let energy = 0;
  for (let index = 0; index < count; index++) energy += (frequencies[index] / 255) ** 2;
  return count ? Math.min(1, Math.sqrt(energy / count) * 2) : 0;
}

export function RadioPulse({ analyser, playing }) {
  const canvasRef = useRef(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas.getContext('2d');
    if (!context) { setError('This browser cannot draw the audio visualizer.'); return; }
    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const frequencies = new Uint8Array(analyser?.frequencyBinCount || 128);
    let frame = null;
    let size = 1;
    let phase = 0;
    let previousTime = null;
    let color = getComputedStyle(canvas).color;
    function draw(now, animate) {
      const elapsed = previousTime === null ? 0 : Math.min(100, now - previousTime);
      previousTime = now;
      if (animate) analyser.getByteFrequencyData(frequencies);
      const level = animate ? radioPulseLevel(frequencies) : 0;
      phase = (phase + elapsed * level / 1400) % 1;
      context.clearRect(0, 0, size, size);
      context.strokeStyle = color;
      for (let index = 0; index < 4; index++) {
        const progress = (phase + index / 4) % 1;
        context.globalAlpha = (1 - progress) * (0.2 + level * 0.65);
        context.lineWidth = 1.5 + level * 3;
        context.beginPath();
        context.arc(size / 2, size / 2, size * (0.16 + progress * 0.31 + level * 0.02), 0, Math.PI * 2);
        context.stroke();
      }
      context.globalAlpha = 0.65 + level * 0.35;
      context.lineWidth = 2 + level * 4;
      context.beginPath();
      context.arc(size / 2, size / 2, size * (0.15 + level * 0.045), 0, Math.PI * 2);
      context.stroke();
    }
    function tick(now) {
      frame = null;
      const animate = Boolean(analyser && playing && !document.hidden && !motion.matches);
      draw(now, animate);
      if (animate) frame = window.requestAnimationFrame(tick);
    }
    function refresh() {
      if (frame !== null) window.cancelAnimationFrame(frame);
      previousTime = null;
      tick(performance.now());
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

  return <div className="expanded-artwork radio-pulse">
    <canvas ref={canvasRef} role="img" aria-label="Radio pulse audio visualizer" />
    <Radio className="radio-pulse-icon" size={44} aria-hidden="true" />
    <span className="radio-pulse-label" role={error ? 'alert' : 'status'}>{error || (!analyser ? 'Preparing visualizer...' : playing ? 'Radio pulse' : 'Paused')}</span>
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
      : display === 'visualizer' ? <RadioPulse analyser={analyser} playing={playing} />
        : <div className="expanded-artwork">{artwork && artwork !== failedArtwork
          ? <img src={artwork} alt={`${song.album || song.title || song.name} cover`} draggable={false} onError={() => setFailedArtwork(artwork)} />
          : <Disc3 size={96} strokeWidth={1} />}</div>}
    {display === 'visualizer' && visualizerError && <div className="notice error" role="alert"><span>{visualizerError}</span>
      <button className="music-icon-button" type="button" title="Retry audio visualizer" aria-label="Retry audio visualizer"
        onClick={() => onModeChange('visualizer')}><RefreshCw size={18} /></button></div>}
  </>;
}
