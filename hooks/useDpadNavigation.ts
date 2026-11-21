// D-pad / TV-remote spatial navigation for an arbitrary React subtree.
//
// Ported from VyseTV's `lib/dpad/` (GPL-3.0), which in turn ports Android TV's
// FocusFinder. The parts that matter and are reproduced here line for line:
//
// - `dpad_traversal.dart` `_isCandidate` / `_beamsOverlap` / `_isBeyond` /
//   `_major` / `_majorToFarEdge` / `_minor` / `_beamBeats` / `_isBetter`. A move
//   is decided by *geometry*, never by DOM order: the cost is
//   `13 * major^2 + minor^2` with a beam preference on top. Substituting an
//   `offsetTop` comparison (as `useSpatialNavigation` does) breaks on grids,
//   staggered rows and cards of different heights, which is exactly the layout
//   PRAHA's home screen is built from.
// - `dpad_traversal.dart` `firstStop` -> `_topLeft`: where a container starts.
// - `focus_memory_tracker.dart`: remember one element per container and come
//   back to it.
// - `dpad_select_long_press_controller.dart`: OK fires on *key up*; held past
//   the threshold it fires the long press instead and the release fires nothing.
// - `key_repeat_helper.dart`: 400 ms before a held arrow repeats, then 100 ms.
// - `input_mode_tracker.dart`: keys vs. pointer, so focus rings only show for a
//   viewer who is actually on a remote or keyboard.
//
// Deliberately left behind (and why) — see the report at the end of the port:
// Rails/Regions (Flutter focus scopes that own a traversal subtree), the ring
// painting in `focus_chrome.dart`/`focus_theme.dart` (CSS owns chrome here),
// `dpad_reveal.dart`'s multi-list scroll choreography (browsers have
// `scrollIntoView`), and the players in `dpad_seek.dart`/`dpad_picture.dart`
// (they bind keys to a feature, not to focus movement).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';

/** The four directions a D-pad moves focus in. */
export type DpadDirection = 'up' | 'down' | 'left' | 'right';

/** What an input is currently driven by: focus chrome is only shown for `keyboard`. */
export type DpadInputMode = 'keyboard' | 'pointer';

/** Everything the navigator can do with a key, as reported by {@link mapRemoteKey}. */
export type DpadAction = DpadDirection | 'select' | 'back';

export interface DpadOptions {
  /** Only elements inside this container are navigable. */
  containerRef: RefObject<HTMLElement | null>;
  /** Set false to disable, e.g. when a modal owns focus. */
  enabled?: boolean;
  /** Called when the user presses OK/Enter on a focused element. */
  onSelect?: (element: HTMLElement) => void;
  /** Long-press OK, e.g. for a context menu. */
  onLongSelect?: (element: HTMLElement) => void;
  /** How a move is animated. */
  onFocusChange?: (element: HTMLElement | null) => void;
}

export interface DpadHandle {
  focusFirst(): void;
  focusElement(element: HTMLElement): void;
  /** Restore the last focused element from before a modal opened. */
  restoreFocus(): void;
  /**
   * The input currently driving the app. The plan's focus rings should be
   * rendered only while this is `'keyboard'`, so a mouse or a finger never
   * leaves a ring behind on the thing it just clicked.
   */
  readonly inputMode: DpadInputMode;
}

/* ─────────────────────────── Timings (ported) ─────────────────────────── */

/**
 * How long OK must be held to become a long press. `dpad_select_long_press_controller.dart`
 * defaults to 500 ms and lets the caller pass more; 600 ms is the value PRAHA spec'd for its
 * context menus — long enough that a deliberate short OK never opens one.
 */
const LONG_PRESS_MS = 600;

/** `key_repeat_helper.dart` `_initialDelay`: how long an arrow is held before it repeats. */
const REPEAT_DELAY_MS = 400;

/** `key_repeat_helper.dart` `_repeatInterval`: the steady pace once it does. */
const REPEAT_INTERVAL_MS = 100;

/** Where a container's remembered element lives. Versioned so a shape change can't crash old data. */
const MEMORY_KEY = 'praha.dpad.memory.v1';

/**
 * What the arrows can land on. `[data-dpad-focusable]` is the escape hatch for a
 * `<div role="button">`-like control that wants in without one of the native tags.
 * Disabled `input`/`select` are excluded for the same reason buttons already are:
 * the browser will not focus them, so they can only ever be a dead-end candidate.
 */
const NAVIGABLE_SELECTOR = [
  '[data-dpad-focusable]',
  'a[href]',
  'button:not([disabled])',
  '[role="button"]',
  'input:not([disabled])',
  'select:not([disabled])',
].join(', ');

/** Input types a caret can live in — the only ones that keep Left/Right for themselves. */
const TEXT_INPUT_TYPES = new Set([
  'text',
  'search',
  'email',
  'url',
  'tel',
  'password',
  'number',
  'date',
  'datetime-local',
  'month',
  'time',
  'week',
]);

/* ────────────────────── Geometry (ported from Dart) ────────────────────── */

/** The four edges a move is decided from; a structural subset of `DOMRect`. */
type Box = { left: number; top: number; right: number; bottom: number };

function isHorizontal(direction: DpadDirection): boolean {
  return direction === 'left' || direction === 'right';
}

/** `_isCandidate`: whether `to` lies in `direction` of `from` at all. */
function isCandidate(from: Box, to: Box, direction: DpadDirection): boolean {
  switch (direction) {
    case 'left':
      return (from.right > to.right || from.left >= to.right) && from.left > to.left;
    case 'right':
      return (from.left < to.left || from.right <= to.left) && from.right < to.right;
    case 'up':
      return (from.bottom > to.bottom || from.top >= to.bottom) && from.top > to.top;
    case 'down':
      return (from.top < to.top || from.bottom <= to.top) && from.bottom < to.bottom;
  }
}

/** `_beamsOverlap`: whether `to` sits in the band `from` would sweep moving in `direction`. */
function beamsOverlap(from: Box, to: Box, direction: DpadDirection): boolean {
  return isHorizontal(direction)
    ? to.bottom > from.top && to.top < from.bottom
    : to.right > from.left && to.left < from.right;
}

/** `_isBeyond`: `to` is entirely past `from`, with no overlap at all. */
function isBeyond(from: Box, to: Box, direction: DpadDirection): boolean {
  switch (direction) {
    case 'left':
      return from.left >= to.right;
    case 'right':
      return from.right <= to.left;
    case 'up':
      return from.top >= to.bottom;
    case 'down':
      return from.bottom <= to.top;
  }
}

/** `_major`: the gap between `from`'s leading edge and `to`'s facing edge (0 when overlapping). */
function major(from: Box, to: Box, direction: DpadDirection): number {
  switch (direction) {
    case 'left':
      return Math.max(0, from.left - to.right);
    case 'right':
      return Math.max(0, to.left - from.right);
    case 'up':
      return Math.max(0, from.top - to.bottom);
    case 'down':
      return Math.max(0, to.top - from.bottom);
  }
}

/**
 * `_majorToFarEdge`: the distance to `to`'s far edge, floored at 1 so it can never
 * be chosen as "nearer" than something genuinely inside the beam.
 */
function majorToFarEdge(from: Box, to: Box, direction: DpadDirection): number {
  switch (direction) {
    case 'left':
      return Math.max(1, from.left - to.left);
    case 'right':
      return Math.max(1, to.right - from.right);
    case 'up':
      return Math.max(1, from.top - to.top);
    case 'down':
      return Math.max(1, to.bottom - from.bottom);
  }
}

/** `_minor`: how far off the beam `to`'s centre sits. */
function minor(from: Box, to: Box, direction: DpadDirection): number {
  const fromX = (from.left + from.right) / 2;
  const fromY = (from.top + from.bottom) / 2;
  const toX = (to.left + to.right) / 2;
  const toY = (to.top + to.bottom) / 2;
  return isHorizontal(direction) ? Math.abs(fromY - toY) : Math.abs(fromX - toX);
}

/**
 * `_beamBeats`: whether being in the beam settles it before any distance is
 * weighed. This is what stops a move landing on something diagonal when there is
 * a perfectly aligned neighbour, and it is the rule that keeps a column of cards
 * a column: Down from a card goes to the card below, not the nearer corner of the
 * card beside it.
 */
function beamBeats(from: Box, a: Box, b: Box, direction: DpadDirection): boolean {
  const aIn = beamsOverlap(from, a, direction);
  const bIn = beamsOverlap(from, b, direction);
  if (bIn || !aIn) return false;
  if (!isBeyond(from, b, direction)) return true;
  if (isHorizontal(direction)) return true;
  return major(from, a, direction) < majorToFarEdge(from, b, direction);
}

/** `_isBetter`: whether `a` is a better place to go than `b`. */
function isBetter(from: Box, a: Box, b: Box, direction: DpadDirection): boolean {
  if (beamBeats(from, a, b, direction)) return true;
  if (beamBeats(from, b, a, direction)) return false;
  // 13:1 — the ported weighting: distance along the axis of travel costs far
  // more than drifting across it, which is what makes rows feel like rows.
  const weighed = (box: Box): number => {
    const along = major(from, box, direction);
    const across = minor(from, box, direction);
    return 13 * along * along + across * across;
  };
  return weighed(a) < weighed(b);
}

/** `_best`: the cheapest candidate in `direction`, optionally only those in the beam. */
function pickBest(
  from: Box,
  stops: readonly HTMLElement[],
  direction: DpadDirection,
  beamOnly: boolean,
): HTMLElement | null {
  let best: HTMLElement | null = null;
  let bestBox: Box | null = null;
  for (const element of stops) {
    const box = element.getBoundingClientRect();
    if (!isCandidate(from, box, direction)) continue;
    if (beamOnly && !beamsOverlap(from, box, direction)) continue;
    if (!bestBox || isBetter(from, box, bestBox, direction)) {
      best = element;
      bestBox = box;
    }
  }
  return best;
}

/**
 * `_topLeft`: the stop a container starts on — top-most, then left-most, with
 * half-a-line of slack so buttons in one row that are a pixel apart still count
 * as the same line.
 */
function topLeftStop(stops: readonly HTMLElement[]): HTMLElement | null {
  let best: HTMLElement | null = null;
  let bestBox: Box | null = null;
  for (const element of stops) {
    const box = element.getBoundingClientRect();
    if (!bestBox) {
      best = element;
      bestBox = box;
      continue;
    }
    const sameLine =
      Math.abs(box.top - bestBox.top) <
      Math.min(box.bottom - box.top, bestBox.bottom - bestBox.top) / 2;
    if (sameLine ? box.left < bestBox.left : box.top < bestBox.top) {
      best = element;
      bestBox = box;
    }
  }
  return best;
}

/* ───────────────────────────── DOM helpers ───────────────────────────── */

/** `data-dpad-skip` marks an element — or a whole subtree — the arrows must step over. */
function isSkipped(element: HTMLElement): boolean {
  return element.closest('[data-dpad-skip]') !== null;
}

/**
 * Whether `element` is on screen. A `display:none` ancestor gives a zero-sized
 * rect in every real engine, so the size check covers it; `visibility:hidden`
 * keeps its size but inherits, so the element's own computed value already says
 * `hidden` when an ancestor set it. That is why this is cheap enough to run on
 * every candidate of every press.
 */
function isVisible(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  if (element.closest('[hidden]') !== null) return false;
  const view = element.ownerDocument.defaultView;
  if (!view) return true; // detached: nothing to be hidden behind
  const style = view.getComputedStyle(element);
  return style.display !== 'none' && style.visibility !== 'hidden';
}

/** Whether `element` is something the arrows may land on. */
function isNavigable(element: HTMLElement): boolean {
  return (
    element.matches(NAVIGABLE_SELECTOR) && !isSkipped(element) && isVisible(element)
  );
}

/** Every navigable element inside `container`, in document order. */
function collectStops(container: HTMLElement): HTMLElement[] {
  const found = Array.from(container.querySelectorAll<HTMLElement>(NAVIGABLE_SELECTOR));
  return found.filter((element) => !isSkipped(element) && isVisible(element));
}

/**
 * Puts focus on `element` and brings it into view.
 *
 * `preventScroll` first, then `scrollIntoView({ block: 'nearest' })`: the browser's
 * own focus scroll centres the element and fights a page that is already showing
 * it, which on a TV makes the whole page drift on every press.
 */
function applyFocus(element: HTMLElement): void {
  // A `data-dpad-focusable` <div> has no tabindex of its own, so `focus()` would
  // silently do nothing. -1 keeps it out of the browser's Tab order while still
  // letting it be a focus target.
  if (element.tabIndex < 0 && !element.hasAttribute('tabindex')) {
    element.setAttribute('tabindex', '-1');
  }
  element.focus({ preventScroll: true });
  const scrollIntoView = element.scrollIntoView;
  if (typeof scrollIntoView === 'function') {
    try {
      scrollIntoView.call(element, { block: 'nearest', inline: 'nearest', behavior: 'smooth' });
    } catch {
      // jsdom and a few old WebViews do not implement it; a missing scroll is never fatal.
    }
  }
}

/** The text field `element` is, when Left/Right belong to its caret rather than to navigation. */
function textEntryOf(element: Element | null): HTMLInputElement | HTMLTextAreaElement | null {
  if (!(element instanceof HTMLElement)) return null;
  if (element instanceof HTMLTextAreaElement) return element;
  if (element instanceof HTMLInputElement) {
    return TEXT_INPUT_TYPES.has(element.type) ? element : null;
  }
  return null;
}

/**
 * `DpadRoot._leaveTextBox`: a field keeps Left/Right while its caret can still
 * move that way, and gives them up at the ends. Up/Down always leave a single-line
 * box, so a form can be navigated out of with the D-pad.
 */
function arrowBelongsToCaret(
  field: HTMLInputElement | HTMLTextAreaElement,
  direction: DpadDirection,
): boolean {
  if (direction === 'up' || direction === 'down') return false;
  const start = field.selectionStart;
  const end = field.selectionEnd;
  if (start === null || end === null) return false;
  if (start !== end) return true; // a selected range: the field owns the arrow
  if (direction === 'left') return start > 0;
  return end < field.value.length;
}

/* ─────────────────────────── Focus memory ─────────────────────────── */

/**
 * The stable name of a container across remounts. The element itself is thrown
 * away when a screen closes, so the key has to come from an attribute the app
 * writes (`data-dpad-container`) or its id — never from the node.
 */
function containerKey(container: HTMLElement): string {
  return (
    container.getAttribute('data-dpad-container') || container.id || 'root'
  );
}

function readMemory(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(MEMORY_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const memory: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string') memory[key] = value;
    }
    return memory;
  } catch {
    return {};
  }
}

/**
 * Remembers `element` for its container, but only when the app gave it a
 * `data-dpad-id`: without a stable name there is nothing to come back to, and
 * storing a DOM path would break the moment a row reorders.
 */
function remember(container: HTMLElement, element: HTMLElement): void {
  const id = element.getAttribute('data-dpad-id');
  if (!id || typeof window === 'undefined') return;
  const key = containerKey(container);
  const memory = readMemory();
  if (memory[key] === id) return;
  memory[key] = id;
  try {
    window.localStorage.setItem(MEMORY_KEY, JSON.stringify(memory));
  } catch {
    // Private mode or a full quota: memory is a convenience, never a requirement.
  }
}

/** The element this container was last left on, if it is still there. */
function resolveRemembered(container: HTMLElement): HTMLElement | null {
  const id = readMemory()[containerKey(container)];
  if (!id) return null;
  return collectStops(container).find((element) => element.getAttribute('data-dpad-id') === id) ?? null;
}

/* ─────────────────────────── Key mapping ─────────────────────────── */

/**
 * True when a key event is a D-pad/transport key we handle.
 *
 * Use it to decide whether a press should switch the app into keyboard mode (and
 * therefore show focus rings) without duplicating the key list at every call site.
 */
export function isDpadKey(event: KeyboardEvent): boolean {
  return mapRemoteKey(event) !== null;
}

/**
 * Maps a key event to a direction or action, or `null` when it is not ours.
 *
 * `event.key` is checked first because it is what every current browser reports.
 * The `keyCode` table underneath is the TV part: Tizen and webOS remotes (and the
 * Android WebView PRAHA runs in on a TV stick) report the legacy codes — 37-40 for
 * the arrow cluster, 13 for OK, 461 for Back on webOS and 10009 on Tizen — and
 * some of them leave `key` as `'Unidentified'`.
 *
 * Deliberately unmapped: Backspace (the browser's own Back gesture, but a text
 * field needs it for deleting) and keyCode 41, which no platform assigns.
 */
export function mapRemoteKey(event: KeyboardEvent): DpadAction | null {
  switch (event.key) {
    case 'ArrowUp':
      return 'up';
    case 'ArrowDown':
      return 'down';
    case 'ArrowLeft':
      return 'left';
    case 'ArrowRight':
      return 'right';
    case 'Enter':
    case 'Select':
      return 'select';
    case 'Escape':
    case 'GoBack':
    case 'BrowserBack':
      return 'back';
    default:
      break;
  }

  switch (event.keyCode) {
    case 37:
      return 'left';
    case 38:
      return 'up';
    case 39:
      return 'right';
    case 40:
      return 'down';
    case 13:
      return 'select';
    case 461: // webOS BACK
    case 10009: // Tizen RETURN
      return 'back';
    default:
      return null;
  }
}

/* ─────────────────────────────── The hook ─────────────────────────────── */

/**
 * Makes the subtree inside `containerRef` navigable with arrow keys / a TV remote.
 *
 * Focus is moved for you; what a press *means* is yours: `onSelect` for OK,
 * `onLongSelect` for a held OK. Back is never consumed — it is left to the app,
 * because on Android TV and in a browser the Back key already has a meaning
 * (history, route) that a focus helper must not steal.
 */
export function useDpadNavigation(options: DpadOptions): DpadHandle {
  const { containerRef, enabled = true } = options;
  const [inputMode, setInputMode] = useState<DpadInputMode>('pointer');

  // Callbacks live in a ref so the listener effect can be mounted once for the
  // life of the screen instead of tearing down and re-adding every render — a
  // re-subscribe per render is how listeners get lost mid-press.
  const latest = useRef({
    onSelect: options.onSelect,
    onLongSelect: options.onLongSelect,
    onFocusChange: options.onFocusChange,
  });
  useEffect(() => {
    latest.current = {
      onSelect: options.onSelect,
      onLongSelect: options.onLongSelect,
      onFocusChange: options.onFocusChange,
    };
  });

  const modeRef = useRef<DpadInputMode>('pointer');
  const lastFocused = useRef<HTMLElement | null>(null);
  const selectDownOn = useRef<HTMLElement | null>(null);
  const selectArmed = useRef(false);
  const longPressFired = useRef(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const repeatDelay = useRef<ReturnType<typeof setTimeout> | null>(null);
  const repeatTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  /** Only touches React state on an actual transition, so a mouse move costs one comparison. */
  const applyMode = useCallback((mode: DpadInputMode) => {
    if (modeRef.current === mode) return;
    modeRef.current = mode;
    setInputMode(mode);
  }, []);

  const focusElement = useCallback((element: HTMLElement) => {
    applyFocus(element);
  }, []);

  const focusFirst = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const first = topLeftStop(collectStops(container));
    if (first) applyFocus(first);
  }, [containerRef]);

  const restoreFocus = useCallback(() => {
    if (typeof window === 'undefined') return;
    const container = containerRef.current;
    if (!container) return;
    // The same node, when the screen never went away (a modal closed): cheapest and exact.
    const last = lastFocused.current;
    if (last && last.isConnected && container.contains(last)) {
      applyFocus(last);
      return;
    }
    // Otherwise the node is gone (an unmount + remount): fall back to the name
    // the container remembers, then to where the page starts.
    const remembered = resolveRemembered(container);
    if (remembered) {
      applyFocus(remembered);
      return;
    }
    focusFirst();
  }, [containerRef, focusFirst]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!enabled) return;

    const doc = window.document;

    const clearLongPress = (): void => {
      if (longPressTimer.current !== null) {
        clearTimeout(longPressTimer.current);
        longPressTimer.current = null;
      }
    };

    const clearRepeat = (): void => {
      if (repeatDelay.current !== null) {
        clearTimeout(repeatDelay.current);
        repeatDelay.current = null;
      }
      if (repeatTimer.current !== null) {
        clearInterval(repeatTimer.current);
        repeatTimer.current = null;
      }
    };

    const containerNow = (): HTMLElement | null => containerRef.current;

    const activeInContainer = (): HTMLElement | null => {
      const container = containerNow();
      const active = doc.activeElement;
      return container && active instanceof HTMLElement && container.contains(active)
        ? active
        : null;
    };

    /** One step of `Dpad.move`. */
    const step = (direction: DpadDirection): void => {
      const container = containerNow();
      if (!container) return;
      const stops = collectStops(container);
      if (stops.length === 0) return;

      const active = activeInContainer();
      if (!active || !isNavigable(active)) {
        // Nothing focused inside (a page just opened, or a modal took focus away):
        // `Dpad.enter` — back to what this container remembers, else where it starts.
        const start = resolveRemembered(container) ?? topLeftStop(stops);
        if (start) applyFocus(start);
        return;
      }

      const from = active.getBoundingClientRect();

      // `stepIn`: Right from a control that holds controls steps into the first of
      // them (a card's buttons) rather than past the card. Without this, a card and
      // its own buttons fight over the same press.
      if (direction === 'right') {
        const inside = stops.filter(
          (element) => element !== active && active.contains(element),
        );
        if (inside.length > 0) {
          // Left-most, as the Dart sorts by `rect.left`.
          const first = inside.reduce((a, b) =>
            a.getBoundingClientRect().left <= b.getBoundingClientRect().left ? a : b,
          );
          applyFocus(first);
          return;
        }
      }

      // `_isAncestor` on both sides: never move onto the wrapping control (a no-op
      // move) and never away from a wrapper to one of its own children by geometry;
      // the stepIn above is the only way in, so the two cannot oscillate.
      const candidates = stops.filter(
        (element) =>
          element !== active && !element.contains(active) && !active.contains(element),
      );

      // Sideways needs a genuine beam: a row runs across the screen, so an element
      // that only shares the y-axis by a corner is not "to the right". Up/down does
      // not, because a page is meant to flow between rows of different widths.
      const target = pickBest(from, candidates, direction, isHorizontal(direction));
      if (target) applyFocus(target);
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      // A browser shortcut (Ctrl/Cmd/Alt + arrow: word-jump, history) is not a move.
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const action = mapRemoteKey(event);
      if (action === null) return;
      const container = containerNow();
      if (!container) return;

      // Activation and dismissal act on what already has focus, so they do not
      // prove the viewer wants to navigate (Dart's `eventRequestsFocusNavigation`):
      // only directions and Back promote to keyboard mode and arm the focus rings.
      if (action !== 'select') applyMode('keyboard');

      if (action === 'back') {
        // Never consumed here, and no `preventDefault`: Back belongs to the app's
        // router/history. On the release we only pick focus up if it fell out of
        // the container in the meantime (a modal closed under it).
        return;
      }

      if (action === 'select') {
        const hasHandler = Boolean(latest.current.onSelect || latest.current.onLongSelect);
        if (!hasHandler) return; // do not hijack Enter on a screen with no select handling
        const focused = activeInContainer();
        if (!focused) return;
        event.preventDefault();
        // A remote may repeat OK. Only the up-to-down transition may arm anything
        // (`dpad_select_long_press_controller.dart`).
        if (event.repeat) return;
        clearLongPress();
        selectDownOn.current = focused;
        selectArmed.current = true;
        longPressFired.current = false;
        if (latest.current.onLongSelect) {
          longPressTimer.current = setTimeout(() => {
            longPressTimer.current = null;
            if (longPressFired.current) return;
            const target = selectDownOn.current;
            if (!target || !target.isConnected) return;
            // Fires once; the release is then swallowed, so a held OK is one action.
            longPressFired.current = true;
            latest.current.onLongSelect?.(target);
          }, LONG_PRESS_MS);
        }
        return;
      }

      const direction: DpadDirection = action;

      // A field's caret keeps Left/Right while it can still move; Up/Down always
      // leave a single-line box, so a form is never a trap.
      const field = textEntryOf(doc.activeElement);
      if (field && container.contains(field) && arrowBelongsToCaret(field, direction)) return;

      // D-pad mode owns the arrows: without this the WebView scrolls underneath
      // the focused item whenever there is nowhere to go, which reads as a lost press.
      event.preventDefault();
      // Remotes send no auto-repeat, and a keyboard's own repeat is faster and less
      // even than the Dart pacing — so ours is the only repeat that runs.
      if (event.repeat) return;

      clearRepeat();
      step(direction);
      repeatDelay.current = setTimeout(() => {
        repeatDelay.current = null;
        repeatTimer.current = setInterval(() => step(direction), REPEAT_INTERVAL_MS);
      }, REPEAT_DELAY_MS);
    };

    const onKeyUp = (event: KeyboardEvent): void => {
      const action = mapRemoteKey(event);
      if (action === null) return;

      if (action === 'select') {
        if (!selectArmed.current) return;
        selectArmed.current = false;
        const firedLong = longPressFired.current;
        const target = selectDownOn.current;
        selectDownOn.current = null;
        longPressFired.current = false;
        const timerWasActive = longPressTimer.current !== null;
        clearLongPress();
        // A held OK already acted; its release must not act a second time.
        if (firedLong) return;
        if (!timerWasActive) return;
        if (target && target.isConnected) latest.current.onSelect?.(target);
        return;
      }

      if (action === 'back') {
        // The app got its Back (we did not consume it). If that closed whatever had
        // focus, put the viewer back where they were instead of on <body>.
        if (!activeInContainer()) restoreFocus();
        return;
      }

      // Arrows: the key that started the repeat stops it. A different arrow's
      // release does not, so rolling from Right to Down keeps Down moving.
      clearRepeat();
    };

    const onFocusIn = (event: FocusEvent): void => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      const container = containerNow();
      if (!container || !container.contains(target)) return;
      if (!isNavigable(target)) return;
      lastFocused.current = target;
      remember(container, target);
      latest.current.onFocusChange?.(target);
    };

    const onFocusOut = (event: FocusEvent): void => {
      const next = event.relatedTarget;
      const container = containerNow();
      if (container && next instanceof Node && container.contains(next)) return;
      // Focus left the subtree entirely: the UI can drop its ring now.
      latest.current.onFocusChange?.(null);
    };

    const onPointerDown = (): void => {
      applyMode('pointer');
      // A pointer landing mid-hold ends the hold: its release will never arrive.
      clearRepeat();
      clearLongPress();
      selectArmed.current = false;
      selectDownOn.current = null;
      longPressFired.current = false;
    };

    const onPointerMove = (): void => {
      applyMode('pointer');
    };

    const onBlur = (): void => {
      // The window lost the keyboard (an app switch, a native dialog): no stray repeats.
      clearRepeat();
      clearLongPress();
      selectArmed.current = false;
      selectDownOn.current = null;
      longPressFired.current = false;
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('blur', onBlur);
    doc.addEventListener('focusin', onFocusIn);
    doc.addEventListener('focusout', onFocusOut);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('blur', onBlur);
      doc.removeEventListener('focusin', onFocusIn);
      doc.removeEventListener('focusout', onFocusOut);
      clearRepeat();
      clearLongPress();
    };
  }, [containerRef, enabled, applyMode, restoreFocus]);

  // Rebuilt only when the mode changes: the handle is given to memoised children,
  // and a fresh object every render would defeat that.
  return useMemo(
    () => ({ focusFirst, focusElement, restoreFocus, inputMode }),
    [focusFirst, focusElement, restoreFocus, inputMode],
  );
}
