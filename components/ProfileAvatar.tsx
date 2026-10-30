import React from 'react';
import type { UserProfile } from '../types';
import { profileInitials } from '../services/profileService';

interface ProfileAvatarProps {
  profile: Pick<UserProfile, 'name' | 'avatar'>;
  size?: number;
  className?: string;
}

const hueFor = (name: string) => {
  const total = [...name].reduce((sum, character) => sum + character.charCodeAt(0), 0);
  return total % 360;
};

/** Renders the uploaded display picture, or a tinted monogram fallback. */
const ProfileAvatar: React.FC<ProfileAvatarProps> = ({ profile, size = 36, className = '' }) => {
  const hue = hueFor(profile.name);
  return (
    <span
      className={`profile-avatar ${className}`}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(10, Math.round(size * 0.34)),
        background: profile.avatar
          ? undefined
          : `linear-gradient(145deg, hsl(${hue} 28% 34%), hsl(${(hue + 42) % 360} 24% 18%))`,
      }}
      aria-hidden={false}
    >
      {profile.avatar
        ? <img src={profile.avatar} alt={`${profile.name} display picture`} />
        : <span>{profileInitials(profile.name)}</span>}
    </span>
  );
};

export default ProfileAvatar;
