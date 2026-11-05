import { Music2 } from 'lucide-react';

export default function MusicLoading({ label = 'Loading music', compact = false }) {
  return <div className={`music-loading${compact ? ' music-loading--compact' : ''}`} role="status" aria-live="polite">
    <span className="music-loading-art" aria-hidden="true">
      <span className="music-loading-record"><Music2 size={26} strokeWidth={1.8} /></span>
      <span className="music-loading-bars">{[0, 1, 2, 3, 4].map((bar) => <span key={bar} style={{ animationDelay: `${bar * -0.14}s` }} />)}</span>
    </span>
    <span>{label}</span>
  </div>;
}