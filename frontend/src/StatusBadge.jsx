import { Check, CircleAlert, Clock3, Pause, RefreshCw, X } from 'lucide-react';

export default function StatusBadge({ status, queuePosition, pausedUntil }) {
  const paused = status === 'running' && Boolean(pausedUntil);
  const icon = paused ? <Pause size={13} /> : status === 'completed' ? <Check size={13} />
    : status === 'failed' ? <X size={13} />
      : status === 'partially_completed' ? <CircleAlert size={13} />
        : status === 'running' ? <RefreshCw size={13} /> : <Clock3 size={13} />;
  const label = paused ? 'Paused - Rate limit' : status === 'queued' && Number.isInteger(queuePosition) && queuePosition > 0
    ? `Queued - Current Position #${queuePosition}`
    : status === 'partially_completed' ? 'partially completed' : status;
  return <span className={`status status-${paused ? 'paused' : status}`}>{icon}{label}</span>;
}