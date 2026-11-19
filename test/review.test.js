// -----------------------------------------------------------------------------
// The scenarios of the review r1: a start during a read, alerts in 404, an old
// snapshot, values that grow old, and one test per guard the review mutated.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/store.js';
import { MAX_CALLS_PER_HOUR } from '../src/constants.js';
import { tagOf } from '../src/app.js';
import {
  CONFIG,
  HOUR,
  MINUTE,
  SECOND,
  START,
  alert,
  alertsBody,
  board,
  defaultRoutes,
  denied,
  departure,
  json,
  meta,
  setup,
  toronto,
} from './helpers/harness.js';

const NEXT = 'NextService';
const ALERTS = 'ServiceAlert';

/** Routes whose first answer waits for `release()`. */
function holdFirst(routes = defaultRoutes) {
  let release;
  const held = new Promise((resolve) => (release = resolve));
  let first = true;
  return {
    release: () => release(),
    routes: async (path, now, url) => {
      if (first) {
        first = false;
        await held;
      }
      return routes(path, now, url);
    },
  };
}

for (const restart of ['start', 'stop+connected']) {
  test(`I1: a ${restart} during a read never leaves the reads dead`, async (t) => {
    const config = { ...CONFIG, stops: 'UN, OA' };
    const hold = holdFirst();
    const h = await setup({ config, routes: hold.routes });
    t.after(() => h.app.stop());
    await h.begin();
    assert.equal(h.api.calls.length, 1);
    if (restart === 'start') await h.app.start(config);
    else {
      await h.app.stop();
      await h.app.connected();
    }
    await h.time.advance(0);
    hold.release();
    await h.time.advance(40 * MINUTE);
    assert.ok(h.api.count('/UN') >= 35, `${h.api.count('/UN')} reads of UN in 40 min`);
    assert.ok(h.api.count('/OA') >= 35);
    assert.ok(h.time.pending.size >= 1, 'a timer is armed');
  });
}

for (const answer of ['http404', 'envelope400']) {
  test(`I2: alerts in ${answer}: the stops go on, the status holds`, async (t) => {
    const h = await setup({
      routes: (path, now) => {
        if (!path.includes(ALERTS)) return defaultRoutes(path, now);
        if (answer === 'http404') return new Response('nope', { status: 404 });
        return { Metadata: meta(now, '400'), Messages: null };
      },
    });
    t.after(() => h.app.stop());
    await h.begin();
    await h.time.advance(HOUR);
    assert.ok(h.api.count(NEXT) >= 60);
    assert.ok(h.api.count(ALERTS) >= 2);
    assert.ok(!h.lines.some((l) => /Tick failed/.test(l)), h.lines.join('\n'));
    assert.doesNotMatch(h.fake.connectionStatus.message.en, /Unknown to the GO API/);
    assert.equal(h.fake.connectionStatus.connected, true);
  });
}

test('I3: an old snapshot is neither published nor fired', async (t) => {
  const old = (now) => now - 3 * HOUR;
  const h = await setup({
    routes: (path, now) => {
      const then = old(now);
      if (path.includes(ALERTS)) return alertsBody(then, [alert('A1')]);
      return board(then, [departure(then, { in: 4, delay: 12, trip: 'A' })]);
    },
  });
  t.after(() => h.app.stop());
  await h.begin();
  assert.equal(h.fake.lastState(h.F('departure_1')), undefined);
  assert.equal(h.fake.lastState(h.A('count')), undefined);
  assert.equal(h.fake.sceneEvents.length, 0);
  assert.match(h.fake.connectionStatus.message.en, /out-of-date snapshot/);
  // Without a Date header, the host clock is the reference.
  h.api.routes = (path, now) =>
    new Response(JSON.stringify(board(old(now), [departure(old(now))])), { status: 200 });
  await h.time.advance(MINUTE);
  assert.equal(h.fake.lastState(h.F('departure_1')), undefined);
  // A fresh one is used again.
  h.api.routes = defaultRoutes;
  await h.time.advance(MINUTE);
  assert.equal(h.fake.lastState(h.F('departure_1')), 5);
});

test('I4: after the age limit without a reading, the countdowns go to 999', async (t) => {
  const h = await setup({ config: { ...CONFIG, watch_alerts: false } });
  t.after(() => h.app.stop());
  await h.begin();
  assert.equal(h.fake.lastState(h.F('departure_1')), 5);
  h.api.routes = () => new Response('', { status: 503 });
  await h.time.advance(14 * MINUTE);
  assert.notEqual(h.fake.lastState(h.F('departure_1')), 999);
  await h.time.advance(MINUTE + SECOND);
  assert.equal(h.fake.lastState(h.F('departure_1')), 999);
  assert.equal(h.fake.lastState(h.F('departure_1_line')), '');
  assert.equal(h.fake.lastState(h.F('summary')), 'No recent reading');
  h.api.routes = defaultRoutes;
  await h.time.advance(6 * HOUR);
  assert.equal(h.fake.lastState(h.F('departure_1')), 5, 'a reading brings them back');
});

test('I4: a refused key stops the reads, the values still blank out', async (t) => {
  let refuse = false;
  const h = await setup({
    config: { ...CONFIG, watch_alerts: false },
    routes: (path, now) => (refuse ? denied(now) : defaultRoutes(path, now)),
  });
  t.after(() => h.app.stop());
  await h.begin();
  refuse = true;
  await h.time.advance(MINUTE);
  assert.match(h.fake.connectionStatus.message.en, /refuses/);
  await h.time.advance(15 * MINUTE);
  assert.equal(h.fake.lastState(h.F('departure_1')), 999);
});

test('I4: after a restart that cannot read, the values left by the last run blank out', async (t) => {
  const store = createMemoryStore({
    salt: '0'.repeat(32),
    pauseUntil: START + 6 * HOUR,
    pauseLevel: 9,
  });
  const h = await setup({ store, config: { ...CONFIG, watch_alerts: false } });
  t.after(() => h.app.stop());
  await h.begin();
  assert.equal(h.api.calls.length, 0);
  await h.time.advance(15 * MINUTE + SECOND);
  assert.equal(h.fake.lastState(h.F('departure_1')), 999);
  assert.equal(h.fake.lastState(h.F('summary')), 'No recent reading');
});

test('minor 7: the widget and the states follow twice a long interval', async (t) => {
  const h = await setup({
    config: { ...CONFIG, watch_alerts: false, departures_poll_frequency: 1800 },
    routes: (path, now) => board(now, [departure(now, { in: 40 })]),
  });
  t.after(() => h.app.stop());
  await h.begin();
  await h.time.advance(25 * MINUTE);
  const content = h.app.widgetDepartures({
    settings: { stop: 'ext:go-transit:stop:UN' },
    language: 'en',
  });
  assert.ok(content.components.some((c) => c.type === 'status'));
  assert.equal(h.fake.lastState(h.F('departure_1')), 40);
});

test('minor 1: a call dated ahead of the host clock still counts', async (t) => {
  const calls = Array.from({ length: MAX_CALLS_PER_HOUR - 1 }, () => START + HOUR);
  const h = await setup({ store: createMemoryStore({ salt: '0'.repeat(32), calls }) });
  t.after(() => h.app.stop());
  await h.begin();
  assert.equal(h.api.calls.length, 1);
});

test('minor 2: a failing search reads the list once per 30 s', async (t) => {
  const h = await setup({
    devices: [],
    routes: (path, now) =>
      path.includes('Stop/All') ? { Metadata: meta(now, '404') } : defaultRoutes(path, now),
  });
  t.after(() => h.app.stop());
  await h.begin();
  for (let i = 0; i < 5; i += 1) await h.app.searchStopsAction({ query: 'oak' });
  assert.equal(h.api.count('Stop/All'), 1);
  assert.match((await h.app.searchStopsAction({ query: 'oak' })).en, /try again in/);
  await h.time.advance(30 * SECOND);
  await h.app.searchStopsAction({ query: 'oak' });
  assert.equal(h.api.count('Stop/All'), 2);
});

test('minor 3: the call is in /data while it is out', async (t) => {
  const hold = holdFirst();
  const store = createMemoryStore();
  const h = await setup({ store, routes: hold.routes, config: { ...CONFIG, watch_alerts: false } });
  t.after(() => h.app.stop());
  await h.begin();
  assert.equal(store.data.calls.length, 1);
  hold.release();
  await h.time.advance(0);
});

test('minor 6: alerts beyond 20 events wait for the next reading', async (t) => {
  let messages = [];
  const h = await setup({
    routes: (path, now) =>
      path.includes(ALERTS) ? alertsBody(now, messages) : defaultRoutes(path, now),
  });
  t.after(() => h.app.stop());
  await h.begin();
  messages = Array.from({ length: 25 }, (_, i) => alert(`N${i}`, { lines: ['LW'] }));
  await h.time.advance(5 * MINUTE);
  assert.equal(h.fake.sceneEvents.length, 20);
  await h.time.advance(5 * MINUTE);
  assert.equal(h.fake.sceneEvents.length, 25);
  await h.time.advance(5 * MINUTE);
  assert.equal(h.fake.sceneEvents.length, 25);
});

test('review 15: 5 lines at most per alert', async (t) => {
  let messages = [];
  const h = await setup({
    routes: (path, now) =>
      path.includes(ALERTS) ? alertsBody(now, messages) : defaultRoutes(path, now),
  });
  t.after(() => h.app.stop());
  await h.begin();
  messages = [alert('M', { lines: ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7'] })];
  await h.time.advance(5 * MINUTE);
  assert.equal(h.fake.sceneEvents.length, 5);
});

test('review 4: a success lifts the "no access" of that kind', async (t) => {
  let deny = true;
  const h = await setup({
    routes: (path, now) => (deny && path.includes(ALERTS) ? denied(now) : defaultRoutes(path, now)),
  });
  t.after(() => h.app.stop());
  await h.begin();
  assert.match(h.fake.connectionStatus.message.en, /no access/);
  deny = false;
  await h.time.advance(5 * MINUTE);
  assert.doesNotMatch(h.fake.connectionStatus.message.en, /no access/);
});

test('review 6 and 8: Retry-After and a restored pause are capped at 6 h', async (t) => {
  const h = await setup({
    config: { ...CONFIG, watch_alerts: false },
    routes: () => json({}, 429, { 'retry-after': '999999' }),
  });
  t.after(() => h.app.stop());
  await h.begin();
  h.api.routes = defaultRoutes;
  await h.time.advance(6 * HOUR);
  assert.equal(h.api.calls.length, 2);

  const store = createMemoryStore({
    salt: '0'.repeat(32),
    pauseUntil: START + 100 * HOUR,
    pauseLevel: 3,
  });
  const again = await setup({ store, config: { ...CONFIG, watch_alerts: false } });
  t.after(() => again.app.stop());
  await again.begin();
  await again.time.advance(6 * HOUR);
  assert.equal(again.api.calls.length, 1);
});

test('review 7: a full budget arms one timer at the end of the hour, no loop', async (t) => {
  const calls = Array.from({ length: MAX_CALLS_PER_HOUR }, () => START - 30 * MINUTE);
  const h = await setup({
    store: createMemoryStore({ salt: '0'.repeat(32), calls }),
    config: { ...CONFIG, watch_alerts: false },
  });
  t.after(() => h.app.stop());
  await h.begin();
  const timers = [...h.time.pending.values()];
  assert.ok(timers.length >= 1);
  assert.ok(
    timers.every((timer) => timer.at - h.time.clock.now >= 15 * MINUTE),
    'never a timer at 0',
  );
});

test('review 9, 32, 33: a delay of exactly 5 fires; trip null; 20 events a reading', async (t) => {
  const h = await setup({
    config: { ...CONFIG, watch_alerts: false },
    routes: (path, now) =>
      board(now, [
        departure(now, { at: START + 3 * MINUTE, delay: 5, trip: '' }),
        ...Array.from({ length: 25 }, (_, i) =>
          departure(now, { at: START + (10 + i) * MINUTE, delay: 5, trip: `T${i}` }),
        ),
      ]),
  });
  t.after(() => h.app.stop());
  await h.begin();
  assert.equal(h.fake.sceneEvents.length, 20);
  assert.equal(h.fake.sceneEvents[0].data.threshold, '5');
  assert.equal(h.fake.sceneEvents[0].data.trip, null);
});

test('review 18: the widget shows 6 departures at most', async (t) => {
  const h = await setup({
    config: { ...CONFIG, watch_alerts: false },
    routes: (path, now) =>
      board(
        now,
        Array.from({ length: 8 }, (_, i) => departure(now, { in: 2 + i, trip: `T${i}` })),
      ),
  });
  t.after(() => h.app.stop());
  await h.begin();
  const content = h.app.widgetDepartures({
    settings: { stop: 'ext:go-transit:stop:UN' },
    language: 'en',
  });
  assert.equal(content.components.find((c) => c.type === 'status').items.length, 6);
});

test('review 22: a read stopped in the queue does not count as read', async (t) => {
  let release;
  const held = new Promise((resolve) => (release = resolve));
  let first = true;
  const h = await setup({
    config: { ...CONFIG, watch_alerts: false },
    routes: async (path, now) => {
      if (first) {
        first = false;
        await held;
        return denied(now);
      }
      return defaultRoutes(path, now);
    },
  });
  t.after(() => h.app.stop());
  // The test button goes first and holds; the read of UN queues behind it.
  await h.app.start(CONFIG);
  const clicked = h.app.testKey();
  await h.time.advance(0);
  release();
  await clicked;
  await h.time.advance(0);
  assert.equal(h.api.calls.length, 1, 'the read of UN never left');
  await h.fake.configUpdated({ ...CONFIG, watch_alerts: false, api_key: 'a-new-key-1234567890' });
  await h.time.advance(0);
  assert.equal(h.api.count('/UN'), 2, 'read at once with the new key');
});

test('review 23, 24, 25: stop() drops a late answer, the config retry, and saves', async (t) => {
  const hold = holdFirst();
  const store = createMemoryStore();
  const h = await setup({ store, routes: hold.routes, config: { ...CONFIG, watch_alerts: false } });
  t.after(() => h.app.stop());
  await h.begin();
  const saves = store.saves;
  await h.app.stop();
  assert.ok(store.saves > saves, 'saved at stop');
  hold.release();
  await h.time.advance(MINUTE);
  assert.equal(h.fake.lastState(h.F('departure_1')), undefined, 'the late answer is dropped');

  const other = await setup();
  t.after(() => other.app.stop());
  let asked = 0;
  other.gladys.getConfig = async () => {
    asked += 1;
    throw new Error('boom');
  };
  await other.app.connected();
  await other.app.stop();
  assert.equal(other.time.pending.size, 0, 'no config retry left armed');
  await other.time.advance(HOUR);
  assert.equal(asked, 1);
});

test('the times of the fixtures are Toronto time', () => {
  assert.equal(toronto(START), '2026-11-16 17:00:00');
});

test('review 5: after a restart, a new key colliding with the refused mark is still tried', async (t) => {
  const store = createMemoryStore();
  const h = await setup({ store, routes: (path, now) => denied(now) });
  t.after(() => h.app.stop());
  await h.begin();
  await h.app.stop();
  const salt = store.data.salt;
  let other;
  for (let i = 0; i < 5000 && !other; i += 1) {
    if (tagOf(salt, `collide-${i}-key`) === store.data.refused.tag) other = `collide-${i}-key`;
  }
  const again = await setup({ store });
  t.after(() => again.app.stop());
  await again.begin();
  assert.equal(again.api.calls.length, 0, 'the refused key is not sent again');
  await again.fake.configUpdated({ ...CONFIG, api_key: other });
  await again.time.advance(0);
  assert.ok(again.api.calls.length >= 1);
  assert.equal(again.api.calls[0].key, other);
});
