export const MAX_READER_ZOOM = 3;

export function clampReaderZoom(zoom: number) {
  return Math.max(1, Math.min(MAX_READER_ZOOM, Math.round(zoom * 100) / 100));
}

export interface ZoomPoint { x: number; y: number }

export function readerZoomOffset(viewport: HTMLElement, from: number, to: number, point?: ZoomPoint) {
  const x = point?.x ?? viewport.clientWidth / 2;
  const y = point?.y ?? 0;
  const ratio = to / from;
  return { left: (viewport.scrollLeft + x) * ratio - x, top: (viewport.scrollTop + y) * ratio - y };
}

export function bindReaderPinch(viewport: HTMLElement, getZoom: () => number, applyZoom: (zoom: number, point: ZoomPoint) => void) {
  let start: { distance: number; zoom: number } | null = null;
  let pending: { zoom: number; point: ZoomPoint } | null = null;
  let frame: number | null = null;

  function pinch(event: TouchEvent) {
    if (event.touches.length !== 2) return;
    const [a, b] = Array.from(event.touches);
    const distance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    if (!distance) return;
    if (event.cancelable) event.preventDefault();
    if (!start) {
      start = { distance, zoom: getZoom() };
      return;
    }
    const rect = viewport.getBoundingClientRect();
    pending = {
      zoom: clampReaderZoom(start.zoom * distance / start.distance),
      point: { x: (a.clientX + b.clientX) / 2 - rect.left, y: (a.clientY + b.clientY) / 2 - rect.top },
    };
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      if (pending) applyZoom(pending.zoom, pending.point);
      pending = null;
    });
  }

  function end() { start = null; }

  viewport.addEventListener('touchstart', pinch, { passive: false });
  viewport.addEventListener('touchmove', pinch, { passive: false });
  viewport.addEventListener('touchend', end);
  viewport.addEventListener('touchcancel', end);
  return () => {
    if (frame !== null) cancelAnimationFrame(frame);
    viewport.removeEventListener('touchstart', pinch);
    viewport.removeEventListener('touchmove', pinch);
    viewport.removeEventListener('touchend', end);
    viewport.removeEventListener('touchcancel', end);
  };
}
