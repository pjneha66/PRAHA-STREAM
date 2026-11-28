import { useEffect, useRef, useState, type RefObject } from 'react';
import { PrahaMedia3 } from '../../services/media3Bridge';
import { PrahaMpv } from '../../services/mpvBridge';
import { fetchGoogleDubVoice, fetchPiperVoice, getDubSpeechEngine, googleDubVoiceAvailable, installPiperVoice, piperVoiceReady, piperVoiceSupported, speakDub, stopDub, translatePlayerDub } from '../../services/dubbing';

interface Props {
  session: string;
  nativeEngine?: 'mpv' | 'media3';
  video: RefObject<HTMLVideoElement | null>;
  playing: boolean;
  rate: number;
  baseVolume: number;
  selected: boolean;
  duck: (enabled: boolean, baseVolume: number) => Promise<void>;
}

export default function PlayerDubbing({ session, nativeEngine, video, playing, rate, baseVolume, selected, duck }: Props) {
  const [enabled, setEnabled] = useState(false);
  const [language, setLanguage] = useState('en');
  const [key, setKey] = useState('');
  const [translation, setTranslation] = useState(false);
  const [voiceMode, setVoiceMode] = useState<'local' | 'google' | 'piper'>('local');
  const [voiceReady, setVoiceReady] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [cue, setCue] = useState('');
  const [error, setError] = useState('');
  const engine = useRef<Awaited<ReturnType<typeof getDubSpeechEngine>>>(null);
  const translated = useRef(new Map<string, string>());
  const clips = useRef(new Map<string, string>());
  const volume = useRef(baseVolume);
  const ducked = useRef(false);
  volume.current = baseVolume;

  useEffect(() => {
    let active = true;
    setVoiceReady(false);
    if (voiceMode === 'piper' && piperVoiceSupported(language)) {
      void piperVoiceReady(language).then((ready) => { if (active) setVoiceReady(ready); }).catch(() => {});
    }
    return () => { active = false; };
  }, [voiceMode, language]);

  useEffect(() => {
    setCue('');
  }, [session, selected, nativeEngine]);

  useEffect(() => {
    if (!enabled || !selected) return;
    let active = true;
    let remove = () => {};
    const accept = (text: string) => {
      if (active) setCue(text.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim());
    };
    if (nativeEngine === 'media3') {
      void PrahaMedia3.addListener('cues', ({ text }) => accept(text)).then((handle) => {
        if (active) remove = () => { void handle.remove(); };
        else void handle.remove();
      }).catch(() => {});
    } else if (nativeEngine === 'mpv') {
      void PrahaMpv.addListener('propertyChange', ({ name, value }) => {
        if (name === 'sub-text') accept(typeof value === 'string' ? value : '');
      }).then(async (handle) => {
        if (!active) { await handle.remove(); return; }
        remove = () => { void handle.remove(); };
        await PrahaMpv.observe({ name: 'sub-text', format: 'string' });
        const { value } = await PrahaMpv.getProperty({ name: 'sub-text' });
        accept(value ?? '');
      }).catch(() => {});
    } else {
      const element = video.current;
      const read = () => {
        const track = element && Array.from<TextTrack>(element.textTracks).find((item) => item.mode === 'showing');
        accept(track ? Array.from<TextTrackCue>(track.activeCues ?? []).map((item) => (item as VTTCue).text || '').join(' ') : '');
      };
      element?.addEventListener('timeupdate', read);
      element?.textTracks.addEventListener('change', read);
      remove = () => {
        element?.removeEventListener('timeupdate', read);
        element?.textTracks.removeEventListener('change', read);
      };
      read();
    }
    return () => { active = false; remove(); };
  }, [enabled, nativeEngine, selected, session, video]);

  useEffect(() => {
    const voice = engine.current;
    if (!enabled || !selected || !playing || !cue || (!voice && voiceMode === 'local')) return;
    let active = true;
    let clip: HTMLAudioElement | undefined;
    const utter = async () => {
      setError('');
      const cacheKey = `${language}:${cue}`;
      let text = translation ? translated.current.get(cacheKey) ?? cue : cue;
      if (translation && !translated.current.has(cacheKey)) {
        text = await translatePlayerDub(cue, language, key.trim());
        if (translated.current.size >= 300) {
          const oldest = translated.current.keys().next().value;
          if (oldest) translated.current.delete(oldest);
        }
        translated.current.set(cacheKey, text);
      }
      if (!active) return;
      if (voiceMode !== 'local') {
        try {
          const clipKey = `${voiceMode}:${language}:${text}`;
          const source = clips.current.get(clipKey) ?? await (voiceMode === 'piper' ? fetchPiperVoice(text, language) : fetchGoogleDubVoice(text, language));
          if (!active) return;
          if (clips.current.size >= 40) {
            const oldest = clips.current.keys().next().value;
            if (oldest) clips.current.delete(oldest);
          }
          clips.current.set(clipKey, source);
          clip = new Audio(source);
          clip.playbackRate = Math.min(2, Math.max(0.75, rate));
          ducked.current = true;
          void duck(true, volume.current);
          clip.onended = () => {
            if (active) {
              ducked.current = false;
              void duck(false, volume.current);
            }
          };
          await clip.play();
          return;
        } catch (cause) {
          if (!voice) throw cause;
        }
      }
      if (!active || !voice) return;
      ducked.current = true;
      void duck(true, volume.current);
      speakDub(voice, { start: 0, end: Math.max(1, text.split(/\s+/).length / 2.6), text }, language, rate);
    };
    void utter().catch((cause: unknown) => {
      if (active) {
        ducked.current = false;
        void duck(false, volume.current);
        setError(cause instanceof Error ? cause.message : 'Could not dub this subtitle.');
      }
    });
    return () => {
      active = false;
      clip?.pause();
      if (ducked.current) {
        ducked.current = false;
        stopDub();
        void duck(false, volume.current);
      }
    };
  }, [cue, duck, enabled, key, language, playing, rate, selected, session, translation, voiceMode]);

  async function toggle() {
    if (enabled) {
      setEnabled(false);
      return;
    }
    engine.current = await getDubSpeechEngine();
    if (!engine.current && voiceMode === 'local') {
      setError('Enable an Android text-to-speech engine or a browser voice to dub subtitles.');
      return;
    }
    if (voiceMode === 'piper' && !voiceReady) return;
    setError('');
    setEnabled(true);
  }

  return <div className="mpv-menu-extra">
    <label>
      <span>Voice language</span>
      <select value={language} disabled={enabled || installing} onChange={(event) => setLanguage(event.target.value)}>
        <option value="en">English</option><option value="hi">Hindi</option><option value="es">Spanish</option>
        <option value="fr">French</option><option value="ja">Japanese</option><option value="ta">Tamil</option>
      </select>
    </label>
    <label><span>Voice engine</span>
      <select value={voiceMode} disabled={enabled || installing} onChange={(event) => setVoiceMode(event.target.value as typeof voiceMode)}>
        <option value="local">Device voice</option>
        {googleDubVoiceAvailable() && <option value="google">Google Translate voice (online)</option>}
        {googleDubVoiceAvailable() && <option value="piper">Piper neural voice (offline)</option>}
      </select>
    </label>
    <label><input type="checkbox" checked={translation} disabled={enabled} onChange={(event) => setTranslation(event.target.checked)} /> Translate subtitles with Google</label>
    {translation && <label><span>Google Cloud Translation key (optional)</span>
      <input type="password" value={key} disabled={enabled} autoComplete="off" onChange={(event) => setKey(event.target.value)} />
    </label>}
    {voiceMode === 'piper' && (piperVoiceSupported(language) ? (!voiceReady && <button type="button" className="mpv-upload-btn" disabled={installing}
      onClick={async () => {
        setError(''); setInstalling(true);
        try {
          if (!await installPiperVoice(language)) throw new Error('Could not install the voice pack.');
          setVoiceReady(true);
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : 'Could not install the voice pack.');
        } finally { setInstalling(false); }
      }}>{installing ? 'Installing voice…' : 'Install voice pack (about 21 MB)'}</button>) : <p>Piper packs are available for English and Hindi.</p>)}
    <button type="button" className="mpv-upload-btn" disabled={voiceMode === 'piper' && !voiceReady} onClick={() => void toggle()}>{enabled ? 'Turn off dubbing' : 'Dub active subtitles'}</button>
    {!selected && <p>Select a subtitle track first.</p>}
    {error && <p role="alert">{error}</p>}
  </div>;
}
