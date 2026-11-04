import React, { useId, useState } from 'react';
import {
  AudioLines, Captions, CaptionsOff, Check, RotateCcw, Sliders,
  Upload, VolumeX, X,
} from 'lucide-react';
import type { PlayerSettings, SubtitleOutline, SubtitlePosition } from '../../types';
import { DEFAULT_SUBTITLE_SETTINGS } from '../../data/defaults';
import type { TrackOption } from './useMpvEngine';

export interface AudioSubtitleDialogProps {
  isOpen: boolean;
  onClose: () => void;
  initialTab?: 'audio' | 'subs';
  audioTracks: TrackOption[];
  currentAudio: string;
  onSelectAudio: (id: string) => void;
  textTracks: TrackOption[];
  currentText: string;
  onSelectText: (id: string) => void;
  onLoadSubtitleFile: () => void;
  settings: PlayerSettings;
  onSettingsChange: (patch: Partial<PlayerSettings>) => void;
  isAndroid?: boolean;
}

const COLOR_PRESETS = [
  { label: 'White', value: '#ffffff' },
  { label: 'Yellow', value: '#ffff00' },
  { label: 'Cyan', value: '#00ffff' },
  { label: 'Green', value: '#00ff00' },
];

const OUTLINE_OPTIONS: Array<{ id: SubtitleOutline; label: string }> = [
  { id: 'none', label: 'None' },
  { id: 'thin', label: 'Thin' },
  { id: 'medium', label: 'Medium' },
  { id: 'thick', label: 'Thick' },
  { id: 'shadow', label: 'Shadow' },
];

const POSITION_OPTIONS: Array<{ id: SubtitlePosition; label: string }> = [
  { id: 'bottom', label: 'Bottom' },
  { id: 'middle', label: 'Middle' },
  { id: 'top', label: 'Top' },
];

export const AudioSubtitleDialog: React.FC<AudioSubtitleDialogProps> = ({
  isOpen,
  onClose,
  initialTab = 'audio',
  audioTracks,
  currentAudio,
  onSelectAudio,
  textTracks,
  currentText,
  onSelectText,
  onLoadSubtitleFile,
  settings,
  onSettingsChange,
  isAndroid = false,
}) => {
  const [activeTab, setActiveTab] = useState<'audio' | 'subs'>(initialTab);
  const [showAppearance, setShowAppearance] = useState(false);
  const dialogId = useId();

  if (!isOpen) return null;

  const isAudioDisabled = currentAudio === 'audio:off' || currentAudio === 'off' || currentAudio === '-1';
  const isSubtitleOff = !currentText || currentText === 'off';

  // Group subtitles into embedded and external
  const embeddedSubs = textTracks.filter((track) => !track.isExternal && !track.id.startsWith('local:'));
  const externalSubs = textTracks.filter((track) => track.isExternal || track.id.startsWith('local:'));

  const shiftDelay = (delta: number) => {
    const next = Number(((settings.subtitleOffset || 0) + delta).toFixed(2));
    onSettingsChange({ subtitleOffset: Math.max(-10, Math.min(10, next)) });
  };

  const resetAppearance = () => {
    onSettingsChange(DEFAULT_SUBTITLE_SETTINGS);
  };

  return (
    <div
      className="mpv-dialog-overlay"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby={`${dialogId}-title`}
    >
      <div className="mpv-dialog-container" onClick={(e) => e.stopPropagation()}>
        <header className="mpv-dialog-header">
          <div className="mpv-dialog-tabs">
            <button
              type="button"
              className={`mpv-tab-btn ${activeTab === 'audio' ? 'active' : ''}`}
              onClick={() => setActiveTab('audio')}
              aria-selected={activeTab === 'audio'}
              role="tab"
            >
              <AudioLines size={15} />
              <span>Audio</span>
              {audioTracks.length > 0 && <span className="mpv-tab-count">{audioTracks.length}</span>}
            </button>
            <button
              type="button"
              className={`mpv-tab-btn ${activeTab === 'subs' ? 'active' : ''}`}
              onClick={() => setActiveTab('subs')}
              aria-selected={activeTab === 'subs'}
              role="tab"
            >
              <Captions size={15} />
              <span>Subtitles</span>
              {textTracks.length > 0 && <span className="mpv-tab-count">{textTracks.length}</span>}
            </button>
          </div>
          <button
            type="button"
            className="mpv-dialog-close"
            onClick={onClose}
            aria-label="Close audio and subtitle dialog"
          >
            <X size={16} />
          </button>
        </header>

        <div className="mpv-dialog-content">
          {activeTab === 'audio' && (
            <div className="mpv-tab-panel" role="tabpanel">
              <div className="mpv-panel-section-title">
                <span>Available Audio Tracks</span>
                {isAndroid && <span className="mpv-badge-native">LibVLC Native</span>}
              </div>

              {/* Audio Disable / Mute option */}
              <div className="mpv-track-item-wrapper">
                <button
                  type="button"
                  className={`mpv-track-item ${isAudioDisabled ? 'selected' : ''}`}
                  onClick={() => onSelectAudio('audio:off')}
                >
                  <div className="mpv-track-info">
                    <div className="mpv-track-name">
                      <VolumeX size={14} />
                      <span>Disable Audio</span>
                    </div>
                    <span className="mpv-track-sub">Mute / turn off audio track</span>
                  </div>
                  {isAudioDisabled && <Check size={16} className="mpv-check" />}
                </button>
              </div>

              {/* Audio Track List */}
              {audioTracks.length === 0 ? (
                <div className="mpv-empty-state">
                  <AudioLines size={24} />
                  <p>No selectable audio tracks reported by this stream or device.</p>
                </div>
              ) : (
                <div className="mpv-track-list">
                  {audioTracks.map((track, index) => {
                    const isSelected = !isAudioDisabled && (currentAudio === track.id || (!currentAudio && index === 0));
                    const trackNum = track.trackNumber ?? (index + 1);
                    const langLabel = track.languageName || (track.language && track.language !== 'und' ? track.language.toUpperCase() : null);

                    return (
                      <button
                        key={track.id}
                        type="button"
                        className={`mpv-track-item ${isSelected ? 'selected' : ''}`}
                        onClick={() => onSelectAudio(track.id)}
                      >
                        <div className="mpv-track-info">
                          <div className="mpv-track-name">
                            <span className="mpv-track-idx">#{trackNum}</span>
                            <strong>{langLabel || track.label || `Audio Track ${trackNum}`}</strong>
                            {track.codecLabel && <span className="mpv-codec-badge">{track.codecLabel}</span>}
                          </div>
                          <span className="mpv-track-sub">
                            {langLabel && track.label && track.label !== langLabel ? `${track.label} · ` : ''}
                            {track.bitrate ? `${Math.round(track.bitrate / 1000)} kbps` : ''}
                            {track.channels ? (track.channels === 6 ? ' · 5.1 Surround' : track.channels === 2 ? ' · Stereo' : ` · ${track.channels}ch`) : ''}
                          </span>
                        </div>
                        {isSelected && <Check size={16} className="mpv-check" />}
                      </button>
                    );
                  })}
                </div>
              )}

              {/* Informative note when only 1 audio track is present */}
              {audioTracks.length === 1 && (
                <div className="mpv-info-notice">
                  Single audio track available. No alternative audio streams found in this container.
                </div>
              )}
            </div>
          )}

          {activeTab === 'subs' && (
            <div className="mpv-tab-panel" role="tabpanel">
              {/* Actions row: Off & Load Subtitle File */}
              <div className="mpv-subs-actions-bar">
                <button
                  type="button"
                  className={`mpv-sub-toggle-btn ${isSubtitleOff ? 'selected' : ''}`}
                  onClick={() => onSelectText('')}
                >
                  <CaptionsOff size={14} />
                  <span>Subtitles Off</span>
                  {isSubtitleOff && <Check size={14} className="mpv-check" />}
                </button>

                <button
                  type="button"
                  className="button button-primary mpv-load-sub-btn"
                  onClick={onLoadSubtitleFile}
                >
                  <Upload size={14} />
                  <span>Load Subtitle File</span>
                </button>
              </div>

              {/* Embedded Subtitles Group */}
              {embeddedSubs.length > 0 && (
                <div className="mpv-sub-group">
                  <div className="mpv-group-header">
                    <span>Embedded Subtitles (MKV / Stream)</span>
                    <span className="mpv-group-count">{embeddedSubs.length}</span>
                  </div>
                  <div className="mpv-track-list">
                    {embeddedSubs.map((track, idx) => {
                      const isSelected = currentText === track.id;
                      const langLabel = track.languageName || (track.language && track.language !== 'und' ? track.language.toUpperCase() : null);
                      const displayTitle = langLabel ? `${langLabel}${track.label && track.label !== langLabel ? ` (${track.label})` : ''}` : track.label || `Subtitle ${idx + 1}`;

                      return (
                        <button
                          key={track.id}
                          type="button"
                          className={`mpv-track-item ${isSelected ? 'selected' : ''}`}
                          onClick={() => onSelectText(track.id)}
                        >
                          <div className="mpv-track-info">
                            <div className="mpv-track-name">
                              <strong>{displayTitle}</strong>
                              {track.codecLabel && <span className="mpv-codec-badge">{track.codecLabel}</span>}
                            </div>
                            {langLabel && track.label && track.label !== langLabel && (
                              <span className="mpv-track-sub">{track.label}</span>
                            )}
                          </div>
                          {isSelected && <Check size={16} className="mpv-check" />}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* External Subtitles Group */}
              {externalSubs.length > 0 && (
                <div className="mpv-sub-group">
                  <div className="mpv-group-header">
                    <span>External Subtitles (Addon / SAF)</span>
                    <span className="mpv-group-count">{externalSubs.length}</span>
                  </div>
                  <div className="mpv-track-list">
                    {externalSubs.map((track) => {
                      const isSelected = currentText === track.id;
                      return (
                        <button
                          key={track.id}
                          type="button"
                          className={`mpv-track-item ${isSelected ? 'selected' : ''}`}
                          onClick={() => onSelectText(track.id)}
                        >
                          <div className="mpv-track-info">
                            <div className="mpv-track-name">
                              <strong>{track.label}</strong>
                              <span className="mpv-codec-badge">External</span>
                            </div>
                            {track.language && <span className="mpv-track-sub">{track.language}</span>}
                          </div>
                          {isSelected && <Check size={16} className="mpv-check" />}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Empty state when no subtitles exist */}
              {embeddedSubs.length === 0 && externalSubs.length === 0 && (
                <div className="mpv-empty-state">
                  <Captions size={24} />
                  <p>No embedded or external subtitle tracks found for this media.</p>
                  <p className="mpv-empty-sub">
                    You can load external SRT, VTT, or ASS files using the button above.
                  </p>
                </div>
              )}

              {/* Appearance & Timing Settings Toggle */}
              <div className="mpv-appearance-section">
                <button
                  type="button"
                  className="mpv-appearance-toggle"
                  onClick={() => setShowAppearance(!showAppearance)}
                >
                  <Sliders size={14} />
                  <span>Subtitle Appearance & Timing</span>
                  <span className="mpv-chevron">{showAppearance ? '▲' : '▼'}</span>
                </button>

                {showAppearance && (
                  <div className="mpv-appearance-controls">
                    {/* Sync Offset */}
                    <div className="mpv-control-group">
                      <div className="mpv-control-label">
                        <span>Sync Delay</span>
                        <strong>{settings.subtitleOffset > 0 ? `+${settings.subtitleOffset}` : settings.subtitleOffset || 0}s</strong>
                      </div>
                      <div className="mpv-btn-row">
                        <button type="button" onClick={() => shiftDelay(-0.25)}>−0.25s</button>
                        <button type="button" onClick={() => onSettingsChange({ subtitleOffset: 0 })}>0s (Reset)</button>
                        <button type="button" onClick={() => shiftDelay(0.25)}>+0.25s</button>
                      </div>
                    </div>

                    {/* Font Size */}
                    <div className="mpv-control-group">
                      <div className="mpv-control-label">
                        <span>Font Size</span>
                        <strong>{settings.subtitleSize}%</strong>
                      </div>
                      <input
                        type="range"
                        min={50}
                        max={300}
                        step={10}
                        value={settings.subtitleSize}
                        onChange={(e) => onSettingsChange({ subtitleSize: Number(e.target.value) })}
                      />
                    </div>

                    {/* Text Color */}
                    <div className="mpv-control-group">
                      <div className="mpv-control-label">
                        <span>Text Color</span>
                        <input
                          type="color"
                          value={settings.subtitleColor}
                          onChange={(e) => onSettingsChange({ subtitleColor: e.target.value })}
                          className="mpv-color-input"
                        />
                      </div>
                      <div className="mpv-preset-swatches">
                        {COLOR_PRESETS.map((preset) => (
                          <button
                            key={preset.value}
                            type="button"
                            className={`mpv-swatch-btn ${settings.subtitleColor.toLowerCase() === preset.value ? 'active' : ''}`}
                            style={{ backgroundColor: preset.value }}
                            onClick={() => onSettingsChange({ subtitleColor: preset.value })}
                            title={preset.label}
                          />
                        ))}
                      </div>
                    </div>

                    {/* Background Opacity */}
                    <div className="mpv-control-group">
                      <div className="mpv-control-label">
                        <span>Background Opacity</span>
                        <strong>{settings.subtitleBgOpacity ?? 55}%</strong>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={100}
                        step={5}
                        value={settings.subtitleBgOpacity ?? 55}
                        onChange={(e) => onSettingsChange({ subtitleBgOpacity: Number(e.target.value) })}
                      />
                      <div className="mpv-btn-row compact">
                        <button type="button" onClick={() => onSettingsChange({ subtitleBgOpacity: 0 })}>Transparent</button>
                        <button type="button" onClick={() => onSettingsChange({ subtitleBgOpacity: 55 })}>Semi (55%)</button>
                        <button type="button" onClick={() => onSettingsChange({ subtitleBgOpacity: 100 })}>Solid (100%)</button>
                      </div>
                    </div>

                    {/* Text Outline */}
                    <div className="mpv-control-group">
                      <div className="mpv-control-label">
                        <span>Text Outline</span>
                        <strong>{settings.subtitleOutline || 'medium'}</strong>
                      </div>
                      <div className="mpv-segmented-control">
                        {OUTLINE_OPTIONS.map((opt) => (
                          <button
                            key={opt.id}
                            type="button"
                            className={`mpv-segment-btn ${(settings.subtitleOutline || 'medium') === opt.id ? 'active' : ''}`}
                            onClick={() => onSettingsChange({ subtitleOutline: opt.id })}
                          >
                            {opt.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Position */}
                    <div className="mpv-control-group">
                      <div className="mpv-control-label">
                        <span>Screen Position</span>
                        <strong>{settings.subtitlePosition || 'bottom'}</strong>
                      </div>
                      <div className="mpv-segmented-control">
                        {POSITION_OPTIONS.map((pos) => (
                          <button
                            key={pos.id}
                            type="button"
                            className={`mpv-segment-btn ${(settings.subtitlePosition || 'bottom') === pos.id ? 'active' : ''}`}
                            onClick={() => onSettingsChange({ subtitlePosition: pos.id })}
                          >
                            {pos.label}
                          </button>
                        ))}
                      </div>
                    </div>

                    {/* Reset Button */}
                    <button
                      type="button"
                      className="mpv-reset-btn"
                      onClick={resetAppearance}
                    >
                      <RotateCcw size={13} />
                      <span>Reset to Default Settings</span>
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default AudioSubtitleDialog;

