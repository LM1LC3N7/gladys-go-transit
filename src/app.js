// -----------------------------------------------------------------------------
// The integration: reads the GO API for the devices the user created, on its
// own timer, and publishes the states, the scene events and the status.
//
// The key can be switched off by Metrolinx when it calls too much, so every
// call goes through one gate, in one queue (one call in flight at a time):
//   - a key, well-formed, not refused, /data read;
//   - no pause (429, 5xx, timeout, unreadable answer: 1 min doubled up to 6 h);
//   - the hourly budget (MAX_CALLS_PER_HOUR, counted before the call);
// and every source is read at most once per its interval, restarts included
// (the time of the attempt is in /data before the call leaves).
//
// Clocks are injected: `monotonic` for every decision (intervals, pauses,
// budget), `now` (the wall clock) only to write /data and read it back.
// -----------------------------------------------------------------------------

import { createHash, randomBytes } from 'node:crypto';
import { logger as sdkLogger } from '@gladysassistant/integration-sdk';
import {
  ACTIONS,
  BOARD_MAX_AGE_MS,
  CONFIG_RETRY_MAX_MS,
  CONFIG_RETRY_MIN_MS,
  DELAY_EVENTS,
  DELAY_THRESHOLDS,
  DENIED_MAX_MS,
  DENIED_MIN_MS,
  ENDPOINTS,
  FIRED_TTL_MS,
  HOUR,
  MAX_CALLS_PER_HOUR,
  MAX_FIRED,
  MAX_SEEN_ALERTS,
  MAX_STATES_PER_MINUTE,
  MAX_STOPS,
  MAX_STOPS_BODY_BYTES,
  MINUTE,
  PAUSE_MAX_MS,
  PAUSE_MIN_MS,
  SEARCH_MIN_GAP_MS,
  STOP_LIST_TTL_MS,
  STORE_RETRY_MS,
  TEST_MIN_GAP_MS,
  TRIGGERS,
  UNKNOWN_STOP_RETRY_MS,
} from './constants.js';
import { normalizeConfig } from './config.js';
import { GoApiError, apiGet } from './api/client.js';
import {
  alertText,
  minutesUntil,
  parseAlerts,
  parseBoard,
  parseStopList,
  searchStops,
  serverNowOf,
} from './api/model.js';
import {
  alertsIds,
  alertsStates,
  departureLine,
  departureStatus,
  discoveredDevices,
  stopIds,
  stopName,
  staleStates,
  stopStates,
  watchedAlerts,
} from './devices.js';
import { MESSAGES, join } from './i18n.js';
import { createFileStore } from './store.js';
import { torontoClock } from './time.js';

/** 8 bits of a salted hash: enough to know "the same key", never enough to find it. */
export const tagOf = (salt, key) =>
  createHash('sha256').update(`${salt}:${key}`).digest()[0].toString(16).padStart(2, '0');

const KINDS = { DEPARTURES: 'departures', ALERTS: 'alerts' };

export class GoApp {
  constructor({
    gladys,
    logger = sdkLogger,
    now = () => Date.now(),
    monotonic = () => performance.now(),
    timers = globalThis,
    store,
    fetchImpl = (...args) => fetch(...args),
    random = (n) => randomBytes(n),
    apiBase,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.store = store ?? createFileStore(undefined, { timers });
    this.fetchImpl = fetchImpl;
    this.random = random;
    this.apiBase = apiBase;

    this.gen = 0;
    this.running = false;
    this.config = null;
    this.loaded = false;
    this.loading = null;
    this.storeTimer = null;
    this.timer = null;
    this.configTimer = null;
    this.configDelay = CONFIG_RETRY_MIN_MS;
    this.configUnread = false;
    this.ticking = null;
    this.again = false;
    this.chain = Promise.resolve();
    this.lastStatus = '';

    // Decisions, on the monotonic clock.
    this.calls = [];
    this.pauseUntil = -Infinity;
    this.pauseLevel = 0;
    this.lastAttempt = new Map();
    this.retryAfter = new Map();
    this.denied = {};
    this.kindResult = {};
    this.jobResult = new Map();
    this.lastTest = -Infinity;
    this.lastSearch = -Infinity;
    this.states = [];
    this.boards = new Map();
    this.refusedKey = null;

    // Kept in /data.
    this.persist = {
      salt: '',
      refused: null,
      seenAlerts: [],
      alertsSeeded: false,
      fired: {},
      stopList: null,
    };
  }

  // --- Lifecycle -------------------------------------------------------------

  /** `connected`: read the config (asked again without end when it fails), then start. */
  async connected() {
    const gen = ++this.gen;
    this.clearConfigTimer();
    this.gladys.forgetPublishedStates?.();
    let raw;
    try {
      raw = await this.gladys.getConfig();
    } catch (err) {
      if (gen !== this.gen) return;
      this.configUnread = true;
      this.logger.warn(`Configuration not read (${err?.name ?? 'Error'}): asked again`);
      await this.reportStatus();
      if (gen !== this.gen) return;
      const delay = this.configDelay;
      this.configDelay = Math.min(CONFIG_RETRY_MAX_MS, this.configDelay * 2);
      this.configTimer = this.timers.setTimeout(() => {
        this.configTimer = null;
        if (gen === this.gen) this.connected().catch(() => {});
      }, delay);
      return;
    }
    if (gen !== this.gen) return;
    this.configDelay = CONFIG_RETRY_MIN_MS;
    await this.start(raw);
  }

  clearConfigTimer() {
    if (this.configTimer) this.timers.clearTimeout(this.configTimer);
    this.configTimer = null;
  }

  /** (Re)start with a configuration; what was learnt (times, pause, budget) is kept. */
  async start(raw) {
    const gen = ++this.gen;
    this.clearConfigTimer();
    this.configUnread = false;
    this.running = true;
    const previousKey = this.config?.apiKey;
    this.config = normalizeConfig(raw);
    if (previousKey !== undefined && previousKey !== this.config.apiKey) {
      // Another key: what the old one could read says nothing of the new one,
      // and the refusal of the old one, known exactly, never covers it.
      if (previousKey && this.isRefused(previousKey)) this.refusedKey = previousKey;
      this.kindResult = {};
      this.denied = {};
    }
    this.clearTimer();
    if (!this.loaded) await this.loadStore();
    if (gen !== this.gen) return;
    try {
      await this.gladys.publishDiscoveredDevices(discoveredDevices(this.gladys, this.config));
    } catch (err) {
      this.logger.warn(`Devices not published (${err?.name ?? 'Error'})`);
    }
    if (gen !== this.gen) return;
    // Values Gladys still shows from before this start blank out too if no
    // reading comes within the age limit.
    const mono = this.monotonic();
    for (const stop of this.config.stops) {
      if (!this.boards.has(stop.id)) this.boards.set(stop.id, { departures: null, mono });
    }
    await this.reportStatus();
    if (gen !== this.gen) return;
    this.schedule();
  }

  async stop() {
    this.gen += 1;
    this.running = false;
    this.clearTimer();
    this.clearConfigTimer();
    if (this.storeTimer) this.timers.clearTimeout(this.storeTimer);
    this.storeTimer = null;
    if (this.loaded) {
      await this.store.save(this.serialize()).catch(() => {});
    }
  }

  clearTimer() {
    if (this.timer) this.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  async scan() {
    if (!this.config) return;
    await this.gladys.publishDiscoveredDevices(discoveredDevices(this.gladys, this.config));
  }

  /** A device created or updated: its first read is due now, unless one was made within its interval. */
  async onDeviceChanged() {
    if (!this.running) return;
    this.schedule();
    await this.reportStatus();
  }

  // --- /data -----------------------------------------------------------------

  /** One read at a time; unreadable: read again on its own timer, nothing written meanwhile. */
  loadStore() {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const result = await this.store.load().catch(() => ({ ok: false, reason: 'read' }));
      this.loading = null;
      if (!result.ok) {
        this.logger.warn(`/data unreadable (${result.reason}): read again in 10 s`);
        if (!this.storeTimer && this.running) {
          this.storeTimer = this.timers.setTimeout(() => {
            this.storeTimer = null;
            if (!this.running) return;
            this.loadStore().then(() => {
              if (this.loaded && this.running) {
                this.schedule();
                this.reportStatus().catch(() => {});
              }
            });
          }, STORE_RETRY_MS);
        }
        return;
      }
      this.restore(result.data);
      this.loaded = true;
    })();
    return this.loading;
  }

  /** /data -> memory: wall times turned into monotonic ones; a future date is invalid. */
  restore(data) {
    const wall = this.now();
    const mono = this.monotonic();
    const ago = (t) =>
      Number.isFinite(t) && t <= wall && wall - t < 7 * 24 * HOUR ? wall - t : undefined;
    this.persist.salt =
      typeof data.salt === 'string' && /^[0-9a-f]{32}$/.test(data.salt)
        ? data.salt
        : this.random(16).toString('hex');
    this.persist.refused =
      data.refused && typeof data.refused.tag === 'string' ? { tag: data.refused.tag } : null;
    if (Array.isArray(data.calls)) {
      for (const t of data.calls.slice(-MAX_CALLS_PER_HOUR)) {
        const age = ago(t);
        // A date ahead of the host clock (a host without a battery clock)
        // counts as a call made now: the budget is never forgotten.
        if (Number.isFinite(t) && t > wall) this.calls.push(mono);
        else if (age !== undefined && age < HOUR) this.calls.push(mono - age);
      }
    }
    if (Number.isFinite(data.pauseUntil) && Number.isFinite(data.pauseLevel)) {
      const left = data.pauseUntil - wall;
      if (left > 0) this.pauseUntil = mono + Math.min(left, PAUSE_MAX_MS);
      this.pauseLevel = Math.max(0, Math.min(20, Math.round(data.pauseLevel)));
    }
    if (data.lastRead && typeof data.lastRead === 'object') {
      for (const [key, t] of Object.entries(data.lastRead).slice(0, 20)) {
        const age = ago(t);
        if (age !== undefined && !this.lastAttempt.has(key)) this.lastAttempt.set(key, mono - age);
      }
    }
    if (Array.isArray(data.seenAlerts)) {
      this.persist.seenAlerts = data.seenAlerts
        .filter((c) => typeof c === 'string')
        .slice(-MAX_SEEN_ALERTS);
    }
    this.persist.alertsSeeded = data.alertsSeeded === true;
    if (data.fired && typeof data.fired === 'object') {
      for (const [key, until] of Object.entries(data.fired).slice(-MAX_FIRED)) {
        if (Number.isFinite(until) && until > wall && until - wall <= FIRED_TTL_MS) {
          this.persist.fired[key] = until;
        }
      }
    }
    const list = data.stopList;
    if (list && Array.isArray(list.stops) && ago(list.at) !== undefined) {
      this.persist.stopList = { at: list.at, stops: list.stops.slice(0, 5000) };
    }
  }

  serialize() {
    const wall = this.now();
    const mono = this.monotonic();
    const toWall = (m) => Math.round(wall - (mono - m));
    return {
      v: 1,
      salt: this.persist.salt,
      refused: this.persist.refused,
      calls: this.calls.filter((t) => mono - t < HOUR).map(toWall),
      pauseUntil: this.pauseUntil > mono ? toWall(this.pauseUntil) : null,
      pauseLevel: this.pauseLevel,
      lastRead: Object.fromEntries(
        [...this.lastAttempt].slice(-20).map(([k, t]) => [k, toWall(t)]),
      ),
      seenAlerts: this.persist.seenAlerts,
      alertsSeeded: this.persist.alertsSeeded,
      fired: this.persist.fired,
      stopList: this.persist.stopList,
    };
  }

  /** Saved in the background: a slow /data never holds a read. */
  save() {
    if (!this.loaded) return;
    this.store.save(this.serialize()).catch((err) => {
      this.logger.warn(`/data not written (${err?.message === 'timeout' ? 'timeout' : 'error'})`);
    });
  }

  // --- Key refusal -----------------------------------------------------------

  isRefused(key = this.config?.apiKey) {
    if (!key) return false;
    if (this.refusedKey !== null) return this.refusedKey === key;
    return (
      this.persist.refused !== null && this.persist.refused.tag === tagOf(this.persist.salt, key)
    );
  }

  refuse(key) {
    this.refusedKey = key;
    this.persist.refused = { tag: tagOf(this.persist.salt, key) };
    this.logger.warn('API key refused by Metrolinx (403): reads stopped until it changes');
    this.save();
  }

  /** A success: the key works, whatever was refused before is lifted. */
  accept(key, kind) {
    this.kindResult[kind] = 'ok';
    delete this.denied[kind];
    this.pauseLevel = 0;
    if (this.refusedKey === key) this.refusedKey = null;
    this.persist.refused = null;
  }

  // --- The gate and the queue ------------------------------------------------

  pruneCalls(mono) {
    while (this.calls.length > 0 && mono - this.calls[0] >= HOUR) this.calls.shift();
  }

  /** Why no call may leave now (a reason key of MESSAGES.reasons), or null. */
  blocked(mono, { test = false } = {}) {
    if (!this.loaded) return 'data';
    if (!this.config?.apiKey) return 'noKey';
    if (!test && this.isRefused()) return 'refused';
    if (mono < this.pauseUntil) return 'paused';
    this.pruneCalls(mono);
    if (this.calls.length >= MAX_CALLS_PER_HOUR) return 'budget';
    return null;
  }

  /**
   * One call, in the queue: the gate is checked again just before it leaves
   * (a refusal or a pause decided by the call before applies to this one).
   */
  call(path, { maxBytes, test = false } = {}) {
    const gen = this.gen;
    const run = this.chain.then(async () => {
      if (gen !== this.gen && !test) throw new GoApiError('error', 'stopped');
      const mono = this.monotonic();
      const reason = this.blocked(mono, { test });
      if (reason) {
        const err = new GoApiError('error', `not sent: ${reason}`);
        err.blocked = reason;
        throw err;
      }
      this.calls.push(mono);
      this.save();
      const key = this.config.apiKey;
      const result = await apiGet({
        path,
        key,
        fetchImpl: this.fetchImpl,
        maxBytes,
        wallNow: this.now,
        ...(this.apiBase ? { base: this.apiBase } : {}),
      });
      return { ...result, key };
    });
    this.chain = run.catch(() => {});
    return run;
  }

  /** A failed call: pause, refusal or "that endpoint only". */
  failed(err, kind, key) {
    const mono = this.monotonic();
    switch (err.kind) {
      case 'auth': {
        if (key !== this.config?.apiKey) return;
        const elsewhere = Object.entries(this.kindResult).some(
          ([other, result]) => other !== kind && result === 'ok',
        );
        if (elsewhere) {
          // The key reads the other endpoint: this one only is closed to it.
          const level = (this.denied[kind]?.level ?? -1) + 1;
          const wait = Math.min(DENIED_MAX_MS, DENIED_MIN_MS * 2 ** level);
          this.denied[kind] = { level, until: mono + wait };
          this.kindResult[kind] = 'denied';
          this.logger.warn(`The key has no access to the ${kind} (403): asked again later`);
        } else {
          this.kindResult[kind] = 'denied';
          this.refuse(key);
        }
        return;
      }
      case 'rate':
      case 'server':
      case 'timeout':
      case 'network':
      case 'unreadable': {
        const ladder = Math.min(PAUSE_MAX_MS, PAUSE_MIN_MS * 2 ** this.pauseLevel);
        const wait = Math.min(PAUSE_MAX_MS, Math.max(ladder, err.retryAfterMs ?? 0));
        this.pauseLevel = Math.min(20, this.pauseLevel + 1);
        this.pauseUntil = Math.max(this.pauseUntil, mono + wait);
        this.logger.warn(`GO API ${err.kind}: calls paused ${Math.round(wait / 1000)} s`);
        this.save();
        return;
      }
      default:
        return;
    }
  }

  // --- Scheduling ------------------------------------------------------------

  /** The sources to read: the devices the user created, of the current configuration. */
  jobs() {
    if (!this.config) return [];
    const created = new Set((this.gladys.devices ?? []).map((d) => d.external_id));
    const jobs = [];
    for (const stop of this.config.stops.slice(0, MAX_STOPS)) {
      if (!created.has(stopIds(this.gladys, stop).device)) continue;
      jobs.push({
        key: `stop:${stop.id}`,
        kind: KINDS.DEPARTURES,
        interval: this.config.departuresInterval * 1000,
        stop,
      });
    }
    if (this.config.watchAlerts && created.has(alertsIds(this.gladys).device)) {
      jobs.push({
        key: 'alerts',
        kind: KINDS.ALERTS,
        interval: this.config.alertsInterval * 1000,
      });
    }
    return jobs;
  }

  /** When a source is due, for ONE reading of the clock. */
  dueAt(job, mono) {
    const last = this.lastAttempt.get(job.key);
    let at =
      last === undefined ? mono : last + Math.max(job.interval, this.retryAfter.get(job.key) ?? 0);
    at = Math.max(at, this.pauseUntil, this.denied[job.kind]?.until ?? -Infinity);
    this.pruneCalls(mono);
    if (this.calls.length >= MAX_CALLS_PER_HOUR) at = Math.max(at, this.calls[0] + HOUR);
    return at;
  }

  /** How old a board may grow before its values are blanked (and the widget shows nothing). */
  boardMaxAge() {
    return Math.max(BOARD_MAX_AGE_MS, 2 * (this.config?.departuresInterval ?? 60) * 1000);
  }

  /** When the oldest board still shown goes past its age, or undefined. */
  nextExpiry() {
    let next;
    for (const stop of this.config?.stops ?? []) {
      const board = this.boards.get(stop.id);
      if (!board || board.cleared) continue;
      const at = board.mono + this.boardMaxAge();
      if (next === undefined || at < next) next = at;
    }
    return next;
  }

  /** Whether reads may be planned at all (else only the expiry of the boards). */
  readable() {
    return this.running && this.loaded && Boolean(this.config?.apiKey) && !this.isRefused();
  }

  schedule() {
    this.clearTimer();
    if (!this.running) return;
    const mono = this.monotonic();
    const candidates = [];
    if (this.readable()) {
      const jobs = this.jobs();
      if (jobs.length > 0) candidates.push(Math.min(...jobs.map((job) => this.dueAt(job, mono))));
    }
    const expiry = this.nextExpiry();
    if (expiry !== undefined) candidates.push(expiry);
    if (candidates.length === 0) return;
    const next = Math.min(...candidates);
    const gen = this.gen;
    this.timer = this.timers.setTimeout(
      () => {
        this.timer = null;
        if (gen === this.gen)
          this.tick().catch((err) => this.logger.error(`Tick failed: ${err?.message}`));
      },
      Math.max(0, Math.ceil(next - mono)),
    );
  }

  /**
   * A stop not read for too long: its countdowns would be frozen, so they go
   * to 999 and the texts say there is no recent reading.
   */
  async expireBoards(gen) {
    const mono = this.monotonic();
    for (const stop of this.config?.stops ?? []) {
      const board = this.boards.get(stop.id);
      if (!board || board.cleared || mono - board.mono < this.boardMaxAge()) continue;
      board.cleared = true;
      if (
        !(this.gladys.devices ?? []).some(
          (d) => d.external_id === stopIds(this.gladys, stop).device,
        )
      ) {
        continue;
      }
      try {
        await this.publish(staleStates(this.gladys, stop, this.config));
      } catch (err) {
        this.logger.warn(`Stale values of ${stop.id} not published (${err?.name ?? 'Error'})`);
      }
      if (gen !== this.gen) return;
    }
  }

  /**
   * Reads every due source, one after the other; then the next timer. A tick
   * of a new generation (config saved, reconnection) waits for the one of the
   * old generation still out, then runs: the reads never stop.
   */
  async tick() {
    const gen = this.gen;
    if (this.ticking) {
      if (this.ticking.gen === gen) {
        this.again = true;
        return this.ticking.promise;
      }
      await this.ticking.promise.catch(() => {});
      if (gen !== this.gen) return;
      if (this.ticking) {
        this.again = true;
        return this.ticking.promise;
      }
    }
    const promise = (async () => {
      do {
        this.again = false;
        await this.expireBoards(gen);
        if (gen !== this.gen) return;
        const mono = this.monotonic();
        const due = this.jobs().filter((job) => this.dueAt(job, mono) <= mono);
        for (const job of due) {
          if (gen !== this.gen) return;
          await this.runJob(job, gen);
        }
      } while (this.again && gen === this.gen);
    })();
    const entry = { gen, promise };
    this.ticking = entry;
    try {
      await promise;
    } finally {
      if (this.ticking === entry) this.ticking = null;
    }
    if (gen !== this.gen) return;
    try {
      await this.reportStatus();
    } finally {
      if (gen === this.gen) this.schedule();
    }
  }

  async runJob(job, gen) {
    const mono = this.monotonic();
    if (this.blocked(mono)) return;
    // The attempt is recorded (and saved) before the call leaves: a restart
    // never reads sooner than the interval.
    this.lastAttempt.set(job.key, mono);
    this.retryAfter.delete(job.key);
    this.save();
    const path =
      job.kind === KINDS.ALERTS ? ENDPOINTS.serviceAlerts() : ENDPOINTS.nextService(job.stop.code);
    let result;
    try {
      result = await this.call(path);
    } catch (err) {
      if (err.blocked) {
        // Never sent: it does not count as a read.
        this.lastAttempt.delete(job.key);
        return;
      }
      if (gen !== this.gen) return;
      const unknown = err.kind === 'notfound' && job.kind === KINDS.DEPARTURES;
      this.jobResult.set(job.key, unknown ? 'unknown' : 'error');
      if (err.kind === 'notfound') this.retryAfter.set(job.key, UNKNOWN_STOP_RETRY_MS);
      this.logger.warn(`Read of ${job.key} failed (${err.kind}${err.code ? ` ${err.code}` : ''})`);
      this.failed(err, job.kind, this.config?.apiKey);
      return;
    }
    if (gen !== this.gen) return;
    try {
      if (job.kind === KINDS.ALERTS) await this.handleAlerts(result, gen);
      else await this.handleBoard(job.stop, result, gen);
      if (gen !== this.gen) return;
      this.accept(result.key, job.kind);
      this.jobResult.set(job.key, 'ok');
      this.save();
    } catch (err) {
      if (gen !== this.gen) return;
      if (err instanceof GoApiError && err.kind === 'stale') {
        this.jobResult.set(job.key, 'stale');
        this.logger.warn(`Answer for ${job.key} out of date: not used`);
      } else if (err instanceof GoApiError) {
        this.jobResult.set(job.key, 'error');
        this.logger.warn(`Answer for ${job.key} not usable (${err.kind})`);
        this.failed(err, job.kind, result.key);
      } else {
        this.jobResult.set(job.key, 'error');
        this.logger.warn(`States of ${job.key} not published (${err?.name ?? 'Error'})`);
      }
    }
  }

  // --- Publishing ------------------------------------------------------------

  /** At most MAX_STATES_PER_MINUTE states a minute, all devices together. */
  async publish(states) {
    const mono = this.monotonic();
    while (this.states.length > 0 && mono - this.states[0].at >= MINUTE) this.states.shift();
    const used = this.states.reduce((sum, entry) => sum + entry.count, 0);
    if (used + states.length > MAX_STATES_PER_MINUTE) {
      this.logger.warn('State budget of the minute reached: this reading is not published');
      return;
    }
    this.states.push({ at: mono, count: states.length });
    await this.gladys.publishChangedStates(states);
  }

  /** The time of an answer; a snapshot far from the clock of the server is not used. */
  answerTime(result) {
    const server = serverNowOf(result.data, result.serverDate, this.now());
    if (server.stale) {
      throw new GoApiError('stale', 'answer time far from the server clock');
    }
    return server;
  }

  async handleBoard(stop, result, gen) {
    const server = this.answerTime(result);
    const board = parseBoard(result.data, { now: server.at, lines: stop.lines });
    const mono = this.monotonic();
    this.boards.set(stop.id, { departures: board, at: server.at, mono });
    await this.publish(stopStates(this.gladys, stop, board, server.at, this.config));
    if (gen !== this.gen) return;
    await this.fireDelays(stop, board, server.at, gen);
  }

  async fireDelays(stop, board, now, gen) {
    const device = stopIds(this.gladys, stop).device;
    const wall = this.now();
    for (const [key, until] of Object.entries(this.persist.fired)) {
      if (until <= wall) delete this.persist.fired[key];
    }
    let sent = 0;
    for (const d of board) {
      if (sent >= 20 || gen !== this.gen) break;
      const id = `${stop.id}|${d.line}|${d.trip || ''}|${d.scheduled ?? d.time}`;
      const events = [];
      if (d.cancelled) events.push({ event: DELAY_EVENTS.CANCELLED, threshold: null, mark: 'c' });
      else if (d.delay !== null) {
        for (const t of DELAY_THRESHOLDS) {
          if (d.delay >= t)
            events.push({ event: DELAY_EVENTS.DELAYED, threshold: String(t), mark: t });
        }
      }
      for (const e of events) {
        const mark = `${id}|${e.mark}`;
        if (this.persist.fired[mark]) continue;
        this.persist.fired[mark] = wall + FIRED_TTL_MS;
        sent += 1;
        await this.gladys
          .publishSceneEvent(TRIGGERS.DELAYED, {
            stop: device,
            event: e.event,
            threshold: e.threshold,
            stop_name: stopName(stop, this.config.language),
            line: d.line,
            direction: departureLine(d),
            trip: d.trip || null,
            delay_minutes: d.delay,
            minutes: minutesUntil(d, now),
            departure_time: torontoClock(d.time),
            scheduled_time: d.scheduled !== null ? torontoClock(d.scheduled) : null,
            status: departureStatus(d, this.config.language),
          })
          .catch((err) => this.logger.warn(`Scene event not sent (${err?.name ?? 'Error'})`));
      }
    }
    const keys = Object.keys(this.persist.fired);
    for (const key of keys.slice(0, Math.max(0, keys.length - MAX_FIRED))) {
      delete this.persist.fired[key];
    }
  }

  async handleAlerts(result, gen) {
    this.answerTime(result);
    const all = parseAlerts(result.data);
    const watched = watchedAlerts(all, this.config.alertLines);
    await this.publish(alertsStates(this.gladys, watched, this.config));
    if (gen !== this.gen) return;
    const seen = new Set(this.persist.seenAlerts);
    const fresh = watched.filter((alert) => !seen.has(alert.code));
    // The first reading ever only learns what is already there: a new user
    // does not get every current alert as a scene event.
    const unsent = new Set();
    if (this.persist.alertsSeeded) {
      let sent = 0;
      for (const alert of fresh) {
        const lines = alert.lines.length > 0 ? alert.lines.slice(0, 5) : [''];
        if (sent + lines.length > 20 || gen !== this.gen) {
          // Kept for the next reading rather than lost.
          unsent.add(alert.code);
          continue;
        }
        for (const line of lines) {
          sent += 1;
          await this.gladys
            .publishSceneEvent(TRIGGERS.ALERT, {
              line: line || null,
              lines: alert.lines.join(', '),
              subject: alertText(alert, 'subject', this.config.language),
              message: alertText(alert, 'body', this.config.language),
              category: alert.category || null,
            })
            .catch((err) => this.logger.warn(`Scene event not sent (${err?.name ?? 'Error'})`));
        }
      }
    }
    for (const alert of all) {
      if (!seen.has(alert.code) && !unsent.has(alert.code)) {
        seen.add(alert.code);
        this.persist.seenAlerts.push(alert.code);
      }
    }
    this.persist.seenAlerts = this.persist.seenAlerts.slice(-MAX_SEEN_ALERTS);
    this.persist.alertsSeeded = true;
  }

  // --- Status ----------------------------------------------------------------

  describeStatus() {
    const config = this.config;
    if (this.configUnread || !config) return { connected: false, message: MESSAGES.configUnread };
    if (!this.loaded) return { connected: false, message: MESSAGES.dataUnreadable };
    if (config.keyMalformed) return { connected: false, message: MESSAGES.keyMalformed };
    if (!config.apiKey) return { connected: false, message: MESSAGES.noKey };
    if (this.isRefused()) return { connected: false, message: MESSAGES.keyRefused };
    const mono = this.monotonic();
    let notes = { en: '', fr: '' };
    if (config.invalidStops.length > 0) {
      notes = join(notes, MESSAGES.invalidStops(config.invalidStops.join(', ')));
    }
    if (config.droppedStops.length > 0) {
      notes = join(notes, MESSAGES.droppedStops(config.droppedStops.join(', '), MAX_STOPS));
    }
    const jobs = this.jobs();
    const unknown = jobs.filter((job) => this.jobResult.get(job.key) === 'unknown');
    if (unknown.length > 0) {
      // Never a throw here: a status that fails would stop the timer.
      const names = unknown.map((job) => job.stop?.code ?? job.key);
      notes = join(notes, MESSAGES.unknownStops(names.join(', ')));
    }
    for (const kind of Object.values(KINDS)) {
      if (this.denied[kind] && jobs.some((job) => job.kind === kind)) {
        notes = join(notes, MESSAGES.deniedEndpoint(MESSAGES.endpointNames[kind]));
      }
    }
    if (jobs.some((job) => this.jobResult.get(job.key) === 'stale')) {
      notes = join(notes, MESSAGES.staleData);
    }
    if (mono < this.pauseUntil) {
      const minutes = Math.max(1, Math.ceil((this.pauseUntil - mono) / MINUTE));
      return { connected: false, message: join(MESSAGES.paused(minutes), notes) };
    }
    if (jobs.length === 0)
      return { connected: true, message: join(MESSAGES.nothingCreated, notes) };
    const results = jobs.map((job) => this.jobResult.get(job.key));
    const ok = results.filter((r) => r === 'ok').length;
    const tried = results.filter((r) => r !== undefined).length;
    this.pruneCalls(mono);
    const budget = this.calls.length >= MAX_CALLS_PER_HOUR;
    let base;
    let connected = true;
    if (tried === 0) base = budget ? MESSAGES.budget : MESSAGES.waiting;
    else if (ok === 0) {
      base = MESSAGES.allFailing;
      connected = false;
    } else base = MESSAGES.ok(ok, jobs.length);
    if (budget && tried > 0)
      notes = join({ en: ` ${MESSAGES.budget.en}`, fr: ` ${MESSAGES.budget.fr}` }, notes);
    return { connected, message: join(base, notes) };
  }

  async reportStatus() {
    const status = this.describeStatus();
    const text = JSON.stringify(status);
    if (text === this.lastStatus) return;
    this.lastStatus = text;
    await this.gladys.setConnectionStatus(status.connected, status.message).catch(() => {
      this.lastStatus = '';
    });
  }

  // --- Buttons ---------------------------------------------------------------

  async testKey() {
    const config = this.config;
    if (!config) return MESSAGES.configUnread;
    if (config.keyMalformed) return MESSAGES.keyMalformed;
    const mono = this.monotonic();
    const reason = this.blocked(mono, { test: true });
    if (reason) {
      return reason === 'noKey' ? MESSAGES.noKey : MESSAGES.testFailed(MESSAGES.reasons[reason]);
    }
    if (mono - this.lastTest < TEST_MIN_GAP_MS) {
      return MESSAGES.testTooSoon(Math.ceil((TEST_MIN_GAP_MS - (mono - this.lastTest)) / 1000));
    }
    this.lastTest = mono;
    const stop = config.stops[0];
    const kind = stop ? KINDS.DEPARTURES : KINDS.ALERTS;
    const path = stop ? ENDPOINTS.nextService(stop.code) : ENDPOINTS.serviceAlerts();
    let result;
    try {
      result = await this.call(path, { test: true });
    } catch (err) {
      if (err.blocked) return MESSAGES.testFailed(MESSAGES.reasons[err.blocked]);
      if (err.kind === 'notfound' && stop) {
        // The key went through: the stop is what the API does not know.
        this.accept(config.apiKey, kind);
        this.save();
        await this.reportStatus();
        this.schedule();
        return MESSAGES.testOk(MESSAGES.stopUnknown(stop.code));
      }
      this.failed(err, kind, config.apiKey);
      await this.reportStatus();
      if (err.kind === 'auth' && this.isRefused(config.apiKey)) return MESSAGES.testRefused;
      return MESSAGES.testFailed(MESSAGES.reasons[err.kind] ?? MESSAGES.reasons.error);
    }
    this.accept(result.key, kind);
    this.save();
    let detail;
    try {
      if (stop) {
        const now = serverNowOf(result.data, result.serverDate, this.now()).at;
        detail = MESSAGES.departuresAt(
          parseBoard(result.data, { now, lines: stop.lines }).length,
          stop.code,
        );
      } else {
        detail = MESSAGES.alertsRead(parseAlerts(result.data).length);
      }
    } catch {
      detail = MESSAGES.answerReceived;
    }
    await this.reportStatus();
    this.schedule();
    return MESSAGES.testOk(detail);
  }

  async searchStopsAction(fields) {
    const query = typeof fields?.query === 'string' ? fields.query : '';
    const wall = this.now();
    const cached = this.persist.stopList;
    const fresh = cached && wall >= cached.at && wall - cached.at < STOP_LIST_TTL_MS;
    let stops = fresh ? cached.stops : null;
    if (!stops) {
      // The list is read at most every 30 s, whatever the clicks: a search
      // that fails must not eat the hourly budget of the reads.
      const mono = this.monotonic();
      if (mono - this.lastSearch < SEARCH_MIN_GAP_MS) {
        if (cached) stops = cached.stops;
        else {
          return MESSAGES.testTooSoon(
            Math.ceil((SEARCH_MIN_GAP_MS - (mono - this.lastSearch)) / 1000),
          );
        }
      } else this.lastSearch = mono;
    }
    if (!stops) {
      try {
        const result = await this.call(ENDPOINTS.stops(), { maxBytes: MAX_STOPS_BODY_BYTES });
        stops = parseStopList(result.data);
        this.accept(result.key, 'stops');
        this.persist.stopList = { at: this.now(), stops };
        this.save();
      } catch (err) {
        if (!err.blocked && err instanceof GoApiError)
          this.failed(err, 'stops', this.config?.apiKey);
        if (cached) stops = cached.stops;
        else {
          const reason = err.blocked ?? err.kind ?? 'error';
          return MESSAGES.searchUnavailable(MESSAGES.reasons[reason] ?? MESSAGES.reasons.error);
        }
      }
    }
    const found = searchStops(stops, query);
    if (found.length === 0) return MESSAGES.searchNone(query.slice(0, 60));
    const list = found.map((s) => `${s.code} (${s.name})`).join('; ');
    return MESSAGES.searchFound(list);
  }

  // --- Widget ----------------------------------------------------------------

  widgetDepartures({ settings, language }) {
    const lang = language === 'fr' ? 'fr' : 'en';
    const config = this.config;
    const stop = config?.stops.find((s) => stopIds(this.gladys, s).device === settings?.stop);
    if (!stop) {
      return {
        ttl_seconds: 60,
        components: [
          {
            type: 'text',
            variant: 'body',
            text: {
              en: 'This stop is not in the configuration any more.',
              fr: 'Cette gare n’est plus dans la configuration.',
            },
          },
        ],
      };
    }
    const board = this.boards.get(stop.id);
    const mono = this.monotonic();
    const title = { type: 'text', variant: 'heading', text: stopName(stop, lang).slice(0, 40) };
    if (!board || !board.departures || mono - board.mono > this.boardMaxAge()) {
      return {
        ttl_seconds: 60,
        components: [
          title,
          {
            type: 'text',
            variant: 'body',
            text: {
              en: 'No recent reading of this stop.',
              fr: 'Aucune lecture récente de cette gare.',
            },
          },
        ],
      };
    }
    const now = board.at + (mono - board.mono);
    const shown = board.departures.filter((d) => d.time >= now - MINUTE).slice(0, 6);
    if (shown.length === 0) {
      return {
        ttl_seconds: 60,
        components: [title, { type: 'text', variant: 'body', text: MESSAGES_NONE[lang] }],
      };
    }
    return {
      ttl_seconds: 60,
      components: [
        title,
        {
          type: 'status',
          items: shown.map((d) => ({
            label: `${torontoClock(d.time)} ${departureLine(d)}`.slice(0, 40),
            value: d.cancelled
              ? departureStatus(d, lang).slice(0, 40)
              : `${minutesUntil(d, now)} min · ${departureStatus(d, lang)}`.slice(0, 40),
            color: d.cancelled
              ? 'danger'
              : d.delay > 0
                ? 'warning'
                : d.delay === null
                  ? 'neutral'
                  : 'success',
          })),
        },
      ],
    };
  }
}

const MESSAGES_NONE = { en: 'No upcoming departure.', fr: 'Aucun départ à venir.' };

export { ACTIONS };
