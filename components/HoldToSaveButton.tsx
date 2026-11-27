import { useEffect, useRef, type ComponentPropsWithoutRef, type HTMLAttributes, type MouseEvent, type PointerEvent } from 'react';

export function useHoldToSave<T extends HTMLElement>(onSave?: () => void) {
  const press = useRef<{ timer: number; id: number; x: number; y: number } | null>(null);
  const held = useRef(false);
  const stop = () => {
    window.clearTimeout(press.current?.timer);
    press.current = null;
  };
  useEffect(() => stop, []);

  const start = (event: PointerEvent<T>) => {
    if (!onSave || !event.isPrimary || event.button !== 0) return;
    const button = (event.target as Element).closest('button');
    if (button && button !== event.currentTarget) return;
    held.current = false;
    stop();
    if (event.pointerType === 'mouse') return;
    press.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      timer: window.setTimeout(() => {
        held.current = true;
        onSave();
      }, 450),
    };
  };

  const bindings: HTMLAttributes<T> & { 'data-hold-to-save'?: string } = {
    'data-hold-to-save': onSave ? '' : undefined,
    onPointerDown: start,
    onPointerMove: (event) => {
      const active = press.current;
      if (active?.id === event.pointerId && Math.hypot(active.x - event.clientX, active.y - event.clientY) > 12) stop();
    },
    onPointerUp: stop,
    onPointerCancel: stop,
    onPointerLeave: stop,
    onContextMenu: (event) => {
      if (press.current || held.current) event.preventDefault();
    },
    onClickCapture: (event: MouseEvent<T>) => {
      if (held.current && event.detail) {
        held.current = false;
        event.preventDefault();
        event.stopPropagation();
      }
    },
  };
  return bindings;
}

export default function HoldToSaveButton({ onSave, ...props }: ComponentPropsWithoutRef<'button'> & {
  onSave?: () => void;
}) {
  const hold = useHoldToSave<HTMLButtonElement>(onSave);
  return <button type="button" {...props} {...hold} />;
}
