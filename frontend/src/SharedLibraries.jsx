import { useEffect, useState } from 'react';
import { Save } from 'lucide-react';
import MusicLibrary from './MusicLibrary.jsx';
import { replaceURL } from './navigation.js';

export default function SharedLibraries({ user, request, confirm }) {
  const [owners, setOwners] = useState(null);
  const [ownerId, setOwnerId] = useState(new URLSearchParams(window.location.search).get('userId'));
  const [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    const load = () => request('/api/library/shared-users').then((result) => {
      if (active) { setOwners(result.users); setError(''); }
    }).catch((loadError) => { if (active) { setOwners(null); setError(loadError.message); } });
    load();
    const timer = window.setInterval(load, 10000);
    return () => { active = false; window.clearInterval(timer); };
  }, [request]);
  const owner = owners?.find((item) => item.id === ownerId) || owners?.[0];
  const scopedRequest = (url, options) => {
    if (url === '/api/library' || url.startsWith('/api/library/tracks?')) {
      const target = new URL(url, window.location.origin);
      target.searchParams.set('userId', owner.id);
      return request(`${target.pathname}${target.search}`, options);
    }
    return request(url, options);
  };
  return <>
    {error && <div className="notice error" role="alert">{error}</div>}
    {!owners && !error && <p role="status">Loading shared libraries...</p>}
    {owners?.length === 0 && <p className="music-empty">No shared libraries available.</p>}
    {owner && <>
      <label className="library-location shared-library-picker">Library<select aria-label="Library owner" value={owner.id} onChange={(event) => {
        setOwnerId(event.target.value);
        replaceURL(`/?${new URLSearchParams({ userId: event.target.value })}`);
      }}>{owners.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
      <MusicLibrary key={owner.id} user={user} request={scopedRequest} confirm={confirm} owner={owner} />
    </>}
  </>;
}

export function SharedLibraryAccess({ users, selectedIds, onChange, onSave, saving }) {
  return <section className="users-section" aria-labelledby="shared-libraries-heading">
    <div className="section-title"><h2 id="shared-libraries-heading">Shared libraries</h2>
      <button className="primary-button compact-button" type="button" disabled={saving} onClick={onSave}><Save size={16} />Save access</button></div>
    <div className="shared-library-options" role="group" aria-label="Library access">
      {users.map((user) => <label key={user.id}><input type="checkbox" checked={selectedIds.includes(user.id)} disabled={saving}
        onChange={(event) => onChange(event.target.checked ? [...selectedIds, user.id] : selectedIds.filter((id) => id !== user.id))} />{user.name}</label>)}
      {!users.length && <p className="music-empty">No eligible users.</p>}
    </div>
  </section>;
}