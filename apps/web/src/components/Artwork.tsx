import { Disc3 } from 'lucide-react';
import { useState } from 'react';
import { artUrl } from '../player/stream-url.js';

interface Props {
  artworkId: string | null | undefined;
  size: 64 | 300 | 640;
  alt: string;
  className?: string;
  rounded?: string;
}

/** Album art with a calm placeholder when there is none (or it fails to load). */
export function Artwork({ artworkId, size, alt, className = '', rounded = 'rounded-lg' }: Props) {
  const [failed, setFailed] = useState(false);
  const src = artUrl(artworkId, size);
  if (!src || failed) {
    return (
      <div
        role="img"
        aria-label={alt}
        className={`flex aspect-square items-center justify-center bg-gradient-to-br from-raised to-surface-2 text-muted ${rounded} ${className}`}
      >
        <Disc3 aria-hidden className="h-1/3 w-1/3 opacity-60" />
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(true)}
      className={`aspect-square object-cover bg-surface-2 ${rounded} ${className}`}
    />
  );
}
