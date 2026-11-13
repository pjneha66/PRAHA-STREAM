import React from 'react';

/**
 * Shimmering grid placeholder shared by every tab's first load. Skeletons read
 * as "fast" — bare spinners read as "stuck" (the app has a freeze history, so
 * perceived speed matters as much as real speed). Reuses the .media-skeleton
 * card styles HomeView already ships.
 */
const SkeletonGrid: React.FC<{
  count?: number;
  label?: string;
  /** Card shape: 'poster' (2:3 artwork + two text lines) or 'row' (logo square + text lines, for channel lists). */
  variant?: 'poster' | 'row';
  /** Minimum column width for the grid, matching the real grid it stands in for. */
  minColumnWidth?: number;
}> = ({ count = 12, label, variant = 'poster', minColumnWidth = 180 }) => (
  <div role="status" aria-label={label || 'Loading'} aria-busy="true">
    {label && (
      <p style={{ margin: '0 0 14px', fontSize: '13px', color: '#8b949e', display: 'flex', alignItems: 'center', gap: '8px' }}>
        {label}
      </p>
    )}
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(auto-fill, minmax(${minColumnWidth}px, 1fr))`, gap: variant === 'poster' ? '14px 10px' : '10px' }}>
      {Array.from({ length: count }).map((_, index) => (
        variant === 'poster'
          ? <div className="media-skeleton" key={index}><span /><i /><i /></div>
          : (
            <div className="media-skeleton skeleton-row" key={index}>
              <span className="skeleton-row-thumb" />
              <div className="skeleton-row-lines"><i /><i /></div>
            </div>
          )
      ))}
    </div>
  </div>
);

export default SkeletonGrid;
