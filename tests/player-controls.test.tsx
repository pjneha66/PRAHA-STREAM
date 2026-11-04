// @vitest-environment jsdom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { DEFAULT_PLAYER_SETTINGS } from '../data/defaults';
import MpvPlayer from '../components/player/MpvPlayer';

const state = vi.hoisted(() => ({ toggle: vi.fn(), seekBy: vi.fn(), selectAudio: vi.fn(), selectText: vi.fn() }));
vi.mock('../components/player/useMpvEngine', () => ({
  useMpvEngine: () => ({
    videoRef: { current: null }, ready: true, waiting: false, playing: true, currentTime: 1, duration: 120,
    buffered: 0, volume: 100, muted: false, rate: 1, levels: [], currentLevel: -1,
    audioTracks: [{ id: 'native:0', label: 'English' }, { id: 'native:1', label: 'Hindi' }], currentAudio: 'native:0',
    textTracks: [{ id: 'text:0', label: 'English subtitles' }], currentText: '', stats: null, loop: { a: null, b: null }, canCast: false,
    ...state,
  }),
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const stream = { id: 'test', title: 'Test', url: 'https://example.com/video', sourceName: 'Example', sourceType: 'stremio' as const };
describe('player controls', () => {
  it('opens audio and subtitle selectors and dispatches the chosen track', () => {
    render(<MpvPlayer stream={stream} effectiveUrl={stream.url} autoplay={false} settings={DEFAULT_PLAYER_SETTINGS} onSettingsChange={vi.fn()} onRequestClose={vi.fn()} />);
    const audio = screen.getByRole('button', { name: 'Audio tracks' });
    fireEvent.touchStart(audio, { touches: [{ clientX: 1, clientY: 1 }] });
    fireEvent.touchEnd(audio);
    fireEvent.click(audio);
    expect(state.toggle).not.toHaveBeenCalled();
    expect(state.seekBy).not.toHaveBeenCalled();
    const menu = screen.getByRole('dialog', { name: 'Audio track' });
    fireEvent.click(within(menu).getByRole('button', { name: 'Hindi' }));
    expect(state.selectAudio).toHaveBeenCalledWith('native:1');
    fireEvent.click(screen.getByRole('button', { name: 'Subtitles' }));
    const subtitles = screen.getByRole('dialog', { name: 'Subtitles' });
    fireEvent.click(within(subtitles).getByRole('button', { name: 'English subtitles' }));
    expect(state.selectText).toHaveBeenCalledWith('text:0');
  });
});
