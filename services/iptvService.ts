// Live TV / IPTV service barrel.
//
// The previous 1,892-line hand-written engine has been replaced by the
// VyseTV TypeScript port under `services/liveTv/`. This file keeps the
// integration surface used by App.tsx, PlayerModal.tsx, m3uWorker.ts and the
// Live TV view; all implementation lives in the ported modules.

export * from './liveTv/index';
