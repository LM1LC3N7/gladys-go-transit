// -----------------------------------------------------------------------------
// The state kept in /data (the only writable place of the container): the
// calls of the last hour, the pause after a 429/5xx, the refused key (8 bits
// of a salted hash, never the key), the time of the last read of each source,
// the alerts already announced and the list of stops. A small JSON file,
// written through a temporary file and a rename, one save after the other.
//
// A missing file is an empty state; a file that cannot be read (error, too
// large, not JSON, too slow) is NOT: `load` says so, the app reads it again on
// its own timer and never writes over it meanwhile.
// -----------------------------------------------------------------------------

import { readFile, rename, writeFile } from 'node:fs/promises';
import { STORE_TIMEOUT_MS } from './constants.js';

export const DEFAULT_STATE_FILE = '/data/go-transit-state.json';
const MAX_STATE_BYTES = 512 * 1024;

const withTimeout = (promise, ms, timers) =>
  new Promise((resolve, reject) => {
    const timer = timers.setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (value) => {
        timers.clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        timers.clearTimeout(timer);
        reject(err);
      },
    );
  });

/**
 * @returns {{ load(): Promise<{ ok: true, data: object } | { ok: false, reason: string }>, save(data: object): Promise<void> }}
 */
export function createFileStore(
  file = DEFAULT_STATE_FILE,
  { timers = globalThis, timeoutMs = STORE_TIMEOUT_MS } = {},
) {
  let queue = Promise.resolve();
  const write = async (data) => {
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(data), 'utf8');
    await rename(tmp, file);
  };
  return {
    async load() {
      let text;
      try {
        text = await withTimeout(readFile(file), timeoutMs, timers);
      } catch (err) {
        if (err?.code === 'ENOENT') return { ok: true, data: {} };
        return { ok: false, reason: err?.message === 'timeout' ? 'timeout' : 'read' };
      }
      if (text.length > MAX_STATE_BYTES) return { ok: false, reason: 'size' };
      try {
        const data = JSON.parse(text.toString('utf8'));
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
          return { ok: false, reason: 'format' };
        }
        return { ok: true, data };
      } catch {
        return { ok: false, reason: 'format' };
      }
    },
    save(data) {
      const snapshot = JSON.parse(JSON.stringify(data));
      const job = queue.then(
        () => withTimeout(write(snapshot), timeoutMs, timers),
        () => withTimeout(write(snapshot), timeoutMs, timers),
      );
      queue = job.catch(() => {});
      return job;
    },
  };
}

/** The same in memory (tests): `fail` makes the loads or the saves fail. */
export function createMemoryStore(initial = {}) {
  const store = {
    data: structuredClone(initial),
    failLoad: false,
    failSave: false,
    loads: 0,
    saves: 0,
    async load() {
      store.loads += 1;
      if (store.failLoad) return { ok: false, reason: 'read' };
      return { ok: true, data: structuredClone(store.data) };
    },
    async save(next) {
      store.saves += 1;
      if (store.failSave) throw new Error('disk full');
      store.data = structuredClone(next);
    },
  };
  return store;
}
