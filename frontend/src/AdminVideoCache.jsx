import { useEffect, useRef, useState } from 'react';
import { Film } from 'lucide-react';

export default function AdminVideoCache({ request }) {
  const [settings, setSettings] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const savingRef = useRef(false);

  useEffect(() => {
    let active = true;
    request('/api/admin/settings/video-cache')
      .then((value) => { if (active) setSettings(value); })
      .catch((failure) => { if (active) setError(failure.message); });
    return () => { active = false; };
  }, [request]);

  async function save(videoCacheEnabled) {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setError('');
    try {
      setSettings(await request('/api/admin/settings/video-cache', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ videoCacheEnabled })
      }));
    } catch (failure) {
      setError(failure.message);
    } finally { savingRef.current = false; setSaving(false); }
  }

  return <section className="theme-section" aria-labelledby="video-cache-heading" aria-busy={saving}>
    <div className="section-title"><div><Film size={19} /><h2 id="video-cache-heading">Video caching</h2></div></div>
    <label className="admin-privacy-setting">
      <input type="checkbox" checked={settings?.videoCacheEnabled === true} disabled={!settings || saving}
        onChange={(event) => save(event.target.checked)} />
      <span>Enable video caching</span>
    </label>
    <p>Prepare and cache adaptive video in the background for smoother playback. Uncached videos play their originals immediately.
      When disabled, videos always play their original files;
      browser compatibility may vary. Existing cache files expire normally. A conversion already running may finish.</p>
    {saving && <p className="sr-only" role="status">Saving video cache settings</p>}
    {error && <p className="notice error" role="alert">{error}</p>}
  </section>;
}
