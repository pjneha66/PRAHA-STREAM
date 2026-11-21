// @vitest-environment jsdom
//
// jsdom does no layout, so every element below is given a real
// `getBoundingClientRect`. The grid's DOM order is deliberately row-major while the
// assertions follow geometry: an implementation that walked `nextElementSibling`
// (or compared `offsetTop`) would go to the cell on the right when asked for
// "down", which is the exact failure this hook exists to prevent.
import { act, cleanup, fireEvent, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isDpadKey, mapRemoteKey, useDpadNavigation } from '../hooks/useDpadNavigation';
import type { DpadHandle } from '../hooks/useDpadNavigation';

const CELL = 100;

interface Cell {
  id: string;
  col: number;
  row: number;
}

/** A 3x3 grid in *row-major* DOM order: `r0c0, r0c1, r0c2, r1c0, …`. */
const GRID: ReadonlyArray<Cell> = Array.from({ length: 3 }, (_, row) =>
  Array.from({ length: 3 }, (_, col) => ({ id: `r${row}c${col}`, col, row })),
).flat();

function rect(left: number, top: number, width = CELL, height = CELL): DOMRect {
  return {
    left,
    top,
    right: left + width,
    bottom: top + height,
    width,
    height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

/** Pins an element's measured box; jsdom would otherwise report all zeros. */
function place(element: HTMLElement, left: number, top: number, width = CELL, height = CELL): void {
  element.getBoundingClientRect = () => rect(left, top, width, height);
}

/** A remote's legacy keyCode, including platforms that leave `key` as 'Unidentified'. */
function remoteEvent(keyCode: number, key = 'Unidentified'): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
  // jsdom's KeyboardEvent ignores `keyCode` in the init dict, so it is shadowed here.
  Object.defineProperty(event, 'keyCode', { configurable: true, get: () => keyCode });
  return event;
}

/**
 * Builds a container of focusable divs straight from the DOM rather than JSX: the
 * hook is about elements and geometry, so the test owns the elements.
 */
function buildContainer(
  id: string,
  cells: ReadonlyArray<Cell>,
  container: HTMLDivElement = document.createElement('div'),
): HTMLDivElement {
  container.id = id;
  for (const cell of cells) {
    const element = document.createElement('div');
    element.setAttribute('data-dpad-focusable', '');
    element.setAttribute('data-dpad-id', cell.id);
    place(element, cell.col * CELL, cell.row * CELL);
    container.appendChild(element);
  }
  document.body.appendChild(container);
  return container;
}

function cellOf(container: ParentNode, id: string): HTMLElement {
  const found = container.querySelector<HTMLElement>(`[data-dpad-id="${id}"]`);
  if (!found) throw new Error(`no cell ${id}`);
  return found;
}

function activeId(): string | null {
  return document.activeElement instanceof HTMLElement
    ? document.activeElement.getAttribute('data-dpad-id')
    : null;
}

beforeEach(() => {
  window.localStorage.clear();
  document.body.innerHTML = '';
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('useDpadNavigation movement', () => {
  it('moves down to the cell below, not the next in DOM order', () => {
    const container = buildContainer('grid', GRID);
    const containerRef = { current: container };
    const { result } = renderHook(() => useDpadNavigation({ containerRef }));

    act(() => result.current.focusFirst());
    expect(activeId()).toBe('r0c0');

    fireEvent.keyDown(window, { key: 'ArrowDown' });

    // Row-major DOM puts `r0c1` (to the right) next; geometry says `r1c0`.
    expect(activeId()).toBe('r1c0');
  });

  it('keeps a column: two downs land on the same column', () => {
    const container = buildContainer('grid', GRID);
    const containerRef = { current: container };
    const { result } = renderHook(() => useDpadNavigation({ containerRef }));

    act(() => result.current.focusFirst());
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    fireEvent.keyDown(window, { key: 'ArrowDown' });

    expect(activeId()).toBe('r2c0');
  });

  it('moves right along a row', () => {
    const container = buildContainer('grid', GRID);
    const containerRef = { current: container };
    const { result } = renderHook(() => useDpadNavigation({ containerRef }));

    act(() => result.current.focusFirst());
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    expect(activeId()).toBe('r0c1');
  });

  it('stays put at the right edge instead of wrapping', () => {
    const container = buildContainer('grid', GRID);
    const containerRef = { current: container };
    const { result } = renderHook(() => useDpadNavigation({ containerRef }));

    act(() => result.current.focusElement(cellOf(container, 'r0c2')));
    expect(activeId()).toBe('r0c2');

    fireEvent.keyDown(window, { key: 'ArrowRight' });

    // No candidate is to the right of the last column, so focus must not move.
    expect(activeId()).toBe('r0c2');
  });

  it('skips a data-dpad-skip element and a zero-sized one', () => {
    // A single column, so "the next one down" is the only sensible target.
    const column = buildContainer('column', [
      { id: 'top', col: 0, row: 0 },
      { id: 'middle', col: 0, row: 1 },
      { id: 'bottom', col: 0, row: 2 },
    ]);
    const middle = cellOf(column, 'middle');
    middle.setAttribute('data-dpad-skip', '');
    // `bottom` is also given a sibling at the same spot that is invisible, to prove
    // the size check runs: without it that sibling would win with distance 0.
    const ghost = document.createElement('div');
    ghost.setAttribute('data-dpad-focusable', '');
    ghost.setAttribute('data-dpad-id', 'ghost');
    place(ghost, 0, CELL, 0, 0);
    column.appendChild(ghost);

    const containerRef = { current: column };
    const { result } = renderHook(() => useDpadNavigation({ containerRef }));

    act(() => result.current.focusFirst());
    fireEvent.keyDown(window, { key: 'ArrowDown' });

    expect(activeId()).toBe('bottom');
  });

  it('does not move when the container is empty', () => {
    const container = buildContainer('empty', []);
    const containerRef = { current: container };
    const { result } = renderHook(() => useDpadNavigation({ containerRef }));

    expect(() => {
      act(() => result.current.focusFirst());
      fireEvent.keyDown(window, { key: 'ArrowDown' });
    }).not.toThrow();
    expect(activeId()).toBeNull();
  });
});

describe('useDpadNavigation select', () => {
  it('fires onSelect on a short OK and never onLongSelect', () => {
    const container = buildContainer('grid', GRID);
    const containerRef = { current: container };
    const onSelect = vi.fn();
    const onLongSelect = vi.fn();
    const { result } = renderHook(() =>
      useDpadNavigation({ containerRef, onSelect, onLongSelect }),
    );

    act(() => result.current.focusFirst());
    fireEvent.keyDown(window, { key: 'Enter' });
    fireEvent.keyUp(window, { key: 'Enter' });

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(container.firstElementChild);
    expect(onLongSelect).not.toHaveBeenCalled();
  });

  it('fires onLongSelect once for a held OK and suppresses onSelect', () => {
    vi.useFakeTimers();
    const container = buildContainer('grid', GRID);
    const containerRef = { current: container };
    const onSelect = vi.fn();
    const onLongSelect = vi.fn();
    const { result } = renderHook(() =>
      useDpadNavigation({ containerRef, onSelect, onLongSelect }),
    );

    act(() => result.current.focusFirst());
    fireEvent.keyDown(window, { key: 'Enter' });
    act(() => {
      vi.advanceTimersByTime(650);
    });
    fireEvent.keyUp(window, { key: 'Enter' });

    expect(onLongSelect).toHaveBeenCalledTimes(1);
    // `dpad_select_long_press_controller.dart`: the release after a long press
    // fires nothing, so a context menu is never also an activation.
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('does not consume OK when the caller has no select handler', () => {
    const container = buildContainer('grid', GRID);
    const containerRef = { current: container };
    renderHook(() => useDpadNavigation({ containerRef }));

    act(() => cellOf(container, 'r0c0').focus());
    const event = new KeyboardEvent('keydown', {
      key: 'Enter',
      bubbles: true,
      cancelable: true,
    });
    act(() => {
      window.dispatchEvent(event);
    });
    // A screen with no select handling must leave Enter to the DOM (a real button).
    expect(event.defaultPrevented).toBe(false);
  });
});

describe('useDpadNavigation focus memory', () => {
  it('restores the same element after unmount and remount', () => {
    const first = buildContainer('library', GRID);
    const firstRef = { current: first };
    const firstHook = renderHook(() => useDpadNavigation({ containerRef: firstRef }));
    act(() => firstHook.result.current.focusElement(cellOf(first, 'r1c1')));
    expect(activeId()).toBe('r1c1');
    firstHook.unmount();
    first.remove();

    const second = buildContainer('library', GRID);
    const secondRef = { current: second };
    const secondHook = renderHook(() => useDpadNavigation({ containerRef: secondRef }));
    act(() => secondHook.result.current.restoreFocus());

    expect(activeId()).toBe('r1c1');
  });

  it('falls back to the top-left cell when nothing was remembered', () => {
    const container = buildContainer('fresh', GRID);
    const containerRef = { current: container };
    const { result } = renderHook(() => useDpadNavigation({ containerRef }));

    act(() => result.current.restoreFocus());

    expect(activeId()).toBe('r0c0');
  });
});

describe('useDpadNavigation lifecycle', () => {
  it('shows keyboard mode only once a direction key is pressed', () => {
    const container = buildContainer('grid', GRID);
    const containerRef = { current: container };
    const { result } = renderHook(() => useDpadNavigation({ containerRef }));

    act(() => result.current.focusFirst());
    expect(result.current.inputMode).toBe('pointer');

    fireEvent.keyDown(window, { key: 'ArrowDown' });
    expect(result.current.inputMode).toBe('keyboard');
    expect(activeId()).toBe('r1c0');

    fireEvent.pointerDown(window);
    expect(result.current.inputMode).toBe('pointer');
  });

  it('removes every listener on unmount', () => {
    const removeFromWindow = vi.spyOn(window, 'removeEventListener');
    const removeFromDocument = vi.spyOn(document, 'removeEventListener');

    const container = buildContainer('grid', GRID);
    const containerRef = { current: container };
    const { unmount } = renderHook(() => useDpadNavigation({ containerRef }));
    unmount();

    for (const type of ['keydown', 'keyup', 'pointerdown', 'pointermove', 'blur']) {
      expect(removeFromWindow).toHaveBeenCalledWith(type, expect.any(Function));
    }
    for (const type of ['focusin', 'focusout']) {
      expect(removeFromDocument).toHaveBeenCalledWith(type, expect.any(Function));
    }
  });

  it('adds nothing when disabled', () => {
    const addToWindow = vi.spyOn(window, 'addEventListener');
    const container = buildContainer('grid', GRID);
    const containerRef = { current: container };
    renderHook(() => useDpadNavigation({ containerRef, enabled: false }));

    expect(addToWindow).not.toHaveBeenCalledWith('keydown', expect.any(Function));
  });
});

describe('mapRemoteKey', () => {
  it('maps the arrow keyCodes a TV remote sends', () => {
    expect(mapRemoteKey(remoteEvent(38))).toBe('up');
    expect(mapRemoteKey(remoteEvent(40))).toBe('down');
    expect(mapRemoteKey(remoteEvent(37))).toBe('left');
    expect(mapRemoteKey(remoteEvent(39))).toBe('right');
  });

  it('maps OK and Back, including the Tizen and webOS codes', () => {
    expect(mapRemoteKey(remoteEvent(13))).toBe('select');
    expect(mapRemoteKey(remoteEvent(461))).toBe('back');
    expect(mapRemoteKey(remoteEvent(10009))).toBe('back');
  });

  it('maps modern key names without a keyCode', () => {
    expect(mapRemoteKey(new KeyboardEvent('keydown', { key: 'ArrowUp' }))).toBe('up');
    expect(mapRemoteKey(new KeyboardEvent('keydown', { key: 'Enter' }))).toBe('select');
    expect(mapRemoteKey(new KeyboardEvent('keydown', { key: 'Escape' }))).toBe('back');
  });

  it('returns null for a key we do not handle, and isDpadKey agrees', () => {
    expect(mapRemoteKey(remoteEvent(65, 'a'))).toBeNull();
    expect(isDpadKey(remoteEvent(65, 'a'))).toBe(false);
    expect(isDpadKey(remoteEvent(38))).toBe(true);
  });
});

/** Compile-time guard: the hook's public surface is exactly what the plan consumes. */
function assertHandleShape(handle: DpadHandle): void {
  void handle.focusFirst;
  void handle.focusElement;
  void handle.restoreFocus;
  void handle.inputMode;
}
void assertHandleShape;
