import { useState } from 'react';
import { Film, ListMusic, Music2 } from 'lucide-react';
import { mediaType } from '../../src/media.js';
import { isNoVocals } from '../../src/library.js';

export default function SongArtwork({ track, placeholder }) {
  const [failedUrl, setFailedUrl] = useState(null);
  return <span className="song-artwork" aria-hidden="true">
    {track.artworkUrl && track.artworkUrl !== failedUrl
      ? <img key={track.artworkUrl} src={track.artworkUrl} alt="" loading="lazy" decoding="async"
        onError={() => setFailedUrl(track.artworkUrl)} />
      : placeholder || (mediaType(track.name) === 'video' ? <Film size={20} /> : <Music2 size={20} />)}
  </span>;
}

export function JobArtwork({ job, userId }) {
  const name = !job.hidden && (job.artworkName || job.files?.find((file) => typeof file === 'string'
    && !isNoVocals({ name: file }) && (/\.mp3$/i.test(file) || mediaType(file) === 'video')));
  const parameters = new URLSearchParams();
  if (job.updatedAt) parameters.set('v', job.updatedAt);
  if (userId) parameters.set('userId', userId);
  if (job.isPlaylist) parameters.set('playlist', '1');
  const artworkUrl = job.playlistArtworkUrl
    || (name ? `/api/jobs/${encodeURIComponent(job.id)}/artwork/${encodeURIComponent(name)}?${parameters}` : null);
  return <SongArtwork track={{ name, artworkUrl }} placeholder={job.isPlaylist || job.playlistArtworkUrl ? <ListMusic size={20} />
    : job.downloadType === 'video' || mediaType(name) === 'video' ? <Film size={20} /> : <Music2 size={20} />} />;
}
