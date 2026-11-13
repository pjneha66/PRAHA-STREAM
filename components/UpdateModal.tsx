import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowDownToLine, Check, ExternalLink, HardDrive, LoaderCircle,
  Sparkles, X,
} from 'lucide-react';
import type { UpdateInfo } from '../services/autoUpdateService';
import { downloadAndInstallUpdate, isAndroidApp, openSafeExternalUrl } from '../services/androidBridge';

interface UpdateModalProps {
  update: UpdateInfo;
  onClose: () => void;
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '';
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

const UpdateModal: React.FC<UpdateModalProps> = ({ update, onClose }) => {
  const [downloading, setDownloading] = useState(false);
  const [started, setStarted] = useState(false);
  const indicatorTimerRef = useRef<number | null>(null);

  // The modal can unmount while the 3.5s indicator is pending; clear it so we
  // never setState on an unmounted component.
  useEffect(() => () => {
    if (indicatorTimerRef.current !== null) window.clearTimeout(indicatorTimerRef.current);
  }, []);

  const handleUpdate = () => {
    setDownloading(true);
    setStarted(true);

    void (async () => {
      try {
        const accepted = await downloadAndInstallUpdate(update.apkUrl, update.latestVersion);
        if (!accepted) throw new Error('Update download rejected.');
        // Let the indicator show for 3 seconds, then inform user it's downloading
        if (indicatorTimerRef.current !== null) window.clearTimeout(indicatorTimerRef.current);
        indicatorTimerRef.current = window.setTimeout(() => {
          indicatorTimerRef.current = null;
          setDownloading(false);
        }, 3500);
      } catch {
        await openSafeExternalUrl(update.apkUrl);
        setDownloading(false);
      }
    })();
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="source-modal"
        style={{
          maxWidth: '520px',
          padding: '1.5rem',
          borderRadius: '18px',
          background: '#111317',
          border: '1px solid rgba(255,255,255,0.14)',
          boxShadow: '0 24px 60px rgba(0,0,0,0.85)',
          animation: 'modal-in 0.25s ease',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '1.25rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <div style={{
              width: '42px',
              height: '42px',
              borderRadius: '12px',
              background: 'rgba(var(--accent-rgb, 245, 197, 24), 0.15)',
              display: 'grid',
              placeItems: 'center',
              color: 'var(--accent, #f5c518)',
            }}>
              <Sparkles size={22} />
            </div>
            <div>
              <span style={{ fontSize: '0.75rem', fontWeight: 800, color: 'var(--accent, #f5c518)', letterSpacing: '1px' }}>
                NEW UPDATE AVAILABLE
              </span>
              <h2 style={{ fontSize: '1.35rem', fontWeight: 800, margin: '2px 0 0 0', color: '#fff' }}>
                {update.latestVersion}
              </h2>
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              width: '32px',
              height: '32px',
              borderRadius: '50%',
              border: '1px solid rgba(255,255,255,0.1)',
              background: 'rgba(255,255,255,0.05)',
              color: '#aaa',
              cursor: 'pointer',
              display: 'grid',
              placeItems: 'center',
            }}
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </div>

        {/* Release Meta Pill */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          padding: '0.65rem 1rem',
          borderRadius: '10px',
          background: 'rgba(255,255,255,0.04)',
          border: '1px solid rgba(255,255,255,0.06)',
          fontSize: '0.82rem',
          color: '#aaa',
          marginBottom: '1rem',
        }}>
          <span>Current: <strong>{update.currentVersion}</strong></span>
          <span>→</span>
          <span>Latest: <strong style={{ color: 'var(--accent, #f5c518)' }}>{update.latestVersion}</strong></span>
          {update.apkSize > 0 && (
            <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: '4px' }}>
              <HardDrive size={13} /> {formatBytes(update.apkSize)}
            </span>
          )}
        </div>

        {/* Release Notes */}
        <div style={{ marginBottom: '1.5rem' }}>
          <div style={{ fontSize: '0.8rem', fontWeight: 700, color: '#888', marginBottom: '0.5rem', textTransform: 'uppercase', letterSpacing: '0.8px' }}>
            What's New:
          </div>
          <div style={{
            maxHeight: '160px',
            overflowY: 'auto',
            padding: '0.85rem',
            borderRadius: '10px',
            background: 'rgba(0,0,0,0.3)',
            border: '1px solid rgba(255,255,255,0.06)',
            fontSize: '0.85rem',
            lineHeight: '1.5',
            color: '#ddd',
            whiteSpace: 'pre-wrap',
          }}>
            {update.releaseNotes}
          </div>
        </div>

        {/* Action Buttons */}
        {started ? (
          <div style={{
            padding: '1rem',
            borderRadius: '12px',
            background: 'rgba(var(--accent-rgb, 245, 197, 24), 0.12)',
            border: '1px solid rgba(var(--accent-rgb, 245, 197, 24), 0.3)',
            textAlign: 'center',
            marginBottom: '1rem',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '0.5rem', fontWeight: 700, color: 'var(--accent, #f5c518)', marginBottom: '0.35rem' }}>
              {downloading ? <LoaderCircle size={18} className="spin" /> : <Check size={18} />}
              {downloading ? 'Downloading APK Update…' : 'Download Started in Background'}
            </div>
            <p style={{ margin: 0, fontSize: '0.8rem', color: '#aaa' }}>
              {isAndroidApp()
                ? 'Check the Android notification drawer. Once download finishes, tap the notification to install.'
                : 'Downloading file via browser.'}
            </p>
          </div>
        ) : null}

        <div style={{ display: 'flex', gap: '0.75rem', flexDirection: 'column' }}>
          <button
            className="button button-primary"
            onClick={handleUpdate}
            disabled={downloading}
            style={{
              width: '100%',
              minHeight: '48px',
              fontSize: '0.95rem',
              fontWeight: 800,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '0.5rem',
              borderRadius: '12px',
            }}
          >
            {downloading ? (
              <>
                <LoaderCircle size={18} className="spin" /> Starting Download…
              </>
            ) : (
              <>
                <ArrowDownToLine size={18} /> Update Now ({update.latestVersion})
              </>
            )}
          </button>

          <div style={{ display: 'flex', gap: '0.75rem' }}>
            <button
              className="button button-secondary"
              onClick={onClose}
              style={{ flex: 1, minHeight: '40px', borderRadius: '10px' }}
            >
              Later
            </button>
            <a
              href={update.apkUrl || update.htmlUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="button button-secondary"
              style={{ flex: 1, minHeight: '40px', borderRadius: '10px', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '6px' }}
            >
              Download in Browser <ExternalLink size={13} />
            </a>
          </div>
        </div>
      </div>
    </div>
  );
};

export default UpdateModal;

