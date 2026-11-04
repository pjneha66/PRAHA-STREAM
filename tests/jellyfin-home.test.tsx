// @vitest-environment jsdom
import React, { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import JellyfinSettings from '../components/JellyfinSettings';
import JellyfinHome from '../components/JellyfinHome';
import type { JellyfinSnapshot } from '../services/jellyfinService';
import { signInJellyfin, listJellyfinItems, signOutJellyfin } from '../services/jellyfinService';

vi.mock('../services/jellyfinService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/jellyfinService')>()),
  signInJellyfin: vi.fn(), listJellyfinItems: vi.fn(), signOutJellyfin: vi.fn(),
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

function Harness() {
  const [snapshot, setSnapshot] = useState<JellyfinSnapshot | null>(null);
  const [home, setHome] = useState(false);
  return <><button onClick={() => setHome(!home)}>Switch page</button>{home
    ? <JellyfinHome snapshot={snapshot} onOpenSettings={() => setHome(false)} />
    : <JellyfinSettings snapshot={snapshot} onSnapshotChange={setSnapshot} />}</>;
}

describe('Jellyfin home', () => {
  it('shows a connected library across navigation without putting the token in the link, and clears it', async () => {
    vi.mocked(signInJellyfin).mockResolvedValue({ token: 'secret', userId: 'user', name: 'Alice' });
    vi.mocked(listJellyfinItems).mockResolvedValue([{ Id: 'item 1', Name: 'My Film', Type: 'Movie', ProductionYear: 2024 }]);
    vi.mocked(signOutJellyfin).mockResolvedValue();
    render(<Harness />);
    fireEvent.change(screen.getByLabelText('Server URL'), { target: { value: 'https://jellyfin.example/base' } });
    fireEvent.change(screen.getByLabelText('Username'), { target: { value: 'Alice' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect and browse' }));
    await screen.findByText(/Alice · 1 titles/);
    expect(signOutJellyfin).toHaveBeenCalledWith('https://jellyfin.example/base', 'secret');
    fireEvent.click(screen.getByRole('button', { name: 'Switch page' }));
    const link = screen.getByRole('link', { name: /My Film/ });
    expect(link.getAttribute('href')).toBe('https://jellyfin.example/base/web/index.html#!/details?id=item%201');
    expect(link.getAttribute('href')).not.toContain('secret');
    fireEvent.click(screen.getByRole('button', { name: 'Switch page' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear session' }));
    fireEvent.click(screen.getByRole('button', { name: 'Switch page' }));
    await waitFor(() => expect(screen.queryByText('My Film')).toBeNull());
  });
});
