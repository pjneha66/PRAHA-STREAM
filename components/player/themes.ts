import type { PlayerThemeId } from '../../types';

/**
 * On-screen controller themes inspired by mpvRx's built-in palettes. Each theme
 * is a set of CSS custom properties applied to the player root, so the whole
 * controller (bar, menus, OSD, stats) recolors together.
 */
export interface PlayerTheme {
  id: PlayerThemeId;
  name: string;
  vars: Record<string, string>;
}

export const PLAYER_THEMES: PlayerTheme[] = [
  {
    id: 'mpvrx',
    name: 'mpvRx Purple',
    vars: {
      '--osc-bg': 'rgba(16,12,26,.86)',
      '--osc-solid': '#1b1428',
      '--osc-fg': '#f2eefc',
      '--osc-muted': '#a497c4',
      '--osc-accent': '#b18cff',
      '--osc-accent-fg': '#150f22',
      '--osc-track': 'rgba(255,255,255,.2)',
      '--osc-buffered': 'rgba(255,255,255,.3)',
      '--osc-border': 'rgba(177,140,255,.22)',
    },
  },
  {
    id: 'amoled',
    name: 'AMOLED Black',
    vars: {
      '--osc-bg': 'rgba(0,0,0,.92)',
      '--osc-solid': '#000000',
      '--osc-fg': '#ffffff',
      '--osc-muted': '#8d8d8d',
      '--osc-accent': '#ffffff',
      '--osc-accent-fg': '#000000',
      '--osc-track': 'rgba(255,255,255,.22)',
      '--osc-buffered': 'rgba(255,255,255,.32)',
      '--osc-border': 'rgba(255,255,255,.16)',
    },
  },
  {
    id: 'catppuccin',
    name: 'Catppuccin Mocha',
    vars: {
      '--osc-bg': 'rgba(24,24,37,.9)',
      '--osc-solid': '#1e1e2e',
      '--osc-fg': '#cdd6f4',
      '--osc-muted': '#9399b2',
      '--osc-accent': '#89b4fa',
      '--osc-accent-fg': '#11111b',
      '--osc-track': 'rgba(205,214,244,.18)',
      '--osc-buffered': 'rgba(205,214,244,.3)',
      '--osc-border': 'rgba(137,180,250,.24)',
    },
  },
  {
    id: 'nord',
    name: 'Nord',
    vars: {
      '--osc-bg': 'rgba(37,49,66,.9)',
      '--osc-solid': '#2e3440',
      '--osc-fg': '#eceff4',
      '--osc-muted': '#9aa5b5',
      '--osc-accent': '#88c0d0',
      '--osc-accent-fg': '#22303c',
      '--osc-track': 'rgba(236,239,244,.18)',
      '--osc-buffered': 'rgba(236,239,244,.3)',
      '--osc-border': 'rgba(136,192,208,.24)',
    },
  },
  {
    id: 'tokyo',
    name: 'Tokyo Night',
    vars: {
      '--osc-bg': 'rgba(22,24,40,.9)',
      '--osc-solid': '#1a1b26',
      '--osc-fg': '#c0caf5',
      '--osc-muted': '#8b93bd',
      '--osc-accent': '#7aa2f7',
      '--osc-accent-fg': '#11121c',
      '--osc-track': 'rgba(192,202,245,.18)',
      '--osc-buffered': 'rgba(192,202,245,.3)',
      '--osc-border': 'rgba(122,162,247,.24)',
    },
  },
  {
    id: 'dracula',
    name: 'Dracula',
    vars: {
      '--osc-bg': 'rgba(34,36,54,.9)',
      '--osc-solid': '#282a36',
      '--osc-fg': '#f8f8f2',
      '--osc-muted': '#a4a8c0',
      '--osc-accent': '#ff79c6',
      '--osc-accent-fg': '#1c1d26',
      '--osc-track': 'rgba(248,248,242,.18)',
      '--osc-buffered': 'rgba(248,248,242,.3)',
      '--osc-border': 'rgba(255,121,198,.24)',
    },
  },
  {
    id: 'gruvbox',
    name: 'Gruvbox',
    vars: {
      '--osc-bg': 'rgba(40,36,32,.92)',
      '--osc-solid': '#282828',
      '--osc-fg': '#ebdbb2',
      '--osc-muted': '#a89984',
      '--osc-accent': '#fabd2f',
      '--osc-accent-fg': '#282828',
      '--osc-track': 'rgba(235,219,178,.18)',
      '--osc-buffered': 'rgba(235,219,178,.3)',
      '--osc-border': 'rgba(250,189,47,.24)',
    },
  },
  {
    id: 'rosepine',
    name: 'Rosé Pine',
    vars: {
      '--osc-bg': 'rgba(35,33,49,.9)',
      '--osc-solid': '#232136',
      '--osc-fg': '#e0def4',
      '--osc-muted': '#9b96b8',
      '--osc-accent': '#c4a7e7',
      '--osc-accent-fg': '#1f1d2e',
      '--osc-track': 'rgba(224,222,244,.18)',
      '--osc-buffered': 'rgba(224,222,244,.3)',
      '--osc-border': 'rgba(196,167,231,.24)',
    },
  },
];

export function getTheme(id: PlayerThemeId): PlayerTheme {
  return PLAYER_THEMES.find((theme) => theme.id === id) || PLAYER_THEMES[0];
}

export const PLAYBACK_SPEEDS = [0.25, 0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];
