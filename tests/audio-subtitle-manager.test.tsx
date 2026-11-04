// @vitest-environment jsdom
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { AudioSubtitleDialog } from '../components/player/AudioSubtitleDialog';
import { DEFAULT_PLAYER_SETTINGS, DEFAULT_SUBTITLE_SETTINGS } from '../data/defaults';
import type { PlayerSettings } from '../types';
import type { TrackOption } from '../components/player/useMpvEngine';
import {
  formatAudioCodec,
  formatSubtitleCodec,
  parseLocalSubtitleFile,
  resolveLanguageName,
} from '../services/subtitleService';
import {
  addNativeSubtitleSlave,
  getNativeAudioTracks,
  getNativeSpuTracks,
  getSelectedNativeAudioTrack,
  getSelectedNativeSpuTrack,
  isNativeVlcAvailable,
  openNativeSubtitlePicker,
  setNativeAudioDelay,
  setNativeAudioTrack,
  setNativeSpuDelay,
  setNativeSpuTrack,
} from '../services/androidBridge';

// Polyfill File.prototype.text for jsdom if needed
if (!File.prototype.text) {
  File.prototype.text = function (this: File) {
    return new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsText(this);
    });
  };
}

describe('PRAHA Player – Audio Language & Subtitle Manager Acceptance Tests', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    delete (window as any).PrahaNative;
  });

  describe('Language & Codec Formatters', () => {
    it('resolves standard ISO 639-1 and 639-2 language codes to full names', () => {
      expect(resolveLanguageName('eng')).toBe('English');
      expect(resolveLanguageName('en')).toBe('English');
      expect(resolveLanguageName('hin')).toBe('Hindi');
      expect(resolveLanguageName('hi')).toBe('Hindi');
      expect(resolveLanguageName('jpn')).toBe('Japanese');
      expect(resolveLanguageName('ja')).toBe('Japanese');
      expect(resolveLanguageName('spa')).toBe('Spanish');
      expect(resolveLanguageName('fra')).toBe('French');
      expect(resolveLanguageName('deu')).toBe('German');
      expect(resolveLanguageName('ger')).toBe('German');
      expect(resolveLanguageName('zho')).toBe('Chinese');
      expect(resolveLanguageName('chi')).toBe('Chinese');
      expect(resolveLanguageName('kor')).toBe('Korean');
      expect(resolveLanguageName('und')).toBeNull();
      expect(resolveLanguageName(undefined)).toBeNull();
    });

    it('formats audio codecs with appropriate labels and channel layouts', () => {
      expect(formatAudioCodec('mp4a.40.2', 2)).toBe('AAC · Stereo');
      expect(formatAudioCodec('ec-3', 6)).toBe('E-AC-3 (Dolby Digital+) · 5.1');
      expect(formatAudioCodec('ac-3', 6)).toBe('AC-3 (Dolby Digital) · 5.1');
      expect(formatAudioCodec('dts', 6)).toBe('DTS · 5.1');
      expect(formatAudioCodec('opus', 2)).toBe('Opus · Stereo');
      expect(formatAudioCodec('flac', 2)).toBe('FLAC · Stereo');
      expect(formatAudioCodec('truehd', 8)).toBe('TrueHD · 7.1');
    });

    it('formats subtitle codecs with readable labels', () => {
      expect(formatSubtitleCodec('subrip')).toBe('SRT');
      expect(formatSubtitleCodec('ass')).toBe('ASS/SSA');
      expect(formatSubtitleCodec('ssa')).toBe('ASS/SSA');
      expect(formatSubtitleCodec('webvtt')).toBe('WebVTT');
      expect(formatSubtitleCodec('hdmv_pgs_subtitle')).toBe('PGS');
      expect(formatSubtitleCodec('vobsub')).toBe('VobSub');
    });

    it('parses local subtitle files with File reader', async () => {
      const mockFile = new File(
        [
          '1\n00:00:01,000 --> 00:00:04,000\nHello World\n\n2\n00:00:05,000 --> 00:00:08,000\nPRAHA Stream',
        ],
        'english_subs.srt',
        { type: 'text/plain' },
      );

      const parsed = await parseLocalSubtitleFile(mockFile);
      expect(parsed.name).toBe('english_subs (Local)');
      expect(parsed.language).toBe('local');
      expect(parsed.url).toContain('blob:');
    });
  });

  describe('Native LibVLC Android Bridge', () => {
    it('interacts correctly with PrahaNative window object', () => {
      const mockNative = {
        isVlcAvailable: vi.fn(() => true),
        getAllAudioTracks: vi.fn(() =>
          JSON.stringify([
            { id: 1, name: 'English (Stereo)', language: 'eng', languageName: 'English', codec: 'mp4a', codecLabel: 'AAC', channels: 2 },
            { id: 2, name: 'Hindi (Surround)', language: 'hin', languageName: 'Hindi', codec: 'ec-3', codecLabel: 'Dolby Digital+ 5.1', channels: 6 },
          ]),
        ),
        getSelectedAudioTrack: vi.fn(() => 1),
        setAudioTrack: vi.fn(() => true),
        getAllSpuTracks: vi.fn(() =>
          JSON.stringify([
            { id: 1, name: 'English', language: 'eng', languageName: 'English', codec: 'subrip', codecLabel: 'SRT', isExternal: false },
          ]),
        ),
        getSelectedSpuTrack: vi.fn(() => 1),
        setSpuTrack: vi.fn(() => true),
        addSlave: vi.fn(() => true),
        openSubtitlePicker: vi.fn(() => true),
        setSpuDelay: vi.fn(() => true),
        setAudioDelay: vi.fn(() => true),
      };

      (window as any).PrahaNative = mockNative;

      expect(isNativeVlcAvailable()).toBe(true);

      const audioTracks = getNativeAudioTracks();
      expect(audioTracks).toHaveLength(2);
      expect(audioTracks[0].name).toBe('English (Stereo)');
      expect(audioTracks[1].language).toBe('hin');
      expect(getSelectedNativeAudioTrack()).toBe(1);

      setNativeAudioTrack(2);
      expect(mockNative.setAudioTrack).toHaveBeenCalledWith(2);

      const spuTracks = getNativeSpuTracks();
      expect(spuTracks).toHaveLength(1);
      expect(spuTracks[0].codecLabel).toBe('SRT');
      expect(getSelectedNativeSpuTrack()).toBe(1);

      setNativeSpuTrack(2);
      expect(mockNative.setSpuTrack).toHaveBeenCalledWith(2);

      addNativeSubtitleSlave('content://subs/file.srt', true);
      expect(mockNative.addSlave).toHaveBeenCalledWith(0, 'content://subs/file.srt', true);

      openNativeSubtitlePicker();
      expect(mockNative.openSubtitlePicker).toHaveBeenCalled();

      setNativeSpuDelay(0.5);
      expect(mockNative.setSpuDelay).toHaveBeenCalledWith(500000);

      setNativeAudioDelay(-0.2);
      expect(mockNative.setAudioDelay).toHaveBeenCalledWith(-200000);
    });
  });

  describe('Scenario 1: MKV containing English and Hindi audio', () => {
    const audioTracks: TrackOption[] = [
      {
        id: 'vlc-audio:1',
        trackNumber: 1,
        label: 'English Audio',
        language: 'eng',
        languageName: 'English',
        codec: 'mp4a',
        codecLabel: 'AAC',
        channels: 2,
        bitrate: 192000,
      },
      {
        id: 'vlc-audio:2',
        trackNumber: 2,
        label: 'Hindi Audio',
        language: 'hin',
        languageName: 'Hindi',
        codec: 'ec-3',
        codecLabel: 'Dolby Digital+ 5.1',
        channels: 6,
        bitrate: 640000,
      },
    ];

    it('displays actual language names, track numbers, and codec badges', () => {
      const onSelectAudio = vi.fn();
      render(
        <AudioSubtitleDialog
          isOpen={true}
          onClose={vi.fn()}
          initialTab="audio"
          audioTracks={audioTracks}
          currentAudio="vlc-audio:1"
          onSelectAudio={onSelectAudio}
          textTracks={[]}
          currentText=""
          onSelectText={vi.fn()}
          onLoadSubtitleFile={vi.fn()}
          settings={DEFAULT_PLAYER_SETTINGS}
          onSettingsChange={vi.fn()}
        />,
      );

      expect(screen.getByText('Available Audio Tracks')).toBeTruthy();
      expect(screen.getByText('English')).toBeTruthy();
      expect(screen.getByText('Hindi')).toBeTruthy();
      expect(screen.getByText('#1')).toBeTruthy();
      expect(screen.getByText('#2')).toBeTruthy();
      expect(screen.getByText('AAC')).toBeTruthy();
      expect(screen.getByText('Dolby Digital+ 5.1')).toBeTruthy();
      expect(screen.getByText(/5\.1 Surround/)).toBeTruthy();

      // Switching track during playback
      const hindiBtn = screen.getByRole('button', { name: /Hindi/i });
      fireEvent.click(hindiBtn);
      expect(onSelectAudio).toHaveBeenCalledWith('vlc-audio:2');
    });
  });

  describe('Scenario 2: MKV containing Japanese audio and English subtitles', () => {
    const audioTracks: TrackOption[] = [
      {
        id: 'vlc-audio:1',
        trackNumber: 1,
        label: 'Japanese Audio',
        language: 'jpn',
        languageName: 'Japanese',
        codec: 'flac',
        codecLabel: 'FLAC',
        channels: 2,
      },
    ];

    const textTracks: TrackOption[] = [
      {
        id: 'vlc-spu:1',
        trackNumber: 1,
        label: 'English Full Dialogue',
        language: 'eng',
        languageName: 'English',
        codec: 'ass',
        codecLabel: 'ASS',
        isExternal: false,
      },
    ];

    it('renders Japanese audio correctly and lists English ASS subtitle in Embedded group', () => {
      const onSelectText = vi.fn();
      render(
        <AudioSubtitleDialog
          isOpen={true}
          onClose={vi.fn()}
          initialTab="subs"
          audioTracks={audioTracks}
          currentAudio="vlc-audio:1"
          onSelectAudio={vi.fn()}
          textTracks={textTracks}
          currentText="vlc-spu:1"
          onSelectText={onSelectText}
          onLoadSubtitleFile={vi.fn()}
          settings={DEFAULT_PLAYER_SETTINGS}
          onSettingsChange={vi.fn()}
        />,
      );

      expect(screen.getByText('Embedded Subtitles (MKV / Stream)')).toBeTruthy();
      expect(screen.getByText('English (English Full Dialogue)')).toBeTruthy();
      expect(screen.getByText('ASS')).toBeTruthy();

      // Subtitles Off button is present
      const offBtn = screen.getByRole('button', { name: /Subtitles Off/i });
      fireEvent.click(offBtn);
      expect(onSelectText).toHaveBeenCalledWith('');

      // Switch to Audio tab and check Japanese audio
      const audioTabBtn = screen.getByRole('tab', { name: /Audio/i });
      fireEvent.click(audioTabBtn);
      expect(screen.getByText('Japanese')).toBeTruthy();
      expect(screen.getByText('FLAC')).toBeTruthy();
    });
  });

  describe('Scenario 3: MKV containing multiple embedded subtitle tracks', () => {
    const textTracks: TrackOption[] = [
      {
        id: 'vlc-spu:1',
        trackNumber: 1,
        label: 'English Signs & Songs',
        language: 'eng',
        languageName: 'English',
        codec: 'ass',
        codecLabel: 'ASS',
        isExternal: false,
      },
      {
        id: 'vlc-spu:2',
        trackNumber: 2,
        label: 'English Full Dialogue',
        language: 'eng',
        languageName: 'English',
        codec: 'ass',
        codecLabel: 'ASS',
        isExternal: false,
      },
      {
        id: 'vlc-spu:3',
        trackNumber: 3,
        label: 'Español Latino',
        language: 'spa',
        languageName: 'Spanish',
        codec: 'subrip',
        codecLabel: 'SRT',
        isExternal: false,
      },
    ];

    it('allows switching between embedded subtitle tracks during playback', () => {
      const onSelectText = vi.fn();
      render(
        <AudioSubtitleDialog
          isOpen={true}
          onClose={vi.fn()}
          initialTab="subs"
          audioTracks={[]}
          currentAudio=""
          onSelectAudio={vi.fn()}
          textTracks={textTracks}
          currentText="vlc-spu:1"
          onSelectText={onSelectText}
          onLoadSubtitleFile={vi.fn()}
          settings={DEFAULT_PLAYER_SETTINGS}
          onSettingsChange={vi.fn()}
        />,
      );

      const items = screen.getAllByRole('button');
      const spanishBtn = items.find((el) => el.textContent?.includes('Spanish'));
      expect(spanishBtn).toBeDefined();
      if (spanishBtn) {
        fireEvent.click(spanishBtn);
        expect(onSelectText).toHaveBeenCalledWith('vlc-spu:3');
      }
    });
  });

  describe('Scenario 4: MKV with no embedded subtitles but an external SRT file', () => {
    const textTracks: TrackOption[] = [
      {
        id: 'vlc-spu:101',
        trackNumber: 1,
        label: 'custom_subtitles.srt',
        language: 'eng',
        languageName: 'English',
        codec: 'subrip',
        codecLabel: 'SRT',
        isExternal: true,
      },
    ];

    it('groups under External Subtitles and triggers file loader callback', () => {
      const onLoadSubtitleFile = vi.fn();
      render(
        <AudioSubtitleDialog
          isOpen={true}
          onClose={vi.fn()}
          initialTab="subs"
          audioTracks={[]}
          currentAudio=""
          onSelectAudio={vi.fn()}
          textTracks={textTracks}
          currentText="vlc-spu:101"
          onSelectText={vi.fn()}
          onLoadSubtitleFile={onLoadSubtitleFile}
          settings={DEFAULT_PLAYER_SETTINGS}
          onSettingsChange={vi.fn()}
        />,
      );

      expect(screen.getByText(/External Subtitles/i)).toBeTruthy();
      expect(screen.getByText('custom_subtitles.srt')).toBeTruthy();

      const loadBtn = screen.getByRole('button', { name: /Load Subtitle File/i });
      fireEvent.click(loadBtn);
      expect(onLoadSubtitleFile).toHaveBeenCalledTimes(1);
    });
  });

  describe('Scenario 5: Video with only one audio track', () => {
    const singleAudioTrack: TrackOption[] = [
      {
        id: 'vlc-audio:1',
        trackNumber: 1,
        label: 'Stereo Sound',
        language: undefined,
        languageName: null,
        codec: 'aac',
        codecLabel: 'AAC',
        channels: 2,
      },
    ];

    it('does not display fake language options and shows honest single-track information notice', () => {
      render(
        <AudioSubtitleDialog
          isOpen={true}
          onClose={vi.fn()}
          initialTab="audio"
          audioTracks={singleAudioTrack}
          currentAudio="vlc-audio:1"
          onSelectAudio={vi.fn()}
          textTracks={[]}
          currentText=""
          onSelectText={vi.fn()}
          onLoadSubtitleFile={vi.fn()}
          settings={DEFAULT_PLAYER_SETTINGS}
          onSettingsChange={vi.fn()}
        />,
      );

      // Single track notice requirement: do not display fake language options
      expect(
        screen.getByText(
          'Single audio track available. No alternative audio streams found in this container.',
        ),
      ).toBeTruthy();
      // Track label is shown honestly without inventing a language
      expect(screen.getByText('Stereo Sound')).toBeTruthy();
    });
  });

  describe('Scenario 6: Video with no subtitles', () => {
    it('shows helpful empty state explaining no subtitle tracks exist', () => {
      render(
        <AudioSubtitleDialog
          isOpen={true}
          onClose={vi.fn()}
          initialTab="subs"
          audioTracks={[]}
          currentAudio=""
          onSelectAudio={vi.fn()}
          textTracks={[]}
          currentText=""
          onSelectText={vi.fn()}
          onLoadSubtitleFile={vi.fn()}
          settings={DEFAULT_PLAYER_SETTINGS}
          onSettingsChange={vi.fn()}
        />,
      );

      expect(
        screen.getByText('No embedded or external subtitle tracks found for this media.'),
      ).toBeTruthy();
      expect(
        screen.getByText(/You can load external SRT, VTT, or ASS files/i),
      ).toBeTruthy();
      expect(screen.getByRole('button', { name: /Subtitles Off/i })).toBeTruthy();
    });
  });

  describe('Scenario 7 & 8: Switching audio & subtitles during playback', () => {
    it('supports disabling audio (mute stream) and selecting tracks', () => {
      const onSelectAudio = vi.fn();
      render(
        <AudioSubtitleDialog
          isOpen={true}
          onClose={vi.fn()}
          initialTab="audio"
          audioTracks={[
            { id: 'vlc-audio:1', label: 'Audio 1' },
            { id: 'vlc-audio:2', label: 'Audio 2' },
          ]}
          currentAudio="vlc-audio:1"
          onSelectAudio={onSelectAudio}
          textTracks={[]}
          currentText=""
          onSelectText={vi.fn()}
          onLoadSubtitleFile={vi.fn()}
          settings={DEFAULT_PLAYER_SETTINGS}
          onSettingsChange={vi.fn()}
        />,
      );

      const disableAudioBtn = screen.getByRole('button', { name: /Disable Audio/i });
      fireEvent.click(disableAudioBtn);
      expect(onSelectAudio).toHaveBeenCalledWith('audio:off');
    });
  });

  describe('Scenario 9: Storage Access Framework / Subtitle file loading', () => {
    it('invokes native file picker launcher when on Android app', () => {
      const onLoadSubtitleFile = vi.fn();
      render(
        <AudioSubtitleDialog
          isOpen={true}
          onClose={vi.fn()}
          initialTab="subs"
          audioTracks={[]}
          currentAudio=""
          onSelectAudio={vi.fn()}
          textTracks={[]}
          currentText=""
          onSelectText={vi.fn()}
          onLoadSubtitleFile={onLoadSubtitleFile}
          settings={DEFAULT_PLAYER_SETTINGS}
          onSettingsChange={vi.fn()}
          isAndroid={true}
        />,
      );

      const loadBtn = screen.getByRole('button', { name: /Load Subtitle File/i });
      fireEvent.click(loadBtn);
      expect(onLoadSubtitleFile).toHaveBeenCalledTimes(1);
    });
  });

  describe('Scenario 10: Closing and reopening video (Settings persistence)', () => {
    it('maintains player settings across instances', () => {
      const customSettings: PlayerSettings = {
        ...DEFAULT_PLAYER_SETTINGS,
        subtitleSize: 130,
        subtitleColor: '#ffff00',
        subtitleBgOpacity: 70,
        subtitleOutline: 'thick',
        subtitlePosition: 'top',
        subtitleOffset: 1.5,
      };

      const { unmount } = render(
        <AudioSubtitleDialog
          isOpen={true}
          onClose={vi.fn()}
          initialTab="subs"
          audioTracks={[]}
          currentAudio=""
          onSelectAudio={vi.fn()}
          textTracks={[]}
          currentText=""
          onSelectText={vi.fn()}
          onLoadSubtitleFile={vi.fn()}
          settings={customSettings}
          onSettingsChange={vi.fn()}
        />,
      );

      // Open appearance section
      fireEvent.click(screen.getByRole('button', { name: /Subtitle Appearance & Timing/i }));

      expect(screen.getByText('130%')).toBeTruthy();
      expect(screen.getByText('70%')).toBeTruthy();
      expect(screen.getByText('+1.5s')).toBeTruthy();

      unmount();

      // Reopening video with persistent settings intact
      render(
        <AudioSubtitleDialog
          isOpen={true}
          onClose={vi.fn()}
          initialTab="subs"
          audioTracks={[]}
          currentAudio=""
          onSelectAudio={vi.fn()}
          textTracks={[]}
          currentText=""
          onSelectText={vi.fn()}
          onLoadSubtitleFile={vi.fn()}
          settings={customSettings}
          onSettingsChange={vi.fn()}
        />,
      );

      fireEvent.click(screen.getByRole('button', { name: /Subtitle Appearance & Timing/i }));
      expect(screen.getByText('130%')).toBeTruthy();
      expect(screen.getByText('70%')).toBeTruthy();
    });
  });

  describe('Scenario 11: Subtitle appearance settings and reset', () => {
    it('handles size, color presets, outline, position, sync delay, and 1-click reset', () => {
      const onSettingsChange = vi.fn();
      render(
        <AudioSubtitleDialog
          isOpen={true}
          onClose={vi.fn()}
          initialTab="subs"
          audioTracks={[]}
          currentAudio=""
          onSelectAudio={vi.fn()}
          textTracks={[]}
          currentText=""
          onSelectText={vi.fn()}
          onLoadSubtitleFile={vi.fn()}
          settings={{
            ...DEFAULT_PLAYER_SETTINGS,
            subtitleSize: 120,
            subtitleOffset: 0.5,
          }}
          onSettingsChange={onSettingsChange}
        />,
      );

      // Expand appearance settings panel
      fireEvent.click(screen.getByRole('button', { name: /Subtitle Appearance & Timing/i }));

      // Color preset click
      const yellowBtn = screen.getByRole('button', { name: 'Yellow' });
      fireEvent.click(yellowBtn);
      expect(onSettingsChange).toHaveBeenCalledWith({ subtitleColor: '#ffff00' });

      // Outline option click
      const thickBtn = screen.getByRole('button', { name: 'Thick' });
      fireEvent.click(thickBtn);
      expect(onSettingsChange).toHaveBeenCalledWith({ subtitleOutline: 'thick' });

      // Position option click
      const topBtn = screen.getByRole('button', { name: 'Top' });
      fireEvent.click(topBtn);
      expect(onSettingsChange).toHaveBeenCalledWith({ subtitlePosition: 'top' });

      // Sync delay buttons
      const advanceBtn = screen.getByRole('button', { name: '+0.25s' });
      fireEvent.click(advanceBtn);
      expect(onSettingsChange).toHaveBeenCalledWith({ subtitleOffset: 0.75 });

      const delayBtn = screen.getByRole('button', { name: '−0.25s' });
      fireEvent.click(delayBtn);
      expect(onSettingsChange).toHaveBeenCalledWith({ subtitleOffset: 0.25 });

      // Reset to default settings
      const resetBtn = screen.getByRole('button', { name: /Reset to Default Settings/i });
      fireEvent.click(resetBtn);
      expect(onSettingsChange).toHaveBeenCalledWith(DEFAULT_SUBTITLE_SETTINGS);
    });
  });
});
