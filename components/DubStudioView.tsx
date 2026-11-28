import { useEffect, useRef, useState } from 'react';
import { getDubSpeechEngine, parseDubCues, speakDub, stopDub, translateDubCues, type DubCue, type DubSpeechEngine } from '../services/dubbing';

const languages = [
  ['en', 'English'], ['hi', 'Hindi'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'],
  ['pt', 'Portuguese'], ['ja', 'Japanese'], ['ko', 'Korean'], ['ar', 'Arabic'],
  ['ta', 'Tamil'], ['te', 'Telugu'], ['bn', 'Bengali'],
];

export default function DubStudioView() {
  const video = useRef<HTMLVideoElement>(null);
  const active = useRef<DubCue | null>(null);
  const audio = useRef<{ ctx: AudioContext; gain: GainNode; source: MediaElementAudioSourceNode } | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [url, setUrl] = useState('');
  const [cues, setCues] = useState<DubCue[]>([]);
  const [voiceCues, setVoiceCues] = useState<DubCue[]>([]);
  const [language, setLanguage] = useState('en');
  const [key, setKey] = useState('');
  const [translate, setTranslate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [line, setLine] = useState('');
  const [engine, setEngine] = useState<DubSpeechEngine | null>();
  useEffect(() => {
    let active = true;
    const update = () => void getDubSpeechEngine().then((result) => { if (active) setEngine(result); });
    update();
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.addEventListener('voiceschanged', update);
    return () => {
      active = false;
      if (typeof speechSynthesis !== 'undefined') speechSynthesis.removeEventListener('voiceschanged', update);
    };
  }, []);

  useEffect(() => {
    if (!file) return;
    const next = URL.createObjectURL(file);
    setUrl(next);
    return () => URL.revokeObjectURL(next);
  }, [file]);

  useEffect(() => () => {
    stopDub();
    void audio.current?.ctx.close();
  }, []);

  function restore() {
    stopDub();
    active.current = null;
    setLine('');
    const graph = audio.current;
    graph?.gain.gain.setTargetAtTime(1, graph.ctx.currentTime, 0.035);
  }

  const sync = () => {
    const player = video.current;
    if (!player || player.paused || player.seeking || !voiceCues.length || !engine) return;
    const now = player.currentTime;
    const cue = voiceCues.find((item) => item.start <= now && now < item.end);
    if ((cue ?? null) === active.current) return;
    restore();
    if (!cue) return;
    active.current = cue;
    setLine(cue.text);
    const graph = audio.current;
    graph?.gain.gain.setTargetAtTime(0.27, graph.ctx.currentTime, 0.035);
    speakDub(engine, cue, language, player.playbackRate);
  };

  const prepare = async () => {
    if (!video.current || !engine) return;
    restore();
    video.current.pause();
    setVoiceCues([]);
    setError('');
    setBusy(true);
    try {
      if (!audio.current) {
        const ctx = new AudioContext();
        const gain = ctx.createGain();
        const source = ctx.createMediaElementSource(video.current);
        source.connect(gain).connect(ctx.destination);
        audio.current = { ctx, gain, source };
      }
      await audio.current.ctx.resume();
      setVoiceCues(translate ? await translateDubCues(cues, language, key.trim()) : cues);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not prepare the dub.');
    } finally {
      setBusy(false);
    }
  };

  function resetDub() {
    video.current?.pause();
    restore();
    setVoiceCues([]);
  }

  return <section className="standard-page">
    <h1>AI Dubbing</h1>
    <p>For a stream, open <strong>Subtitles → AI Dubbing</strong> in the video player. It offers device voices, an online Google voice, and downloadable English and Hindi Piper voices on Android.</p>
    <p>Choose a local video and a subtitle file. PRAHA reads each cue aloud and lowers the video audio while the voice plays.</p>
    <div className="install-panel">
      <div className="directory-actions">
        <label>Video <input type="file" accept="video/*,.mkv" disabled={busy} onChange={(event) => {
          resetDub();
          setFile(event.target.files?.[0] ?? null);
        }} /></label>
        <label>Subtitles <input type="file" accept=".srt,.vtt,.ass,.ssa" disabled={busy} onChange={async (event) => {
          resetDub();
          setError('');
          setCues([]);
          const subtitle = event.target.files?.[0];
          if (!subtitle) return;
          try {
            const parsed = parseDubCues(await subtitle.text());
            setCues(parsed);
            if (!parsed.length) setError('The subtitle file contains no readable cues.');
          } catch {
            setError('Could not read the subtitle file.');
          }
        }} /></label>
      </div>
      <div className="directory-actions">
        <label>Voice language <select className="reading-select" value={language} disabled={busy} onChange={(event) => {
          resetDub();
          setLanguage(event.target.value);
        }}>{languages.map(([value, name]) => <option key={value} value={value}>{name}</option>)}</select></label>
        <label><input type="checkbox" checked={translate} disabled={busy} onChange={(event) => {
          resetDub();
          setTranslate(event.target.checked);
        }} /> Translate subtitle text with Google</label>
        {translate && <label>Google Cloud API key <input type="password" autoComplete="off" value={key} disabled={busy} onChange={(event) => setKey(event.target.value)} /></label>}
      </div>
      <div className="directory-actions">
        <button className="button button-primary" disabled={busy || !file || !cues.length || !engine || (translate && !key.trim())}
          onClick={() => void prepare()}>{busy ? 'Preparing…' : 'Prepare dub'}</button>
        {voiceCues.length > 0 && <><button className="button button-secondary" onClick={resetDub}>Turn off dub</button><span role="status">{voiceCues.length} cues ready. Press Play.</span></>}
      </div>
      {error && <p role="alert">{error}</p>}
      {engine === null && <p>No speech engine is available. Install or enable a text-to-speech engine on this device.</p>}
    </div>
    <video ref={video} controls playsInline src={url || undefined} onPlay={sync} onTimeUpdate={sync}
      onPause={restore} onSeeking={restore} onSeeked={sync} onWaiting={restore} onEnded={restore}
      onError={() => setError('This video could not play on this device.')}
      style={{ display: url ? 'block' : 'none', width: '100%', maxHeight: '65vh', background: '#000' }} />
    {line && <p>{line}</p>}
  </section>;
}
