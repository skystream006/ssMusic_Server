import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CircleAlert, RefreshCw, Terminal, X } from 'lucide-react';
import StatusBadge from './StatusBadge.jsx';
import { startVisiblePolling } from './polling.js';

export function LiveOutputDialog({ job, request, onClose }) {
  const dialogRef = useRef(null);
  const outputRef = useRef(null);
  const headingId = useId();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [following, setFollowing] = useState(true);

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    const previousOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    dialog.showModal();
    return () => {
      dialog.close();
      document.documentElement.style.overflow = previousOverflow;
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const result = await request(`/api/jobs/${encodeURIComponent(job.id)}/live-output`, {
          signal: controller.signal, cache: 'no-store'
        });
        if (controller.signal.aborted) return false;
        if (document.hidden) return;
        setData(result);
        setError('');
        return result.status === 'queued' || result.status === 'running' ? 1000 : false;
      } catch (loadError) {
        if (controller.signal.aborted) return false;
        if (document.hidden) return;
        setError(loadError.message);
        if ([401, 403, 404].includes(loadError.status)) {
          setData(null);
          return false;
        }
        return 2000;
      }
    }
    const stop = startVisiblePolling(load, 1000);
    return () => { controller.abort(); stop(); };
  }, [job.id, request]);

  useEffect(() => {
    const output = outputRef.current;
    if (!following || !output) return;
    const follow = () => { output.scrollTop = output.scrollHeight; };
    follow();
    const observer = new ResizeObserver(follow);
    observer.observe(output);
    return () => observer.disconnect();
  }, [data?.output, following]);

  const waiting = data?.status === 'queued' ? 'Waiting for job to start...'
    : data?.status === 'running' ? 'Waiting for process output...' : 'No process output was captured.';

  return <dialog ref={dialogRef} className="confirmation-dialog live-output-dialog" aria-labelledby={headingId}
    onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); onClose(); } }}
    aria-modal="true" onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <header className="live-output-heading">
      <div><h2 id={headingId}>Live output</h2><p>{job.playlistTitle || job.id}</p></div>
      <button className="music-icon-button" type="button" title="Close live output" aria-label="Close live output" onClick={onClose}><X size={20} /></button>
    </header>
    <div className="live-output-toolbar">
      {data ? <StatusBadge status={data.status} queuePosition={job.queuePosition} />
        : !error && <span className="live-output-connecting" role="status"><RefreshCw className="spin" size={15} />Connecting...</span>}
      {data?.truncated && <span className="live-output-truncated">Showing the latest output</span>}
      <label className="live-output-follow"><input type="checkbox" checked={following} onChange={(event) => setFollowing(event.target.checked)} />Follow output</label>
    </div>
    {error && <div className="notice error" role="alert"><CircleAlert size={16} />{error}</div>}
    <pre ref={outputRef} className="live-output-log" tabIndex={0} aria-label="Process output"
      onScroll={(event) => {
        const output = event.currentTarget;
        setFollowing(output.scrollHeight - output.scrollTop - output.clientHeight < 32);
      }}>{data?.output || (error ? '' : data ? waiting : 'Connecting to job output...')}</pre>
  </dialog>;
}

export default function LiveJobOutput({ job, user, request }) {
  const [open, setOpen] = useState(false);
  if (user?.role !== 'admin') return null;

  return <>
    <button className="secondary-button compact-button" type="button" title="Live output" aria-haspopup="dialog"
      aria-expanded={open} onClick={() => setOpen(true)}><Terminal size={16} />Live output</button>
    {open && createPortal(<LiveOutputDialog key={job.id} job={job} request={request} onClose={() => setOpen(false)} />, document.body)}
  </>;
}