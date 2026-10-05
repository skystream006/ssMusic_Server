import { useEffect, useState } from 'react';
import { Save } from 'lucide-react';
import MusicLibrary from './MusicLibrary.jsx';
import { navigationHistory, replaceURL } from './navigation.js';
import { sortSelectOptions } from './selectOptions.js';

export default function SharedLibraries({ user, request, confirm }) {
  const [owners, setOwners] = useState(null);
  const [ownerId, setOwnerId] = useState(new URLSearchParams(window.location.search).get('userId'));
  const [error, setError] = useState('');
  useEffect(() => navigationHistory().subscribe(({ routeChanged }) => {
    if (routeChanged) setOwnerId(new URLSearchParams(window.location.search).get('userId'));
  }), []);
  useEffect(() => {
    let active = true;
    const load = () => request('/api/library/shared-users').then((result) => {
      if (active) { setOwners(result.users); setError(''); }
    }).catch((loadError) => { if (active) { setOwners(null); setError(loadError.message); } });
    load();
    const timer = window.setInterval(load, 10000);
    return () => { active = false; window.clearInterval(timer); };
  }, [request]);
  const available = user.role === 'shared' ? owners : [{ id: user.id, name: user.name }, ...(owners || [])];
  const owner = ownerId ? available?.find((item) => item.id === ownerId) : available?.[0];
  return <>
    {error && <div className="notice error" role="alert">{error}</div>}
    {!owners && !owner && !error && <p role="status">Loading shared libraries...</p>}
    {available?.length === 0 && <p className="music-empty">No shared libraries available.</p>}
    {owners && ownerId && !owner && <p className="notice error" role="alert">This library is no longer available.</p>}
    {available?.length > 0 && (available.length > 1 || user.role === 'shared' || !owner) &&
      <label className="library-location shared-library-picker">Library<select aria-label="Library owner" value={owner?.id || ''} onChange={(event) => {
        setOwnerId(event.target.value);
        replaceURL(event.target.value === user.id && user.role !== 'shared' ? '/' : `/?${new URLSearchParams({ userId: event.target.value })}`);
      }}>{!owner && <option value="" disabled>Select a library</option>}
        {sortSelectOptions(available, (item) => item.name).map((item) => <option key={item.id} value={item.id}>{item.name}{item.id === user.id ? ' (your library)' : ''}</option>)}
      </select></label>}
    {owner && <MusicLibrary key={owner.id} user={user} request={request} confirm={confirm} owner={owner.id === user.id ? null : owner} />}
  </>;
}

export function SharedLibraryAccess({ users, selectedIds, onChange, onSave, saving, saveDisabled = false }) {
  return <section className="users-section" aria-labelledby="shared-libraries-heading">
    <div className="section-title"><h2 id="shared-libraries-heading">Shared libraries</h2>
      <button className="primary-button compact-button" type="button" disabled={saving || saveDisabled} onClick={onSave}><Save size={16} />Save access</button></div>
    <div className="shared-library-options" role="group" aria-label="Library access">
      {users.map((user) => <label key={user.id}><input type="checkbox" checked={selectedIds.includes(user.id)} disabled={saving}
        onChange={(event) => onChange(event.target.checked ? [...selectedIds, user.id] : selectedIds.filter((id) => id !== user.id))} />{user.name}</label>)}
      {!users.length && <p className="music-empty">No eligible users.</p>}
    </div>
  </section>;
}