// Shared Live TV widgets.
//
// A TypeScript transcription of VyseTV's `lib/screens/live_tv/live_tv_widgets.dart`
// and `lib/screens/live_tv/match_widgets.dart` (GPL-3.0-or-later): the same
// widgets, the same copy, the same props — Flutter widgets become functions and
// the class names match the vocabulary in `components/live-tv.css`.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  IptvController,
  LiveFavorites,
  PortalNames,
  type FavoriteChannel,
} from '../../services/iptvService';

/** A lucide icon component; `LucideIcon` itself is not exported by the package. */
export type IconType = React.ComponentType<{
  size?: number | string;
  strokeWidth?: number;
  className?: string;
}>;

/** `hhmm(d)` — the 24-hour time VyseTV puts on every row and fixture. */
export function hhmm(value: number | string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** `_counted(n)` — "5,000 channels", "1 channel". */
export function counted(count: number, noun: string, plural?: string): string {
  return `${count.toLocaleString()} ${count === 1 ? noun : plural ?? `${noun}s`}`;
}

/** Re-render whenever the controller changes. */
export function useIptvController(): IptvController {
  const controller = IptvController.instance;
  const [, bump] = useState(0);
  useEffect(() => {
    PortalNames.load();
    const unsubscribe = controller.subscribe(() => bump((value) => value + 1));
    void controller.init();
    return unsubscribe;
  }, [controller]);
  return controller;
}

/** Re-render whenever a channel is starred or unstarred. */
export function useLiveFavorites(): readonly FavoriteChannel[] {
  const [, bump] = useState(0);
  useEffect(() => {
    LiveFavorites.load();
    return LiveFavorites.subscribe(() => bump((value) => value + 1));
  }, []);
  return LiveFavorites.saved;
}

/** `LivePill` — the red LIVE badge, optionally with what it is showing. */
export function LivePill({ text }: { text?: string }) {
  return (
    <span className="ltv-live-pill">
      <i />
      {text ? `LIVE  ${text}` : 'LIVE'}
    </span>
  );
}

/** `FilterChipPill` — the one pill used for tabs, day picks, tags and groups. */
export function FilterChipPill({
  label,
  selected,
  icon: Icon,
  title,
  onClick,
}: {
  label: React.ReactNode;
  selected?: boolean;
  icon?: IconType;
  title?: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      className={`ltv-pill${selected ? ' selected' : ''}`}
      aria-pressed={selected || undefined}
      title={title}
      onClick={onClick}
    >
      {Icon ? <Icon size={14} /> : null}
      {label}
    </button>
  );
}

/** `ShelfHeader` — the small heading above a row of cards. */
export function ShelfHeader({ children }: { children: React.ReactNode }) {
  return <h3 className="ltv-shelf-header">{children}</h3>;
}

/** `SectionHeader` — the page title and its one-line subtitle. */
export function SectionHeader({ title, subtitle }: { title: React.ReactNode; subtitle?: React.ReactNode }) {
  return (
    <header className="ltv-section-header">
      <h2>{title}</h2>
      {subtitle ? <p>{subtitle}</p> : null}
    </header>
  );
}

/** `TeamBadge` — a crest, or a shield when the fixture has no picture. */
export function TeamBadge({
  name,
  logo,
  size,
  ShieldIcon,
}: {
  name: string;
  logo?: string;
  size: number;
  ShieldIcon: IconType;
}) {
  return (
    <span className="ltv-team-badge" style={{ width: size, height: size }} title={name}>
      {logo ? <img src={logo} alt="" loading="lazy" /> : <ShieldIcon size={Math.round(size * 0.55)} />}
    </span>
  );
}

/** `ChannelTile` — the 16:9 art tile from the curated catalogue. */
export function ChannelTile({
  name,
  shortName,
  gradient,
  logo,
  chips,
  onClick,
}: {
  name: string;
  shortName?: string;
  gradient?: readonly [string, string];
  logo?: string;
  chips?: readonly string[];
  onClick?: () => void;
}) {
  const style = {
    '--ltv-tile-a': gradient?.[0] || '#303a6e',
    '--ltv-tile-b': gradient?.[1] || '#171b30',
  } as React.CSSProperties;
  return (
    <button type="button" className="ltv-tile" onClick={onClick}>
      <span className="ltv-tile-art" style={style}>
        {logo ? <img src={logo} alt="" loading="lazy" /> : <span className="ltv-tile-name">{shortName || name}</span>}
      </span>
      {chips?.length ? (
        <span className="ltv-tile-chips">
          {chips.slice(0, 3).map((chip) => <span key={chip}>{chip}</span>)}
        </span>
      ) : null}
      <span className="ltv-tile-caption">
        <strong>{name}</strong>
        {shortName ? <small>{shortName}</small> : null}
      </span>
    </button>
  );
}

/** `StreamCard` — a portal's or playlist's channel: art with the name under it. */
export function StreamCard({
  name,
  logo,
  alive,
  poster,
  onClick,
}: {
  name: string;
  logo?: string;
  alive?: boolean;
  poster?: boolean;
  onClick?: () => void;
}) {
  const initials = name.trim().slice(0, 2).toUpperCase() || 'TV';
  if (poster) {
    return (
      <button type="button" className="ltv-poster" onClick={onClick}>
        <span className="ltv-poster-art">
          {logo ? <img src={logo} alt="" loading="lazy" /> : <span className="ltv-stream-initials">{initials}</span>}
        </span>
        <span className="ltv-poster-name">{name}</span>
      </button>
    );
  }
  return (
    <button type="button" className="ltv-stream-card" onClick={onClick}>
      <span className="ltv-stream-art">
        {logo ? <img src={logo} alt="" loading="lazy" /> : <span className="ltv-stream-initials">{initials}</span>}
      </span>
      <span className="ltv-stream-caption">
        {alive === undefined ? null : <i className={`ltv-alive-dot${alive ? ' on' : ''}`} />}
        <span>{name}</span>
      </span>
    </button>
  );
}

/** `InfoTile` — portals and playlists: a flat tile, a title, quiet lines. */
export function InfoTile({
  title,
  lines,
  selected,
  trailing,
  onClick,
}: {
  title: React.ReactNode;
  lines: readonly React.ReactNode[];
  selected?: boolean;
  trailing?: React.ReactNode;
  onClick?: () => void;
}) {
  const activate = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      onClick?.();
    },
    [onClick],
  );
  return (
    <div
      className={`ltv-info-tile${selected ? ' selected' : ''}`}
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={activate}
    >
      <span className="ltv-info-body">
        <span className="ltv-info-title">{title}</span>
        {lines.filter(Boolean).map((line, index) => (
          <span className="ltv-info-line" key={index}>{line}</span>
        ))}
      </span>
      {trailing ? <span className="ltv-info-trailing">{trailing}</span> : null}
    </div>
  );
}

/** `StatusLine` — the quiet working line above a list. */
export function StatusLine({ text, busy }: { text: React.ReactNode; busy?: boolean }) {
  return (
    <div className="ltv-status">
      {busy ? <span className="ltv-spin" /> : null}
      <p>{text}</p>
    </div>
  );
}

/** `ToolButton` — a bare icon and label that lifts on hover. */
export function ToolButton({
  icon: Icon,
  label,
  onClick,
  danger,
  disabled,
}: {
  icon: IconType;
  label: React.ReactNode;
  onClick?: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`ltv-tool${danger ? ' danger' : ''}`}
      onClick={onClick}
      disabled={disabled}
    >
      <Icon size={15} />
      {label}
    </button>
  );
}

/** `EmptyState` — an icon, a title and one line of what to do about it. */
export function EmptyState({
  icon: Icon,
  title,
  body,
}: {
  icon: IconType;
  title: React.ReactNode;
  body?: React.ReactNode;
}) {
  return (
    <div className="ltv-empty-state">
      <Icon size={34} />
      <strong>{title}</strong>
      {body ? <p>{body}</p> : null}
    </div>
  );
}

/** `TagFilterRow` — CHANNEL / LANGUAGE / QUALITY, shown only when it can narrow. */
export function TagFilterRow({
  label,
  values,
  value,
  onPick,
}: {
  label: string;
  values: readonly string[];
  value: string | null;
  onPick: (next: string | null) => void;
}) {
  if (values.length < 2) return null;
  return (
    <div className="ltv-tag-row">
      <strong>{label}</strong>
      <div className="ltv-tag-values">
        <FilterChipPill label="All" selected={value === null} onClick={() => onPick(null)} />
        {values.map((entry) => (
          <FilterChipPill key={entry} label={entry} selected={value === entry} onClick={() => onPick(entry)} />
        ))}
      </div>
    </div>
  );
}

/** One field in a `showFieldsDialog` sheet. */
export interface DialogField {
  key: string;
  label: string;
  hint?: string;
  obscure?: boolean;
  multiline?: boolean;
}

/** `showFieldsDialog` — the small form VyseTV uses to add a portal or paste a list. */
export function FieldsDialog({
  title,
  description,
  fields,
  confirmLabel,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  title: string;
  description?: string;
  fields: readonly DialogField[];
  confirmLabel: string;
  busy?: boolean;
  error?: string | null;
  onSubmit: (values: Record<string, string>) => void;
  onClose: () => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(fields.map((field) => [field.key, ''])),
  );
  const canSubmit = useMemo(
    () => fields.every((field) => field.multiline || values[field.key]?.trim()),
    [fields, values],
  );
  return (
    <div className="ltv-scrim" role="presentation" onClick={onClose}>
      <div
        className="ltv-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <h3>{title}</h3>
        {description ? <p>{description}</p> : null}
        {fields.map((field) => (
          <React.Fragment key={field.key}>
            <label htmlFor={`ltv-field-${field.key}`}>{field.label}</label>
            {field.multiline ? (
              <textarea
                id={`ltv-field-${field.key}`}
                value={values[field.key] || ''}
                placeholder={field.hint}
                onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))}
              />
            ) : (
              <input
                id={`ltv-field-${field.key}`}
                type={field.obscure ? 'password' : 'text'}
                value={values[field.key] || ''}
                placeholder={field.hint}
                autoComplete={field.obscure ? 'current-password' : 'off'}
                onChange={(event) => setValues((current) => ({ ...current, [field.key]: event.target.value }))}
              />
            )}
          </React.Fragment>
        ))}
        {error ? <p role="alert">{error}</p> : null}
        <div className="ltv-dialog-actions">
          <button type="button" className="ghost" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="primary"
            disabled={!canSubmit || busy}
            onClick={() => onSubmit(values)}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** A toast, as VyseTV shows it after copying a login or adding a portal. */
export function useToast(): { message: string; show: (text: string) => void } {
  const [message, setMessage] = useState('');
  const show = useCallback((text: string) => {
    setMessage(text);
    window.setTimeout(() => setMessage((current) => (current === text ? '' : current)), 2600);
  }, []);
  return { message, show };
}

/** `_LivePage` — the sub-page scaffold: a back link, a title, then content. */
export function SubPage({
  title,
  subtitle,
  onBack,
  children,
  actions,
  compact,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  onBack: () => void;
  children: React.ReactNode;
  actions?: React.ReactNode;
  /** "A phone on its side": the title shrinks (`_topBar(compact: short)`). */
  compact?: boolean;
}) {
  return (
    <div className={`ltv-subpage${compact ? ' is-compact' : ''}`}>
      <div className="ltv-subpage-head">
        <button type="button" className="ltv-back" onClick={onBack}>‹ Back</button>
        <div style={{ flex: '1 1 auto', minWidth: 0 }}>
          <SectionHeader title={title} subtitle={subtitle} />
        </div>
        {actions}
      </div>
      {children}
    </div>
  );
}
