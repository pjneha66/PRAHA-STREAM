import { useEffect } from 'react';
import { isAndroidTv } from '../services/androidBridge';

const FOCUSABLE_SELECTOR = [
  'button:not([disabled])',
  'a[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex="0"]',
].join(',');

function isVisible(el: HTMLElement): boolean {
  if (el.offsetParent === null && getComputedStyle(el).position !== 'fixed') return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 4 && rect.height > 4;
}

/**
 * Spatial 2D arrow-key / Android TV D-Pad remote navigation.
 * Automatically activates on Android TV / Leanback devices or when enabled in
 * Settings, and pauses while the built-in video player owns arrow keys.
 */
export function useSpatialNavigation(enabled: boolean, paused = false) {
  useEffect(() => {
    const active = enabled || isAndroidTv();
    document.documentElement.classList.toggle('dpad-mode', active);
    if (!active || paused) return;

    const onKeyDown = (event: KeyboardEvent) => {
      const dirMap: Record<string, { dx: number; dy: number }> = {
        ArrowUp: { dx: 0, dy: -1 },
        ArrowDown: { dx: 0, dy: 1 },
        ArrowLeft: { dx: -1, dy: 0 },
        ArrowRight: { dx: 1, dy: 0 },
      };
      const dir = dirMap[event.key];
      if (!dir) return;

      const activeEl = document.activeElement as HTMLElement | null;
      if (activeEl && ['INPUT', 'TEXTAREA', 'SELECT'].includes(activeEl.tagName)) {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') return;
      }

      // Scope focus inside the topmost modal dialog if one is open
      const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).filter(isVisible);
      const scopeRoot: ParentNode = dialogs.length ? dialogs[dialogs.length - 1] : document;

      const candidates = Array.from(scopeRoot.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(isVisible);
      if (!candidates.length) return;

      if (!activeEl || !candidates.includes(activeEl)) {
        event.preventDefault();
        candidates[0].focus();
        return;
      }

      const origin = activeEl.getBoundingClientRect();
      const ox = origin.left + origin.width / 2;
      const oy = origin.top + origin.height / 2;

      let best: HTMLElement | null = null;
      let bestScore = Number.POSITIVE_INFINITY;

      for (const candidate of candidates) {
        if (candidate === activeEl) continue;
        const rect = candidate.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const vx = cx - ox;
        const vy = cy - oy;

        const primary = vx * dir.dx + vy * dir.dy;
        if (primary <= 4) continue;

        const perpendicular = Math.abs(vx * dir.dy + vy * dir.dx);
        const score = primary + perpendicular * 2.6;
        if (score < bestScore) {
          bestScore = score;
          best = candidate;
        }
      }

      if (best) {
        event.preventDefault();
        best.focus();
        best.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled, paused]);
}
