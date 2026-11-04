import React, { useState } from 'react';
import { Check, Users } from 'lucide-react';
import type { UserProfile } from '../types';

const ProfilePicker: React.FC<{
  profiles: UserProfile[];
  activeProfile: UserProfile;
  onContinue: (profileId: string) => void;
}> = ({ profiles, activeProfile, onContinue }) => {
  const [selectedId, setSelectedId] = useState(activeProfile.id);

  return (
    <div className="profile-picker-backdrop">
      <section className="profile-picker" role="dialog" aria-modal="true" aria-labelledby="profile-picker-title">
        <div className="profile-picker-icon"><Users size={22} /></div>
        <span className="page-kicker">PRAHA STREAM · PROFILES</span>
        <h1 id="profile-picker-title">Who’s watching?</h1>
        <p>Choose a profile to load its own library and watch history.</p>
        <div className="profile-picker-list" role="radiogroup" aria-label="Choose a profile">
          {profiles.map((profile) => {
            const selected = profile.id === selectedId;
            return (
              <button
                key={profile.id}
                type="button"
                role="radio"
                aria-checked={selected}
                className={`profile-picker-option ${selected ? 'selected' : ''}`}
                onClick={() => setSelectedId(profile.id)}
              >
                <span className="avatar" style={{ background: profile.avatarColor, color: '#11150c' }}>{profile.name.trim().charAt(0).toUpperCase() || 'P'}</span>
                <span className="profile-picker-copy"><strong>{profile.name}</strong><small>{profile.isKids ? 'Kids profile' : 'Standard profile'}</small></span>
                {selected && <Check size={18} />}
              </button>
            );
          })}
        </div>
        <button className="button button-primary profile-picker-continue" onClick={() => onContinue(selectedId)}>
          Continue as {profiles.find((profile) => profile.id === selectedId)?.name || activeProfile.name}
        </button>
        <small className="profile-picker-note">Add or manage profiles anytime in Settings.</small>
      </section>
    </div>
  );
};

export default ProfilePicker;
