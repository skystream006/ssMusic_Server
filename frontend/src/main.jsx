import { createContext, StrictMode, useContext, useEffect, useId, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import {
  Activity,
  ArrowDown,
  ArrowDownToLine,
  ArrowLeft,
  ArrowUp,
  ArrowUpDown,
  Check,
  CircleAlert,
  Clock3,
  Copy,
  Disc3,
  ExternalLink,
  FileAudio,
  Fingerprint,
  HardDrive,
  KeyRound,
  ListChecks,
  ListPlus,
  ListMusic,
  Lock,
  LockOpen,
  LogOut,
  MemoryStick,
  Moon,
  Music2,
  Network,
  Palette,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Settings,
  Share2,
  ShieldCheck,
  Sun,
  Trash2,
  Mic,
  UserCheck,
  Users,
  UserX,
  Upload,
  X
} from 'lucide-react';
import './styles.css';
import appIcon from './assets/ic_launcher.png';
import MusicPlayer, { PlaybackProvider, usePlayback } from './MusicPlayer.jsx';
import PublicMedia, { PublicPlaylist } from './PublicMedia.jsx';
import AdminMediaShares, { AdminArtworkThumbnails } from './AdminMediaShares.jsx';
import SharedLibraries, { SharedLibraryAccess } from './SharedLibraries.jsx';
import { LibraryAccessList, LinkedUsers, OrganizedSharedUsers, OrganizerControl, SettingsTabs, SharedRegistrationFields, UsernameForm } from './AccountSettings.jsx';
import ImportMusic from './ImportMusic.jsx';
import JobPlaylistDialog from './JobPlaylistDialog.jsx';
import { submitJobUrl } from './jobSubmission.js';
import { jobSortColumns, sortJobs } from './jobSorting.js';
import { navigate, useNavigation } from './navigation.js';
import { initializeTouchControls } from './touchControls.js';
import { countDownloadedFiles, themes } from '../../src/library.js';
import { isPlayableFile } from '../../src/media.js';
import { canChangePrivacy, canManageJob, canModifyJob, canRunJobAction, getFilePrivacy, isContributor, formatBytes, formatDate, ListSongRating, MetadataDialog, ReplaceFileDialog, ShareMediaDialog, SongActions, TranscriptionDialog, transcriptionInactiveMessage, TranscriptionStatus, useTranscriptionService } from './SongActions.jsx';

const POLL_INTERVAL = 5000;
const AuthContext = createContext(null);

function ConfirmationDialog({ title, message, action, label, onAnswer }) {
  const dialogRef = useRef(null);
  const titleId = useId();
  const messageId = useId();
  const ActionIcon = action === 'delete' ? Trash2 : action === 'rerun' ? RotateCcw : ExternalLink;
  const actionLabel = label || (action === 'delete' ? 'Delete job' : action === 'rerun' ? 'Rerun job' : 'Open details');

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  return <dialog ref={dialogRef} className="confirmation-dialog" aria-labelledby={titleId} aria-describedby={messageId}
    onKeyDown={(event) => { if (event.key === 'Escape') { event.preventDefault(); onAnswer(false); } }}
    onCancel={(event) => { event.preventDefault(); onAnswer(false); }}>
    <h2 id={titleId}>{title}</h2>
    <p id={messageId}>{message}</p>
    <div className="dialog-actions">
      <button className="secondary-button" type="button" onClick={() => onAnswer(false)}>Cancel</button>
      <button className={action === 'delete' ? 'danger-button' : 'primary-button'} type="button" onClick={() => onAnswer(true)}>
        <ActionIcon size={17} />{actionLabel}
      </button>
    </div>
  </dialog>;
}

function useConfirmation() {
  const [options, setOptions] = useState(null);
  const answerRef = useRef(null);

  useEffect(() => () => {
    answerRef.current?.(false);
    answerRef.current = null;
  }, []);

  function confirm(options) {
    if (answerRef.current) return Promise.resolve(false);
    return new Promise((resolve) => {
      answerRef.current = resolve;
      setOptions(options);
    });
  }

  function answer(value) {
    answerRef.current?.(value);
    answerRef.current = null;
    setOptions(null);
  }

  return { confirm, dialog: options && <ConfirmationDialog {...options} onAnswer={answer} /> };
}

async function request(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { error: text || 'Request failed' };
  }
  if (!response.ok) {
    const error = new Error(body.error || 'Request failed');
    error.status = response.status;
    error.code = body.code;
    error.existingJob = body.existingJob;
    throw error;
  }
  return body;
}

function usePolling(loader, interval = POLL_INTERVAL, pollingKey = 'default') {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const result = await loader();
        if (active) {
          setData(result);
          setError('');
        }
      } catch (loadError) {
        if (active) setError(loadError.message);
      }
    };

    load();
    const timer = window.setInterval(load, interval);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [interval, pollingKey]);

  return { data, error };
}

const loadJobs = () => request('/api/jobs');
const loadBackup = () => request('/api/library/backup');
const loadHealth = () => request('/api/health');

function ThemeChoices() {
  const { theme, themeMode, changeTheme, themeSaving, themeError } = useContext(AuthContext);
  return <>
    <div className="theme-mode-controls" role="group" aria-label="Theme mode">
      <button type="button" aria-pressed={themeMode === 'light'} disabled={themeSaving} onClick={() => changeTheme(theme, 'light')}><Sun size={17} />Light</button>
      <button type="button" aria-pressed={themeMode === 'dark'} disabled={themeSaving} onClick={() => changeTheme(theme, 'dark')}><Moon size={17} />Dark</button>
    </div>
    <div className="theme-choices" role="group" aria-label="Color theme">
      {themes.map((option) => <button className="theme-choice" type="button" key={option.id}
        aria-label={`${option.name} theme`} aria-pressed={theme === option.id} title={option.name} disabled={themeSaving} onClick={() => changeTheme(option.id)}>
        <span className="theme-swatch" style={{ backgroundColor: option.color }}>{theme === option.id && <Check size={19} />}</span><span>{option.name}</span>
      </button>)}
    </div>
    {themeSaving && <p className="sr-only" role="status">Saving theme</p>}
    {themeError && <p className="notice error" role="alert">{themeError}</p>}
  </>;
}

function ThemeDialog({ onClose }) {
  const dialogRef = useRef(null);
  const headingId = useId();
  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    dialog.showModal();
    return () => { dialog.close(); if (previousFocus?.isConnected) previousFocus.focus(); };
  }, []);
  return <dialog ref={dialogRef} className="confirmation-dialog theme-dialog" aria-labelledby={headingId} onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <div className="folder-dialog-heading"><h2 id={headingId}>Appearance</h2><button className="music-icon-button" type="button" aria-label="Close appearance" title="Close" onClick={onClose}><X size={18} /></button></div>
    <ThemeChoices />
  </dialog>;
}

function AppShell({ children, section = 'jobs' }) {
  const { user, logout } = useContext(AuthContext);
  const [choosingTheme, setChoosingTheme] = useState(false);
  useEffect(() => { document.title = section === 'music' ? `${user.name}'s Music` : `${section.charAt(0).toUpperCase()}${section.slice(1)} | ssMusicServer`; }, [section, user.name]);
  return (
    <div className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="ssMusic Player">
          <img className="brand-mark" src={appIcon} alt="" width="34" height="34" />
          <span>ssMusic</span>
        </a>
        <nav aria-label="Main navigation">
          <a className={section === 'music' ? 'active' : ''} href="/" title="Music library" aria-label="Music library">
            <Music2 size={17} /> Music
          </a>
          {user.role !== 'shared' && <><a className={section === 'jobs' ? 'active' : ''} href="/job" title="Jobs" aria-label="Jobs">
            <ListMusic size={17} /> Jobs
          </a>
          <a className={section === 'health' ? 'active' : ''} href="/health">
            <Activity size={17} /> Health
          </a></>}
          {user.role === 'admin' && <a className={section === 'admin' ? 'active' : ''} href="/admin">
            <Users size={17} /> Admin
          </a>}
        </nav>
        <div className="account-menu">
          <span><strong>{user.name}</strong><small>{user.role}</small></span>
          <button onClick={() => setChoosingTheme(true)} type="button" aria-label="Choose theme" title="Choose theme"><Palette size={17} /></button>
          <a href="/settings" className={section === 'settings' ? 'active' : ''} aria-label="User settings" title="User settings"><Settings size={17} /></a>
          <button onClick={logout} type="button" aria-label="Log out" title="Log out"><LogOut size={17} /></button>
        </div>
      </header>
      <main className={section === 'music' ? 'music-main' : undefined}>
        {section === 'admin' && <nav className="admin-tabs" aria-label="Administration">
          <a href="/admin" aria-current={window.location.pathname === '/admin' ? 'page' : undefined}><Users size={17} />Users</a>
          <a href="/admin/shared-links" aria-current={window.location.pathname === '/admin/shared-links' ? 'page' : undefined}><Share2 size={17} />Shared links</a>
        </nav>}
        {children}
      </main>
      {choosingTheme && <ThemeDialog onClose={() => setChoosingTheme(false)} />}
    </div>
  );
}

function StatusBadge({ status }) {
  const icon = status === 'completed' ? <Check size={13} />
    : status === 'failed' ? <X size={13} />
      : status === 'partially_completed' ? <CircleAlert size={13} />
      : status === 'running' ? <RefreshCw size={13} /> : <Clock3 size={13} />;
  const label = status === 'partially_completed' ? 'partially completed' : status;
  return <span className={`status status-${status}`}>{icon}{label}</span>;
}

function MusicHomePage() {
  const { user } = useContext(AuthContext);
  const { confirm, dialog } = useConfirmation();
  return <AppShell section="music"><SharedLibraries user={user} request={request} confirm={confirm} />{dialog}</AppShell>;
}

function BackupJobStatus() {
  const { data: backup, error } = usePolling(loadBackup);
  const status = backup?.running ? 'running' : backup?.error ? 'failed' : backup?.latest ? 'completed' : null;
  const totalSongs = backup?.running ? backup.progress?.totalSongs : status === 'completed' ? backup.latest.songCount : null;
  const processedSongs = backup?.running ? backup.progress?.processedSongs : totalSongs;
  const format = backup?.running ? backup.progress?.format : status === 'completed' ? backup.latest.format : null;
  const hasCount = Number.isInteger(totalSongs) && Number.isInteger(processedSongs);
  const timestamp = status === 'completed' ? backup.latest.createdAt : backup?.lastAttemptAt;
  const stage = backup?.progress?.stage === 'finalizing' ? 'Finalizing archive'
    : hasCount ? 'Writing archive' : 'Preparing songs';

  return <section className="jobs-section backup-jobs-section" aria-labelledby="backup-jobs-heading">
    <div className="section-title"><div><span>02</span><h2 id="backup-jobs-heading">Your library backup</h2></div></div>
    {error && <div className="notice error" role="alert"><CircleAlert size={16} />Backup status unavailable: {error}</div>}
    {backup ? <>
      <div className="backup-job-row">
        <HardDrive size={22} aria-hidden="true" />
        <div className="backup-job-details">
          <strong>{format === 'itunes' ? 'iTunes backup' : format === 'android' ? 'Android backup' : 'Library backup'}</strong>
          <small>{timestamp ? `${status === 'completed' ? 'Completed' : 'Started'} ${formatDate(timestamp)}` : 'No backups yet'}</small>
        </div>
        {status && <StatusBadge status={status} />}
        <div className="backup-job-progress">
          <div role="status" aria-live="polite">
            {hasCount ? <span>{processedSongs.toLocaleString()} / {totalSongs.toLocaleString()} songs processed</span>
              : <span>{backup.running ? stage : status === 'completed' ? 'Backup ready' : status === 'failed' ? 'Backup failed' : 'Not started'}</span>}
            {backup.running && hasCount && <small>{stage}</small>}
          </div>
          {(backup.running || (hasCount && totalSongs > 0)) && <progress aria-label="Backup song progress"
            max={totalSongs > 0 ? totalSongs : 1} value={hasCount && totalSongs > 0 ? processedSongs : undefined} />}
        </div>
        {backup.latest && <a className="icon-link" href="/api/library/export?source=latest" target="_blank" rel="noreferrer"
          aria-label="Download latest backup ZIP" title="Download latest backup ZIP"><ArrowDownToLine size={17} /></a>}
      </div>
      {backup.error && <div className="notice error" role="alert"><CircleAlert size={16} />{backup.error}</div>}
    </> : !error && <p className="refresh-note" role="status">Loading backup status</p>}
  </section>;
}

function JobsPage() {
  const playback = usePlayback();
  const { user } = useContext(AuthContext);
  const { confirm, dialog } = useConfirmation();
  const [revision, setRevision] = useState(0);
  const { data: jobs, error: loadError } = usePolling(loadJobs, POLL_INTERVAL, revision);
  const [url, setUrl] = useState('');
  const [downloadType, setDownloadType] = useState('audio');
  const [metadataOnly, setMetadataOnly] = useState(false);
  const [message, setMessage] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [jobAction, setJobAction] = useState(null);
  const [actionError, setActionError] = useState('');
  const [userFilter, setUserFilter] = useState('mine');
  const [jobSort, setJobSort] = useState({ key: 'created', direction: 'desc' });
  const [importing, setImporting] = useState(false);
  const [addingJob, setAddingJob] = useState(null);
  const [playlistMessage, setPlaylistMessage] = useState('');
  const [selectingJobs, setSelectingJobs] = useState(false);
  const [selectedJobIds, setSelectedJobIds] = useState(new Set());
  const [bulkResult, setBulkResult] = useState(null);

  useEffect(() => {
    if (!jobs) return;
    const availableIds = new Set(jobs.map((job) => job.id));
    setSelectedJobIds((current) => {
      const next = new Set([...current].filter((id) => availableIds.has(id)));
      return next.size === current.size ? current : next;
    });
  }, [jobs]);

  function selectJobs(ids, checked) {
    setSelectedJobIds((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (checked) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }

  function changeSort(key) {
    setJobSort((current) => ({
      key,
      direction: current.key === key ? (current.direction === 'asc' ? 'desc' : 'asc') : (key === 'created' ? 'desc' : 'asc')
    }));
  }

  async function runJobAction(job, action) {
    if (jobAction || !canRunJobAction(user, job, action)) return;
    const message = action === 'rerun'
      ? `Rerun ${job.playlistTitle || job.id}? Keep existing songs and download missing ones?`
      : `Delete ${job.playlistTitle || job.id} and all of its downloaded files?`;
    if (!await confirm({ title: action === 'rerun' ? 'Rerun job?' : 'Delete job?', message, action })) return;

    setJobAction({ id: job.id, action });
    setActionError('');
    setBulkResult(null);
    try {
      const jobUrl = `/api/jobs/${encodeURIComponent(job.id)}`;
      if (action === 'rerun') {
        await request(`${jobUrl}/rerun`, { method: 'POST' });
        navigate(`/job/${encodeURIComponent(job.id)}`);
      } else {
        await request(jobUrl, { method: 'DELETE' });
        playback.removeJob(job.id);
        selectJobs([job.id], false);
        setRevision((current) => current + 1);
        setJobAction(null);
      }
    } catch (error) {
      setActionError(error.message);
      setJobAction(null);
    }
  }

  async function runSelectedJobAction(action) {
    if (jobAction || !selectedJobs.length || !selectedJobs.every((job) => canRunJobAction(user, job, action))) return;
    const targets = [...selectedJobs];
    const label = `${action === 'delete' ? 'Delete' : 'Rerun'} ${targets.length} selected ${targets.length === 1 ? 'job' : 'jobs'}`;
    const message = action === 'delete'
      ? `Delete all ${targets.length} selected jobs and all their downloaded files? This also removes their files from linked playlists and cannot be undone.`
      : `Rerun all ${targets.length} selected jobs? Existing files will be kept and missing media downloaded.`;
    if (!await confirm({ title: `${label}?`, message, action, label })) return;

    setActionError('');
    setBulkResult(null);
    const failures = [];
    let succeeded = 0;
    setJobAction({ action, bulk: true, completed: 0, total: targets.length });
    for (const [index, job] of targets.entries()) {
      setJobAction({ id: job.id, action, bulk: true, completed: index, total: targets.length });
      try {
        const jobUrl = `/api/jobs/${encodeURIComponent(job.id)}`;
        await request(action === 'rerun' ? `${jobUrl}/rerun` : jobUrl, { method: action === 'rerun' ? 'POST' : 'DELETE' });
        if (action === 'delete') playback.removeJob(job.id);
        selectJobs([job.id], false);
        succeeded += 1;
      } catch (error) {
        failures.push({ id: job.id, title: job.playlistTitle || job.id, message: error.message });
      }
    }
    setBulkResult({ action, succeeded, total: targets.length, failures });
    setJobAction(null);
    setRevision((current) => current + 1);
  }

  async function submitJob(event) {
    event.preventDefault();
    setSubmitting(true);
    setMessage(null);
    try {
      const result = await submitJobUrl(url, { request, user, confirm, metadataOnly, downloadType });
      if (!result) return;
      const { job, created } = result;
      if (!created) {
        navigate(`/job/${encodeURIComponent(job.id)}`);
        return;
      }
      setUrl('');
      setMetadataOnly(false);
      setMessage({ type: 'success', text: `Job ${job.id} was added to the queue.` });
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    } finally {
      setSubmitting(false);
    }
  }

  const initiators = new Map([[user.id, user.name]]);
  for (const job of jobs || []) {
    const id = job.initiatedBy?.id || 'unknown';
    if (!initiators.has(id)) initiators.set(id, job.initiatedBy?.name || 'Unknown');
  }
  const userOptions = [...initiators].sort((left, right) => left[1].localeCompare(right[1]));
  const filteredJobs = (jobs || []).filter((job) => (
    userFilter === 'all' || (userFilter === 'mine'
      ? job.initiatedBy?.id === user.id || isContributor(user, job)
      : (job.initiatedBy?.id || 'unknown') === userFilter)
  ));
  const sortedJobs = sortJobs(filteredJobs, jobSort.key, jobSort.direction);
  const selectedJobs = sortedJobs.filter((job) => selectedJobIds.has(job.id));
  const counts = filteredJobs.reduce((result, job) => {
    result[job.status] = (result[job.status] || 0) + 1;
    return result;
  }, {});

  return (
    <AppShell>
      {dialog}
      {importing && <ImportMusic user={user} request={request} onClose={() => setImporting(false)} onImported={() => setRevision((current) => current + 1)} />}
      {addingJob && <JobPlaylistDialog job={addingJob} request={request} onClose={() => setAddingJob(null)} onAdded={(count, title) => {
        setAddingJob(null);
        setPlaylistMessage(count ? `Added ${count} ${count === 1 ? 'file' : 'files'} to "${title}".` : `All files are already in "${title}".`);
      }} />}
      <section className="page-heading">
        <div>
          <p className="eyebrow">Download queue</p>
          <h1>Music and video.</h1>
          <p>Your local media archive.</p>
        </div>
        <div className="jobs-heading-actions">
          <button className="secondary-button" type="button" onClick={() => setImporting(true)}><Upload size={17} />Import media</button>
          <div className="queue-summary" aria-label="Queue summary">
          <div><strong>{jobs ? filteredJobs.length : '-'}</strong><span>Total</span></div>
          <div><strong>{counts.running || 0}</strong><span>Active</span></div>
          <div><strong>{(counts.completed || 0) + (counts.partially_completed || 0)}</strong><span>Ready</span></div>
          </div>
        </div>
      </section>

      <section className="create-panel" aria-labelledby="create-heading">
        <div className="panel-index">01</div>
        <div className="create-copy">
          <h2 id="create-heading">Start a download</h2>
        </div>
        <form onSubmit={submitJob}>
          <div className="url-field">
            <Music2 size={19} />
            <input
              aria-label="YouTube URL"
              type="url"
              required
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder={downloadType === 'video' ? 'https://www.youtube.com/watch?v=...' : 'https://music.youtube.com/watch?v=...'}
            />
          </div>
          <button className="primary-button" disabled={submitting} type="submit">
            {submitting ? <RefreshCw className="spin" size={18} /> : <Plus size={18} />}
            {submitting ? 'Adding' : 'Add job'}
          </button>
          <div className="job-download-options">
            <label className="job-download-type">
              Format
              <select value={downloadType} disabled={submitting} onChange={(event) => setDownloadType(event.target.value)}>
                <option value="audio">Audio (MP3)</option>
                <option value="video">Video (MP4)</option>
              </select>
            </label>
            <label className="job-metadata-only">
              <input type="checkbox" checked={metadataOnly} disabled={submitting} onChange={(event) => setMetadataOnly(event.target.checked)} />
              Download metadata only
            </label>
          </div>
        </form>
        {message && <div className={`notice ${message.type}`} role="status">{message.text}</div>}
      </section>

      <BackupJobStatus />

      <section className="jobs-section">
        <div className="section-title">
          <div><span>03</span><h2>Recent jobs</h2>
            <button className="music-icon-button" type="button" title="Select jobs" aria-label="Select jobs" aria-pressed={selectingJobs}
              disabled={(!selectingJobs && !jobs?.length) || Boolean(jobAction)} onClick={() => { setSelectingJobs(!selectingJobs); setSelectedJobIds(new Set()); }}><ListChecks size={19} /></button>
          </div>
          <span className="refresh-note"><RefreshCw size={13} /> Refreshes every 5 seconds</span>
        </div>
        <div className="jobs-filters">
          <div className="job-filter-control">
          <label htmlFor="job-user-filter"><Users size={16} />Jobs</label>
          <select id="job-user-filter" value={userFilter} disabled={Boolean(jobAction)} onChange={(event) => { setUserFilter(event.target.value); setSelectedJobIds(new Set()); }}>
            <option value="mine">My jobs (owned and contributing)</option>
            <option value="all">All users</option>
            {userOptions.map(([id, name]) => <option key={id} value={id}>Initiated by {name}</option>)}
            {!['all', 'mine'].includes(userFilter) && !initiators.has(userFilter) && <option value={userFilter}>Selected user (no jobs)</option>}
          </select>
          </div>
          <div className="job-sort-controls">
            <label htmlFor="job-sort">Sort by</label>
            <select id="job-sort" value={jobSort.key} onChange={(event) => changeSort(event.target.value)}>
              {jobSortColumns.map(({ key, label }) => <option key={key} value={key}>{label}</option>)}
            </select>
            <button className="job-sort-direction" type="button" onClick={() => changeSort(jobSort.key)}
              aria-label={`Sort ${jobSort.direction === 'asc' ? 'descending' : 'ascending'}`}
              title={`${jobSort.direction === 'asc' ? 'Ascending' : 'Descending'}; switch to ${jobSort.direction === 'asc' ? 'descending' : 'ascending'}`}>
              {jobSort.direction === 'asc' ? <ArrowUp size={16} /> : <ArrowDown size={16} />}
            </button>
          </div>
        </div>
        {loadError && <div className="notice error"><CircleAlert size={16} />{loadError}</div>}
        {actionError && <div className="notice error" role="alert"><CircleAlert size={16} />{actionError}</div>}
        {playlistMessage && <div className="notice success" role="status"><Check size={16} />{playlistMessage}</div>}
        {bulkResult && <div className={`notice ${bulkResult.failures.length ? 'error' : 'success'} job-bulk-result`} role={bulkResult.failures.length ? 'alert' : 'status'}>
          <span>{bulkResult.succeeded} of {bulkResult.total} {bulkResult.total === 1 ? 'job' : 'jobs'} {bulkResult.action === 'delete' ? 'deleted' : 'submitted for rerun'}.</span>
          {bulkResult.failures.length > 0 && <ul>{bulkResult.failures.map((failure) => <li key={failure.id}><strong>{failure.title}:</strong> {failure.message}</li>)}</ul>}
        </div>}
        {selectingJobs && <div className="job-selection-toolbar">
          <label className="job-select-all"><input type="checkbox" aria-label="Select all matching jobs" disabled={!filteredJobs.length || Boolean(jobAction)}
            checked={filteredJobs.length > 0 && selectedJobs.length === filteredJobs.length}
            ref={(element) => { if (element) element.indeterminate = selectedJobs.length > 0 && selectedJobs.length < filteredJobs.length; }}
            onChange={(event) => selectJobs(filteredJobs.map((job) => job.id), event.target.checked)} />
            <span role="status">{selectedJobs.length} selected</span>
          </label>
          <button className="music-icon-button" type="button" aria-label="Rerun selected jobs"
            title={selectedJobs.length && !selectedJobs.every((job) => canRunJobAction(user, job, 'rerun')) ? 'All selected jobs must be idle, non-imported jobs you can rerun' : 'Rerun selected jobs'}
            disabled={Boolean(jobAction) || !selectedJobs.length || !selectedJobs.every((job) => canRunJobAction(user, job, 'rerun'))}
            onClick={() => runSelectedJobAction('rerun')}><RotateCcw size={18} /></button>
          <button className="music-icon-button job-bulk-delete" type="button" aria-label="Delete selected jobs"
            title={selectedJobs.length && !selectedJobs.every((job) => canRunJobAction(user, job, 'delete')) ? 'All selected jobs must be idle jobs you own or administer' : 'Delete selected jobs'}
            disabled={Boolean(jobAction) || !selectedJobs.length || !selectedJobs.every((job) => canRunJobAction(user, job, 'delete'))}
            onClick={() => runSelectedJobAction('delete')}><Trash2 size={18} /></button>
          <button className="music-icon-button" type="button" title="Clear job selection" aria-label="Clear job selection" disabled={!selectedJobs.length || Boolean(jobAction)}
            onClick={() => setSelectedJobIds(new Set())}><X size={18} /></button>
          {jobAction?.bulk && <span className="job-bulk-progress" role="status"><RefreshCw className="spin" size={15} />Processed {jobAction.completed} of {jobAction.total} jobs</span>}
        </div>}
        {jobs?.length === 0 && (
          <div className="empty-state"><Disc3 size={34} /><h3>No downloads yet</h3><p>Your first job will appear here.</p></div>
        )}
        {jobs?.length > 0 && filteredJobs.length === 0 && (
          <div className="empty-state"><Users size={34} /><h3>No matching jobs</h3></div>
        )}
        {filteredJobs.length > 0 && (
          <div className="table-wrap">
            <table className="jobs-table">
              <thead><tr>
                {selectingJobs && <th className="job-selection-cell" scope="col"><span className="sr-only">Select job</span></th>}
                {jobSortColumns.map(({ key, label }) => <th key={key} className={`job-column-${key}`} scope="col" aria-sort={jobSort.key === key ? (jobSort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}>
                  <button className="job-sort-button" type="button" onClick={() => changeSort(key)} title={`Sort by ${label}`}>
                    <span>{label}</span>{jobSort.key !== key ? <ArrowUpDown size={13} /> : jobSort.direction === 'asc' ? <ArrowUp size={13} /> : <ArrowDown size={13} />}
                  </button>
                </th>)}
                <th scope="col">Actions</th>
              </tr></thead>
              <tbody>{sortedJobs.map((job) => (
                <tr key={job.id} className={selectingJobs && selectedJobIds.has(job.id) ? 'job-selected' : undefined}>
                  {selectingJobs && <td className="job-selection-cell"><label className="job-select-row"><input type="checkbox" aria-label={`Select job ${job.playlistTitle || job.id}`}
                    checked={selectedJobIds.has(job.id)} disabled={Boolean(jobAction)} onChange={(event) => selectJobs([job.id], event.target.checked)} /></label></td>}
                  <td><a className="job-name" href={`/job/${job.id}`}><span>{job.isPlaylist ? <ListMusic size={18} /> : <Music2 size={18} />}</span><div><strong>{job.playlistTitle || 'Preparing playlist'}</strong><small>{job.id}</small></div></a></td>
                  <td className="job-column-format">{job.isPlaylist ? 'Playlist' : 'Track'}</td>
                  <td><StatusBadge status={job.status} /></td>
                  <td className="job-column-created">{formatDate(job.createdAt)}</td>
                  <td>{job.isPlaylist ? (job.playlistSongCount ?? '-') : 1}</td>
                  <td>{countDownloadedFiles(job.files)}</td>
                  <td><span className="job-initiator">{job.initiatedBy?.name || 'Unknown'}</span></td>
                  <td><div className="job-row-actions">
                    <a className="icon-link" href={`/job/${job.id}`} aria-label={`Open job ${job.id}`} title="Open job"><ExternalLink size={17} /></a>
                    {(job.initiatedBy?.id === user.id || isContributor(user, job)) && <button className="icon-link" type="button"
                      title="Add all files to playlist" aria-label={`Add all files from ${job.playlistTitle || job.id} to playlist`}
                      disabled={Boolean(jobAction) || !(job.files || []).some(isPlayableFile)}
                      onClick={() => { setPlaylistMessage(''); setAddingJob(job); }}><ListPlus size={17} /></button>}
                    {canModifyJob(user, job) && <>
                    {!job.source && <button className="icon-link" type="button" title="Rerun job" aria-label={`Rerun job ${job.id}`} disabled={Boolean(jobAction) || !canRunJobAction(user, job, 'rerun')} onClick={() => runJobAction(job, 'rerun')}>
                      {jobAction?.id === job.id && jobAction.action === 'rerun' ? <RefreshCw className="spin" size={17} /> : <RotateCcw size={17} />}
                    </button>}
                    {canManageJob(user, job) && <button className="icon-link row-delete" type="button" title="Delete job" aria-label={`Delete job ${job.id}`} disabled={Boolean(jobAction) || !canRunJobAction(user, job, 'delete')} onClick={() => runJobAction(job, 'delete')}>
                      {jobAction?.id === job.id && jobAction.action === 'delete' ? <RefreshCw className="spin" size={17} /> : <Trash2 size={17} />}
                    </button>}
                    </>}
                  </div></td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </section>
    </AppShell>
  );
}

function ContributorDialog({ job, onClose, onSaved }) {
  const dialogRef = useRef(null);
  const titleId = useId();
  const [users, setUsers] = useState(null);
  const [selected, setSelected] = useState((job.contributors || []).map((contributor) => contributor.id));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let active = true;
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    dialog.showModal();
    request(`/api/jobs/${encodeURIComponent(job.id)}/contributors/users`).then((result) => {
      if (!active) return;
      setUsers(result.users);
      setSelected((current) => current.filter((id) => result.users.some((candidate) => candidate.id === id)));
    }).catch((requestError) => { if (active) setError(requestError.message); });
    return () => {
      active = false;
      dialog.close();
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [job.id]);

  async function save(event) {
    event.preventDefault();
    if (saving || !users) return;
    setSaving(true);
    setError('');
    try {
      await request(`/api/jobs/${encodeURIComponent(job.id)}/contributors`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userIds: selected })
      });
      onSaved();
    } catch (requestError) {
      setError(requestError.message);
      setSaving(false);
    }
  }

  return <dialog ref={dialogRef} className="confirmation-dialog contributor-dialog" aria-labelledby={titleId}
    onCancel={(event) => { event.preventDefault(); if (!saving) onClose(); }}>
    <form onSubmit={save}>
      <h2 id={titleId}>Contributors</h2>
      {error && <div className="notice error" role="alert">{error}</div>}
      {!users && !error && <p role="status">Loading users...</p>}
      {users?.length === 0 && <p>No available users.</p>}
      {users && <fieldset className="contributor-options" disabled={saving}>
        <legend>Available users</legend>
        {users.map((candidate) => <label key={candidate.id}>
          <input type="checkbox" checked={selected.includes(candidate.id)} onChange={(event) => {
            setSelected((current) => event.target.checked ? [...current, candidate.id] : current.filter((id) => id !== candidate.id));
          }} />
          <span>{candidate.name}</span>
        </label>)}
      </fieldset>}
      <div className="dialog-actions">
        <button className="secondary-button" type="button" disabled={saving} onClick={onClose}>Cancel</button>
        <button className="primary-button" type="submit" disabled={saving || !users}>
          {saving ? <RefreshCw className="spin" size={17} /> : <Check size={17} />}{saving ? 'Saving' : 'Save contributors'}
        </button>
      </div>
    </form>
  </dialog>;
}

function JobPage({ id }) {
  const playback = usePlayback();
  const [editingMetadata, setEditingMetadata] = useState(null);
  const [replacingFile, setReplacingFile] = useState(null);
  const [sharingFile, setSharingFile] = useState(null);
  const { user } = useContext(AuthContext);
  const { confirm, dialog } = useConfirmation();
  const [fileRevision, setFileRevision] = useState(0);
  const transcriptionActive = useTranscriptionService(request, user.role !== 'shared');
  const loadJob = () => Promise.all([
    request(`/api/jobs/${id}`),
    request(`/api/jobs/${id}/files`).catch(() => null)
  ]);
  const { data, error } = usePolling(loadJob, POLL_INTERVAL, `${id}:${fileRevision}`);
  const [rerunning, setRerunning] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deletingFiles, setDeletingFiles] = useState({});
  const [editingContributors, setEditingContributors] = useState(false);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState('');
  const [savingTitle, setSavingTitle] = useState(false);
  const [savingPrivacy, setSavingPrivacy] = useState(false);
  const privacySavingRef = useRef(false);
  const [transcribingFile, setTranscribingFile] = useState(null);
  const [pendingTranscriptions, setPendingTranscriptions] = useState({});
  const [transcriptionNotice, setTranscriptionNotice] = useState('');
  const [actionError, setActionError] = useState('');
  const job = data?.[0];
  const files = data?.[1]?.files || [];
  const firstSong = files.find((file) => file.isPlayable);
  const isActive = job?.status === 'queued' || job?.status === 'running';
  const hasPendingTranscription = Object.values(job?.transcriptions || {}).some((transcription) => transcription.status === 'sent');
  const canModify = canModifyJob(user, job);
  const canManage = canManageJob(user, job);
  const transcriptionDisabled = !canModify || isActive || rerunning || deleting || editingContributors || savingTitle || savingPrivacy;
  const mutationDisabled = transcriptionDisabled || hasPendingTranscription || Object.keys(pendingTranscriptions).length > 0 || Object.keys(deletingFiles).length > 0 || transcribingFile !== null;

  async function savePrivacy(file = null) {
    if (!canChangePrivacy(user, job) || mutationDisabled || privacySavingRef.current || (file && getFilePrivacy(file, job).inherited)) return;
    privacySavingRef.current = true;
    setSavingPrivacy(true);
    setActionError('');
    const isPrivate = file ? getFilePrivacy(file, job).private : Boolean(job.private);
    try {
      await request(`/api/jobs/${encodeURIComponent(id)}${file ? `/files/${encodeURIComponent(file.name)}` : ''}/privacy`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ private: !isPrivate })
      });
      setSharingFile(null);
      setFileRevision((revision) => revision + 1);
    } catch (requestError) {
      setActionError(`Unable to save privacy: ${requestError.message}`);
    } finally {
      privacySavingRef.current = false;
      setSavingPrivacy(false);
    }
  }

  async function saveTitle(event) {
    event.preventDefault();
    if (!canManage || mutationDisabled || !titleDraft.trim()) return;
    setSavingTitle(true);
    setActionError('');
    try {
      await request(`/api/jobs/${encodeURIComponent(id)}/title`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playlistTitle: titleDraft })
      });
      setEditingTitle(false);
      setFileRevision((revision) => revision + 1);
    } catch (requestError) {
      setActionError(requestError.message);
    } finally { setSavingTitle(false); }
  }

  function songMutationDisabled(name) {
    return transcriptionDisabled || Boolean(deletingFiles[name]) || Boolean(pendingTranscriptions[name]) || job?.transcriptions?.[name]?.status === 'sent';
  }

  async function transcribe(file, options) {
    const locking = typeof options.transcriptionLocked === 'boolean';
    if (songMutationDisabled(file.name) || (!locking && (!transcriptionActive || (file.transcriptionLocked && options.NoVocalsOnly !== true)))) return;
    setPendingTranscriptions((current) => ({
      ...current, [file.name]: { status: locking ? 'locking' : 'sent', requestedAt: new Date().toISOString(),
        options: { NoVocalsOnly: options.NoVocalsOnly === true } }
    }));
    setTranscribingFile(null);
    setTranscriptionNotice('');
    setActionError('');
    try {
      await request(`/api/jobs/${encodeURIComponent(id)}/files/${encodeURIComponent(file.name)}/${locking ? 'metadata' : 'transcribe'}`, {
        method: locking ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(options)
      });
      setTranscriptionNotice(`${options.NoVocalsOnly ? 'No-vocals version created' : `Transcription ${locking ? (options.transcriptionLocked ? 'locked' : 'unlocked') : 'complete'}`}: ${file.name}`);
    } catch (requestError) {
      setActionError(`Transcription request for ${file.name}: ${requestError.message}`);
    } finally {
      setPendingTranscriptions((current) => {
        const remaining = { ...current };
        delete remaining[file.name];
        return remaining;
      });
      setFileRevision((revision) => revision + 1);
    }
  }

  async function rerun() {
    if (mutationDisabled) return;
    if (!await confirm({ title: 'Rerun job?', message: `Rerun ${job.playlistTitle || job.id}? Keep existing songs and download missing ones?`, action: 'rerun' })) return;
    setRerunning(true);
    setActionError('');
    try {
      await request(`/api/jobs/${id}/rerun`, { method: 'POST' });
      setFileRevision((revision) => revision + 1);
      setRerunning(false);
    } catch (requestError) {
      setActionError(requestError.message);
      setRerunning(false);
    }
  }

  async function remove() {
    if (!canManage || mutationDisabled) return;
    if (!await confirm({ title: 'Delete job?', message: 'Delete this job and all of its downloaded files?', action: 'delete' })) {
      return;
    }

    setDeleting(true);
    setActionError('');
    try {
      await request(`/api/jobs/${id}`, { method: 'DELETE' });
      playback.removeJob(id);
      navigate('/job');
    } catch (requestError) {
      setActionError(requestError.message);
      setDeleting(false);
    }
  }

  async function removeFile(file) {
    if (songMutationDisabled(file.name)) return;
    if (!await confirm({ title: 'Delete song?', message: `Delete ${file.name} from this job?`, action: 'delete', label: 'Delete song' })) return;
    setDeletingFiles((current) => ({ ...current, [file.name]: true }));
    setActionError('');
    try {
      await request(`/api/jobs/${encodeURIComponent(id)}/files/${encodeURIComponent(file.name)}`, { method: 'DELETE' });
      playback.removeSong(id, file.name);
      setFileRevision((revision) => revision + 1);
    } catch (requestError) {
      setActionError(requestError.message);
    } finally {
      setDeletingFiles((current) => {
        const remaining = { ...current };
        delete remaining[file.name];
        return remaining;
      });
    }
  }

  return (
    <AppShell>
      {dialog}
      <a className="back-link" href="/job"><ArrowLeft size={17} /> Back to jobs</a>
      {transcribingFile && <TranscriptionDialog file={transcribingFile} serviceActive={transcriptionActive} onClose={() => setTranscribingFile(null)} onSubmit={transcribe} />}
      {sharingFile && <ShareMediaDialog file={{ ...sharingFile, private: getFilePrivacy(sharingFile, job).private }} jobId={id} request={request} onClose={() => setSharingFile(null)} />}
      {editingMetadata && <MetadataDialog file={editingMetadata} jobId={id} request={request} onClose={() => setEditingMetadata(null)} onSaved={(result) => {
        playback.updateMetadata(id, editingMetadata.name, result);
        setFileRevision((revision) => revision + 1);
      }} />}
      {replacingFile && <ReplaceFileDialog file={replacingFile} jobId={id} request={request} onClose={() => setReplacingFile(null)} onSaved={(result) => {
        playback.replaceFile(id, replacingFile.name, result);
        setFileRevision((revision) => revision + 1);
      }} />}
      {editingContributors && <ContributorDialog job={job} onClose={() => setEditingContributors(false)} onSaved={() => {
        setEditingContributors(false);
        setFileRevision((revision) => revision + 1);
      }} />}
      {error && <div className="notice error page-notice"><CircleAlert size={16} />{error}</div>}
      {!job && !error && <div className="loading"><RefreshCw className="spin" /> Loading job</div>}
      {job && <>
        <section className="detail-heading">
          <div>
            <p className="eyebrow">{job.source ? 'Music import' : job.isPlaylist ? 'Playlist download' : 'Track download'}</p>
            <h1>{job.playlistTitle || 'Preparing playlist'}</h1>
            <div className="detail-meta"><StatusBadge status={job.status} /><span>Created {formatDate(job.createdAt)}</span>{job.private && <span><Lock size={14} /> Private — owner only</span>}</div>
          </div>
          <div className="detail-actions">
            <div className="record-art"><Disc3 size={70} strokeWidth={1.2} /></div>
            {canModify && <>
            {!job.source && <button className="primary-button job-action-button" disabled={mutationDisabled} onClick={rerun} type="button">
              {rerunning ? <RefreshCw className="spin" size={17} /> : <RotateCcw size={17} />}
              {rerunning ? 'Starting' : 'Rerun job'}
            </button>}
            {canManage && <button className="danger-button job-action-button" disabled={mutationDisabled} onClick={remove} type="button">
              {deleting ? <RefreshCw className="spin" size={17} /> : <Trash2 size={17} />}
              {deleting ? 'Deleting' : 'Delete job'}
            </button>}
            </>}
          </div>
        </section>
        {actionError && <div className="notice error page-notice" role="alert"><CircleAlert size={16} />{actionError}</div>}
        {transcriptionNotice && <div className="notice success page-notice" role="status"><Check size={16} />{transcriptionNotice}</div>}
        <div className="detail-grid">
          <section className="info-panel">
            <div className="section-title"><div><span>01</span><h2>Job details</h2></div></div>
            <dl>
              <dt>{job.source ? 'Source' : 'Source URL'}</dt><dd>{job.source ? (job.source === 'itunes' ? 'iTunes library' : 'Uploaded files') : <a href={job.url} target="_blank" rel="noreferrer">{job.url}<ExternalLink size={14} /></a>}</dd>
              <dt>Job ID</dt><dd><code>{job.id}</code></dd>
              <dt>Initiated by</dt><dd>{job.initiatedBy?.name || 'Unknown'}</dd>
              <dt>Privacy</dt><dd className="playlist-title-value">
                <span>{job.private ? 'Private — only the owner can access this job and its files' : 'Not private'}</span>
                {canChangePrivacy(user, job) && <button className="secondary-button compact-button" type="button"
                  title={job.private ? 'Make job public' : 'Make job private'} aria-label={job.private ? 'Make job public' : 'Make job private'}
                  aria-pressed={Boolean(job.private)} disabled={mutationDisabled} onClick={() => savePrivacy()}>
                  {savingPrivacy ? <RefreshCw className="spin" size={16} /> : job.private ? <LockOpen size={16} /> : <Lock size={16} />}
                  {savingPrivacy ? 'Saving privacy...' : job.private ? 'Make public' : 'Make private'}
                </button>}
              </dd>
              <dt>Contributors</dt><dd className="job-contributors">
                <span>{job.contributors?.map((contributor) => contributor.name).join(', ') || 'None'}</span>
                {canManage && <button className="icon-link" type="button" title="Manage contributors" aria-label="Manage contributors" disabled={mutationDisabled} onClick={() => setEditingContributors(true)}><Users size={17} /></button>}
              </dd>
              <dt>Downloaded files</dt><dd>{data?.[1] ? countDownloadedFiles(files) : 'Not available'}</dd>
              {job.isPlaylist && <><dt>Playlist songs</dt><dd>{job.playlistSongCount ?? 'Not available'}</dd></>}
              <dt>Playlist Title</dt><dd>
                {editingTitle ? <form className="playlist-title-editor" onSubmit={saveTitle}>
                  <input aria-label="Playlist Title" autoFocus required maxLength={200} value={titleDraft} disabled={mutationDisabled} onChange={(event) => setTitleDraft(event.target.value)} />
                  <button className="music-icon-button" type="submit" title="Save playlist title" aria-label="Save playlist title" disabled={mutationDisabled || !titleDraft.trim()}>{savingTitle ? <RefreshCw className="spin" size={17} /> : <Check size={17} />}</button>
                  <button className="music-icon-button" type="button" title="Cancel title edit" aria-label="Cancel title edit" disabled={savingTitle} onClick={() => setEditingTitle(false)}><X size={17} /></button>
                </form> : <div className="playlist-title-value"><span>{job.playlistTitle || 'Pending'}</span>
                  {canManage && <button className="music-icon-button" type="button" title="Edit playlist title" aria-label="Edit playlist title" disabled={mutationDisabled} onClick={() => { setTitleDraft(job.playlistTitle || ''); setEditingTitle(true); }}><Pencil size={16} /></button>}
                </div>}
              </dd>
              <dt>Last updated</dt><dd>{formatDate(job.updatedAt)}</dd>
              {!job.source && <><dt>Command</dt><dd><code className="command-code">{job.command || 'Pending'}</code></dd></>}
            </dl>
            {job.warning && <div className="notice warning"><CircleAlert size={16} />{job.warning}</div>}
            {job.error && <div className="notice error"><CircleAlert size={16} />{job.error}</div>}
          </section>
          <section className="output-panel">
            <div className="section-title"><div><span>02</span><h2>Process output</h2></div></div>
            <pre>{job.output || (isActive ? 'Waiting for process output...' : 'No process output was captured.')}</pre>
          </section>
          <section className="files-panel">
            <div className="section-title">
              <div><span>03</span><h2>Files</h2>
                {firstSong && <a className="icon-link files-play" href={`/job/${encodeURIComponent(id)}/player?${new URLSearchParams({ song: firstSong.name, play: '1' })}`} aria-label="Play all songs" title="Play all songs"><Play size={17} /></a>}
              </div>
              <div className="files-actions">
                <strong>{files.length}</strong>
                {files.length > 0 && <a className="download-all" href={`/api/jobs/${id}/download-all`}><ArrowDownToLine size={16} />Download all</a>}
              </div>
            </div>
            {files.length === 0 ? <div className="empty-files"><FileAudio size={29} /><p>No downloadable files yet.</p></div> : (
              <ul className="file-list">{files.map((file) => {
                const privacy = getFilePrivacy(file, job);
                const privacyLabel = privacy.inherited ? 'Inherited privacy' : privacy.private ? 'Make file public' : 'Make file private';
                return (
                <li key={file.name}>
                  {file.isPlayable ? <a className="song-file-link" href={`/job/${encodeURIComponent(id)}/player?${new URLSearchParams({ song: file.name, play: '1' })}`} aria-label={`Play ${file.name}`} title="Play media">
                    <span className="file-icon">{file.mediaType === 'video' ? <Play size={19} /> : <FileAudio size={19} />}</span>
                    <span className="file-song-info"><strong>{file.title || file.name}</strong>
                      {(file.artist || file.album) && <span className="file-song-credit">{[file.artist, file.album].filter(Boolean).join(' / ')}</span>}
                      <small>{file.title ? `${file.name} / ` : ''}{formatBytes(file.sizeBytes)}</small>
                      {privacy.private && <small><Lock size={12} /> {privacy.inherited ? 'Inherited privacy — owner only' : 'Private file — owner only'}</small>}
                      <TranscriptionStatus transcription={pendingTranscriptions[file.name] || job.transcriptions?.[file.name]} />
                    </span>
                  </a> : <>
                    <span className="file-icon"><FileAudio size={19} /></span>
                    <div><strong>{file.name}</strong><small>{formatBytes(file.sizeBytes)}</small>{privacy.private && <small>{privacy.inherited ? 'Inherited privacy — owner only' : 'Private file — owner only'}</small>}</div>
                  </>}
                  <ListSongRating file={file} jobId={id} request={request} canModify={canModify}
                    disabled={songMutationDisabled(file.name) || editingMetadata?.name === file.name} onError={setActionError}
                    onSaved={(result) => {
                      playback.updateMetadata(id, file.name, result);
                      setFileRevision((revision) => revision + 1);
                    }} />
                  <SongActions name={file.name} className="file-row-actions">
                    {canChangePrivacy(user, job) && <button className="icon-link" type="button"
                      title={privacy.inherited ? 'Private via source; change the source job or original file privacy first' : privacyLabel} data-action-label={privacyLabel}
                      aria-label={`${privacyLabel}: ${file.name}`} aria-pressed={privacy.private}
                      disabled={mutationDisabled || privacy.inherited} onClick={() => savePrivacy(file)}>
                      {savingPrivacy ? <RefreshCw className="spin" size={18} /> : privacy.private ? <Lock size={18} /> : <LockOpen size={18} />}
                    </button>}
                    {canModify && file.isSong && <button className="icon-link" type="button" title={privacy.private ? 'Private files cannot be shared' : 'Share Media'} data-action-label="Share Media" aria-label={`Share Media ${file.name}`} aria-haspopup="dialog" disabled={songMutationDisabled(file.name) || privacy.private} onClick={() => setSharingFile(file)}><Share2 size={18} /></button>}
                    {canModify && file.isSong && <button className="icon-link" type="button" title="Edit song metadata" aria-label={`Edit metadata ${file.name}`} disabled={songMutationDisabled(file.name)} onClick={() => setEditingMetadata(file)}><Pencil size={18} /></button>}
                    {canModify && file.isSong && <button className="icon-link" type="button" title="Replace File" aria-label={`Replace File ${file.name}`} disabled={songMutationDisabled(file.name)} onClick={() => setReplacingFile(file)}><Upload size={18} /></button>}
                    {file.isSong && !file.name.toLowerCase().startsWith('[novocals]/') && <button className="icon-link song-transcribe" type="button" data-action-label="Transcribe song" title={transcriptionActive ? 'Transcribe song' : transcriptionInactiveMessage} aria-label={`Transcribe ${file.name}`} disabled={songMutationDisabled(file.name) || !transcriptionActive} onClick={() => { setTranscriptionNotice(''); setTranscribingFile(file); }}><Mic size={18} /></button>}
                    <a href={file.downloadUrl} aria-label={`Download ${file.name}`} title="Download song"><ArrowDownToLine size={18} /></a>
                    {canModify && <button className="icon-link" type="button" title="Delete song" aria-label={`Delete song ${file.name}`} disabled={songMutationDisabled(file.name)} onClick={() => removeFile(file)}>
                      {deletingFiles[file.name] ? <RefreshCw className="spin" size={18} /> : <Trash2 size={18} />}
                    </button>}
                  </SongActions>
                </li>
              ); })}</ul>
            )}
          </section>
        </div>
      </>}
    </AppShell>
  );
}

function Metric({ icon, label, value, detail, percent }) {
  return <article className="metric">
    <div className="metric-top"><span>{icon}</span><small>{label}</small></div>
    <strong>{value}</strong>
    {detail && <p>{detail}</p>}
    {Number.isFinite(percent) && <div className="meter"><span style={{ width: `${Math.min(100, percent)}%` }} /></div>}
  </article>;
}

function HealthPage() {
  const { user } = useContext(AuthContext);
  return user.role === 'shared' ? <MusicHomePage /> : <HealthMetrics />;
}

function HealthMetrics() {
  const { data: health, error } = usePolling(loadHealth, 3000);
  const memoryPercent = health ? health.memory.usedBytes / health.memory.totalBytes * 100 : 0;
  const diskUsed = health ? health.storage.totalBytes - health.storage.freeBytes : 0;
  const diskPercent = health ? diskUsed / health.storage.totalBytes * 100 : 0;

  return <AppShell section="health">
    <section className="page-heading health-heading">
      <div><p className="eyebrow">System monitor</p><h1>Runtime health.</h1><p>Live resource use from the host running your downloads.</p></div>
      {health && <div className="updated"><span /> Updated {new Date(health.timestamp).toLocaleTimeString()}</div>}
    </section>
    {error && <div className="notice error page-notice"><CircleAlert size={16} />{error}</div>}
    {!health && !error && <div className="loading"><RefreshCw className="spin" /> Reading system metrics</div>}
    {health && <>
      <section className="metrics-grid">
        <Metric icon={<Activity />} label="CPU usage" value={`${health.cpu.usagePercent.toFixed(1)}%`} detail="Current processor load" percent={health.cpu.usagePercent} />
        <Metric icon={<MemoryStick />} label="Memory" value={formatBytes(health.memory.usedBytes)} detail={`${formatBytes(health.memory.totalBytes)} total`} percent={memoryPercent} />
        <Metric icon={<HardDrive />} label="Storage free" value={formatBytes(health.storage.freeBytes)} detail={`${formatBytes(health.storage.totalBytes)} total`} percent={diskPercent} />
        <Metric icon={<Network />} label="Network in" value={`${formatBytes(health.network.rxSec)}/s`} detail={`${formatBytes(health.network.rxBytes)} received`} />
        <Metric icon={<Network />} label="Network out" value={`${formatBytes(health.network.txSec)}/s`} detail={`${formatBytes(health.network.txBytes)} sent`} />
        <Metric icon={<Mic />} label="Transcription service" value={health.transcription?.status === 'active' ? <span className="transcription-active">Active</span> : <span className="transcription-inactive">Inactive</span>} detail={health.transcription?.status === 'active' ? null : health.transcription?.message || 'Status unavailable'} />
        <Metric icon={<FileAudio />} label="Total media files"
          value={Number.isInteger(health.media?.totalFiles) ? health.media.totalFiles.toLocaleString() : '-'}
          detail={<>Songs and videos across all users<br />
            {health.media?.scannedAt ? <>Last scanned: <time dateTime={health.media.scannedAt}>{new Date(health.media.scannedAt).toLocaleString()}</time></> : 'No completed scan'}
            <br />{health.media?.scanning ? 'Scanning...' : health.media?.error || 'Daily scan'}
          </>} />
      </section>
    </>}
  </AppShell>;
}

function LoginPage({ onLogin, appLogin = false }) {
  const [name, setName] = useState('');
  const [registrationAccount, setRegistrationAccount] = useState({ role: 'user', organizerId: null });
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState(null);
  const [redirectUrl, setRedirectUrl] = useState('');
  const [appAuthorization] = useState(() => {
    if (!appLogin) return null;
    const params = new URLSearchParams(window.location.search);
    return {
      client: 'browser-app',
      redirectUri: params.get('redirect_uri'),
      state: params.get('state'),
      codeChallenge: params.get('code_challenge'),
      codeChallengeMethod: params.get('code_challenge_method')
    };
  });

  useEffect(() => {
    if (appLogin) {
      document.title = 'Sign in to Android app - ssMusic Player';
      window.history.replaceState(null, '', '/app-login');
    }
  }, [appLogin]);

  async function login() {
    setBusy('login');
    setMessage(null);
    try {
      const ceremony = await request('/api/auth/login/options', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(appAuthorization || {})
      });
      const response = await startAuthentication({ optionsJSON: ceremony.options });
      const result = await request('/api/auth/login/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: ceremony.requestId, response })
      });
      if (appLogin) {
        setRedirectUrl(result.redirectUrl);
        window.location.assign(result.redirectUrl);
      } else onLogin(result.user);
    } catch (error) {
      setMessage({ type: error.code === 'ACCESS_PENDING' ? 'warning' : 'error', text: error.message });
    } finally {
      setBusy('');
    }
  }

  async function register(event) {
    event.preventDefault();
    if (busy || (registrationAccount.role === 'shared' && !registrationAccount.organizerId)) return;
    setBusy('register');
    setMessage(null);
    try {
      const ceremony = await request('/api/auth/register/options', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, ...registrationAccount })
      });
      const response = await startRegistration({ optionsJSON: ceremony.options });
      const result = await request('/api/auth/register/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: ceremony.requestId, response })
      });
      if (result.user.status === 'approved') {
        onLogin(result.user);
      } else {
        setName('');
        setRegistrationAccount({ role: 'user', organizerId: null });
        setMessage({ type: 'warning', text: 'Passkey registered. An administrator must approve your access before you can log in.' });
      }
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    } finally {
      setBusy('');
    }
  }

  return <main className="auth-page">
    <section className="auth-intro">
      <img className="auth-mark" src={appIcon} alt="ssMusic Player" width="58" height="58" />
      <p className="eyebrow">Private music workspace</p>
      <h1>{appLogin ? 'ssMusic Player' : 'Open your archive.'}</h1>
      <p>{appLogin ? 'Authorize the Android app to access your account.' : 'Your passkey stays with your password manager or device. The server stores only the public credential needed to recognize you.'}</p>
    </section>
    <section className="auth-panel" aria-labelledby="access-heading">
      <div className="auth-panel-heading"><Fingerprint size={27} /><div><p>Secure access</p><h2 id="access-heading">{appLogin ? 'Sign in to Android app' : 'Use a passkey'}</h2></div></div>
      {redirectUrl ? <a className="primary-button auth-login" href={redirectUrl}><ExternalLink size={18} />Return to app</a> : <button className="primary-button auth-login" disabled={Boolean(busy)} onClick={login} type="button">
        {busy === 'login' ? <RefreshCw className="spin" size={18} /> : <Fingerprint size={18} />}
        {appLogin ? 'Authorize with Passkey' : 'Login with Passkey'}
      </button>}
      {appLogin ? <a className="secondary-button" href="/">Cancel</a> : <><div className="auth-divider"><span>or register</span></div>
      <form onSubmit={register}>
        <label htmlFor="registration-name">Display name</label>
        <input id="registration-name" minLength="2" maxLength="64" required value={name} disabled={Boolean(busy)} onChange={(event) => setName(event.target.value)} placeholder="Your name" />
        <SharedRegistrationFields account={registrationAccount} onChange={setRegistrationAccount} request={request} disabled={Boolean(busy)} />
        <button className="secondary-button" disabled={Boolean(busy) || (registrationAccount.role === 'shared' && !registrationAccount.organizerId)} type="submit">
          {busy === 'register' ? <RefreshCw className="spin" size={18} /> : <ShieldCheck size={18} />}
          Register with Passkey
        </button>
      </form></>}
      {message && <div className={`notice ${message.type}`} role="status">{message.text}</div>}
    </section>
  </main>;
}

function PatDialog({ pat, onClose }) {
  const dialogRef = useRef(null);
  const tokenRef = useRef(null);
  const titleId = useId();
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  async function copyToken() {
    try {
      await navigator.clipboard.writeText(pat.token);
      setCopied(true);
      setError('');
    } catch {
      tokenRef.current.focus();
      tokenRef.current.select();
      setError('Clipboard unavailable. Copy the selected PAT manually.');
    }
  }

  return <dialog ref={dialogRef} className="confirmation-dialog pat-dialog" aria-labelledby={titleId}
    onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <h2 id={titleId}>Private Access Token created</h2>
    <p className="pat-name">{pat.name}</p>
    <p>This secret is shown only once. Store it securely before closing.</p>
    <label className="sr-only" htmlFor={`${titleId}-token`}>Private Access Token</label>
    <textarea ref={tokenRef} id={`${titleId}-token`} readOnly value={pat.token} spellCheck={false} />
    {error && <p role="alert">{error}</p>}
    <div className="dialog-actions">
      <button type="button" className="secondary-button" onClick={copyToken}><Copy size={17} />{copied ? 'Copied' : 'Copy PAT'}</button>
      <button type="button" className="primary-button" onClick={onClose}><Check size={17} />Done</button>
    </div>
    <span className="sr-only" role="status">{copied ? 'PAT copied to clipboard' : ''}</span>
  </dialog>;
}

function UserSettingsPage({ userId }) {
  const { user: currentUser, setUser } = useContext(AuthContext);
  const [settingsTab, setSettingsTab] = useState('account');
  const [details, setDetails] = useState(null);
  const [tokens, setTokens] = useState(null);
  const [passkeys, setPasskeys] = useState([]);
  const [libraryUsers, setLibraryUsers] = useState([]);
  const [organizerUsers, setOrganizerUsers] = useState([]);
  const [sharedUserIds, setSharedUserIds] = useState([]);
  const [accessSaved, setAccessSaved] = useState(false);
  const [name, setName] = useState('');
  const [secret, setSecret] = useState(null);
  const [passkeyMessage, setPasskeyMessage] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const { confirm, dialog } = useConfirmation();
  const endpoint = userId ? `/api/admin/users/${encodeURIComponent(userId)}` : '/api/auth/pats';

  async function load() {
    try {
      const [result, passkeyResult, accounts] = await Promise.all([
        request(endpoint), userId ? null : request('/api/auth/passkeys'), userId ? request('/api/admin/users') : null
      ]);
      if (passkeyResult) updatePasskeys(passkeyResult);
      else setDetails(result.user || currentUser);
      if (accounts) {
        const available = accounts.users.filter((account) => account.id !== userId && account.status === 'approved' && account.role !== 'shared');
        setOrganizerUsers(available);
        setLibraryUsers(result.libraries || available);
        setSharedUserIds(result.user.sharedUserIds || []);
      }
      setTokens(result.tokens);
      setError('');
    } catch (loadError) {
      setError(loadError.message);
    }
  }

  useEffect(() => { load(); }, [endpoint]);

  async function saveAccess(changes) {
    if (busy) return;
    setBusy('access');
    setError('');
    setAccessSaved(false);
    try {
      const result = await request(endpoint, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(changes) });
      setDetails(result.user);
      setSharedUserIds(result.user.sharedUserIds || []);
      if (result.libraries) setLibraryUsers(result.libraries);
      setAccessSaved(true);
    } catch (saveError) { setError(saveError.message); }
    finally { setBusy(''); }
  }

  function updatePasskeys(result) {
    setDetails(result.user);
    setPasskeys(result.passkeys);
    setUser((current) => current?.id === result.user.id ? result.user : current);
  }

  async function addPasskey() {
    if (busy) return;
    setBusy('passkey');
    setPasskeyMessage(null);
    try {
      const ceremony = await request('/api/auth/passkeys/options', { method: 'POST' });
      const response = await startRegistration({ optionsJSON: ceremony.options });
      const result = await request('/api/auth/passkeys/verify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: ceremony.requestId, response })
      });
      updatePasskeys(result);
      setPasskeyMessage({ type: 'success', text: 'Passkey added.' });
    } catch (addError) {
      const canceled = addError.name === 'NotAllowedError' || addError.cause?.name === 'NotAllowedError';
      setPasskeyMessage({ type: 'error', text: canceled ? 'Passkey setup was canceled or timed out.' : addError.message });
    } finally {
      setBusy('');
    }
  }

  async function removePasskey(passkey) {
    if (busy || !await confirm({
      title: 'Delete passkey?',
      message: `Delete passkey "${passkey.id.slice(0, 12)}"? It will no longer sign in to this account. Existing sessions will remain signed in.`,
      action: 'delete', label: 'Delete passkey'
    })) return;
    setBusy(`passkey-delete:${passkey.id}`);
    setPasskeyMessage(null);
    try {
      const result = await request(`/api/auth/passkeys/${encodeURIComponent(passkey.id)}`, { method: 'DELETE' });
      updatePasskeys(result);
      setPasskeyMessage({ type: 'success', text: 'Passkey deleted.' });
    } catch (deleteError) {
      setPasskeyMessage({ type: 'error', text: deleteError.message });
      if ([404, 409].includes(deleteError.status)) {
        await request('/api/auth/passkeys').then(updatePasskeys).catch(() => {});
      }
    } finally {
      setBusy('');
    }
  }

  async function generate(event) {
    event.preventDefault();
    setBusy('generate');
    setError('');
    try {
      const pat = await request('/api/auth/pats', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name })
      });
      setSecret(pat);
      setTokens((previous) => [{ id: pat.id, name: pat.name, createdAt: pat.createdAt }, ...previous]);
      setName('');
    } catch (generateError) {
      setError(generateError.message);
    } finally {
      setBusy('');
    }
  }

  async function remove(pat) {
    if (!await confirm({ title: 'Delete Private Access Token?', message: `Delete "${pat.name}"? Requests using this PAT will no longer be authenticated.`, action: 'delete', label: 'Delete PAT' })) return;
    setBusy(pat.id);
    setError('');
    try {
      const deleteEndpoint = userId ? `${endpoint}/pats/${pat.id}` : `${endpoint}/${pat.id}`;
      await request(deleteEndpoint, { method: 'DELETE' });
      setTokens((previous) => previous.filter((token) => token.id !== pat.id));
    } catch (deleteError) {
      setError(deleteError.message);
    } finally {
      setBusy('');
    }
  }

  return <AppShell section={userId ? 'admin' : 'settings'}>
    {userId && <a className="settings-back" href="/admin"><ArrowLeft size={16} />All users</a>}
    <section className="page-heading settings-heading"><div><p className="eyebrow">Account</p><h1>{userId ? 'User details' : 'User settings'}</h1></div></section>
    {!userId && <SettingsTabs value={settingsTab} onChange={setSettingsTab} disabled={Boolean(busy)} />}
    {!userId && settingsTab === 'links' && <div role="tabpanel" id="settings-panel-links" aria-labelledby="settings-tab-links">
      <LinkedUsers request={request} confirm={confirm} />
    </div>}
    {!userId && settingsTab === 'shared' && <div role="tabpanel" id="settings-panel-shared" aria-labelledby="settings-tab-shared">
      <OrganizedSharedUsers request={request} confirm={confirm} />
    </div>}
    {error && <div className="notice error" role="alert">{error}<button type="button" className="secondary-button compact-button" onClick={load} disabled={Boolean(busy)}><RefreshCw size={16} />Retry</button></div>}
    {!details && !error && <p role="status">Loading account...</p>}
    {details && (userId || settingsTab === 'account') && <div role={userId ? undefined : 'tabpanel'} id={userId ? undefined : 'settings-panel-account'} aria-labelledby={userId ? undefined : 'settings-tab-account'}>
      <section className="settings-profile" aria-label="User details">
        <UserIdentity user={details} />
        <dl><div><dt>Role</dt><dd>{details.role}</dd></div><div><dt>Joined</dt><dd>{formatDate(details.createdAt)}</dd></div><div><dt>User ID</dt><dd>{details.id}</dd></div></dl>
        <UsernameForm user={details} request={request} endpoint={userId ? endpoint : '/api/auth/me'} disabled={Boolean(busy)} onSaved={(updated) => {
          setDetails(updated);
          if (updated.id === currentUser.id) setUser(updated);
        }} />
        {userId && <label className="role-control"><span>Role</span><select aria-label="User role" value={details.role} disabled={Boolean(busy) || userId === currentUser.id}
          onChange={(event) => saveAccess({ role: event.target.value })}><option value="user">User</option><option value="admin">Admin</option><option value="shared">Shared</option></select></label>}
        {userId && <OrganizerControl user={details} users={organizerUsers} disabled={Boolean(busy)} confirm={confirm}
          onChange={(organizerId) => saveAccess({ organizerId })} />}
      </section>
      {accessSaved && <p className="notice success" role="status">Access saved.</p>}
      {userId && details.role === 'shared' && <SharedLibraryAccess users={libraryUsers} selectedIds={sharedUserIds}
        onChange={(ids) => { setSharedUserIds(ids); setAccessSaved(false); }} onSave={() => saveAccess({ sharedUserIds })} saving={Boolean(busy)} />}
      {!userId && <section className="passkey-section" aria-labelledby="passkey-heading" aria-busy={busy === 'passkey' || busy.startsWith('passkey-delete:')}>
        <div className="section-title"><div><Fingerprint size={19} /><h2 id="passkey-heading">Passkeys</h2></div>
          <button className="secondary-button" type="button" onClick={addPasskey} disabled={Boolean(busy)}>
            {busy === 'passkey' ? <RefreshCw size={17} className="spin" /> : <Plus size={17} />}
            {busy === 'passkey' ? 'Adding passkey...' : 'Add passkey'}
          </button>
        </div>
        {passkeyMessage && <div className={`notice ${passkeyMessage.type}`} role={passkeyMessage.type === 'error' ? 'alert' : 'status'}>{passkeyMessage.text}</div>}
        <ul className="pat-list passkey-list" aria-label="Registered passkeys">
          {passkeys.map((passkey) => <li key={passkey.id}><Fingerprint size={18} /><div>
            <strong>Passkey {passkey.id.slice(0, 12)}</strong>
            <code title="Credential ID">{passkey.id}</code>
            <small>{passkey.transports.length ? passkey.transports.join(', ') : 'Transport not reported'}</small>
            <small>Created: {passkey.createdAt ? <time dateTime={passkey.createdAt}>{new Date(passkey.createdAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</time> : 'Unknown'}</small>
            <small>Last used: {passkey.lastUsedAt ? <time dateTime={passkey.lastUsedAt}>{new Date(passkey.lastUsedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</time> : passkey.createdAt ? 'Never' : 'Unknown'}</small>
            {passkeys.length === 1 && <small>Last passkey</small>}
          </div>
            <button className="danger-button pat-delete" type="button"
              title={passkeys.length <= 1 ? 'At least one passkey is required' : `Delete passkey ${passkey.id.slice(0, 12)}`}
              aria-label={`Delete passkey ${passkey.id.slice(0, 12)}`} disabled={Boolean(busy) || passkeys.length <= 1}
              onClick={() => removePasskey(passkey)}>
              {busy === `passkey-delete:${passkey.id}` ? <RefreshCw size={17} className="spin" /> : <Trash2 size={17} />}
            </button>
          </li>)}
        </ul>
      </section>}
      {!userId && <section className="theme-section" aria-labelledby="appearance-heading">
        <div className="section-title"><div><Palette size={19} /><h2 id="appearance-heading">Appearance</h2></div></div>
        <ThemeChoices />
      </section>}
      <section className="pat-section" aria-labelledby="pat-heading">
        <div className="section-title"><div><KeyRound size={19} /><h2 id="pat-heading">Private Access Tokens</h2></div><strong>{tokens.length}</strong></div>
        {!userId && <form className="pat-form" onSubmit={generate}>
          <div><label htmlFor="pat-name">PAT name</label><input id="pat-name" required maxLength={64} value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Home automation" /></div>
          <button className="primary-button" type="submit" disabled={Boolean(busy) || !name.trim()}>{busy === 'generate' ? <RefreshCw size={17} className="spin" /> : <Plus size={17} />}Generate PAT</button>
        </form>}
        {tokens.length === 0 ? <div className="empty-state compact"><KeyRound size={28} /><h3>No Private Access Tokens</h3></div> : <ul className="pat-list">
          {tokens.map((pat) => <li key={pat.id}><KeyRound size={18} /><div><strong>{pat.name}</strong><small>Created {formatDate(pat.createdAt)}</small></div>
            <button className="danger-button pat-delete" type="button" title={`Delete ${pat.name}`} aria-label={`Delete ${pat.name}`} disabled={Boolean(busy)} onClick={() => remove(pat)}><Trash2 size={17} /></button>
          </li>)}
        </ul>}
      </section>
    </div>}
    {secret && <PatDialog pat={secret} onClose={() => setSecret(null)} />}
    {dialog}
  </AppShell>;
}

function AdminSharedLinksPage() {
  const { confirm, dialog } = useConfirmation();
  return <AppShell section="admin"><AdminMediaShares request={request} confirm={confirm} />{dialog}</AppShell>;
}

function AdminPage() {
  const { user: currentUser } = useContext(AuthContext);
  const [users, setUsers] = useState([]);
  const [mediaScan, setMediaScan] = useState(null);
  const [error, setError] = useState('');
  const [updating, setUpdating] = useState('');
  const { confirm, dialog } = useConfirmation();

  async function loadUsers() {
    try {
      const result = await request('/api/admin/users');
      setUsers(result.users);
      setMediaScan(result.mediaScan);
      setError('');
    } catch (loadError) {
      setError(loadError.message);
    }
  }

  usePolling(loadUsers, mediaScan?.scanning ? POLL_INTERVAL : 60_000);

  async function changeUser(userId, changes) {
    setUpdating(userId);
    setError('');
    try {
      await request(`/api/admin/users/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(changes)
      });
      await loadUsers();
    } catch (updateError) {
      setError(updateError.message);
    } finally {
      setUpdating('');
    }
  }

  async function removeUser(user) {
    if (!await confirm({
      title: 'Delete user?',
      message: `Permanently delete "${user.name}"? Their passkeys, sessions, Private Access Tokens, and personal library settings will be removed. Backups, jobs, and downloaded media will remain. This cannot be undone.`,
      action: 'delete',
      label: 'Delete user'
    })) return;
    setUpdating(user.id);
    setError('');
    try {
      await request(`/api/admin/users/${encodeURIComponent(user.id)}`, { method: 'DELETE' });
      setUsers((previous) => previous.filter((account) => account.id !== user.id));
    } catch (deleteError) {
      setError(deleteError.message);
    } finally {
      setUpdating('');
    }
  }

  const pending = users.filter((user) => user.status === 'pending');
  return <AppShell section="admin">
    <section className="page-heading admin-heading">
      <div><p className="eyebrow">Access control</p><h1>Allowed users.</h1><p>Review passkey registrations and control who can use this server.</p></div>
      <div className="pending-count"><strong>{pending.length}</strong><span>Awaiting approval</span></div>
    </section>
    {error && <div className="notice error page-notice" role="alert"><CircleAlert size={16} />{error}</div>}
    <section className="users-section">
      <div className="section-title"><div><span>01</span><h2>Access requests</h2></div></div>
      {pending.length === 0 ? <div className="empty-state compact"><UserCheck size={30} /><h3>No pending requests</h3><p>New passkey registrations will appear here.</p></div> : (
        <div className="user-list">{pending.map((user) => <article className="user-row pending-user" key={user.id}>
          <UserIdentity user={user} />
          <button className="primary-button compact-button" disabled={Boolean(updating)} onClick={() => changeUser(user.id, { status: 'approved' })} type="button"><UserCheck size={16} />Approve</button>
        </article>)}</div>
      )}
    </section>
    <section className="users-section">
      <div className="section-title"><div><span>02</span><h2>All users</h2></div><strong>{users.length}</strong></div>
      <div className="user-scan-status" role="status">
        <span>{mediaScan?.scanning ? <RefreshCw size={14} className="spin" aria-hidden="true" /> : <Clock3 size={14} aria-hidden="true" />}
          {mediaScan?.scanning ? 'Scanning media...' : mediaScan?.error || (mediaScan?.scannedAt ? 'Daily media scan' : 'Awaiting media scan')}
        </span>
        {mediaScan?.scannedAt && <span>Last scan: <time dateTime={mediaScan.scannedAt}>{formatDate(mediaScan.scannedAt)}</time></span>}
      </div>
      <div className="user-list">{users.map((user) => <article className="user-row user-usage-row" key={user.id}>
        <a className="user-details-link" href={`/admin/users/${encodeURIComponent(user.id)}`} aria-label={`View ${user.name} details`}><UserIdentity user={user} /><ExternalLink size={16} /></a>
        <dl className="user-media-usage" aria-label={`Media usage for ${user.name}`}>
          <div><dt>Song files</dt><dd>{Number.isInteger(user.mediaUsage?.songFiles) ? user.mediaUsage.songFiles.toLocaleString() : '-'}</dd></div>
          <div><dt>Storage</dt><dd title={user.mediaUsage ? `${user.mediaUsage.totalBytes.toLocaleString()} bytes in ${user.mediaUsage.totalFiles.toLocaleString()} audio and video files` : 'No completed scan'}>{formatBytes(user.mediaUsage?.totalBytes)}</dd></div>
        </dl>
        <div className="user-role-controls">
          <label className="role-control"><span>Role</span><select disabled={Boolean(updating) || user.id === currentUser.id} value={user.role} onChange={(event) => changeUser(user.id, { role: event.target.value })}><option value="user">User</option><option value="admin">Admin</option><option value="shared">Shared</option></select></label>
          <OrganizerControl user={user} users={users} disabled={Boolean(updating)} confirm={confirm}
            onChange={(organizerId) => changeUser(user.id, { organizerId })} />
        </div>
        <div className="user-actions">
          {user.status === 'approved'
            ? <button className="danger-button compact-button" disabled={Boolean(updating) || user.id === currentUser.id} onClick={() => changeUser(user.id, { status: 'revoked' })} type="button"><UserX size={16} />Revoke</button>
            : <button className="secondary-button compact-button" disabled={Boolean(updating)} onClick={() => changeUser(user.id, { status: 'approved' })} type="button"><UserCheck size={16} />Allow</button>}
          <button className="danger-button user-delete" type="button" title={user.id === currentUser.id ? 'You cannot delete your own account' : `Delete ${user.name}`} aria-label={`Delete ${user.name}`} disabled={Boolean(updating) || user.id === currentUser.id} onClick={() => removeUser(user)}>
            {updating === user.id ? <RefreshCw size={16} className="spin" /> : <Trash2 size={16} />}
          </button>
        </div>
      </article>)}</div>
    </section>
    <AdminArtworkThumbnails request={request} />
    {dialog}
  </AppShell>;
}

function UserIdentity({ user }) {
  return <div className="user-identity"><span>{user.name.slice(0, 1).toUpperCase()}</span><div><strong>{user.name}</strong><small>{user.status} · {user.credentialCount} passkey{user.credentialCount === 1 ? '' : 's'}</small></div></div>;
}

function Router({ user }) {
  const revision = useNavigation();
  return <PageRoutes key={revision} user={user} />;
}

function SharedSettingsPage() {
  const { user, setUser } = useContext(AuthContext);
  return <AppShell section="settings"><section className="page-heading settings-heading"><h1>User settings</h1></section>
    <section className="settings-profile" aria-label="User details"><UserIdentity user={user} /><dl><div><dt>Role</dt><dd>Shared</dd></div></dl>
      <UsernameForm user={user} request={request} endpoint="/api/auth/me" onSaved={setUser} />
    </section>
    <LibraryAccessList request={request} />
    <section className="theme-section" aria-labelledby="appearance-heading">
      <div className="section-title"><div><Palette size={19} /><h2 id="appearance-heading">Appearance</h2></div></div>
      <ThemeChoices />
    </section>
  </AppShell>;
}

function PageRoutes({ user }) {
  if (user.role === 'shared') return window.location.pathname === '/settings' ? <SharedSettingsPage /> : <MusicHomePage />;
  if (window.location.pathname === '/admin/shared-links' && user.role === 'admin') return <AdminSharedLinksPage />;
  const userMatch = window.location.pathname.match(/^\/admin\/users\/([^/]+)\/?$/);
  if (userMatch && user.role === 'admin') return <UserSettingsPage userId={decodeURIComponent(userMatch[1])} />;
  if (window.location.pathname === '/settings') return <UserSettingsPage />;
  const playerMatch = window.location.pathname.match(/^\/job\/([^/]+)\/player\/?$/);
  if (playerMatch) return <AppShell><MusicPlayer id={decodeURIComponent(playerMatch[1])} request={request} /></AppShell>;
  const jobMatch = window.location.pathname.match(/^\/job\/([^/]+)\/?$/);
  if (jobMatch) return <JobPage key={jobMatch[1]} id={decodeURIComponent(jobMatch[1])} />;
  if (window.location.pathname === '/health') return <HealthPage />;
  if (window.location.pathname === '/admin' && user.role === 'admin') return <AdminPage />;
  if (/^\/job\/?$/.test(window.location.pathname)) return <JobsPage />;
  return <MusicHomePage />;
}

function App() {
  const [user, setUser] = useState(undefined);
  const [preferences, setPreferences] = useState(null);
  const [themeSaving, setThemeSaving] = useState(false);
  const [themeError, setThemeError] = useState('');
  const accountRef = useRef(null);
  const themeSaveRef = useRef(false);

  useEffect(() => {
    request('/api/auth/me').then((result) => setUser(result.user)).catch(() => setUser(null));
  }, []);

  useEffect(() => {
    let active = true;
    accountRef.current = user?.id || null;
    setThemeError('');
    if (user) {
      request('/api/preferences').then((result) => { if (active) setPreferences({ ...result, userId: user.id }); })
        .catch((error) => {
          if (active) { setPreferences({ theme: 'midnight', mode: 'light', userId: user.id }); setThemeError(error.message); }
        });
    } else setPreferences(null);
    return () => { active = false; accountRef.current = null; };
  }, [user?.id]);

  useEffect(() => {
    document.documentElement.dataset.theme = preferences?.userId === user?.id ? preferences?.theme || 'midnight' : 'midnight';
    document.documentElement.dataset.themeMode = preferences?.userId === user?.id ? preferences?.mode || 'light' : 'light';
  }, [preferences, user?.id]);

  async function changeTheme(theme, mode = preferences?.mode || 'light') {
    if (!user || themeSaveRef.current || (theme === preferences?.theme && mode === preferences?.mode)) return;
    const previous = preferences;
    const userId = user.id;
    themeSaveRef.current = true;
    setThemeSaving(true);
    setThemeError('');
    setPreferences({ userId, theme, mode });
    try {
      const result = await request('/api/preferences', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ theme, mode }) });
      if (accountRef.current === userId) setPreferences({ ...result, userId });
    } catch (error) {
      if (accountRef.current === userId) { setPreferences(previous); setThemeError(error.message); }
    } finally { themeSaveRef.current = false; setThemeSaving(false); }
  }

  async function logout() {
    await request('/api/auth/logout', { method: 'POST' }).catch(() => {});
    setUser(null);
  }

  if (user === undefined) return <div className="auth-loading"><Fingerprint className="spin" size={28} />Checking passkey session</div>;
  if (!user) return <LoginPage onLogin={setUser} />;
  if (preferences?.userId !== user.id) return <div className="auth-loading"><RefreshCw className="spin" size={24} />Loading account</div>;
  return <AuthContext.Provider value={{ user, setUser, logout, theme: preferences.theme, themeMode: preferences.mode, changeTheme, themeSaving, themeError }}><PlaybackProvider key={user.id} request={request}><Router user={user} /></PlaybackProvider></AuthContext.Provider>;
}

initializeTouchControls();
const publicPlaylistMatch = window.location.pathname.match(/^\/share\/playlist\/([^/]+)\/?$/);
const publicMediaMatch = window.location.pathname.match(/^\/share\/([^/]+)\/?$/);
createRoot(document.getElementById('root')).render(<StrictMode>{publicPlaylistMatch
  ? <PublicPlaylist key={publicPlaylistMatch[1]} token={publicPlaylistMatch[1]} request={request} /> : publicMediaMatch
  ? <PublicMedia token={publicMediaMatch[1]} request={request} />
  : window.location.pathname === '/app-login' ? <LoginPage appLogin /> : <App />}</StrictMode>);