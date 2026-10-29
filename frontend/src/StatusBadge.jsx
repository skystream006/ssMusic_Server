import { Check, CircleAlert, Clock3, RefreshCw, X } from 'lucide-react';

export default function StatusBadge({ status, queuePosition }) {
  const icon = status === 'completed' ? <Check size={13} />
    : status === 'failed' ? <X size={13} />
      : status === 'partially_completed' ? <CircleAlert size={13} />
        : status === 'running' ? <RefreshCw size={13} /> : <Clock3 size={13} />;
  const label = status === 'queued' && Number.isInteger(queuePosition) && queuePosition > 0
    ? `Queued - Current Position #${queuePosition}`
    : status === 'partially_completed' ? 'partially completed' : status;
  return <span className={`status status-${status}`}>{icon}{label}</span>;
}