/** Keyboard map for the mpvRx-style player, shown in the in-player help panel. */
export interface Shortcut {
  keys: string[];
  action: string;
  group: 'Playback' | 'Navigation' | 'Audio & subtitles' | 'Window';
}

export const SHORTCUTS: Shortcut[] = [
  { keys: ['Space', 'K'], action: 'Play / pause', group: 'Playback' },
  { keys: ['←', '→'], action: 'Seek backward / forward', group: 'Navigation' },
  { keys: ['Shift', '←', '→'], action: 'Seek by one minute', group: 'Navigation' },
  { keys: [',', '.'], action: 'Step one frame back / forward', group: 'Playback' },
  { keys: ['[', ']'], action: 'Playback speed −0.1 / +0.1', group: 'Playback' },
  { keys: ['{', '}'], action: 'Playback speed ÷2 / ×2', group: 'Playback' },
  { keys: ['Backspace'], action: 'Reset speed to 1.0×', group: 'Playback' },
  { keys: ['↑', '↓'], action: 'Volume up / down', group: 'Playback' },
  { keys: ['M'], action: 'Mute / unmute', group: 'Audio & subtitles' },
  { keys: ['J', 'Shift+J'], action: 'Cycle subtitle track', group: 'Audio & subtitles' },
  { keys: ['#'], action: 'Cycle audio track', group: 'Audio & subtitles' },
  { keys: ['C'], action: 'Toggle subtitles on / off', group: 'Audio & subtitles' },
  { keys: ['Q', 'W'], action: 'Subtitle smaller / larger', group: 'Audio & subtitles' },
  { keys: ['F'], action: 'Toggle fullscreen', group: 'Window' },
  { keys: ['P'], action: 'Picture-in-picture', group: 'Window' },
  { keys: ['I'], action: 'Statistics overlay', group: 'Window' },
  { keys: ['L'], action: 'Set / clear A-B loop', group: 'Playback' },
  { keys: ['S'], action: 'Save a frame as PNG', group: 'Window' },
  { keys: ['0', '–', '9'], action: 'Jump to that percent of the runtime', group: 'Navigation' },
  { keys: ['?', 'H'], action: 'This help panel', group: 'Window' },
  { keys: ['Esc'], action: 'Leave fullscreen / close', group: 'Window' },
];

export const SHORTCUT_GROUPS = ['Playback', 'Navigation', 'Audio & subtitles', 'Window'] as const;
