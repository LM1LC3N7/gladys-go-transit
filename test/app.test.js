// -----------------------------------------------------------------------------
// The app on a virtual clock: what is read, when, what is published, and how
// the key, the pauses, the budget and /data are kept.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/store.js';
import { MAX_CALLS_PER_HOUR } from '../src/constants.js';
import { tagOf } from '../src/app.js';
import {
  CONFIG,
  HOUR,
  KEY,
  MINUTE,
  SECOND,
  START,
  alert,
  alertsBody,
  board,
  createdDevices,
  defaultRoutes,
  denied,
  departure,
  json,
  setup,
} from './helpers/harness.js';

const NEXT = 'NextService';
const ALERTS = 'ServiceAlert';

test('no key: nothing is called, the status says what to do', async (t) => {
  const h = await setup({ config: { stops: 'UN' } });
  t.after(() => h.app.stop());
  await h.begin();
  await h.time.advance(10 * MINUTE);
  assert.equal(h.api.calls.length, 0);
  assert.equal(h.fake.connectionStatus.connected, false);
  assert.match(h.fake.connectionStatus.message.en, /Add your GO API key/);
});

test('a malformed key is never sent and is said so', async (t) => {
  const h = await setup({ config: { api_key: 'abc def\r\nX: y', stops: 'UN' } });
  t.after(() => h.app.stop());
  await h.begin();
  assert.equal(h.api.calls.length, 0);
  assert.match(h.fake.connectionStatus.message.en, /characters a GO key never has/);
});

test('reads at once, then once per interval; the states of a stop', async (t) => {
  const h = await setup();
  t.after(() => h.app.stop());
  await h.begin();
  assert.equal(h.api.count(NEXT), 1);
  assert.equal(h.api.count(ALERTS), 1);
  assert.equal(h.api.calls[0].key, KEY);
  assert.equal(h.api.calls[0].init.redirect, 'error');
  assert.equal(h.api.calls[0].init.headers.Accept, 'application/json');
  assert.match(
    h.api.calls[0].init.headers['User-Agent'],
    /^gladys-go-transit\/\d+\.\d+\.\d+ \(\+https:\/\/github\.com\/LM1LC3N7\/gladys-go-transit\)$/,
  );
  assert.equal(h.fake.lastState(h.F('departure_1')), 5);
  assert.equal(h.fake.lastState(h.F('departure_1_line')), 'LW - Aldershot GO');
  assert.equal(h.fake.lastState(h.F('departure_1_status')), 'On time · Pl. 4');
  assert.equal(h.fake.lastState(h.F('departure_2')), 999);
  assert.equal(h.fake.lastState(h.F('summary')), 'LW 17:05 On time · Pl. 4');
  await h.time.advance(59 * SECOND);
  assert.equal(h.api.count(NEXT), 1, 'never sooner than the interval');
  await h.time.advance(1 * SECOND);
  assert.equal(h.api.count(NEXT), 2);
  await h.time.advance(4 * MINUTE);
  assert.equal(h.api.count(NEXT), 6);
  assert.equal(h.api.count(ALERTS), 2, 'alerts every 5 minutes');
  assert.equal(h.fake.connectionStatus.connected, true);
});

test('only the created devices are read', async (t) => {
  const h = await setup({ devices: [] });
  t.after(() => h.app.stop());
  await h.begin();
  assert.equal(h.api.calls.length, 0);
  assert.match(h.fake.connectionStatus.message.en, /Discover/);
  assert.deepEqual(
    h.fake.discoveredDevices.map((d) => d.external_id),
    ['ext:go-transit:stop:UN', 'ext:go-transit:alerts:network'],
  );
  // Created: read now; created again later: not sooner than its interval.
  await h.fake.deviceCreated(createdDevices()[0]);
  await h.time.advance(0);
  assert.equal(h.api.count(NEXT), 1);
  await h.fake.deviceUpdated(createdDevices()[0]);
  await h.time.advance(10 * SECOND);
  assert.equal(h.api.count(NEXT), 1);
});

test('delays, cancellations, early and scheduled-only departures', async (t) => {
  const h = await setup({
    config: { ...CONFIG, max_departures: 4 },
    routes: (path, now) =>
      path.includes(NEXT)
        ? board(now, [
            departure(now, { at: START + 20 * MINUTE, delay: null, trip: 'D' }),
            departure(now, { at: START + 3 * MINUTE, delay: 12, trip: 'A', platform: '' }),
            departure(now, {
              at: START + 8 * MINUTE,
              delay: -2,
              trip: 'B',
              line: 'LE',
              direction: 'Oshawa GO',
            }),
            departure(now, { at: START + 9 * MINUTE, delay: 0, trip: 'C', status: 'Cancelled' }),
            departure(now, { in: -5, trip: 'gone' }),
          ])
        : alertsBody(now, []),
  });
  t.after(() => h.app.stop());
  await h.begin();
  // Sorted by the expected time: B 6 min, C 9 min, A 15 min, D 20 min.
  assert.equal(h.fake.lastState(h.F('departure_1')), 6);
  assert.equal(h.fake.lastState(h.F('departure_1_line')), 'LE Oshawa GO');
  assert.equal(h.fake.lastState(h.F('departure_1_status')), '2 min early · Pl. 4');
  assert.equal(h.fake.lastState(h.F('departure_2_status')), 'Cancelled · Pl. 4');
  assert.equal(h.fake.lastState(h.F('departure_3')), 15);
  assert.equal(h.fake.lastState(h.F('departure_3_status')), '+12 min');
  assert.equal(h.fake.lastState(h.F('departure_4_status')), 'Scheduled · Pl. 4');
  const events = h.fake.sceneEvents.filter((e) => e.key === 'departure_delayed');
  assert.deepEqual(
    events.map((e) => [e.data.trip, e.data.event, e.data.threshold]),
    [
      ['C', 'cancelled', null],
      ['A', 'delayed', '5'],
      ['A', 'delayed', '10'],
    ],
  );
  assert.equal(events[1].data.stop, 'ext:go-transit:stop:UN');
  assert.equal(events[1].data.delay_minutes, 12);
  assert.equal(events[1].data.line, 'LW');
  assert.equal(events[1].data.departure_time, '17:15');
  assert.equal(events[1].data.scheduled_time, '17:03');
  // The next reading: nothing fired twice.
  await h.time.advance(MINUTE);
  assert.equal(h.fake.sceneEvents.filter((e) => e.key === 'departure_delayed').length, 3);
});

test('the fired events survive a restart (kept in /data)', async (t) => {
  const store = createMemoryStore();
  const routes = (path, now) =>
    path.includes(NEXT)
      ? board(now, [departure(now, { at: START + 10 * MINUTE, delay: 6, trip: 'A' })])
      : alertsBody(now, []);
  const h = await setup({ store, routes });
  t.after(() => h.app.stop());
  await h.begin();
  assert.equal(h.fake.sceneEvents.length, 1);
  await h.app.stop();
  const again = await setup({ store, routes, start: START + 2 * MINUTE });
  t.after(() => again.app.stop());
  await again.begin();
  assert.equal(again.api.count(NEXT), 1);
  assert.equal(again.fake.sceneEvents.length, 0);
});

test('alerts: count and latest of the watched lines; the first reading only learns', async (t) => {
  let messages = [alert('A1', { lines: ['LW'] }), alert('A2', { lines: ['BR'] })];
  const h = await setup({
    config: { ...CONFIG, alert_lines: 'lw, LE' },
    routes: (path, now) =>
      path.includes(ALERTS) ? alertsBody(now, messages) : defaultRoutes(path, now),
  });
  t.after(() => h.app.stop());
  await h.begin();
  assert.equal(h.fake.lastState(h.A('count')), 1);
  assert.equal(h.fake.lastState(h.A('latest')), 'Alert A1');
  assert.equal(h.fake.sceneEvents.filter((e) => e.key === 'service_alert').length, 0);
  messages = [
    ...messages,
    alert('A3', { lines: ['LE', 'LW'], posted: START + MINUTE, subject: 'New one' }),
    alert('A4', { lines: ['BR'] }),
  ];
  await h.time.advance(5 * MINUTE);
  assert.equal(h.fake.lastState(h.A('count')), 2);
  assert.equal(h.fake.lastState(h.A('latest')), 'New one');
  const events = h.fake.sceneEvents.filter((e) => e.key === 'service_alert');
  assert.deepEqual(
    events.map((e) => e.data.line),
    ['LE', 'LW'],
  );
  assert.equal(events[0].data.subject, 'New one');
  assert.equal(events[0].data.lines, 'LE, LW');
  await h.time.advance(5 * MINUTE);
  assert.equal(h.fake.sceneEvents.filter((e) => e.key === 'service_alert').length, 2);
});

test('French: the alert texts and the statuses', async (t) => {
  const h = await setup({
    config: { ...CONFIG, language: 'fr' },
    routes: (path, now) =>
      path.includes(ALERTS) ? alertsBody(now, [alert('A1')]) : defaultRoutes(path, now),
  });
  t.after(() => h.app.stop());
  await h.begin();
  assert.equal(h.fake.lastState(h.A('latest')), 'Alerte A1');
  assert.equal(h.fake.lastState(h.F('departure_1_status')), "À l'heure · Voie 4");
});

test('403 with no endpoint ever read: the key is refused, kept, never sent again on its own', async (t) => {
  const store = createMemoryStore();
  const routes = (path, now) => denied(now);
  const h = await setup({ store, routes });
  t.after(() => h.app.stop());
  await h.begin();
  const sent = h.api.calls.length;
  assert.ok(sent >= 1 && sent <= 2);
  assert.equal(h.fake.connectionStatus.connected, false);
  assert.match(h.fake.connectionStatus.message.en, /refuses this API key/);
  await h.time.advance(6 * HOUR);
  assert.equal(h.api.calls.length, sent, 'no automatic attempt');
  // Kept as 8 bits of a salted hash, never the key.
  assert.equal(store.data.refused.tag, tagOf(store.data.salt, KEY));
  assert.ok(!JSON.stringify(store.data).includes(KEY));
  // Saving the same key again: still refused.
  await h.fake.configUpdated(CONFIG);
  await h.time.advance(MINUTE);
  assert.equal(h.api.calls.length, sent);
  await h.app.stop();

  // A restart with the same key: still nothing.
  const again = await setup({ store, routes });
  t.after(() => again.app.stop());
  await again.begin();
  await again.time.advance(HOUR);
  assert.equal(again.api.calls.length, 0);
  // Another key: tried at once.
  again.api.routes = defaultRoutes;
  await again.fake.configUpdated({ ...CONFIG, api_key: 'another-key-0987654321' });
  await again.time.advance(0);
  assert.ok(again.api.calls.length >= 1);
  assert.equal(again.api.calls[0].key, 'another-key-0987654321');
  assert.equal(again.fake.connectionStatus.connected, true);
  assert.equal(store.data.refused, null, 'a success lifts the refusal');
});

test('a key changed after a refusal in the session is always tried (exact compare)', async (t) => {
  const h = await setup({ routes: (path, now) => denied(now) });
  t.after(() => h.app.stop());
  await h.begin();
  const sent = h.api.calls.length;
  // Find a key whose 8-bit tag collides with the refused one.
  const salt = h.store.data.salt;
  let other;
  for (let i = 0; i < 5000 && !other; i += 1) {
    const candidate = `collide-key-${i}`;
    if (tagOf(salt, candidate) === tagOf(salt, KEY)) other = candidate;
  }
  assert.ok(other);
  h.api.routes = defaultRoutes;
  await h.fake.configUpdated({ ...CONFIG, api_key: other });
  await h.time.advance(0);
  assert.ok(h.api.calls.length > sent);
  assert.equal(h.api.calls.at(-1).key, other);
});

test('401 envelope (no key reached the API) is a refusal too', async (t) => {
  const h = await setup({ routes: (path, now) => denied(now, '401') });
  t.after(() => h.app.stop());
  await h.begin();
  assert.match(h.fake.connectionStatus.message.en, /refuses this API key/);
});

test('403 on the alerts while the departures read: only the alerts wait, doubled', async (t) => {
  const h = await setup({
    routes: (path, now) => (path.includes(ALERTS) ? denied(now) : defaultRoutes(path, now)),
  });
  t.after(() => h.app.stop());
  await h.begin();
  assert.equal(h.api.count(ALERTS), 1);
  assert.equal(h.fake.connectionStatus.connected, true);
  assert.match(h.fake.connectionStatus.message.en, /no access to the service alerts/);
  await h.time.advance(5 * MINUTE);
  assert.equal(h.api.count(ALERTS), 2, 'asked again at its interval (2 min denied < 5 min)');
  assert.equal(h.api.count(NEXT), 6);
  await h.time.advance(5 * MINUTE);
  assert.equal(h.api.count(ALERTS), 3);
  // 2, 4, 8 min: the third denial waits 8 min.
  await h.time.advance(5 * MINUTE);
  assert.equal(h.api.count(ALERTS), 3);
  await h.time.advance(3 * MINUTE);
  assert.equal(h.api.count(ALERTS), 4);
  assert.match(h.fake.connectionStatus.message.en, /Connected/);
});

test('then every endpoint denied: the key is refused', async (t) => {
  let deny = false;
  const h = await setup({
    routes: (path, now) => (deny ? denied(now) : defaultRoutes(path, now)),
  });
  t.after(() => h.app.stop());
  await h.begin();
  deny = true;
  await h.time.advance(5 * MINUTE);
  assert.match(h.fake.connectionStatus.message.en, /refuses this API key/);
  const sent = h.api.calls.length;
  await h.time.advance(HOUR);
  assert.equal(h.api.calls.length, sent);
});

test('429: pause with Retry-After, doubled, kept across a restart', async (t) => {
  const store = createMemoryStore();
  let busy = true;
  const routes = (path, now) =>
    busy ? json({ Message: 'busy' }, 429, { 'retry-after': '120' }) : defaultRoutes(path, now);
  const h = await setup({ store, routes, config: { ...CONFIG, watch_alerts: false } });
  t.after(() => h.app.stop());
  await h.begin();
  assert.equal(h.api.calls.length, 1);
  assert.match(h.fake.connectionStatus.message.en, /paused for 2 min/);
  assert.equal(h.fake.connectionStatus.connected, false);
  await h.time.advance(119 * SECOND);
  assert.equal(h.api.calls.length, 1, 'Retry-After honored');
  await h.time.advance(1 * SECOND);
  assert.equal(h.api.calls.length, 2);
  // Second one: 2 min ladder, max with Retry-After 2 min.
  await h.app.stop();
  const again = await setup({
    store,
    routes,
    start: START + 3 * MINUTE,
    config: { ...CONFIG, watch_alerts: false },
  });
  t.after(() => again.app.stop());
  await again.begin();
  assert.equal(again.api.calls.length, 0, 'the pause survives the restart');
  busy = false;
  // The second pause (2 min from +2 min) ends at +4 min: one minute after the restart.
  await again.time.advance(MINUTE - SECOND);
  assert.equal(again.api.calls.length, 0);
  await again.time.advance(SECOND);
  assert.equal(again.api.calls.length, 1);
  assert.equal(again.fake.connectionStatus.connected, true);
});

test('5xx, timeouts and unreadable answers pause 1, 2, 4 min; a success resets', async (t) => {
  let mode = 'server';
  const h = await setup({
    config: { ...CONFIG, watch_alerts: false },
    routes: (path, now) => {
      if (mode === 'server') return new Response('oops', { status: 503 });
      if (mode === 'timeout') return 'timeout';
      if (mode === 'garbage') return new Response('<html>', { status: 200 });
      return defaultRoutes(path, now);
    },
  });
  t.after(() => h.app.stop());
  await h.begin();
  assert.equal(h.api.calls.length, 1);
  await h.time.advance(MINUTE);
  assert.equal(h.api.calls.length, 2);
  mode = 'timeout';
  await h.time.advance(MINUTE);
  assert.equal(h.api.calls.length, 2, 'second pause: 2 min');
  await h.time.advance(MINUTE);
  assert.equal(h.api.calls.length, 3);
  mode = 'garbage';
  await h.time.advance(4 * MINUTE);
  assert.equal(h.api.calls.length, 4);
  mode = 'ok';
  await h.time.advance(8 * MINUTE);
  assert.equal(h.api.calls.length, 5);
  assert.equal(h.fake.connectionStatus.connected, true);
  await h.time.advance(MINUTE);
  assert.equal(h.api.calls.length, 6, 'back to the interval');
});

test('a hung answer is cut at 10 s and pauses', async (t) => {
  const h = await setup({
    config: { ...CONFIG, watch_alerts: false },
    routes: () => 'hang',
  });
  t.after(() => h.app.stop());
  await h.begin();
  // AbortSignal.timeout runs on the real clock: wait for it, bounded.
  const deadline = Date.now() + 15_000;
  while (!h.lines.some((l) => /timeout/.test(l)) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(
    h.lines.some((l) => /timeout/.test(l)),
    h.lines.join('\n'),
  );
  await h.time.advance(0);
  assert.match(h.fake.connectionStatus.message.en, /paused/);
});

test('the hourly budget is counted before the call and kept across restarts', async (t) => {
  const calls = Array.from({ length: MAX_CALLS_PER_HOUR }, (_, i) => START - 30 * MINUTE + i);
  const store = createMemoryStore({ salt: '0'.repeat(32), calls });
  const h = await setup({ store });
  t.after(() => h.app.stop());
  await h.begin();
  assert.equal(h.api.calls.length, 0);
  assert.match(h.fake.connectionStatus.message.en, /Hourly call limit/);
  await h.time.advance(30 * MINUTE + MINUTE);
  assert.ok(h.api.calls.length >= 1, 'resumes when the oldest calls leave the hour');
  assert.ok(h.api.calls.length <= 3);
});

test('a restart reads no sooner than the interval (time of the attempt in /data)', async (t) => {
  const store = createMemoryStore();
  const h = await setup({ store, config: { ...CONFIG, watch_alerts: false } });
  t.after(() => h.app.stop());
  await h.begin();
  assert.equal(h.api.calls.length, 1);
  await h.app.stop();
  const again = await setup({
    store,
    start: START + 20 * SECOND,
    config: { ...CONFIG, watch_alerts: false },
  });
  t.after(() => again.app.stop());
  await again.begin();
  assert.equal(again.api.calls.length, 0);
  await again.time.advance(39 * SECOND);
  assert.equal(again.api.calls.length, 0);
  await again.time.advance(1 * SECOND);
  assert.equal(again.api.calls.length, 1);
});

test('a future date in /data is invalid: neither a pause nor a last read', async (t) => {
  const store = createMemoryStore({
    salt: '0'.repeat(32),
    lastRead: { 'stop:UN': START + HOUR },
    calls: [START + HOUR],
  });
  const h = await setup({ store, config: { ...CONFIG, watch_alerts: false } });
  t.after(() => h.app.stop());
  await h.begin();
  assert.equal(h.api.calls.length, 1);
});

test('/data unreadable: no call, nothing written, read again every 10 s', async (t) => {
  const store = createMemoryStore({ salt: '0'.repeat(32), refused: null });
  store.failLoad = true;
  const h = await setup({ store });
  t.after(() => h.app.stop());
  await h.begin();
  assert.equal(h.api.calls.length, 0);
  assert.match(h.fake.connectionStatus.message.en, /\/data cannot be read/);
  await h.time.advance(30 * SECOND);
  assert.equal(h.api.calls.length, 0);
  assert.equal(store.saves, 0, 'never written over');
  assert.ok(store.loads >= 3 && store.loads <= 5, `${store.loads} loads`);
  store.failLoad = false;
  await h.time.advance(10 * SECOND);
  assert.ok(h.api.calls.length >= 1);
  assert.equal(h.fake.connectionStatus.connected, true);
});

test('/data that cannot be written does not stop the reads', async (t) => {
  const store = createMemoryStore();
  store.failSave = true;
  const h = await setup({ store });
  t.after(() => h.app.stop());
  await h.begin();
  await h.time.advance(MINUTE);
  assert.equal(h.api.count(NEXT), 2);
});

test('getConfig() failing in `connected`: asked again, spaced, then the start', async (t) => {
  const h = await setup();
  t.after(() => h.app.stop());
  const real = h.gladys.getConfig.bind(h.gladys);
  let failures = 2;
  let asked = 0;
  h.gladys.getConfig = async () => {
    asked += 1;
    if (failures > 0) {
      failures -= 1;
      throw new Error('boom');
    }
    return real();
  };
  await h.app.connected();
  await h.time.advance(0);
  assert.equal(asked, 1);
  assert.match(h.fake.connectionStatus.message.en, /configuration could not be read/);
  assert.equal(h.api.calls.length, 0);
  await h.time.advance(5 * SECOND);
  assert.equal(asked, 2);
  await h.time.advance(9 * SECOND);
  assert.equal(asked, 2, 'spaced: 10 s the second time');
  await h.time.advance(1 * SECOND);
  assert.equal(asked, 3);
  assert.ok(h.api.calls.length >= 1);
  assert.equal(h.fake.connectionStatus.connected, true);
});

test('an unknown stop is asked again every 30 min and named in the status', async (t) => {
  const h = await setup({
    config: { ...CONFIG, watch_alerts: false },
    routes: () => ({
      Metadata: { TimeStamp: '', ErrorCode: '404', ErrorMessage: 'Not Found' },
      NextService: null,
    }),
  });
  t.after(() => h.app.stop());
  await h.begin();
  assert.match(h.fake.connectionStatus.message.en, /Unknown to the GO API: UN/);
  await h.time.advance(29 * MINUTE);
  assert.equal(h.api.calls.length, 1);
  await h.time.advance(MINUTE);
  assert.equal(h.api.calls.length, 2);
});

test('several stops: one in error does not stop the others', async (t) => {
  const config = { ...CONFIG, stops: 'UN, OA@LW:Oakville, XX', watch_alerts: false };
  const h = await setup({
    config,
    routes: (path, now) =>
      path.endsWith('/XX')
        ? { Metadata: { ErrorCode: '404' }, NextService: null }
        : defaultRoutes(path, now),
  });
  t.after(() => h.app.stop());
  await h.begin();
  assert.equal(h.fake.lastState(h.F('departure_1', 'OA_LW')), 5);
  assert.equal(h.fake.lastState(h.F('departure_1', 'UN')), 5);
  assert.match(h.fake.connectionStatus.message.en, /2\/3 source/);
  assert.ok(h.fake.discoveredDevices.some((d) => d.name === 'Oakville'));
});

test('at most 6 stops; the others are named in the status', async (t) => {
  const config = { ...CONFIG, stops: 'A1,A2,A3,A4,A5,A6,A7,A8', watch_alerts: false };
  const h = await setup({ config });
  t.after(() => h.app.stop());
  await h.begin();
  assert.equal(h.api.count(NEXT), 6);
  assert.match(h.fake.connectionStatus.message.en, /ignored: A7, A8/);
});

test('one call in flight at a time', async (t) => {
  let inFlight = 0;
  let peak = 0;
  const config = { ...CONFIG, stops: 'A1,A2,A3' };
  const h = await setup({
    config,
    routes: async (path, now) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight -= 1;
      return defaultRoutes(path, now);
    },
  });
  t.after(() => h.app.stop());
  await h.begin();
  await Promise.all([
    h.app.testKey(),
    h.app.searchStopsAction({ query: 'oak' }),
    h.time.advance(MINUTE),
  ]);
  assert.equal(peak, 1);
  assert.ok(h.api.calls.length >= 8);
});

test('the test button: lifts a refusal, once a minute, never during a pause', async (t) => {
  let refuse = true;
  const h = await setup({
    routes: (path, now) => (refuse ? denied(now) : defaultRoutes(path, now)),
  });
  t.after(() => h.app.stop());
  await h.begin();
  assert.match(h.fake.connectionStatus.message.en, /refuses/);
  const first = await h.app.testKey();
  assert.match(first.en, /refused/);
  const tooSoon = await h.app.testKey();
  assert.match(tooSoon.en, /try again in/);
  refuse = false;
  await h.time.advance(MINUTE);
  const sent = h.api.calls.length;
  const ok = await h.app.testKey();
  assert.match(ok.en, /Key accepted by the GO API \(1 departure\(s\) at UN\)/);
  assert.equal(h.api.calls.length, sent + 1);
  await h.time.advance(0);
  assert.ok(h.api.calls.length > sent + 1, 'the reads resume');
  assert.equal(h.fake.connectionStatus.connected, true);

  h.api.routes = () => new Response('', { status: 503 });
  await h.time.advance(MINUTE);
  const paused = await h.app.testKey();
  assert.match(paused.en, /could not be tested \(API paused\)/);
});

test('search: the list of stops is read once and kept a week', async (t) => {
  const h = await setup({ devices: [] });
  t.after(() => h.app.stop());
  await h.begin();
  const found = await h.app.searchStopsAction({ query: 'oakville' });
  assert.match(found.en, /OA \(Oakville GO\)/);
  const exact = await h.app.searchStopsAction({ query: 'un' });
  assert.match(exact.en, /^Stop codes to type in “Stops”: UN \(Union Station\)/);
  const none = await h.app.searchStopsAction({ query: 'zzz' });
  assert.match(none.fr, /Aucune gare GO/);
  assert.equal(h.api.count('Stop/All'), 1);
  await h.time.advance(8 * 24 * HOUR);
  await h.app.searchStopsAction({ query: 'oak' });
  assert.equal(h.api.count('Stop/All'), 2);
});

test('the widget: the last board, counted down, never a stale one', async (t) => {
  const h = await setup({
    routes: (path, now) =>
      path.includes(NEXT)
        ? board(now, [
            departure(now, { in: 10, delay: 3 }),
            departure(now, { in: 20, status: 'CANCELLED', trip: 'X' }),
          ])
        : defaultRoutes(path, now),
  });
  t.after(() => h.app.stop());
  await h.begin();
  const content = h.app.widgetDepartures({
    settings: { stop: 'ext:go-transit:stop:UN' },
    language: 'en',
  });
  const status = content.components.find((c) => c.type === 'status');
  assert.equal(status.items[0].value, '13 min · +3 min · Pl. 4');
  assert.equal(status.items[0].color, 'warning');
  assert.equal(status.items[1].color, 'danger');
  // Stop the reads: the board grows old.
  h.api.routes = () => new Response('', { status: 503 });
  await h.time.advance(16 * MINUTE);
  const old = h.app.widgetDepartures({
    settings: { stop: 'ext:go-transit:stop:UN' },
    language: 'fr',
  });
  assert.match(JSON.stringify(old), /Aucune lecture récente/);
  const other = h.app.widgetDepartures({ settings: { stop: 'nope' }, language: 'en' });
  assert.match(JSON.stringify(other), /not in the configuration/);
});

test('the key never reaches the logs, the status, /data nor the devices', async (t) => {
  const store = createMemoryStore();
  const h = await setup({
    store,
    routes: (path, now) => (path.includes(ALERTS) ? 'timeout' : denied(now)),
  });
  t.after(() => h.app.stop());
  await h.begin();
  await h.app.testKey();
  await h.app.searchStopsAction({ query: 'x' });
  await h.time.advance(HOUR);
  await h.app.stop();
  const everything = JSON.stringify([
    h.lines,
    h.fake.connectionStatuses,
    store.data,
    h.fake.discoveredDevices,
    h.fake.states,
  ]);
  assert.ok(!everything.includes(KEY));
  assert.ok(!everything.includes('openmetrolinx.com/OpenDataAPI/api'), 'no URL either');
});

test('stop() leaves no timer and no call behind', async (t) => {
  const h = await setup();
  t.after(() => h.app.stop());
  await h.begin();
  await h.app.stop();
  const sent = h.api.calls.length;
  await h.time.advance(HOUR);
  assert.equal(h.api.calls.length, sent);
  assert.equal(h.time.pending.size, 0);
});

test('states per minute are bounded, all devices together', async (t) => {
  const h = await setup({ config: { ...CONFIG, watch_alerts: false } });
  t.after(() => h.app.stop());
  await h.begin();
  const batch = (n, v) =>
    Array.from({ length: n }, (_, i) => ({
      device_feature_external_id: h.F(`departure_${(i % 5) + 1}`),
      state: v + i,
    }));
  const before = h.fake.states.length;
  await h.app.publish(batch(200, 1000));
  const after = h.fake.states.length;
  assert.ok(after > before);
  await h.app.publish(batch(100, 5000));
  assert.equal(h.fake.states.length, after, 'over 250 in the minute: not published');
  assert.ok(h.lines.some((l) => /State budget/.test(l)));
  await h.time.advance(MINUTE);
  await h.app.publish(batch(100, 9000));
  assert.ok(h.fake.states.length > after);
});

test('the buttons go through the gate too: /data unreadable, hourly budget', async (t) => {
  const store = createMemoryStore();
  store.failLoad = true;
  const h = await setup({ store });
  t.after(() => h.app.stop());
  await h.begin();
  const test1 = await h.app.testKey();
  assert.match(test1.en, /\/data unreadable/);
  const search = await h.app.searchStopsAction({ query: 'oak' });
  assert.match(search.en, /\/data unreadable/);
  h.app.save();
  await h.time.advance(0);
  assert.equal(h.api.calls.length, 0);
  assert.equal(store.saves, 0, 'never written over an unreadable /data');

  const calls = Array.from({ length: MAX_CALLS_PER_HOUR }, (_, i) => START - 10 * MINUTE + i);
  const full = await setup({ store: createMemoryStore({ salt: '0'.repeat(32), calls }) });
  t.after(() => full.app.stop());
  await full.begin();
  assert.match((await full.app.testKey()).en, /hourly limit reached/);
  assert.match((await full.app.searchStopsAction({ query: 'oak' })).en, /hourly limit reached/);
  assert.equal(full.api.calls.length, 0);
});

test('every call is counted: the budget stops the reads within the hour', async (t) => {
  const calls = Array.from({ length: MAX_CALLS_PER_HOUR - 3 }, (_, i) => START - 10 * MINUTE + i);
  const store = createMemoryStore({ salt: '0'.repeat(32), calls });
  const h = await setup({ store });
  t.after(() => h.app.stop());
  await h.begin();
  assert.equal(h.api.calls.length, 2);
  await h.time.advance(MINUTE);
  assert.equal(h.api.calls.length, 3);
  await h.time.advance(5 * MINUTE);
  assert.equal(h.api.calls.length, 3, 'the hour is full');
  assert.match(h.fake.connectionStatus.message.en, /Hourly call limit/);
  assert.equal(store.data.calls.length, MAX_CALLS_PER_HOUR);
});

test('a refusal decided by the call before stops a call already queued', async (t) => {
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const h = await setup({
    devices: [],
    routes: async (path, now) => {
      await held;
      return denied(now);
    },
  });
  t.after(() => h.app.stop());
  await h.begin();
  const first = h.app.testKey();
  const second = h.app.searchStopsAction({ query: 'oak' });
  await h.time.settle();
  release();
  assert.match((await first).en, /refused/);
  assert.match((await second).en, /key refused/);
  assert.equal(h.api.calls.length, 1);
});

test('the time of the attempt is in /data before the call leaves', async (t) => {
  let release;
  const held = new Promise((resolve) => (release = resolve));
  const store = createMemoryStore();
  const h = await setup({
    store,
    config: { ...CONFIG, watch_alerts: false },
    routes: async (path, now) => {
      await held;
      return defaultRoutes(path, now);
    },
  });
  t.after(() => h.app.stop());
  await h.begin();
  assert.equal(h.api.calls.length, 1);
  assert.ok(Number.isFinite(store.data.lastRead?.['stop:UN']), 'saved while the call is out');
  release();
  await h.time.advance(0);
});
