import { useEffect, useId, useState } from 'react';
import { Link2, RefreshCw, Save, Settings, Unlink, UserCheck, UserPlus, Users, X } from 'lucide-react';
import { SharedLibraryAccess } from './SharedLibraries.jsx';

export function OrganizerControl({ user, users, onChange, confirm, disabled = false }) {
  if (user.role !== 'shared') return null;
  const organizers = users.filter((account) => account.id !== user.id && account.status === 'approved' && account.role !== 'shared');
  const organizer = organizers.find((account) => account.id === user.organizerId);
  return <label className="role-control organizer-control"><span>Organizer</span>
    <select aria-label={`Organizer for ${user.name}`} value={user.organizerId || ''} disabled={disabled}
      title={organizer?.name || 'Administrator managed'} onChange={async (event) => {
        const organizerId = event.target.value || null;
        if (organizerId === (user.organizerId || null)) return;
        const name = organizers.find((account) => account.id === organizerId)?.name || 'Administrator managed';
        if (await confirm({ title: 'Change organizer?',
          message: `Change the organizer for "${user.name}" to "${name}"? Current library access will be cleared and must be selected again.`,
          label: 'Change organizer' })) onChange(organizerId);
      }}>
      <option value="">Administrator managed</option>
      {organizers.map((account) => <option key={account.id} value={account.id}>{account.name}</option>)}
    </select>
  </label>;
}

export function SharedRegistrationFields({ account, onChange, request, disabled = false }) {
  const inputId = useId();
  const [users, setUsers] = useState(null);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  const shared = account.role === 'shared';
  useEffect(() => {
    if (!shared) return;
    let active = true;
    setUsers(null);
    setError('');
    request('/api/auth/register/users').then((result) => {
      if (active) setUsers(result.users);
    }).catch((loadError) => { if (active) setError(loadError.message); });
    return () => { active = false; };
  }, [request, shared, refresh]);
  return <fieldset className="registration-shared" disabled={disabled}>
    <label className="registration-shared-toggle" htmlFor={inputId}>
      <input id={inputId} type="checkbox" checked={shared} aria-describedby={`${inputId}-help`}
        onChange={(event) => onChange({ role: event.target.checked ? 'shared' : 'user', organizerId: null })} />
      Register as a Shared user
    </label>
    <p id={`${inputId}-help`}>Shared users allow read-only access to multiple libraries. This is convenient if you have a separate system such as in your car to provide listen to multiple libraries.</p>
    {shared && <>
      <label htmlFor={`${inputId}-organizer`}>Organizer</label>
      <select id={`${inputId}-organizer`} className="account-user-select" required value={account.organizerId || ''} disabled={disabled || !users?.length}
        onChange={(event) => onChange({ role: 'shared', organizerId: event.target.value || null })}>
        <option value="">Select an organizer</option>
        {users?.map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}
      </select>
      {!users && !error && <p role="status">Loading available users...</p>}
      {users?.length === 0 && <p role="status">No approved organizers are available.</p>}
      {error && <div className="notice error" role="alert">{error}
        <button className="secondary-button compact-button" type="button" onClick={() => setRefresh((value) => value + 1)}><RefreshCw size={16} />Retry</button>
      </div>}
    </>}
  </fieldset>;
}

export function UsernameForm({ user, request, endpoint, onSaved, disabled = false }) {
  const inputId = useId();
  const [name, setName] = useState(user.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  useEffect(() => { setName(user.name); }, [user.id, user.name]);
  async function submit(event) {
    event.preventDefault();
    if (saving || disabled) return;
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      const result = await request(endpoint, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
      setName(result.user.name);
      onSaved(result.user);
      setSaved(true);
    } catch (saveError) { setError(saveError.message); }
    finally { setSaving(false); }
  }
  return <>
    <form className="pat-form" onSubmit={submit}>
      <div><label htmlFor={inputId}>Username</label><input id={inputId} autoComplete="username" required minLength={2} maxLength={64}
        value={name} disabled={disabled || saving} onChange={(event) => { setName(event.target.value); setSaved(false); }} /></div>
      <button className="primary-button" type="submit" disabled={disabled || saving || name.trim().length < 2 || name === user.name}>
        {saving ? <RefreshCw className="spin" size={17} /> : <Save size={17} />}Save username
      </button>
    </form>
    {error && <p className="notice error" role="alert">{error}</p>}
    {saved && <p className="notice success" role="status">Username saved.</p>}
  </>;
}

export function SettingsTabs({ value, onChange, disabled = false }) {
  const tabs = [{ id: 'account', name: 'Account', Icon: Settings }, { id: 'links', name: 'Linked users', Icon: Link2 },
    { id: 'shared', name: 'Shared users', Icon: Users }];
  return <div className="settings-tabs" role="tablist" aria-label="User settings">
    {tabs.map(({ id, name, Icon }, index) => <button key={id} id={`settings-tab-${id}`} type="button" role="tab"
      aria-controls={`settings-panel-${id}`} aria-selected={value === id} tabIndex={value === id ? 0 : -1} disabled={disabled}
      onClick={() => onChange(id)} onKeyDown={(event) => {
        const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length
          : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
        if (next === null) return;
        event.preventDefault();
        onChange(tabs[next].id);
        event.currentTarget.parentElement.querySelectorAll('[role="tab"]')[next].focus();
      }}><Icon size={17} /><span>{name}</span></button>)}
  </div>;
}

export function LinkedUsers({ request, confirm }) {
  const selectId = useId();
  const [data, setData] = useState(null);
  const [selectedId, setSelectedId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    const load = () => request('/api/auth/links').then((result) => {
      if (active) { setData(result); setError(''); }
    }).catch((loadError) => { if (active) setError(loadError.message); });
    load();
    const timer = window.setInterval(load, 10000);
    return () => { active = false; window.clearInterval(timer); };
  }, [request, refresh]);
  const available = data?.users.filter((user) => !data.links.some((link) => link.id === user.id)) || [];

  async function mutate(url, method, body, success) {
    if (busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await request(url, { method, headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      setData(await request('/api/auth/links'));
      setSelectedId('');
      setMessage(success);
    } catch (mutationError) { setError(mutationError.message); }
    finally { setBusy(false); }
  }

  async function remove(link) {
    if (busy) return;
    if (link.status === 'linked' && !await confirm({ title: 'Unlink users?',
      message: `Unlink "${link.name}"? Both libraries and dependent Shared-user library access will be disconnected.`, action: 'delete', label: 'Unlink users' })) return;
    await mutate(`/api/auth/links/${encodeURIComponent(link.id)}`, 'DELETE', undefined,
      link.status === 'linked' ? 'Users unlinked.' : link.status === 'incoming' ? 'Link request declined.' : 'Link request canceled.');
  }

  return <section className="users-section account-sharing" aria-labelledby={`${selectId}-heading`}>
    <div className="section-title"><h2 id={`${selectId}-heading`}>Linked users</h2>
      <button className="music-icon-button" type="button" title="Refresh user links" aria-label="Refresh user links" disabled={busy}
        onClick={() => setRefresh((value) => value + 1)}><RefreshCw size={18} /></button></div>
    {error && <p className="notice error" role="alert">{error}</p>}
    {message && <p className="notice success" role="status">{message}</p>}
    {!data && !error && <p role="status">Loading user links...</p>}
    {data && <>
      <form className="pat-form" onSubmit={(event) => {
        event.preventDefault();
        if (available.some((user) => user.id === selectedId)) void mutate('/api/auth/links', 'POST', { userId: selectedId }, 'Link request sent.');
      }}>
        <div><label htmlFor={selectId}>User</label><select id={selectId} className="account-user-select" value={available.some((user) => user.id === selectedId) ? selectedId : ''}
          required disabled={busy || !available.length} onChange={(event) => setSelectedId(event.target.value)}>
          <option value="">{available.length ? 'Select a user' : 'No available users'}</option>
          {available.map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}
        </select></div>
        <button className="primary-button" type="submit" disabled={busy || !available.some((user) => user.id === selectedId)}><UserPlus size={17} />Send link request</button>
      </form>
      {!data.links.length && <p className="music-empty">No linked users or requests.</p>}
      {data.links.length > 0 && <ul className="pat-list account-link-list" aria-label="User links">{data.links.map((link) => <li key={link.id}>
        <Link2 size={18} /><div><strong>{link.status === 'linked'
          ? <a href={`/?${new URLSearchParams({ userId: link.id })}`} title={`View ${link.name}'s library`}>{link.name}</a> : link.name}</strong>
          <small>{link.status === 'linked' ? 'Linked' : link.status === 'incoming' ? 'Request received' : 'Request sent'}</small></div>
        <div className="account-link-actions">
          {link.status === 'incoming' && <button className="music-icon-button" type="button" title={`Accept link from ${link.name}`} aria-label={`Accept link from ${link.name}`} disabled={busy}
            onClick={() => mutate(`/api/auth/links/${encodeURIComponent(link.id)}/accept`, 'POST', undefined, 'Users linked.')}><UserCheck size={19} /></button>}
          <button className="music-icon-button" type="button" title={`${link.status === 'linked' ? 'Unlink' : link.status === 'incoming' ? 'Decline request from' : 'Cancel request to'} ${link.name}`}
            aria-label={`${link.status === 'linked' ? 'Unlink' : link.status === 'incoming' ? 'Decline request from' : 'Cancel request to'} ${link.name}`} disabled={busy} onClick={() => remove(link)}>
            {link.status === 'linked' ? <Unlink size={18} /> : <X size={18} />}</button>
        </div>
      </li>)}</ul>}
    </>}
  </section>;
}

export function OrganizedSharedUsers({ request, confirm }) {
  const selectId = useId();
  const [data, setData] = useState(null);
  const [selectedId, setSelectedId] = useState('');
  const [draft, setDraft] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    request('/api/auth/shared-users').then((result) => {
      if (active) { setData(result); setDraft(null); setError(''); }
    }).catch((loadError) => { if (active) setError(loadError.message); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [request, refresh]);
  const selected = data?.users.find((user) => user.id === selectedId) || data?.users[0];
  const selectedIds = draft && draft.userId === selected?.id ? draft.ids : selected?.sharedUserIds || [];
  const dirty = selected && (selectedIds.length !== selected.sharedUserIds.length || selectedIds.some((id) => !selected.sharedUserIds.includes(id)));
  async function discardChanges() {
    return !dirty || await confirm({ title: 'Discard library access changes?', message: 'The current library selection has not been saved.', label: 'Discard changes' });
  }
  async function save() {
    if (!selected || saving || loading || !dirty) return;
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      const result = await request(`/api/auth/shared-users/${encodeURIComponent(selected.id)}/libraries`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sharedUserIds: selectedIds })
      });
      setData((current) => ({ ...current, users: current.users.map((user) => user.id === selected.id ? result.user : user) }));
      setDraft(null);
      setSaved(true);
    } catch (saveError) { setError(saveError.message); }
    finally { setSaving(false); }
  }
  return <section className="users-section account-sharing" aria-labelledby={`${selectId}-heading`}>
    <div className="section-title"><h2 id={`${selectId}-heading`}>Shared users</h2>
      <button className="music-icon-button" type="button" title="Refresh Shared users" aria-label="Refresh Shared users" disabled={saving || loading}
        onClick={async () => { if (await discardChanges()) { setSaved(false); setRefresh((value) => value + 1); } }}><RefreshCw size={18} /></button></div>
    {error && <p className="notice error" role="alert">{error}</p>}
    {loading && <p role="status">Loading Shared users...</p>}
    {saved && <p className="notice success" role="status">Library access saved.</p>}
    {data?.users.length === 0 && <p className="music-empty">No Shared users have assigned you as Organizer.</p>}
    {selected && <>
      <label className="library-location shared-library-picker" htmlFor={selectId}>Shared user
        <select id={selectId} value={selected.id} disabled={saving || loading} onChange={async (event) => {
          const nextId = event.target.value;
          if (await discardChanges()) { setSelectedId(nextId); setDraft(null); setSaved(false); setError(''); }
        }}>{data.users.map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}</select>
      </label>
      <p className="account-sharing-status"><span>Organizer</span><span>{selected.status === 'pending' ? 'Pending approval' : selected.status === 'revoked' ? 'Access revoked' : 'Approved'}</span></p>
      <SharedLibraryAccess users={data.libraries} selectedIds={selectedIds} onChange={(ids) => { setDraft({ userId: selected.id, ids }); setSaved(false); }}
        onSave={save} saving={saving || loading} saveDisabled={!dirty} />
    </>}
  </section>;
}

export function LibraryAccessList({ request }) {
  const [users, setUsers] = useState(null);
  const [error, setError] = useState('');
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    const load = () => request('/api/library/shared-users').then((result) => {
      if (active) { setUsers(result.users); setError(''); }
    }).catch((loadError) => { if (active) { setUsers(null); setError(loadError.message); } });
    load();
    const timer = window.setInterval(load, 10000);
    return () => { active = false; window.clearInterval(timer); };
  }, [request, refresh]);
  return <section className="users-section" aria-labelledby="library-access-heading">
    <div className="section-title"><h2 id="library-access-heading">Library access</h2>
      <button className="music-icon-button" type="button" title="Refresh library access" aria-label="Refresh library access" onClick={() => setRefresh((value) => value + 1)}><RefreshCw size={18} /></button>
    </div>
    {error && <p className="notice error" role="alert">{error}</p>}
    {!users && !error && <p role="status">Loading library access...</p>}
    {users?.length === 0 && <p className="music-empty">No shared libraries available.</p>}
    {users?.length > 0 && <ul className="pat-list" aria-label="Accessible libraries">{users.map((user) => <li key={user.id}>
      <a className="user-details-link" href={`/?${new URLSearchParams({ userId: user.id })}`}>{user.name}</a>
    </li>)}</ul>}
  </section>;
}