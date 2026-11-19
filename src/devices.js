// -----------------------------------------------------------------------------
// The devices: one per watched stop (its next departures) and one for the
// service alerts of the network. Read-only, never a switch: nothing here acts
// on anything. Ids are fixed for ever: `stop:<CODE>` or `stop:<CODE>_<LINES>`
// with a line filter, and `alerts:network`.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';
import { ALERTS_PLATFORM_ID, DEVICE_TYPES, NO_DEPARTURE_MINUTES } from './constants.js';
import { LABELS } from './i18n.js';
import { minutesUntil, alertText } from './api/model.js';
import { torontoClock } from './time.js';

/** Text features carry a 0/0 range: the core columns are NOT NULL. */
const TEXT = {
  category: DEVICE_FEATURE_CATEGORIES.TEXT,
  type: DEVICE_FEATURE_TYPES.TEXT.TEXT,
  min: 0,
  max: 0,
  read_only: true,
  has_feedback: false,
  keep_history: false,
};
const MAX_TEXT = 250;

export const featureKeys = {
  departure: (n) => `departure_${n}`,
  line: (n) => `departure_${n}_line`,
  status: (n) => `departure_${n}_status`,
  summary: 'summary',
  count: 'count',
  latest: 'latest',
};

export function stopIds(gladys, stop) {
  return gladys.externalIds(DEVICE_TYPES.STOP, stop.id);
}

export function alertsIds(gladys) {
  return gladys.externalIds(DEVICE_TYPES.ALERTS, ALERTS_PLATFORM_ID);
}

export function stopName(stop, language) {
  if (stop.name) return stop.name;
  const lines = stop.lines.length > 0 ? ` (${stop.lines.join(', ')})` : '';
  return `${LABELS[language].stop} ${stop.code}${lines}`;
}

export function buildStopDevice(gladys, stop, config) {
  const ids = stopIds(gladys, stop);
  const labels = LABELS[config.language];
  const features = [];
  for (let n = 1; n <= config.maxDepartures; n += 1) {
    features.push({
      name: labels.departure(n),
      external_id: ids.feature(featureKeys.departure(n)),
      category: DEVICE_FEATURE_CATEGORIES.DURATION,
      type: DEVICE_FEATURE_TYPES.DURATION.INTEGER,
      unit: DEVICE_FEATURE_UNITS.MINUTES,
      min: 0,
      max: NO_DEPARTURE_MINUTES,
      read_only: true,
      has_feedback: false,
      // A countdown: its history would be thousands of rows a day, worth nothing.
      keep_history: false,
    });
    features.push({ ...TEXT, name: labels.line(n), external_id: ids.feature(featureKeys.line(n)) });
    features.push({
      ...TEXT,
      name: labels.status(n),
      external_id: ids.feature(featureKeys.status(n)),
    });
  }
  features.push({
    ...TEXT,
    name: labels.summary,
    external_id: ids.feature(featureKeys.summary),
  });
  return {
    name: stopName(stop, config.language),
    external_id: ids.device,
    // Read by the integration's own timer (src/app.js), not by the core poller.
    should_poll: false,
    params: [
      { name: 'stop_code', value: stop.code },
      { name: 'lines', value: stop.lines.join(',') },
    ],
    features,
  };
}

export function buildAlertsDevice(gladys, config) {
  const ids = alertsIds(gladys);
  const labels = LABELS[config.language];
  return {
    name: labels.alertsDevice,
    external_id: ids.device,
    should_poll: false,
    params: [{ name: 'lines', value: config.alertLines.join(',') }],
    features: [
      {
        name: labels.alertCount,
        external_id: ids.feature(featureKeys.count),
        category: DEVICE_FEATURE_CATEGORIES.COUNTER_SENSOR,
        type: DEVICE_FEATURE_TYPES.SENSOR.INTEGER,
        min: 0,
        max: 1000,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
      { ...TEXT, name: labels.latestAlert, external_id: ids.feature(featureKeys.latest) },
    ],
  };
}

/** "+5 min · Pl. 4", "On time", "Cancelled", "Scheduled" (no real-time time given). */
export function departureStatus(departure, language) {
  const labels = LABELS[language];
  let text;
  if (departure.cancelled) text = labels.cancelled;
  else if (departure.delay === null) text = labels.scheduled;
  else if (departure.delay > 0) text = labels.late(departure.delay);
  else if (departure.delay < 0) text = labels.early(-departure.delay);
  else text = labels.onTime;
  return departure.platform ? `${text} · ${labels.platform(departure.platform)}` : text;
}

export function departureLine(departure) {
  const direction = departure.direction.toUpperCase().startsWith(departure.line)
    ? departure.direction
    : `${departure.line} ${departure.direction}`.trim();
  return (direction || departure.line).slice(0, 80);
}

/** "LW 17:23 +5 min · Pl. 4 · LE 17:30 On time" (Toronto times). */
export function summaryOf(departures, language) {
  if (departures.length === 0) return LABELS[language].none;
  let text = '';
  for (const d of departures) {
    const part = `${d.line} ${torontoClock(d.time)} ${departureStatus(d, language)}`;
    const next = text ? `${text} | ${part}` : part;
    if (next.length > MAX_TEXT) break;
    text = next;
  }
  return text;
}

/**
 * The states of a stop for a board read at `now` (time of the answer).
 * A rank without a departure gets 999 and empty texts: a stale "2 min" left
 * from the read before would be a train that never comes.
 */
export function stopStates(gladys, stop, board, now, config) {
  const ids = stopIds(gladys, stop);
  const states = [];
  const shown = board.slice(0, config.maxDepartures);
  for (let n = 1; n <= config.maxDepartures; n += 1) {
    const d = shown[n - 1];
    states.push({
      device_feature_external_id: ids.feature(featureKeys.departure(n)),
      state: d ? Math.min(minutesUntil(d, now), NO_DEPARTURE_MINUTES) : NO_DEPARTURE_MINUTES,
    });
    states.push({
      device_feature_external_id: ids.feature(featureKeys.line(n)),
      text: d ? departureLine(d) : '',
    });
    states.push({
      device_feature_external_id: ids.feature(featureKeys.status(n)),
      text: d ? departureStatus(d, config.language) : '',
    });
  }
  states.push({
    device_feature_external_id: ids.feature(featureKeys.summary),
    text: summaryOf(shown, config.language),
  });
  return states;
}

/** A stop not read for too long: no countdown left, the summary says why. */
export function staleStates(gladys, stop, config) {
  const ids = stopIds(gladys, stop);
  const states = [];
  for (let n = 1; n <= config.maxDepartures; n += 1) {
    states.push({
      device_feature_external_id: ids.feature(featureKeys.departure(n)),
      state: NO_DEPARTURE_MINUTES,
    });
    states.push({ device_feature_external_id: ids.feature(featureKeys.line(n)), text: '' });
    states.push({ device_feature_external_id: ids.feature(featureKeys.status(n)), text: '' });
  }
  states.push({
    device_feature_external_id: ids.feature(featureKeys.summary),
    text: LABELS[config.language].noReading,
  });
  return states;
}

/** The alerts of the watched lines (every alert when no line is chosen). */
export function watchedAlerts(alerts, lines) {
  if (lines.length === 0) return alerts;
  return alerts.filter((alert) => alert.lines.some((line) => lines.includes(line)));
}

export function alertsStates(gladys, alerts, config) {
  const ids = alertsIds(gladys);
  const latest = alerts[0];
  return [
    { device_feature_external_id: ids.feature(featureKeys.count), state: alerts.length },
    {
      device_feature_external_id: ids.feature(featureKeys.latest),
      text: latest
        ? alertText(latest, 'subject', config.language).slice(0, MAX_TEXT) ||
          LABELS[config.language].noAlert
        : LABELS[config.language].noAlert,
    },
  ];
}

/** Every device the configuration describes, for the Discovery screen. */
export function discoveredDevices(gladys, config) {
  const devices = config.stops.map((stop) => buildStopDevice(gladys, stop, config));
  if (config.watchAlerts) devices.push(buildAlertsDevice(gladys, config));
  return devices;
}
