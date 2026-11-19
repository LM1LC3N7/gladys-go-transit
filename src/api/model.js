// -----------------------------------------------------------------------------
// The answers of the GO API, read field by field: nothing is trusted (type,
// length, count), a time that cannot be read leaves the value unknown, and a
// departure never gets a delay it was not given.
// -----------------------------------------------------------------------------

import { cleanText } from '../config.js';
import { GoApiError } from './client.js';
import { parseTorontoTime } from '../time.js';

const MAX_DEPARTURES = 30;
const MAX_ALERTS = 200;
const MAX_STOPS = 5000;
/** A departure whose time is this much behind "now" has left. */
const GONE_AFTER_MS = 60 * 1000;
const CODE = /^[A-Za-z0-9]{1,12}$/;
/** How far the time of an answer may be from the server clock. */
export const MAX_SKEW_MS = 10 * 60 * 1000;

const str = (value) => (typeof value === 'string' ? value : '');

/**
 * The time of the answer: the API's own clock (Metadata.TimeStamp, Toronto),
 * else the HTTP Date header, else the clock of the host.
 */
export function serverNowOf(data, serverDate, wallNow) {
  const stamp = parseTorontoTime(str(data?.Metadata?.TimeStamp));
  if (stamp !== null) {
    // A snapshot far from the clock of the answer (the Date header, else the
    // host) is an old one served again: neither published nor fired.
    const reference = Number.isFinite(serverDate) ? serverDate : wallNow;
    const stale = Number.isFinite(reference) && Math.abs(stamp - reference) > MAX_SKEW_MS;
    return { at: stamp, source: 'api', ...(stale ? { stale: true } : {}) };
  }
  if (Number.isFinite(serverDate)) return { at: serverDate, source: 'header' };
  return { at: wallNow, source: 'host' };
}

function platformOf(line) {
  for (const value of [line.ActualPlatform, line.ScheduledPlatform]) {
    const text = cleanText(str(value), 8);
    if (text && text !== '-' && text !== '0') return text;
  }
  return '';
}

/**
 * NextService of one stop -> the upcoming departures, soonest first, the line
 * filter of the stop applied.
 * @param {object} data the API answer
 * @param {{ now: number, lines?: string[] }} options `now` = the time of the answer
 */
export function parseBoard(data, { now, lines = [] }) {
  const next = data.NextService;
  if (next === null || next === undefined) return [];
  if (typeof next !== 'object' || (next.Lines !== null && !Array.isArray(next.Lines ?? []))) {
    throw new GoApiError('unreadable', 'NextService without a list of departures');
  }
  const departures = [];
  for (const raw of (next.Lines ?? []).slice(0, 200)) {
    if (!raw || typeof raw !== 'object') continue;
    const line = cleanText(str(raw.LineCode), 8).toUpperCase();
    if (!line) continue;
    if (lines.length > 0 && !lines.includes(line)) continue;
    const scheduled = parseTorontoTime(str(raw.ScheduledDepartureTime));
    const computed = parseTorontoTime(str(raw.ComputedDepartureTime));
    const time = computed ?? scheduled;
    if (time === null || time < now - GONE_AFTER_MS) continue;
    const statusText = `${str(raw.DepartureStatus)} ${str(raw.Status)}`;
    departures.push({
      line,
      lineName: cleanText(str(raw.LineName), 60),
      direction: cleanText(str(raw.DirectionName), 60),
      trip: cleanText(str(raw.TripNumber), 16),
      scheduled,
      computed,
      time,
      // Only a delay the API gave: both times read.
      delay:
        computed !== null && scheduled !== null
          ? Math.round((computed - scheduled) / 60_000)
          : null,
      cancelled: /cancel/i.test(statusText),
      platform: platformOf(raw),
    });
  }
  departures.sort((a, b) => a.time - b.time || a.line.localeCompare(b.line));
  return departures.slice(0, MAX_DEPARTURES);
}

/**
 * Minutes to wait, from the time of the answer plus the time elapsed since;
 * one second of slack, so that the time a reading takes does not show 12 min
 * for a train 13 min away.
 */
export function minutesUntil(departure, now) {
  return Math.max(0, Math.floor((departure.time - now + 1000) / 60_000));
}

/** ServiceAlert/All -> the alerts, newest first. */
export function parseAlerts(data) {
  const messages = data.Messages;
  if (messages === null || messages === undefined) return [];
  const list = messages.Message;
  if (list === null || list === undefined) return [];
  if (!Array.isArray(list)) throw new GoApiError('unreadable', 'Messages without a list');
  const alerts = [];
  const codes = new Set();
  for (const raw of list.slice(0, MAX_ALERTS * 2)) {
    if (!raw || typeof raw !== 'object') continue;
    const code = cleanText(str(raw.Code), 64);
    if (!code || codes.has(code)) continue;
    codes.add(code);
    const lineCodes = Array.isArray(raw.Lines)
      ? raw.Lines.slice(0, 50)
          .map((l) => cleanText(str(l?.Code), 8).toUpperCase())
          .filter(Boolean)
      : [];
    alerts.push({
      code,
      subject: {
        en: cleanText(str(raw.SubjectEnglish), 200),
        fr: cleanText(str(raw.SubjectFrench), 200),
      },
      body: {
        en: cleanText(str(raw.BodyEnglish), 1000),
        fr: cleanText(str(raw.BodyFrench), 1000),
      },
      category: cleanText(str(raw.Category), 40),
      posted: parseTorontoTime(str(raw.PostedDateTime)),
      lines: [...new Set(lineCodes)],
    });
    if (alerts.length >= MAX_ALERTS) break;
  }
  alerts.sort((a, b) => (b.posted ?? 0) - (a.posted ?? 0));
  return alerts;
}

/** The text of an alert in a language, the other one when it is empty. */
export function alertText(alert, field, language) {
  const other = language === 'fr' ? 'en' : 'fr';
  return alert[field][language] || alert[field][other] || '';
}

/** Stop/All -> [{ code, name, type }]. */
export function parseStopList(data) {
  const list = data?.Stations?.Station;
  if (!Array.isArray(list)) throw new GoApiError('unreadable', 'Stations without a list');
  const stops = [];
  for (const raw of list.slice(0, MAX_STOPS)) {
    const code = cleanText(str(raw?.LocationCode), 12).toUpperCase();
    if (!CODE.test(code)) continue;
    stops.push({
      code,
      name: cleanText(str(raw.LocationName), 80),
      type: cleanText(str(raw.LocationType), 40),
    });
  }
  return stops;
}

/** The stops whose code or name holds the query, exact codes first, 10 at most. */
export function searchStops(stops, query) {
  const q = cleanText(query, 60).toLowerCase();
  if (!q) return [];
  const exact = stops.filter((s) => s.code.toLowerCase() === q);
  const rest = stops.filter(
    (s) => s.code.toLowerCase() !== q && `${s.code} ${s.name}`.toLowerCase().includes(q),
  );
  return [...exact, ...rest].slice(0, 10);
}
