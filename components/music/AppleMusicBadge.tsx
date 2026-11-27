import { openSafeExternalUrl } from '../../services/androidBridge';

export default function AppleMusicBadge({ url }: { url: string }) {
  return (
    <a className="apple-music-badge" href={url} target="_blank" rel="noreferrer" onClick={(event) => {
      event.preventDefault();
      void openSafeExternalUrl(url);
    }}>
      <img src="https://tools.applemediaservices.com/api/badges/listen-on-apple-music/badge/en-us?size=250x83"
        alt="Listen on Apple Music" loading="lazy" />
    </a>
  );
}
