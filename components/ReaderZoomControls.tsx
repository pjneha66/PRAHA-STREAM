import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { Minus, Plus } from 'lucide-react';
import { bindReaderPinch, clampReaderZoom, MAX_READER_ZOOM, readerZoomOffset, type ZoomPoint } from '../services/readerPinch';

export function useReaderZoom(viewport: RefObject<HTMLDivElement | null>) {
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  const unbind = useRef<(() => void) | null>(null);
  const target = useRef<{ left: number; top: number } | null>(null);

  const changeZoom = useCallback((value: number, point?: ZoomPoint) => {
    const next = clampReaderZoom(value);
    if (next === zoomRef.current) return;
    const root = viewport.current;
    if (root) target.current = readerZoomOffset(root, zoomRef.current, next, point);
    zoomRef.current = next;
    setZoom(next);
  }, [viewport]);

  const bindViewport = useCallback((element: HTMLDivElement | null) => {
    unbind.current?.();
    viewport.current = element;
    unbind.current = element ? bindReaderPinch(element, () => zoomRef.current, changeZoom) : null;
  }, [viewport, changeZoom]);

  useLayoutEffect(() => {
    const root = viewport.current;
    if (!root || !target.current) return;
    root.scrollLeft = target.current.left;
    root.scrollTop = target.current.top;
    target.current = null;
  }, [viewport, zoom]);

  return { zoom, changeZoom, bindViewport };
}

export default function ReaderZoomControls({ zoom, onChange }: { zoom: number; onChange: (zoom: number) => void }) {
  return (
    <div className="reader-zoom-controls" role="group" aria-label="Page zoom">
      <button type="button" aria-label="Zoom out" disabled={zoom === 1} onClick={() => onChange(zoom - 0.25)}>
        <Minus size={16} />
      </button>
      <button type="button" aria-label="Reset zoom to fit" title="Fit page" disabled={zoom === 1} onClick={() => onChange(1)}>
        {Math.round(zoom * 100)}%
      </button>
      <button type="button" aria-label="Zoom in" disabled={zoom === MAX_READER_ZOOM} onClick={() => onChange(zoom + 0.25)}>
        <Plus size={16} />
      </button>
    </div>
  );
}
