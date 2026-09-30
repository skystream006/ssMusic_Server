import { useEffect, useId, useState } from 'react';
import { RefreshCw, Save } from 'lucide-react';

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