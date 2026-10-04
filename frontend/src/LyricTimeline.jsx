import { useEffect, useRef } from 'react';

function timeLabel(seconds) {
  const total = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function scrollToActiveLyric(container, reducedMotion) {
  if (!container) return;
  const line = container.querySelector('[aria-current="true"]');
  container.scrollTo({
    top: line ? line.offsetTop - container.clientHeight / 2 + line.clientHeight / 2 : 0,
    behavior: reducedMotion ? 'instant' : 'smooth'
  });
}

export default function LyricTimeline({
  lines = [], position = 0, mode = 'sylt', uslt = '', onSeek, disabled = false,
  formatTime = timeLabel, children
}) {
  const lyricRef = useRef(null);
  const activeLine = lines.findLastIndex((line) => line.time <= position);

  useEffect(() => {
    const container = lyricRef.current;
    const centerActiveLine = () => scrollToActiveLyric(container,
      window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    centerActiveLine();
    const observer = new ResizeObserver(centerActiveLine);
    observer.observe(container);
    return () => observer.disconnect();
  }, [activeLine, mode, lines]);

  return <div ref={lyricRef} className="lyric-timeline" tabIndex={0}
    aria-label={mode === 'sylt' ? 'Synchronized lyrics' : 'Unsynchronized lyrics'}>
    {children || (mode === 'uslt'
      ? (uslt ? <p className="plain-lyrics">{uslt}</p> : <p className="music-empty">No USLT lyrics embedded.</p>)
      : lines.length > 0 ? <ol>{lines.map((line, index) => <li key={index}>
        <button type="button" disabled={disabled}
          aria-current={activeLine === index ? 'true' : undefined}
          aria-label={`Seek to ${formatTime(line.time)}: ${line.text.trim() || 'Instrumental'}`}
          onClick={() => onSeek?.(line.time)}>
          <time aria-hidden="true">{formatTime(line.time)}</time><span>{line.text.trim() ? line.text : '♪'}</span>
        </button>
      </li>)}</ol> : <p className="music-empty">No SYLT lyrics embedded.</p>)}
  </div>;
}
