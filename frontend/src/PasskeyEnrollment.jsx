import { useEffect, useId, useRef, useState } from 'react';
import { startRegistration } from '@simplewebauthn/browser';

export function PasskeyOriginDialog({ origins, onChoose, onClose }) {
  const dialogRef = useRef(null);
  const titleId = useId();
  const [name, setName] = useState('');
  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    dialog.showModal();
    return () => { dialog.close(); if (previousFocus?.isConnected) previousFocus.focus(); };
  }, []);

  return <dialog ref={dialogRef} className="confirmation-dialog" aria-labelledby={titleId}
    onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <h2 id={titleId}>Add passkey</h2>
    <p>Would you like to add a passkey for the main or secondary origin?</p>
    <p>Main: {origins.primary}</p>
    <p>{origins.secondary ? `Secondary: ${origins.secondary}` : 'Secondary origin is not configured.'}</p>
    <p>The secondary origin opens in another window and adds a passkey to this account without another login.</p>
    <label htmlFor={`${titleId}-name`}>Passkey name (optional)</label>
    <input id={`${titleId}-name`} maxLength={64} value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Phone or security key" />
    <div className="dialog-actions">
      <button className="secondary-button" type="button" onClick={onClose}>Cancel</button>
      <button className="primary-button" type="button" onClick={() => onChoose('primary', name)}>Main origin</button>
      <button className="primary-button" type="button" disabled={!origins.secondary} onClick={() => onChoose('secondary', name)}>Secondary origin</button>
    </div>
  </dialog>;
}

export function PasskeyNameForm({ passkey, onSave, disabled }) {
  const inputId = useId();
  const [name, setName] = useState(passkey.name || '');
  useEffect(() => { setName(passkey.name || ''); }, [passkey.id, passkey.name]);
  return <form className="pat-form" onSubmit={(event) => { event.preventDefault(); if (!disabled) onSave(passkey, name); }}>
    <div><label htmlFor={inputId}>Passkey name</label>
      <input id={inputId} maxLength={64} value={name} disabled={disabled}
        onChange={(event) => setName(event.target.value)} placeholder="Unnamed passkey" />
    </div>
    <button className="secondary-button" type="submit" disabled={disabled || name === (passkey.name || '')}>Save name</button>
  </form>;
}

export function SecondaryPasskeyEnrollment({ request }) {
  const [token] = useState(() => window.location.hash.slice(1));
  const [busy, setBusy] = useState(false);
  const [added, setAdded] = useState(false);
  const [error, setError] = useState('');
  const started = useRef(false);
  useEffect(() => {
    window.history.replaceState(window.history.state, '', window.location.pathname);
  }, []);

  async function enroll() {
    if (started.current) return;
    started.current = true;
    setBusy(true);
    try {
      const ceremony = await request('/api/auth/passkeys/secondary/options', {
        method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
      });
      const response = await startRegistration({ optionsJSON: ceremony.options });
      await request('/api/auth/passkeys/secondary/verify', {
        method: 'POST', credentials: 'omit', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId: ceremony.requestId, response })
      });
      setAdded(true);
    } catch (enrollError) {
      const canceled = enrollError.name === 'NotAllowedError' || enrollError.cause?.name === 'NotAllowedError';
      setError(canceled ? 'Passkey setup was canceled or timed out.' : enrollError.message);
    } finally { setBusy(false); }
  }

  return <main className="auth-page"><section className="auth-panel" aria-labelledby="enroll-heading">
    <h1 id="enroll-heading">Add secondary-origin passkey</h1>
    <p>{added ? 'Passkey added to your original account. Close this window and return to User settings.' : 'Add a passkey for the account that opened this window. This does not sign you in here.'}</p>
    {(!token || error) && <p role="alert">{error || 'No enrollment credentials were provided.'} Return to the original window and start Add passkey again.</p>}
    {!added && <button className="primary-button" type="button" disabled={!token || busy || Boolean(error)} onClick={enroll}>
      {busy ? 'Adding passkey...' : 'Create passkey'}
    </button>}
    {added && <button className="secondary-button" type="button" onClick={() => window.close()}>Close window</button>}
  </section></main>;
}
