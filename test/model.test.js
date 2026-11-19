// -----------------------------------------------------------------------------
// Pure parts: Toronto times, the answers of the API, the configuration and one
// call of the client (envelope, size, time, redirects, the key kept out of
// every message).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTorontoTime, torontoClock } from '../src/time.js';
import {
  minutesUntil,
  parseAlerts,
  parseBoard,
  parseStopList,
  searchStops,
  serverNowOf,
} from '../src/api/model.js';
import { GoApiError, apiGet, retryAfterMs } from '../src/api/client.js';
import { cleanKey, normalizeConfig, parseLines, parseStops } from '../src/config.js';
import { MINUTE, START, board, departure, json, toronto } from './helpers/harness.js';

test('Toronto local times, winter and summer, DST changes, invalid dates', () => {
  assert.equal(parseTorontoTime('2026-11-16 17:00:00'), START);
  assert.equal(parseTorontoTime('2026-07-01 12:00:00'), Date.UTC(2026, 6, 1, 16, 0, 0));
  // 2026-03-08 03:00 EDT = 07:00 UTC; the minute before the change is EST.
  assert.equal(parseTorontoTime('2026-03-08 01:59:00'), Date.UTC(2026, 2, 8, 6, 59, 0));
  assert.equal(parseTorontoTime('2026-03-08 03:00:00'), Date.UTC(2026, 2, 8, 7, 0, 0));
  // 2026-11-01 at 1:30 exists twice: one of the two, never another hour.
  const twice = parseTorontoTime('2026-11-01 01:30:00');
  assert.ok([Date.UTC(2026, 10, 1, 5, 30), Date.UTC(2026, 10, 1, 6, 30)].includes(twice));
  // Midnight: the day after in UTC.
  assert.equal(parseTorontoTime('2026-11-16 23:30'), Date.UTC(2026, 10, 17, 4, 30, 0));
  assert.equal(parseTorontoTime('2026-11-16T17:00:00-05:00'), START);
  for (const bad of [
    '',
    null,
    42,
    '2026-02-30 10:00:00',
    '2026-13-01 10:00',
    '17:00',
    '2026-11-16 24:00:00',
    'sample string 9',
  ]) {
    assert.equal(parseTorontoTime(bad), null, String(bad));
  }
  assert.equal(torontoClock(START), '17:00');
  assert.equal(torontoClock(Date.UTC(2026, 6, 1, 16, 5)), '12:05');
});

test('the time of an answer: the API clock, else the Date header, else the host', () => {
  assert.deepEqual(serverNowOf({ Metadata: { TimeStamp: toronto(START) } }, null, START), {
    at: START,
    source: 'api',
  });
  assert.deepEqual(serverNowOf({ Metadata: { TimeStamp: 'x' } }, 5, 1), {
    at: 5,
    source: 'header',
  });
  assert.deepEqual(serverNowOf({}, null, 1), { at: 1, source: 'host' });
});

test('a board: sorted, filtered by line, unknown delays left unknown', () => {
  const now = START;
  const data = board(now, [
    departure(now, { in: 30, line: 'LE' }),
    departure(now, { in: 10, delay: null }),
    departure(now, { in: 5, delay: 4, platform: '-' }),
    { LineCode: 'LW', ScheduledDepartureTime: 'garbage', ComputedDepartureTime: null },
    null,
    { LineCode: '' },
  ]);
  const all = parseBoard(data, { now });
  assert.deepEqual(
    all.map((d) => [d.line, minutesUntil(d, now), d.delay, d.platform]),
    [
      ['LW', 9, 4, ''],
      ['LW', 10, null, '4'],
      ['LE', 30, 0, '4'],
    ],
  );
  assert.equal(parseBoard(data, { now, lines: ['LE'] }).length, 1);
  assert.deepEqual(parseBoard({ Metadata: {}, NextService: null }, { now }), []);
  assert.deepEqual(parseBoard({ Metadata: {}, NextService: { Lines: null } }, { now }), []);
  assert.throws(() => parseBoard({ NextService: { Lines: 'x' } }, { now }), GoApiError);
  // The actual platform first.
  const moved = departure(now, { platform: '4' });
  moved.ActualPlatform = '7';
  assert.equal(parseBoard(board(now, [moved]), { now })[0].platform, '7');
  // Bounded: 30 departures at most, texts cut, control characters out.
  const many = Array.from({ length: 300 }, (_, i) =>
    departure(now, { in: i % 50, direction: `A\u0000B${'x'.repeat(200)}` }),
  );
  const parsed = parseBoard(board(now, many), { now });
  assert.equal(parsed.length, 30);
  assert.ok(parsed[0].direction.length <= 60 && !parsed[0].direction.includes('\u0000'));
});

test('alerts: newest first, deduplicated, bounded; the other language when one is empty', () => {
  const alerts = parseAlerts({
    Messages: {
      Message: [
        {
          Code: 'A',
          PostedDateTime: '2026-11-16 10:00:00',
          SubjectEnglish: 'old',
          Lines: [{ Code: 'lw' }],
        },
        { Code: 'B', PostedDateTime: '2026-11-16 12:00:00', SubjectFrench: 'neuf', Lines: 'x' },
        { Code: 'A', PostedDateTime: '2026-11-16 13:00:00' },
        { Code: '' },
        'junk',
      ],
    },
  });
  assert.deepEqual(
    alerts.map((a) => a.code),
    ['B', 'A'],
  );
  assert.deepEqual(alerts[1].lines, ['LW']);
  assert.deepEqual(alerts[0].lines, []);
  assert.deepEqual(parseAlerts({ Messages: null }), []);
  assert.throws(() => parseAlerts({ Messages: { Message: {} } }), GoApiError);
});

test('stops: list and search', () => {
  const stops = parseStopList({
    Stations: {
      Station: [
        { LocationCode: 'un', LocationName: 'Union Station' },
        { LocationCode: 'bad code' },
        { LocationCode: 'OA', LocationName: 'Oakville GO' },
      ],
    },
  });
  assert.deepEqual(
    stops.map((s) => s.code),
    ['UN', 'OA'],
  );
  assert.deepEqual(
    searchStops(stops, 'UN').map((s) => s.code),
    ['UN'],
  );
  assert.deepEqual(
    searchStops(stops, 'go').map((s) => s.code),
    ['OA'],
  );
  assert.deepEqual(searchStops(stops, ''), []);
  assert.throws(() => parseStopList({}), GoApiError);
});

test('the configuration: stops, lines, bounds, key', () => {
  const { stops, invalid, dropped } = parseStops(
    'un, OA@lw+LE:Oakville to work, bad code, UN, X@@Y, A1, A2, A3, A4, A5',
  );
  assert.deepEqual(
    stops.map((s) => [s.id, s.code, s.lines, s.name]),
    [
      ['UN', 'UN', [], ''],
      ['OA_LE-LW', 'OA', ['LE', 'LW'], 'Oakville to work'],
      ['A1', 'A1', [], ''],
      ['A2', 'A2', [], ''],
      ['A3', 'A3', [], ''],
      ['A4', 'A4', [], ''],
    ],
  );
  assert.deepEqual(invalid, ['bad code', 'X@@Y']);
  assert.deepEqual(dropped, ['A5']);
  assert.deepEqual(parseLines('lw, LE ; zz?'), ['LE', 'LW']);
  assert.equal(cleanKey(' abc-123_XYZ '), 'abc-123_XYZ');
  for (const bad of ['a b c d', 'abc\r\ndef', 'abc"def', 'ab', 'x'.repeat(200), 42]) {
    assert.equal(cleanKey(bad), '', JSON.stringify(bad));
  }
  const c = normalizeConfig({
    api_key: 'bad key here',
    departures_poll_frequency: '5',
    alerts_poll_frequency: 99999,
    max_departures: 'x',
    language: 'de',
  });
  assert.equal(c.apiKey, '');
  assert.equal(c.keyMalformed, true);
  assert.equal(c.departuresInterval, 60);
  assert.equal(c.alertsInterval, 3600);
  assert.equal(c.maxDepartures, 3);
  assert.equal(c.language, 'en');
  assert.equal(normalizeConfig({ departures_poll_frequency: '' }).departuresInterval, 60);
  assert.equal(normalizeConfig().keyMalformed, false);
});

// --- The client ----------------------------------------------------------------

const KEY = 'secret-key-0123456789';
const get = (fetchImpl, extra = {}) => apiGet({ path: 'api/V1/x', key: KEY, fetchImpl, ...extra });

async function failure(promise) {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof GoApiError);
    assert.ok(!err.message.includes(KEY) && !err.message.includes('http'), err.message);
    return err;
  }
  assert.fail('should have failed');
}

test('client: the envelope decides (HTTP 200 with ErrorCode 403 is a refusal)', async () => {
  const ok = await get(async (url, init) => {
    assert.equal(url.host, 'api.openmetrolinx.com');
    assert.equal(url.protocol, 'https:');
    assert.equal(url.searchParams.get('key'), KEY);
    assert.equal(init.redirect, 'error');
    return json({ Metadata: { ErrorCode: '200' }, X: 1 });
  });
  assert.equal(ok.data.X, 1);
  assert.equal(ok.empty, false);
  assert.equal((await get(async () => json({ Metadata: { ErrorCode: '204' } }))).empty, true);
  assert.equal(
    (await failure(get(async () => json({ Metadata: { ErrorCode: '403' } })))).kind,
    'auth',
  );
  assert.equal(
    (await failure(get(async () => json({ Metadata: { ErrorCode: '401' } })))).kind,
    'auth',
  );
  assert.equal(
    (await failure(get(async () => json({ Metadata: { ErrorCode: '404' } })))).kind,
    'notfound',
  );
  assert.equal(
    (await failure(get(async () => json({ Metadata: { ErrorCode: '503' } })))).kind,
    'server',
  );
  assert.equal(
    (await failure(get(async () => json({ Metadata: { ErrorCode: 'weird' } })))).kind,
    'error',
  );
  assert.equal((await failure(get(async () => json({ no: 'envelope' })))).kind, 'unreadable');
  assert.equal((await failure(get(async () => json([1, 2])))).kind, 'unreadable');
  assert.equal((await failure(get(async () => new Response('<html>')))).kind, 'unreadable');
  assert.equal((await failure(get(async () => new Response('', { status: 403 })))).kind, 'auth');
  const rate = await failure(
    get(async () => new Response('', { status: 429, headers: { 'retry-after': '30' } })),
  );
  assert.equal(rate.kind, 'rate');
  assert.equal(rate.retryAfterMs, 30_000);
  assert.equal((await failure(get(async () => new Response('', { status: 502 })))).kind, 'server');
  assert.equal(
    (
      await failure(
        get(async () => {
          throw new TypeError('fetch failed');
        }),
      )
    ).kind,
    'network',
  );
  assert.equal(
    (
      await failure(
        get(async () => {
          throw new DOMException('t', 'TimeoutError');
        }),
      )
    ).kind,
    'timeout',
  );
});

test('client: an oversized answer is cut before it is read whole', async () => {
  let pulled = 0;
  const stream = new ReadableStream({
    pull(controller) {
      pulled += 1;
      controller.enqueue(new Uint8Array(64 * 1024));
      if (pulled > 1000) controller.close();
    },
  });
  const err = await failure(get(async () => new Response(stream), { maxBytes: 256 * 1024 }));
  assert.equal(err.kind, 'unreadable');
  assert.ok(pulled < 20, `${pulled} chunks read`);
  const declared = await failure(
    get(async () => new Response('x', { headers: { 'content-length': '99999999' } })),
  );
  assert.equal(declared.kind, 'unreadable');
});

test('client: a hung answer is cut by the deadline', async (t) => {
  // AbortSignal.timeout does not hold the event loop (Node 22): a real socket
  // would; this interval plays it.
  const keep = setInterval(() => {}, 1000);
  t.after(() => clearInterval(keep));
  const started = Date.now();
  const err = await failure(
    get(
      (url, init) =>
        new Promise((resolve, reject) =>
          init.signal.addEventListener('abort', () => reject(init.signal.reason)),
        ),
      { timeoutMs: 100 },
    ),
  );
  assert.equal(err.kind, 'timeout');
  assert.ok(Date.now() - started < 5000);
  // A body that stops in the middle.
  const slow = new ReadableStream({ pull: () => new Promise(() => {}) });
  const cut = await failure(get(async () => new Response(slow), { timeoutMs: 100 }));
  assert.ok(['timeout', 'unreadable'].includes(cut.kind));
});

test('Retry-After: seconds or a date, bounded inputs', () => {
  assert.equal(retryAfterMs('120', 0), 120_000);
  assert.equal(retryAfterMs(new Date(START + MINUTE).toUTCString(), START), MINUTE);
  assert.equal(retryAfterMs('soon', 0), undefined);
  assert.equal(retryAfterMs(undefined, 0), undefined);
});
