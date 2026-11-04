import React from 'react';
import { ExternalLink, Library } from 'lucide-react';
import type { JellyfinSnapshot } from '../services/jellyfinService';

const JellyfinHome: React.FC<{ snapshot: JellyfinSnapshot | null; onOpenSettings: () => void }> = ({ snapshot, onOpenSettings }) => {
  if (!snapshot) return null;
  return <section className="media-section jellyfin-home" aria-label="Jellyfin library">
    <div className="section-heading"><div><h2><Library size={20} /> Your Jellyfin library</h2><p>{snapshot.name} · First {snapshot.items.length} movies and series · Opens in Jellyfin</p></div><button className="text-button" onClick={onOpenSettings}>Manage</button></div>
    {snapshot.items.length ? <div className="jellyfin-home-row">
      {snapshot.items.map((item) => <a className="jellyfin-home-card" key={item.Id} href={`${snapshot.base}/web/index.html#!/details?id=${encodeURIComponent(item.Id)}`} target="_blank" rel="noopener noreferrer">
        <span className="jellyfin-home-icon"><Library size={24} /></span><strong>{item.Name}</strong><span>{item.Type === 'Series' ? 'Series' : 'Movie'}{item.ProductionYear ? ` · ${item.ProductionYear}` : ''}</span><small>Open in Jellyfin <ExternalLink size={12} /></small>
      </a>)}
    </div> : <p>No movies or series found in this library.</p>}
  </section>;
};
export default JellyfinHome;
