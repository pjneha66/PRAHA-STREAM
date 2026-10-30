import React, { useEffect, useRef, useState } from 'react';
import {
  Check, CircleAlert, ImageUp, LoaderCircle, Pencil, Plus, ShieldCheck,
  Trash2, UserRound, Users, X,
} from 'lucide-react';
import type { UserProfile } from '../types';
import { fileToProfileAvatar, profileStats } from '../services/profileService';
import ProfileAvatar from './ProfileAvatar';
import type { ProfileInput } from '../hooks/useProfiles';

interface ProfilesViewProps {
  profiles: UserProfile[];
  activeId: string;
  onSwitch: (id: string) => void;
  onCreate: (input: ProfileInput) => void;
  onUpdate: (id: string, patch: Partial<ProfileInput>) => void;
  onDelete: (id: string) => void;
  onContinue: () => void;
}

interface ProfileEditorProps {
  profile?: UserProfile;
  onClose: () => void;
  onSave: (input: ProfileInput) => void;
}

const ProfileEditor: React.FC<ProfileEditorProps> = ({ profile, onClose, onSave }) => {
  const [name, setName] = useState(profile?.name || '');
  const [avatar, setAvatar] = useState(profile?.avatar || '');
  const [processing, setProcessing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    document.body.classList.add('modal-open');
    return () => { window.removeEventListener('keydown', handler); document.body.classList.remove('modal-open'); };
  }, [onClose]);

  const acceptFile = async (file?: File | null) => {
    if (!file) return;
    setProcessing(true);
    setError('');
    try {
      setAvatar(await fileToProfileAvatar(file));
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : 'That image could not be used.');
    } finally {
      setProcessing(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!name.trim()) { setError('Give this profile a name.'); return; }
    onSave({ name: name.trim(), avatar });
  };

  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="profile-editor" role="dialog" aria-modal="true" aria-label={profile ? 'Edit profile' : 'Create profile'}>
        <header className="profile-editor-header">
          <div><span className="page-kicker"><UserRound size={13} /> {profile ? 'EDIT PROFILE' : 'NEW PROFILE'}</span><h2>{profile ? `Edit ${profile.name}` : 'Add a profile'}</h2></div>
          <button className="modal-close" onClick={onClose} aria-label="Close profile editor"><X size={20} /></button>
        </header>

        <form onSubmit={submit}>
          <div
            className={`profile-avatar-editor ${dragging ? 'dragging' : ''}`}
            onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => { event.preventDefault(); setDragging(false); acceptFile(event.dataTransfer.files?.[0]); }}
          >
            <ProfileAvatar profile={{ name: name || 'New profile', avatar }} size={92} />
            <div>
              <strong>Display picture</strong>
              <p>Drop an image here or choose a file. It is centre-cropped to a square and kept on this device.</p>
              <div className="profile-avatar-actions">
                <button type="button" className="button button-secondary button-small" onClick={() => fileRef.current?.click()} disabled={processing}>
                  {processing ? <LoaderCircle size={15} className="spin" /> : <ImageUp size={15} />}
                  {processing ? 'Processing…' : avatar ? 'Replace photo' : 'Upload photo'}
                </button>
                {avatar && <button type="button" className="text-button" onClick={() => setAvatar('')}><Trash2 size={14} /> Remove</button>}
              </div>
            </div>
            <input ref={fileRef} type="file" accept="image/*" hidden onChange={(event) => acceptFile(event.target.files?.[0])} />
          </div>

          <label className="profile-name-field">
            <span>Profile name</span>
            <input
              autoFocus
              value={name}
              maxLength={24}
              onChange={(event) => { setName(event.target.value); setError(''); }}
              placeholder="e.g. Neha, Family, Anime nights"
            />
          </label>

          {error && <p className="profile-editor-error"><CircleAlert size={14} />{error}</p>}

          <footer className="profile-editor-footer">
            <p><ShieldCheck size={13} /> Profiles never leave this browser.</p>
            <div>
              <button type="button" className="button button-secondary" onClick={onClose}>Cancel</button>
              <button type="submit" className="button button-primary" disabled={processing}>
                <Check size={16} />{profile ? 'Save profile' : 'Create profile'}
              </button>
            </div>
          </footer>
        </form>
      </section>
    </div>
  );
};

const ProfilesView: React.FC<ProfilesViewProps> = ({
  profiles, activeId, onSwitch, onCreate, onUpdate, onDelete, onContinue,
}) => {
  const [editor, setEditor] = useState<{ profile?: UserProfile } | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  return (
    <div className="standard-page profiles-page page-enter">
      <header className="profiles-heading">
        <span className="page-kicker"><Users size={14} /> PROFILES</span>
        <h1>Who’s watching?</h1>
        <p>Every profile gets its own display picture, library, watch history, addons, and preferences. All of it stays on this device.</p>
      </header>

      <div className="profiles-grid">
        {profiles.map((profile) => {
          const isActive = profile.id === activeId;
          const stats = profileStats(profile.id);
          const deleting = pendingDelete === profile.id;
          return (
            <article className={`profile-card ${isActive ? 'active' : ''}`} key={profile.id}>
              <button
                className="profile-card-select"
                onClick={() => (isActive ? onContinue() : onSwitch(profile.id))}
                aria-label={isActive ? `Continue as ${profile.name}` : `Switch to ${profile.name}`}
              >
                <ProfileAvatar profile={profile} size={88} />
                <strong>{profile.name}</strong>
                <small>{stats.addons} addon{stats.addons === 1 ? '' : 's'} · {stats.saved} saved · {stats.watched} watched</small>
                <span className="profile-card-state">{isActive ? 'Watching now' : 'Switch profile'}</span>
              </button>
              <div className="profile-card-actions">
                <button className="icon-button" onClick={() => setEditor({ profile })} aria-label={`Edit ${profile.name}`}><Pencil size={15} /></button>
                <button
                  className="icon-button danger"
                  onClick={() => setPendingDelete(deleting ? null : profile.id)}
                  disabled={profiles.length < 2}
                  aria-label={`Delete ${profile.name}`}
                >
                  <Trash2 size={15} />
                </button>
              </div>
              {deleting && (
                <div className="profile-confirm" role="alertdialog" aria-label={`Delete ${profile.name}`}>
                  <p>Delete <b>{profile.name}</b> and everything saved in this profile? This cannot be undone.</p>
                  <div>
                    <button className="button button-secondary button-small" onClick={() => setPendingDelete(null)}>Cancel</button>
                    <button
                      className="button button-small profile-danger"
                      onClick={() => { onDelete(profile.id); setPendingDelete(null); }}
                    >
                      <Trash2 size={14} /> Delete
                    </button>
                  </div>
                </div>
              )}
            </article>
          );
        })}

        <button className="profile-add-card" onClick={() => setEditor({})}>
          <span><Plus size={24} /></span>
          <strong>Add profile</strong>
          <small>Pick a name and upload a display picture</small>
        </button>
      </div>

      <section className="profiles-note">
        <ShieldCheck size={18} />
        <p>
          <strong>Local profiles, private by default</strong>
          Profiles are a convenience for everyone using this browser — they are not accounts and nothing is uploaded.
          Deleting a profile removes its library, history, and sources from this device.
        </p>
      </section>

      {editor && (
        <ProfileEditor
          profile={editor.profile}
          onClose={() => setEditor(null)}
          onSave={(input) => {
            if (editor.profile) onUpdate(editor.profile.id, input);
            else onCreate(input);
            setEditor(null);
          }}
        />
      )}
    </div>
  );
};

export default ProfilesView;
