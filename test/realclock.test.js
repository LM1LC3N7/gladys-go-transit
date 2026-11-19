// -----------------------------------------------------------------------------
// The app on a REAL moving clock (performance.now, Date.now, setTimeout) and a
// real local HTTP server playing the GO API: the reads really start at 0, the
// interval and twice the interval, never sooner, with a bounded number of
// timers. Time sped up 40 times (the 60 s interval lasts 1.5 s).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { GoApp } from '../src/app.js';
import { createMemoryStore } from '../src/store.js';
import { CONFIG, SELECTOR, board, createdDevices, departure } from './helpers/harness.js';

const SPEED = 40;
const INTERVAL = 60_000;

test('real clock: reads at 0, the interval and twice the interval; timers bounded', async (t) => {
  const reads = [];
  const server = createServer((req, res) => {
    const now = Date.now();
    if (req.url.includes('/NextService/')) reads.push(performance.now() * SPEED);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(board(now, [departure(now)])));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  let timersSet = 0;
  const live = new Set();
  const timers = {
    setTimeout(fn, ms) {
      timersSet += 1;
      const id = setTimeout(
        () => {
          live.delete(id);
          fn();
        },
        Math.max(0, ms) / SPEED,
      );
      live.add(id);
      return id;
    },
    clearTimeout(id) {
      live.delete(id);
      clearTimeout(id);
    },
  };
  const config = { ...CONFIG, watch_alerts: false };
  const gladys = createFakeGladys({ selector: SELECTOR, config, devices: createdDevices(config) });
  await gladys.connect();
  const quiet = () => {};
  const app = new GoApp({
    gladys,
    logger: { info: quiet, warn: quiet, error: quiet, debug: quiet },
    now: () => Date.now(),
    monotonic: () => performance.now() * SPEED,
    timers,
    store: createMemoryStore(),
    apiBase: `http://127.0.0.1:${port}/OpenDataAPI/`,
  });
  t.after(() => app.stop());
  const started = performance.now() * SPEED;
  await app.start(config);
  const deadline = performance.now() + 15_000;
  while (performance.now() * SPEED < started + 2.5 * INTERVAL && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  await app.stop();
  const at = reads.map((r) => Math.round(r - started));
  assert.equal(reads.length, 3, `reads at ${at}`);
  assert.ok(reads[0] - started < INTERVAL / 2, `the first read at once: ${at}`);
  for (let i = 1; i < reads.length; i += 1) {
    const gap = reads[i] - reads[i - 1];
    assert.ok(gap >= 0.9 * INTERVAL, `never sooner than the interval: ${at}`);
    assert.ok(gap < 1.5 * INTERVAL, `on time: ${at}`);
  }
  assert.ok(timersSet <= 10, `${timersSet} timers`);
  assert.equal(live.size, 0, 'no timer left after stop()');
  assert.equal(gladys.fake.lastState(`ext:${SELECTOR}:stop:UN:departure_1`), 5);
});
