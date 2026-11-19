/// <reference lib="webworker" />

import { M3uParser } from './iptvService';

const worker = self as unknown as DedicatedWorkerGlobalScope;

worker.onmessage = (event: MessageEvent<string>) => {
  try {
    const channels = M3uParser.parse(event.data || '');
    worker.postMessage({ ok: true, channels });
  } catch (error) {
    worker.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};

export {};