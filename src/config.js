// -----------------------------------------------------------------------------
// The configuration filled in by the user, normalized: every value bounded,
// the watched stops parsed ("UN, OA@LW:Union to work"), anything unreadable
// set aside and reported, never guessed.
// -----------------------------------------------------------------------------

import { MAX_STOPS } from './constants.js';

export const LANGUAGES = ['en', 'fr'];

/** Mirrors the `default` values of the manifest `config_schema`. */
export const DEFAULTS = {
  watch_alerts: true,
  departures_poll_frequency: 60,
  alerts_poll_frequency: 300,
  max_departures: 3,
  language: 'en',
};

export const BOUNDS = {
  departures_poll_frequency: { min: 60, max: 3600 },
  alerts_poll_frequency: { min: 120, max: 3600 },
  max_departures: { min: 1, max: 5 },
};

/** Stop codes are short letters and digits (UN, OA, 02300). */
const CODE = /^[A-Za-z0-9]{1,12}$/;
/** Line codes (LW, LE, 21, 40). */
const LINE = /^[A-Za-z0-9]{1,8}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
/** The characters a key can hold; anything else (spaces, CR, LF, quotes) refuses it. */
const KEY = /^[A-Za-z0-9._~-]{4,128}$/;

/** A text from outside, cleaned for a name or a state: no control character, bounded. */
export function cleanText(value, max = 60) {
  if (typeof value !== 'string') return '';
  return value.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function bounded(raw, key) {
  const { min, max } = BOUNDS[key];
  const n = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : raw;
  if (typeof n !== 'number' || !Number.isFinite(n)) return DEFAULTS[key];
  return Math.min(max, Math.max(min, Math.round(n)));
}

/**
 * "UN, OA@LW:Union to work" -> stops. A stop is `CODE[@LINE[+LINE]][:Name]`.
 * @returns {{ stops: {code: string, lines: string[], name: string, id: string}[], invalid: string[], dropped: string[] }}
 */
export function parseStops(raw) {
  const stops = [];
  const invalid = [];
  const dropped = [];
  const seen = new Set();
  if (typeof raw !== 'string') return { stops, invalid, dropped };
  for (const entry of raw.split(/[,;\n]/)) {
    const text = entry.trim();
    if (!text) continue;
    const colon = text.indexOf(':');
    const head = (colon >= 0 ? text.slice(0, colon) : text).trim();
    const name = colon >= 0 ? cleanText(text.slice(colon + 1)) : '';
    const [codePart, linesPart, ...rest] = head.split('@');
    const code = codePart.trim().toUpperCase();
    const lines = (linesPart ?? '')
      .split('+')
      .map((line) => line.trim().toUpperCase())
      .filter(Boolean);
    if (rest.length > 0 || !CODE.test(code) || lines.some((line) => !LINE.test(line))) {
      invalid.push(cleanText(text, 40));
      continue;
    }
    const sorted = [...new Set(lines)].sort();
    // The id is the device id for ever: the code, then the line filter.
    const id = sorted.length > 0 ? `${code}_${sorted.join('-')}` : code;
    if (seen.has(id)) continue;
    seen.add(id);
    if (stops.length >= MAX_STOPS) {
      dropped.push(id);
      continue;
    }
    stops.push({ code, lines: sorted, name, id });
  }
  return { stops, invalid, dropped };
}

/** "LW, LE" -> ['LE', 'LW']; an empty list watches every line. */
export function parseLines(raw) {
  if (typeof raw !== 'string') return [];
  return [
    ...new Set(
      raw
        .split(/[,;\s+]+/)
        .map((line) => line.trim().toUpperCase())
        .filter((line) => LINE.test(line)),
    ),
  ].sort();
}

/** The key as typed, or '' when absent or unusable (never echoed back). */
export function cleanKey(raw) {
  if (typeof raw !== 'string') return '';
  const key = raw.trim();
  return KEY.test(key) ? key : '';
}

export function normalizeConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const typedKey = typeof source.api_key === 'string' && source.api_key.trim() !== '';
  const { stops, invalid, dropped } = parseStops(source.stops);
  return {
    apiKey: cleanKey(source.api_key),
    keyMalformed: typedKey && !cleanKey(source.api_key),
    stops,
    invalidStops: invalid,
    droppedStops: dropped,
    watchAlerts:
      typeof source.watch_alerts === 'boolean' ? source.watch_alerts : DEFAULTS.watch_alerts,
    alertLines: parseLines(source.alert_lines),
    departuresInterval: bounded(source.departures_poll_frequency, 'departures_poll_frequency'),
    alertsInterval: bounded(source.alerts_poll_frequency, 'alerts_poll_frequency'),
    maxDepartures: bounded(source.max_departures, 'max_departures'),
    language: LANGUAGES.includes(source.language) ? source.language : DEFAULTS.language,
  };
}
