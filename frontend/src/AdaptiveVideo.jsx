import { useEffect, useRef, useState } from 'react';
import { adaptiveVideoSource, attachAdaptiveVideo } from './adaptiveVideo.js';

export default function AdaptiveVideo({ src, ref: externalRef, onError, ...props }) {
  const localRef = useRef(null);
  const [status, setStatus] = useState(false);
  const [error, setError] = useState('');
  const errorRef = useRef(onError);
  errorRef.current = onError;
  useEffect(() => {
    const video = localRef.current;
    let active = true;
    setError('');
    const fail = (failure) => { if (active) { setError(failure.message); errorRef.current?.(failure); } };
    const playback = attachAdaptiveVideo(video, adaptiveVideoSource(src, window.location.href), { onStatus: setStatus, onError: fail });
    playback.ready.then(() => {
      if (active && video.autoplay) video.play().catch(fail);
    }).catch(fail);
    return () => { active = false; playback.destroy(); };
  }, [src]);
  return <>
    <video {...props} data-adaptive-source={adaptiveVideoSource(src)} ref={(element) => {
      localRef.current = element;
      if (typeof externalRef === 'function') externalRef(element);
      else if (externalRef) externalRef.current = element;
    }} onError={onError} />
    {status && <p role="status">Preparing adaptive video...</p>}
    {error && <p role="alert">{error}</p>}
  </>;
}
