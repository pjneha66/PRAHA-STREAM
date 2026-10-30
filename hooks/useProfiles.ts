import { useCallback, useMemo, useState } from 'react';
import type { UserProfile } from '../types';
import {
  clearProfileData, createProfileId, loadProfiles, saveActiveProfileId, saveProfiles,
  seedProfileData, type ProfileState,
} from '../services/profileService';

export interface ProfileInput {
  name: string;
  avatar?: string;
}

/**
 * Owns the local profile list and the active profile. Every profile-scoped
 * hook in the workspace re-reads its data when the active profile changes,
 * because App remounts the workspace with `key={activeProfile.id}`.
 */
export function useProfiles() {
  const [state, setState] = useState<ProfileState>(() => loadProfiles());

  const commit = useCallback((profiles: UserProfile[], activeId: string) => {
    saveProfiles(profiles);
    saveActiveProfileId(activeId);
    setState({ profiles, activeId });
  }, []);

  const activeProfile = useMemo(
    () => state.profiles.find((profile) => profile.id === state.activeId) || state.profiles[0],
    [state],
  );

  const switchProfile = useCallback((id: string) => {
    if (!state.profiles.some((profile) => profile.id === id) || state.activeId === id) return;
    saveActiveProfileId(id);
    setState((current) => ({ ...current, activeId: id }));
  }, [state]);

  /** Creates a profile, inherits the current preferences, and switches to it. */
  const addProfile = useCallback((input: ProfileInput) => {
    const now = Date.now();
    const profile: UserProfile = {
      id: createProfileId(),
      name: input.name.trim() || 'New profile',
      ...(input.avatar ? { avatar: input.avatar } : {}),
      createdAt: now,
      updatedAt: now,
    };
    seedProfileData(profile.id, state.activeId);
    commit([...state.profiles, profile], profile.id);
    return profile;
  }, [commit, state]);

  const updateProfile = useCallback((id: string, patch: Partial<ProfileInput>) => {
    const profiles = state.profiles.map((profile) => profile.id === id
      ? {
          ...profile,
          ...(patch.name !== undefined ? { name: patch.name.trim() || profile.name } : {}),
          ...(patch.avatar !== undefined ? { avatar: patch.avatar || undefined } : {}),
          updatedAt: Date.now(),
        }
      : profile);
    commit(profiles, state.activeId);
  }, [commit, state]);

  /** Removes a profile and every piece of profile-scoped data it owns. */
  const deleteProfile = useCallback((id: string) => {
    if (state.profiles.length <= 1) return;
    clearProfileData(id);
    const profiles = state.profiles.filter((profile) => profile.id !== id);
    commit(profiles, state.activeId === id ? profiles[0].id : state.activeId);
  }, [commit, state]);

  return {
    profiles: state.profiles,
    activeProfile,
    activeId: state.activeId,
    switchProfile,
    addProfile,
    updateProfile,
    deleteProfile,
  };
}
