import { Check, CircleAlert, Clock3, Pause, RefreshCw, Square, X } from 'lucide-react';

export default function StatusBadge({ status, queuePosition, pausedUntil, commandProgress }) {
  const paused = status === 'running' && Boolean(pausedUntil);
  const showProgress = status !== 'queued' && Number.isInteger(commandProgress?.completed) && commandProgress.completed >= 0
    && Number.isInteger(commandProgress.total) && commandProgress.total > 0 && commandProgress.completed <= commandProgress.total;
  const icon = paused ? <Pause size={13} /> : status === 'stopped' ? <Square size={13} /> : status === 'completed' ? <Check size={13} />
    : status === 'failed' ? <X size={13} />
      : status === 'partially_completed' ? <CircleAlert size={13} />
        : status === 'running' ? <RefreshCw size={13} /> : <Clock3 size={13} />;
  const label = paused ? 'Paused - Rate limit' : status === 'queued' && Number.isInteger(queuePosition) && queuePosition > 0
    ? `Queued - Current Position #${queuePosition}`
    : status === 'partially_completed' ? 'partially completed' : status;
  return <span className={`status status-${paused ? 'paused' : status}`}>{icon}<span>{label}
    {showProgress && <span className="job-command-progress">Commands: {commandProgress.completed.toLocaleString()} / {commandProgress.total.toLocaleString()}</span>}
  </span></span>;
}