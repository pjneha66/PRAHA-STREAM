// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { usePersistentState } from '../hooks/usePersistentState';

/**
 * The stored settings blob is untrusted input: it comes from localStorage, a
 * backup file, or a sync response, any of which a user or another page can
 * write. `revive` merges it over the defaults, and a `__proto__` key in that
 * merge used to rewrite the merged object's prototype instead of adding a field.
 */

function Probe({ storageKey, initial }: { storageKey: string; initial: Record<string, unknown> }) {
  const [value] = usePersistentState<Record<string, unknown>>(storageKey, initial);
  return <pre data-testid="value">{JSON.stringify(value)}</pre>;
}

const KEY = 'praha.test.proto';

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  cleanup();
});

describe('usePersistentState revive', () => {
  it('merges stored fields over the defaults so new defaults still appear', () => {
    window.localStorage.setItem(KEY, JSON.stringify({ b: 2 }));
    render(<Probe storageKey={KEY} initial={{ a: 1, b: 0 }} />);
    expect(JSON.parse(screen.getByTestId('value').textContent || '{}')).toEqual({ a: 1, b: 2 });
  });

  it('drops __proto__ from a stored payload instead of rewriting the prototype', () => {
    window.localStorage.setItem(KEY, '{"__proto__":{"polluted":true},"b":2}');
    render(<Probe storageKey={KEY} initial={{ a: 1, b: 0 }} />);

    const value = JSON.parse(screen.getByTestId('value').textContent || '{}');
    expect(value.b).toBe(2);
    expect(value.polluted).toBeUndefined();
    // The object the app hands on must still be an ordinary plain object.
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
  });

  it('ignores constructor and prototype keys too', () => {
    window.localStorage.setItem(KEY, JSON.stringify({ constructor: { bad: 1 }, prototype: { bad: 1 } }));
    render(<Probe storageKey={KEY} initial={{ a: 1 }} />);
    const value = JSON.parse(screen.getByTestId('value').textContent || '{}');
    expect(value.a).toBe(1);
    // Own properties, not the inherited `constructor` function: the payload's
    // keys must not have replaced anything on the object itself.
    expect(Object.prototype.hasOwnProperty.call(value, 'constructor')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(value, 'prototype')).toBe(false);
  });

  it('still merges nested blocks', () => {
    window.localStorage.setItem(KEY, JSON.stringify({ player: { seekStep: 30 } }));
    render(<Probe storageKey={KEY} initial={{ player: { seekStep: 10, volume: 100 } }} />);
    expect(JSON.parse(screen.getByTestId('value').textContent || '{}'))
      .toEqual({ player: { seekStep: 30, volume: 100 } });
  });

  it('reads a different key when the prop changes', () => {
    window.localStorage.setItem('praha.test.other', JSON.stringify({ from: 'other' }));
    const { rerender } = render(<Probe storageKey={KEY} initial={{ from: 'first' }} />);
    expect(JSON.parse(screen.getByTestId('value').textContent || '{}')).toEqual({ from: 'first' });

    act(() => {
      rerender(<Probe storageKey="praha.test.other" initial={{ from: 'first' }} />);
    });
    expect(JSON.parse(screen.getByTestId('value').textContent || '{}')).toEqual({ from: 'other' });
  });

  it('falls back to the caller current default when the key changes and nothing is stored', () => {
    // The first key's default must not leak into the new key.
    window.localStorage.setItem(KEY, JSON.stringify({ theme: 'old-key-theme' }));
    const { rerender } = render(<Probe storageKey={KEY} initial={{ from: 'first' }} />);
    act(() => {
      rerender(<Probe storageKey="praha.test.empty" initial={{ from: 'new-default' }} />);
    });
    expect(JSON.parse(screen.getByTestId('value').textContent || '{}')).toEqual({ from: 'new-default' });
  });

  it('survives corrupt JSON without throwing', () => {
    window.localStorage.setItem(KEY, '{not json');
    render(<Probe storageKey={KEY} initial={{ a: 1 }} />);
    expect(JSON.parse(screen.getByTestId('value').textContent || '{}')).toEqual({ a: 1 });
  });
});
