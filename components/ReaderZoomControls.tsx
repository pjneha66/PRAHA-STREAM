import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { Minus, Plus } from 'lucide-react';

const READER_ZOOM_MAX = 3;

export function useReaderZoom(viewport: RefObject<HTMLDivElement | null>) {
  const [zoom, setZoom] = useState(1);
  const target = useRef<{ left: number; top: number } | null>(null);

  function changeZoom(next: number) {
    const root = viewport.current;
    if (root) {
      const ratio = next / zoom;
      target.current = {
        left: (root.scrollLeft + root.clientWidth / 2) * ratio - root.clientWidth / 2,
        top: root.scrollTop * ratio,
      };
    }
    setZoom(next);
  }

  useLayoutEffect(() => {
    const root = viewport.current;
    if (!root || !target.current) return;
    root.scrollLeft = target.current.left;
    root.scrollTop = target.current.top;
    target.current = null;
  }, [viewport, zoom]);

  return { zoom, changeZoom };
}

export default function ReaderZoomControls({ zoom, onChange }: { zoom: number; onChange: (zoom: number) => void }) {
  return (
    <div className="reader-zoom-controls" role="group" aria-label="Page zoom">
      <button type="button" aria-label="Zoom out" disabled={zoom === 1} onClick={() => onChange(zoom - 0.25)}>
        <Minus size={16} />
      </button>
      <button type="button" aria-label="Reset zoom to fit" title="Fit page" disabled={zoom === 1} onClick={() => onChange(1)}>
        {zoom * 100}%
      </button>
      <button type="button" aria-label="Zoom in" disabled={zoom === READER_ZOOM_MAX} onClick={() => onChange(zoom + 0.25)}>
        <Plus size={16} />
      </button>
    </div>
  );
}
