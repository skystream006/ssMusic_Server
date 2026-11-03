import { fileTypeFromBuffer } from 'file-type';
import { normalizeVideoUrl } from './utils.js';

async function fetchBounded(url, limit, signal) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`YouTube metadata request failed (HTTP ${response.status})`);
  }
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel();
    throw new Error('YouTube metadata response is too large');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limit) throw new Error('YouTube metadata response is too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function retrieveYoutubeMetadata(source, signal = new AbortController().signal, { includeArtwork = true } = {}) {
  const videoUrl = normalizeVideoUrl(source);
  if (!videoUrl) throw new Error('A YouTube video URL is required');
  const endpoint = new URL('https://www.youtube.com/oembed');
  endpoint.search = new URLSearchParams({ url: videoUrl, format: 'json' }).toString();
  const metadata = JSON.parse((await fetchBounded(endpoint, 128 * 1024, signal)).toString('utf8'));
  const title = typeof metadata.title === 'string' ? metadata.title.trim() : '';
  const artist = typeof metadata.author_name === 'string' ? metadata.author_name.trim() : '';
  const thumbnailUrl = typeof metadata.thumbnail_url === 'string' ? metadata.thumbnail_url : null;
  const artwork = includeArtwork ? await retrieveYoutubeArtwork(thumbnailUrl, signal) : { image: null, warning: null };
  return { title, artist, thumbnailUrl, ...artwork };
}

export async function retrieveYoutubeArtwork(thumbnailUrl, signal = new AbortController().signal) {
  let image = null;
  let warning = null;
  if (thumbnailUrl) {
    try {
      const thumbnail = new URL(thumbnailUrl);
      if (thumbnail.protocol !== 'https:' || thumbnail.username || thumbnail.password || thumbnail.port
        || !(thumbnail.hostname.endsWith('.ytimg.com') || thumbnail.hostname === 'img.youtube.com')) {
        throw new Error('Unsupported YouTube thumbnail URL');
      }
      const imageBuffer = await fetchBounded(thumbnail, 3 * 1024 * 1024, signal);
      const type = await fileTypeFromBuffer(imageBuffer);
      if (!['image/jpeg', 'image/png', 'image/webp', 'image/avif'].includes(type?.mime)) {
        throw new Error('Unsupported YouTube thumbnail image');
      }
      image = { mime: type.mime, imageBuffer };
    } catch (error) {
      signal.throwIfAborted();
      warning = error.message;
    }
  }
  return { image, warning };
}