import React, { ChangeEvent, FormEvent, useEffect, useRef, useState } from 'react';
import { Camera, Check, ImagePlus, Link2, Pencil, Plus, Trash2, X } from 'lucide-react';
import type { ProfileAvatarIcon, UserProfile } from '../types';

export const PROFILE_PALETTE = [
  '#e50914', // Netflix Crimson
  '#0071eb', // Cobalt Blue
  '#2ebd59', // Emerald Green
  '#f5b50a', // Amber Gold
  '#8b5cf6', // Electric Violet
  '#ec4899', // Hot Rose
  '#14b8a6', // Ocean Teal
  '#d6f77a', // PRAHA Lime
] as const;

export const PROFILE_FACES: Array<{ id: ProfileAvatarIcon; label: string }> = [
  { id: 'classic', label: 'Classic Smile' },
  { id: 'cool', label: 'Sunglasses' },
  { id: 'wink', label: 'Playful Wink' },
  { id: 'joy', label: 'Big Grin' },
  { id: 'hero', label: 'Star Eyes' },
  { id: 'kids', label: 'Kids Buddy' },
];

function isLightHex(hex: string): boolean {
  const clean = hex.replace('#', '');
  if (clean.length !== 6) return false;
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.66;
}

function defaultFaceForProfile(profile: Pick<UserProfile, 'id' | 'name' | 'isKids' | 'avatarIcon'>, index = 0): ProfileAvatarIcon {
  if (profile.avatarIcon) return profile.avatarIcon;
  if (profile.isKids) return 'kids';
  const order: ProfileAvatarIcon[] = ['classic', 'cool', 'wink', 'joy', 'hero'];
  const hash = (profile.id || profile.name || '').split('').reduce((acc, ch) => acc + ch.charCodeAt(0), index);
  return order[hash % order.length];
}

function isValidAvatarUrl(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('data:image/')) return true;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

export async function readAndResizeAvatarFile(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) {
    throw new Error('Please choose an image file (PNG, JPG, WebP, or GIF).');
  }
  if (file.size > 12 * 1024 * 1024) {
    throw new Error('Image is too large (max 12 MB).');
  }

  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') resolve(reader.result);
      else reject(new Error('Could not read image file.'));
    };
    reader.onerror = () => reject(new Error('Could not read image file.'));
    reader.readAsDataURL(file);
  });

  const env = (import.meta as unknown as { env?: Record<string, string | boolean | undefined> }).env || {};
  if (env.MODE === 'test' || file.type === 'image/gif' || file.type === 'image/svg+xml') {
    return dataUrl;
  }

  try {
    const resized = await new Promise<string>((resolve, reject) => {
      const img = new Image();
      const timeout = window.setTimeout(() => reject(new Error('Image decode timed out')), 4000);
      img.onload = () => {
        window.clearTimeout(timeout);
        try {
          const targetSize = 256;
          const canvas = document.createElement('canvas');
          canvas.width = targetSize;
          canvas.height = targetSize;
          const ctx = canvas.getContext('2d');
          if (!ctx) {
            resolve(dataUrl);
            return;
          }
          const side = Math.min(img.naturalWidth || targetSize, img.naturalHeight || targetSize);
          const sx = Math.max(0, ((img.naturalWidth || side) - side) / 2);
          const sy = Math.max(0, ((img.naturalHeight || side) - side) / 2);
          ctx.drawImage(img, sx, sy, side, side, 0, 0, targetSize, targetSize);
          let encoded = canvas.toDataURL('image/webp', 0.86);
          if (!encoded.startsWith('data:image/webp')) {
            encoded = canvas.toDataURL('image/jpeg', 0.86);
          }
          resolve(encoded);
        } catch {
          resolve(dataUrl);
        }
      };
      img.onerror = () => {
        window.clearTimeout(timeout);
        resolve(dataUrl);
      };
      img.src = dataUrl;
    });
    return resized;
  } catch {
    return dataUrl;
  }
}

export const ProfileAvatar: React.FC<{
  profile: Pick<UserProfile, 'id' | 'name' | 'avatarColor' | 'avatarIcon' | 'avatarImage' | 'isKids'>;
  size?: 'xs' | 'sm' | 'md' | 'lg';
  index?: number;
  className?: string;
}> = ({ profile, size = 'lg', index = 0, className = '' }) => {
  const baseColor = profile.avatarColor || PROFILE_PALETTE[0];
  const ink = isLightHex(baseColor) ? '#14161a' : '#ffffff';
  const face = defaultFaceForProfile(profile, index);
  const customImg = profile.avatarImage?.trim() || '';
  const [imgBroken, setImgBroken] = useState(false);

  useEffect(() => {
    setImgBroken(false);
  }, [customImg]);

  const showPhoto = Boolean(customImg) && !imgBroken && isValidAvatarUrl(customImg);

  return (
    <span
      className={`nf-avatar nf-avatar-${size} ${showPhoto ? 'nf-avatar-has-photo' : ''} ${className}`.trim()}
      style={{ '--nf-avatar-bg': baseColor, '--nf-avatar-ink': ink } as React.CSSProperties}
      aria-hidden="true"
    >
      {showPhoto ? (
        <img
          src={customImg}
          alt=""
          className="nf-avatar-photo"
          referrerPolicy="no-referrer"
          decoding="async"
          onError={() => setImgBroken(true)}
        />
      ) : (
        <svg viewBox="0 0 100 100" className="nf-avatar-svg" focusable="false">
          <defs>
            <linearGradient id={`gloss-${profile.id || index}-${size}`} x1="0" y1="0" x2="1" y2="1">
              <stop offset="0%" stopColor="#ffffff" stopOpacity="0.22" />
              <stop offset="48%" stopColor="#ffffff" stopOpacity="0.03" />
              <stop offset="100%" stopColor="#000000" stopOpacity="0.28" />
            </linearGradient>
          </defs>
          <rect x="0" y="0" width="100" height="100" fill={`url(#gloss-${profile.id || index}-${size})`} />

          {face === 'classic' && (
            <g stroke={ink} fill="none" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="32" cy="39" r="5.2" fill={ink} stroke="none" />
              <circle cx="68" cy="39" r="5.2" fill={ink} stroke="none" />
              <path d="M 27 60 Q 50 79 73 58" strokeWidth="6.2" />
            </g>
          )}

          {face === 'cool' && (
            <g stroke={ink} fill="none" strokeLinecap="round" strokeLinejoin="round">
              <rect x="18" y="31" width="27" height="17" rx="5" fill={ink} />
              <rect x="55" y="31" width="27" height="17" rx="5" fill={ink} />
              <path d="M 45 37 L 55 37" strokeWidth="4.5" />
              <path d="M 13 35 L 18 36 M 82 36 L 87 35" strokeWidth="4" />
              <path d="M 33 65 Q 53 74 70 60" strokeWidth="5.8" />
            </g>
          )}

          {face === 'wink' && (
            <g stroke={ink} fill="none" strokeLinecap="round" strokeLinejoin="round">
              <path d="M 24 40 Q 32 32 40 40" strokeWidth="5.6" />
              <circle cx="68" cy="39" r="5.4" fill={ink} stroke="none" />
              <path d="M 28 59 Q 50 78 72 59" strokeWidth="6" />
            </g>
          )}

          {face === 'joy' && (
            <g stroke={ink} fill="none" strokeLinecap="round" strokeLinejoin="round">
              <path d="M 23 41 Q 32 30 41 41" strokeWidth="5.6" />
              <path d="M 59 41 Q 68 30 77 41" strokeWidth="5.6" />
              <path d="M 27 57 Q 50 82 73 57 Z" fill={ink} strokeWidth="3.5" />
            </g>
          )}

          {face === 'hero' && (
            <g fill={ink} stroke={ink} strokeLinecap="round" strokeLinejoin="round">
              <polygon points="32,29 34.8,36.2 42.5,36.6 36.4,41.3 38.5,48.8 32,44.4 25.5,48.8 27.6,41.3 21.5,36.6 29.2,36.2" stroke="none" />
              <polygon points="68,29 70.8,36.2 78.5,36.6 72.4,41.3 74.5,48.8 68,44.4 61.5,48.8 63.6,41.3 57.5,36.6 65.2,36.2" stroke="none" />
              <path d="M 30 62 Q 50 77 70 62" fill="none" strokeWidth="6" />
            </g>
          )}

          {face === 'kids' && (
            <g stroke={ink} fill="none" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="33" cy="39" r="6.8" fill={ink} stroke="none" />
              <circle cx="67" cy="39" r="6.8" fill={ink} stroke="none" />
              <circle cx="31" cy="37" r="2.2" fill={baseColor} stroke="none" />
              <circle cx="65" cy="37" r="2.2" fill={baseColor} stroke="none" />
              <path d="M 28 58 Q 50 80 72 58" strokeWidth="6.4" />
            </g>
          )}
        </svg>
      )}
      {profile.isKids && size === 'lg' && <em className="nf-kids-pill">KIDS</em>}
    </span>
  );
};

export interface ProfilePickerProps {
  profiles: UserProfile[];
  activeProfile: UserProfile;
  onContinue: (profileId: string) => void;
  onCreateProfile?: (
    name: string,
    avatarColor: string,
    isKids: boolean,
    avatarIcon?: ProfileAvatarIcon,
    avatarImage?: string,
  ) => UserProfile | void;
  onUpdateProfile?: (
    profileId: string,
    patch: Partial<Pick<UserProfile, 'name' | 'avatarColor' | 'isKids' | 'avatarIcon' | 'avatarImage'>>,
  ) => void;
  onDeleteProfile?: (profileId: string) => void;
  canDismiss?: boolean;
  onDismiss?: () => void;
}

type ScreenMode = 'browse' | 'add' | 'edit';

const ProfilePicker: React.FC<ProfilePickerProps> = ({
  profiles,
  activeProfile,
  onContinue,
  onCreateProfile,
  onUpdateProfile,
  onDeleteProfile,
  canDismiss = false,
  onDismiss,
}) => {
  const [mode, setMode] = useState<ScreenMode>('browse');
  const [isManaging, setIsManaging] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const [draftName, setDraftName] = useState('');
  const [draftColor, setDraftColor] = useState<string>(PROFILE_PALETTE[1]);
  const [draftFace, setDraftFace] = useState<ProfileAvatarIcon>('cool');
  const [draftImage, setDraftImage] = useState('');
  const [draftImageUrlInput, setDraftImageUrlInput] = useState('');
  const [draftKids, setDraftKids] = useState(false);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [formError, setFormError] = useState('');
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (mode !== 'browse') {
        setMode('browse');
        setFormError('');
      } else if (isManaging) {
        setIsManaging(false);
      } else if (canDismiss && onDismiss) {
        onDismiss();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [mode, isManaging, canDismiss, onDismiss]);

  const openAddForm = () => {
    const nextColor = PROFILE_PALETTE[profiles.length % PROFILE_PALETTE.length];
    const nextFace = PROFILE_FACES[profiles.length % PROFILE_FACES.length].id;
    setDraftName('');
    setDraftColor(nextColor);
    setDraftFace(nextFace);
    setDraftImage('');
    setDraftImageUrlInput('');
    setDraftKids(false);
    setFormError('');
    setMode('add');
  };

  const openEditForm = (profile: UserProfile, index: number) => {
    setEditingId(profile.id);
    setDraftName(profile.name);
    setDraftColor(profile.avatarColor || PROFILE_PALETTE[0]);
    setDraftFace(defaultFaceForProfile(profile, index));
    const existingImg = profile.avatarImage || '';
    setDraftImage(existingImg);
    setDraftImageUrlInput(existingImg.startsWith('data:') ? '' : existingImg);
    setDraftKids(Boolean(profile.isKids));
    setFormError('');
    setMode('edit');
  };

  const handleFilePicked = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setUploadingPhoto(true);
    setFormError('');
    try {
      const encoded = await readAndResizeAvatarFile(file);
      setDraftImage(encoded);
      setDraftImageUrlInput('');
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Could not load that image.');
    } finally {
      setUploadingPhoto(false);
    }
  };

  const handleImageUrlChange = (value: string) => {
    setDraftImageUrlInput(value);
    const trimmed = value.trim();
    if (!trimmed) {
      if (!draftImage.startsWith('data:')) setDraftImage('');
      return;
    }
    if (isValidAvatarUrl(trimmed)) {
      setDraftImage(trimmed);
      if (formError) setFormError('');
    }
  };

  const clearCustomImage = () => {
    setDraftImage('');
    setDraftImageUrlInput('');
  };

  const handleSaveNew = (event: FormEvent) => {
    event.preventDefault();
    const clean = draftName.trim();
    if (!clean) {
      setFormError('Please enter a profile name.');
      return;
    }
    if (draftImageUrlInput.trim() && !isValidAvatarUrl(draftImageUrlInput)) {
      setFormError('Custom image URL must start with https:// or http://.');
      return;
    }
    const icon = draftKids && draftFace === 'classic' ? 'kids' : draftFace;
    onCreateProfile?.(clean, draftColor, draftKids, icon, draftImage || undefined);
    setMode('browse');
    setFormError('');
  };

  const handleSaveEdit = (event: FormEvent) => {
    event.preventDefault();
    if (!editingId) return;
    const clean = draftName.trim();
    if (!clean) {
      setFormError('Please enter a profile name.');
      return;
    }
    if (draftImageUrlInput.trim() && !isValidAvatarUrl(draftImageUrlInput)) {
      setFormError('Custom image URL must start with https:// or http://.');
      return;
    }
    onUpdateProfile?.(editingId, {
      name: clean,
      avatarColor: draftColor,
      avatarIcon: draftFace,
      avatarImage: draftImage || undefined,
      isKids: draftKids,
    });
    setEditingId(null);
    setMode('browse');
    setFormError('');
  };

  const handleDelete = () => {
    if (!editingId || editingId === 'default') return;
    onDeleteProfile?.(editingId);
    setEditingId(null);
    setMode('browse');
  };

  const titleText = mode === 'add'
    ? 'Add Profile'
    : mode === 'edit'
      ? 'Edit Profile'
      : isManaging
        ? 'Manage Profiles:'
        : 'Who’s watching?';

  return (
    <div className="profile-picker-backdrop">
      <header className="nf-gate-topbar">
        <div className="brand nf-gate-brand" aria-hidden="true">
          <span className="brand-mark"><span /></span>
          <span className="brand-word">PRAHA<span>STREAM</span></span>
        </div>
        {canDismiss && onDismiss && mode === 'browse' && (
          <button
            type="button"
            className="nf-gate-close"
            onClick={onDismiss}
            aria-label="Close profile switcher"
          >
            <X size={20} />
          </button>
        )}
      </header>

      <section
        className={`nf-gate-stage ${mode !== 'browse' ? 'nf-gate-stage-form' : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="profile-picker-title"
      >
        {mode === 'browse' ? (
          <>
            <h1 id="profile-picker-title" className="nf-gate-title">{titleText}</h1>

            <div className="nf-profile-list" role="list" aria-label="Profiles">
              {profiles.map((profile, index) => {
                const isCurrent = profile.id === activeProfile.id;
                return (
                  <div className="nf-profile-item" role="listitem" key={profile.id}>
                    <button
                      type="button"
                      className={`nf-profile-tile ${isManaging ? 'managing' : ''} ${isCurrent && canDismiss ? 'current' : ''}`}
                      onClick={() => {
                        if (isManaging) {
                          openEditForm(profile, index);
                        } else {
                          onContinue(profile.id);
                        }
                      }}
                      aria-label={isManaging ? `Edit ${profile.name}` : profile.name}
                    >
                      <span className="nf-profile-avatar-wrap">
                        <ProfileAvatar profile={profile} size="lg" index={index} />
                        {isManaging && (
                          <span className="nf-edit-scrim" aria-hidden="true">
                            <span className="nf-edit-badge"><Pencil size={20} /></span>
                          </span>
                        )}
                      </span>
                      <span className="nf-profile-name">{profile.name}</span>
                      {profile.isKids && <span className="nf-profile-sub">Kids</span>}
                    </button>
                  </div>
                );
              })}

              {onCreateProfile && profiles.length < 6 && (
                <div className="nf-profile-item" role="listitem">
                  <button
                    type="button"
                    className="nf-profile-tile nf-add-tile"
                    onClick={openAddForm}
                    aria-label="Add Profile"
                  >
                    <span className="nf-profile-avatar-wrap nf-add-box" aria-hidden="true">
                      <span className="nf-add-circle"><Plus size={38} strokeWidth={2.2} /></span>
                    </span>
                    <span className="nf-profile-name">Add Profile</span>
                  </button>
                </div>
              )}
            </div>

            <div className="nf-gate-actions">
              {(onUpdateProfile || onCreateProfile || onDeleteProfile) ? (
                <button
                  type="button"
                  className={`nf-manage-button ${isManaging ? 'done' : ''}`}
                  onClick={() => setIsManaging((prev) => !prev)}
                >
                  {isManaging ? 'Done' : 'Manage Profiles'}
                </button>
              ) : (
                <button
                  type="button"
                  className="nf-manage-button done"
                  onClick={() => onContinue(activeProfile.id)}
                >
                  Continue as {activeProfile.name}
                </button>
              )}
            </div>
          </>
        ) : (
          <form className="nf-profile-editor" onSubmit={mode === 'add' ? handleSaveNew : handleSaveEdit}>
            <h1 id="profile-picker-title" className="nf-editor-title">{titleText}</h1>
            <p className="nf-editor-sub">
              {mode === 'add'
                ? 'Add a profile for another person watching PRAHA STREAM.'
                : 'Personalize this profile’s name, custom photo or avatar icon, and watchlist space.'}
            </p>

            <div className="nf-editor-body">
              <div className="nf-editor-preview">
                <button
                  type="button"
                  className="nf-avatar-upload-trigger"
                  onClick={() => fileInputRef.current?.click()}
                  title="Upload custom profile image"
                  aria-label="Upload custom profile image"
                >
                  <ProfileAvatar
                    profile={{
                      id: editingId || 'draft',
                      name: draftName || 'Profile',
                      avatarColor: draftColor,
                      avatarIcon: draftFace,
                      avatarImage: draftImage || undefined,
                      isKids: draftKids,
                    }}
                    size="lg"
                  />
                  <span className="nf-avatar-camera-badge" aria-hidden="true">
                    <Camera size={15} />
                  </span>
                </button>
                <span className="nf-preview-caption">
                  {draftImage ? 'Custom photo' : 'Click to upload'}
                </span>
              </div>

              <div className="nf-editor-fields">
                <input
                  type="text"
                  className="nf-editor-input"
                  aria-label="Profile name"
                  placeholder="Name"
                  value={draftName}
                  maxLength={24}
                  autoFocus
                  onChange={(event) => {
                    setDraftName(event.target.value);
                    if (formError) setFormError('');
                  }}
                />

                <div className="nf-picker-group nf-photo-picker-group">
                  <span className="nf-picker-label">Custom profile image</span>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    className="nf-hidden-file"
                    aria-label="Upload custom profile photo"
                    onChange={handleFilePicked}
                  />
                  <div className="nf-photo-actions">
                    <button
                      type="button"
                      className="nf-photo-btn"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={uploadingPhoto}
                    >
                      <ImagePlus size={15} />
                      {uploadingPhoto ? 'Processing…' : draftImage ? 'Change photo' : 'Upload image'}
                    </button>
                    {draftImage && (
                      <button
                        type="button"
                        className="nf-photo-btn nf-photo-btn-clear"
                        onClick={clearCustomImage}
                      >
                        <X size={14} /> Remove photo
                      </button>
                    )}
                  </div>
                  <div className="nf-photo-url-row">
                    <Link2 size={14} />
                    <input
                      type="url"
                      aria-label="Custom image URL"
                      placeholder="Or paste image URL (https://…)"
                      value={draftImageUrlInput}
                      onChange={(event) => handleImageUrlChange(event.target.value)}
                    />
                  </div>
                </div>

                <label className="nf-kids-toggle">
                  <input
                    type="checkbox"
                    checked={draftKids}
                    onChange={(event) => {
                      const nextKids = event.target.checked;
                      setDraftKids(nextKids);
                      if (nextKids) setDraftFace('kids');
                    }}
                  />
                  <span>
                    <strong>Kid?</strong>
                    <small>Displays the KIDS badge with a dedicated watchlist & history</small>
                  </span>
                </label>

                <div className="nf-picker-group">
                  <span className="nf-picker-label">Avatar color</span>
                  <div className="nf-color-swatches">
                    {PROFILE_PALETTE.map((color) => (
                      <button
                        key={color}
                        type="button"
                        className={`nf-color-swatch ${draftColor.toLowerCase() === color.toLowerCase() ? 'active' : ''}`}
                        style={{ background: color }}
                        onClick={() => setDraftColor(color)}
                        aria-label={`Color ${color}`}
                      >
                        {draftColor.toLowerCase() === color.toLowerCase() && (
                          <Check size={14} color={isLightHex(color) ? '#14161a' : '#ffffff'} />
                        )}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="nf-picker-group">
                  <span className="nf-picker-label">Expression {draftImage ? '(used if photo is removed)' : ''}</span>
                  <div className="nf-face-picks">
                    {PROFILE_FACES.map((face) => (
                      <button
                        key={face.id}
                        type="button"
                        className={`nf-face-pick ${draftFace === face.id && !draftImage ? 'active' : ''}`}
                        onClick={() => {
                          setDraftFace(face.id);
                          if (draftImage) clearCustomImage();
                        }}
                        aria-label={face.label}
                        title={face.label}
                      >
                        <ProfileAvatar
                          profile={{
                            id: `pick-${face.id}`,
                            name: face.label,
                            avatarColor: draftColor,
                            avatarIcon: face.id,
                          }}
                          size="sm"
                        />
                      </button>
                    ))}
                  </div>
                </div>

                {formError && <p className="nf-editor-error" role="alert">{formError}</p>}
              </div>
            </div>

            <div className="nf-editor-footer">
              <button type="submit" className="nf-btn-solid">Save</button>
              <button
                type="button"
                className="nf-btn-outline"
                onClick={() => {
                  setMode('browse');
                  setEditingId(null);
                  setFormError('');
                }}
              >
                Cancel
              </button>
              {mode === 'edit' && editingId && editingId !== 'default' && onDeleteProfile && (
                <button type="button" className="nf-btn-outline nf-btn-danger" onClick={handleDelete}>
                  <Trash2 size={15} /> Delete Profile
                </button>
              )}
            </div>
          </form>
        )}
      </section>
    </div>
  );
};

export default ProfilePicker;
