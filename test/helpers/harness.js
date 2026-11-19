// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys, a scripted GO API and a virtual clock.
// The monotonic clock moves 1 µs at every read (a decision reading it twice is
// caught), the wall clock can be set apart from it.
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { GoApp } from '../../src/app.js';
import { wire } from '../../src/handlers.js';
import { createMemoryStore } from '../../src/store.js';
import { buildAlertsDevice, buildStopDevice } from '../../src/devices.js';
import { normalizeConfig } from '../../src/config.js';

export const SELECTOR = 'go-transit';
export const KEY = 'test-key-1234567890abcdef';
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
/** 2026-11-16 17:00:00 in Toronto (EST, UTC−5). */
export const START = Date.UTC(2026, 10, 16, 22, 0, 0);

/** "2026-11-16 17:05:00" for an instant (EST, the test dates are in winter). */
export function toronto(instant) {
  const d = new Date(instant - 5 * HOUR);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

export function createClock(start = START) {
  const clock = { now: start, drift: 0 };
  let nextId = 1;
  const pending = new Map();
  const timers = {
    setTimeout(fn, ms) {
      const id = nextId++;
      pending.set(id, { fn, at: clock.now + Math.max(0, Number(ms) || 0) });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
  };
  const settle = async () => {
    for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  async function advance(ms) {
    const target = clock.now + ms;
    for (let i = 0; i < 100_000; i += 1) {
      await settle();
      let next;
      for (const [id, timer] of pending) {
        if (timer.at <= target && (!next || timer.at < next.timer.at)) next = { id, timer };
      }
      if (!next) break;
      pending.delete(next.id);
      clock.now = Math.max(clock.now, next.timer.at);
      next.timer.fn();
    }
    clock.now = Math.max(clock.now, target);
    await settle();
  }
  return {
    clock,
    timers,
    pending,
    advance,
    settle,
    monotonic: () => clock.now + (clock.drift += 0.001),
  };
}

// --- The GO API --------------------------------------------------------------

export const meta = (now, code = '200') => ({
  TimeStamp: toronto(now),
  ErrorCode: code,
  ErrorMessage: code === '200' ? 'OK' : 'Error',
});

/** One departure: minutes from now, delay in minutes (null: no computed time). */
export function departure(
  now,
  {
    at,
    line = 'LW',
    in: minutes = 5,
    delay = 0,
    trip = '1234',
    platform = '4',
    status = '',
    direction = 'LW - Aldershot GO',
  } = {},
) {
  const scheduled = at ?? now + minutes * MINUTE;
  return {
    StopCode: 'UN',
    LineCode: line,
    LineName: 'Lakeshore West',
    ServiceType: 'T',
    DirectionCode: 'W',
    DirectionName: direction,
    ScheduledDepartureTime: toronto(scheduled),
    ComputedDepartureTime: delay === null ? null : toronto(scheduled + delay * MINUTE),
    DepartureStatus: status,
    ScheduledPlatform: platform,
    ActualPlatform: '',
    TripOrder: 1,
    TripNumber: trip,
    UpdateTime: '',
    Status: '',
    Latitude: 43.6,
    Longitude: -79.3,
  };
}

export const board = (now, lines) => ({ Metadata: meta(now), NextService: { Lines: lines } });

export const alertsBody = (now, messages) => ({
  Metadata: meta(now),
  Messages: { Message: messages },
});

export function alert(code, { lines = ['LW'], subject = `Alert ${code}`, posted = START } = {}) {
  return {
    Code: code,
    ParentCode: '',
    Status: 'INIT',
    PostedDateTime: toronto(posted),
    SubjectEnglish: subject,
    SubjectFrench: `Alerte ${code}`,
    BodyEnglish: `Body ${code}`,
    BodyFrench: `Texte ${code}`,
    Category: 'Service Disruption',
    SubCategory: '',
    Lines: lines.map((Code) => ({ Code })),
    Stops: [],
    Trips: [],
  };
}

export const denied = (now, code = '403') => ({ Metadata: meta(now, code), NextService: null });

/** A JSON answer; `headers` added. */
export const json = (body, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      date: new Date(START).toUTCString(),
      ...headers,
    },
  });

/**
 * The scripted API: `routes(path, now)` -> body | Response | 'timeout' | 'hang'.
 * Default: Union with one LW departure in 5 min, no alert.
 */
export function createApi(clock, routes) {
  const api = { calls: [], routes };
  api.fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    api.calls.push({
      path: parsed.pathname,
      key: parsed.searchParams.get('key'),
      init,
      at: clock.now,
    });
    const answer = await api.routes(parsed.pathname, clock.now, parsed);
    if (answer === 'timeout') throw new DOMException('The operation timed out.', 'TimeoutError');
    if (answer === 'hang') {
      return new Promise((resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal.reason));
      });
    }
    if (answer instanceof Response) return answer;
    if (answer === undefined) return new Response('not found', { status: 404 });
    return json(answer);
  };
  api.count = (part) => api.calls.filter((c) => c.path.includes(part)).length;
  return api;
}

export const defaultRoutes = (path, now) => {
  if (path.includes('/Stop/NextService/')) return board(now, [departure(now)]);
  if (path.includes('/ServiceAlert/')) return alertsBody(now, []);
  if (path.includes('/Stop/All')) {
    return {
      Metadata: meta(now),
      Stations: {
        Station: [
          {
            LocationCode: 'UN',
            PublicStopId: '',
            LocationName: 'Union Station',
            LocationType: 'Train & Bus Station',
          },
          {
            LocationCode: 'OA',
            PublicStopId: '',
            LocationName: 'Oakville GO',
            LocationType: 'Train Station',
          },
        ],
      },
    };
  }
  return undefined;
};

export const CONFIG = { api_key: KEY, stops: 'UN', watch_alerts: true };

/** The devices the user created from the Discovery screen, for a config. */
export function createdDevices(config = CONFIG, { alerts = true } = {}) {
  const gladys = createFakeGladys({ selector: SELECTOR });
  const normalized = normalizeConfig(config);
  const devices = normalized.stops.map((stop) => buildStopDevice(gladys, stop, normalized));
  if (alerts && normalized.watchAlerts) devices.push(buildAlertsDevice(gladys, normalized));
  return devices;
}

export async function setup({
  config = CONFIG,
  devices,
  store = createMemoryStore(),
  routes = defaultRoutes,
  start = START,
  wall = { offset: 0 },
} = {}) {
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config,
    devices: devices ?? createdDevices(config),
  });
  const time = createClock(start);
  const api = createApi(time.clock, routes);
  const lines = [];
  const log = (...args) => lines.push(args.map(String).join(' '));
  const app = new GoApp({
    gladys,
    logger: { info: log, warn: log, error: log, debug: log },
    now: () => time.clock.now + wall.offset,
    monotonic: time.monotonic,
    timers: time.timers,
    store,
    fetchImpl: api.fetch,
    random: (n) => Buffer.alloc(n, 7),
  });
  const quiet = { info: log, warn: log, error: log, debug: log };
  wire(gladys, app, quiet);
  // Connected without the `connected` start: each test starts the app itself.
  gladys.removeAllListeners?.('connected');
  await gladys.connect();
  const begin = async (cfg = config) => {
    await app.start(cfg);
    await time.advance(0);
  };
  const states = (part) =>
    gladys.fake.states.filter((s) => s.device_feature_external_id.includes(part));
  const F = (key, id = 'UN') => `ext:${SELECTOR}:stop:${id}:${key}`;
  const A = (key) => `ext:${SELECTOR}:alerts:network:${key}`;
  return { app, gladys, fake: gladys.fake, time, api, store, lines, begin, states, F, A, wall };
}
