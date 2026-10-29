import { CircleAlert, Clock3, ExternalLink, ListOrdered, Lock, RefreshCw, Square } from 'lucide-react';
import { formatDate } from './SongActions.jsx';
import StatusBadge from './StatusBadge.jsx';

function QueueJobRow({ job, onStop, stoppingId }) {
  return <li className="queue-job-row">
    <div className="queue-job-details">
      {job.hidden ? <strong className="queue-job-title"><Lock size={15} />Private job</strong> : <>
        <a className="queue-job-title" href={`/job/${encodeURIComponent(job.id)}`}>
          <strong>{job.playlistTitle || (job.isPlaylist ? 'Preparing playlist' : 'Preparing track')}</strong><ExternalLink size={15} />
        </a>
        <a className="queue-job-source" href={job.url} target="_blank" rel="noreferrer">{job.url}</a>
        <div className="queue-job-type">
          <span>{job.downloadType === 'video' ? 'Video' : 'Audio'} {job.isPlaylist ? 'playlist' : 'track'}</span>
          {job.isPlaylist && Number.isInteger(job.playlistSongCount) && <span>{job.playlistSongCount.toLocaleString()} items</span>}
          {job.metadataOnly && <span>Metadata only</span>}
        </div>
      </>}
    </div>
    <div className="queue-job-owner">
      {!job.hidden && <><span>Submitted by</span><strong>{job.initiatedBy?.name || 'Unknown'}</strong>
        <span>{job.status === 'queued' ? 'Queued' : 'Started'} <time dateTime={job.updatedAt}>{formatDate(job.updatedAt)}</time></span></>}
      {job.pausedUntil && <span>Resumes <time dateTime={job.pausedUntil}>{formatDate(job.pausedUntil)}</time></span>}
    </div>
    <div className="queue-job-state"><StatusBadge status={job.status} queuePosition={job.queuePosition} pausedUntil={job.pausedUntil} commandProgress={job.commandProgress} />
      {onStop && !job.hidden && ['queued', 'running'].includes(job.status) && <button className="music-icon-button" type="button"
        title="Stop job" aria-label={`Stop job ${job.id}`} disabled={Boolean(stoppingId)} onClick={() => onStop(job)}>
        {stoppingId === job.id ? <RefreshCw className="spin" size={17} /> : <Square size={17} />}
      </button>}
    </div>
  </li>;
}

export default function AdminJobQueue({ data, error = '', onRefresh, onStop, stoppingId }) {
  const loading = !data && !error;
  return <>
    <section className="page-heading admin-heading queue-heading">
      <div><p className="eyebrow">Jobs</p><h1>Jobs Queue</h1></div>
      <button className="music-icon-button" type="button" title="Refresh job queue" aria-label="Refresh job queue" disabled={loading} onClick={onRefresh}>
        <RefreshCw size={20} className={loading ? 'spin' : undefined} />
      </button>
    </section>
    {error && <p className="notice error" role="alert"><CircleAlert size={16} />Queue status unavailable: {error}</p>}
    {loading && <p className="loading" role="status"><RefreshCw className="spin" size={18} />Loading job queue...</p>}
    {data?.rateLimit?.limited && <p className="notice error" role="alert"><CircleAlert size={16} />{data.rateLimit.message}</p>}
    {data?.maintenance && <p className="notice" role="status"><RefreshCw size={16} className="spin" />Runtime maintenance in progress</p>}
    {data && <>
      <section className="admin-job-queue" aria-labelledby="running-job-heading">
        <div className="section-title"><div><Clock3 size={19} /><h2 id="running-job-heading">{data.running?.pausedUntil ? 'Paused job' : 'Running job'}</h2></div><strong role="status">{data.running ? '1 / 1' : '0 / 1'}</strong></div>
        {data.running ? <ul className="queue-job-list"><QueueJobRow job={data.running} onStop={onStop} stoppingId={stoppingId} /></ul>
          : <div className="empty-state compact"><Clock3 size={28} /><h3>No jobs running</h3></div>}
      </section>
      <section className="admin-job-queue" aria-labelledby="queued-jobs-heading">
        <div className="section-title"><div><ListOrdered size={19} /><h2 id="queued-jobs-heading">Queued jobs</h2></div><strong role="status">{data.queued.length}</strong></div>
        {data.queued.length ? <ol className="queue-job-list">{data.queued.map((job) => <QueueJobRow key={job.id || `queued-${job.queuePosition}`} job={job} onStop={onStop} stoppingId={stoppingId} />)}</ol>
          : <div className="empty-state compact"><ListOrdered size={28} /><h3>No jobs queued</h3></div>}
      </section>
    </>}
  </>;
}