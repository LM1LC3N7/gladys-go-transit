// -----------------------------------------------------------------------------
// Fixed values of the integration: the Metrolinx Open Data API, the limits the
// module keeps to (a key that calls too much is switched off by Metrolinx, by
// hand), and the keys shared by the manifest and the code.
// -----------------------------------------------------------------------------

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

/** The GO API of Metrolinx (Open Government Licence – Ontario). */
export const API_BASE = 'https://api.openmetrolinx.com/OpenDataAPI/';
export const ENDPOINTS = {
  nextService: (code) => `api/V1/Stop/NextService/${encodeURIComponent(code)}`,
  serviceAlerts: () => 'api/V1/ServiceUpdate/ServiceAlert/All',
  stops: () => 'api/V1/Stop/All',
};

/** What a read may cost before it is cut. */
export const REQUEST_TIMEOUT_MS = 10 * SECOND;
export const MAX_BODY_BYTES = 512 * 1024;
/** The list of every stop is the one large answer. */
export const MAX_STOPS_BODY_BYTES = 2 * 1024 * 1024;

/**
 * Calls per rolling hour, all of them (reads, test button, stop search),
 * counted before the call and kept across restarts. Six stops every minute
 * and the alerts every five minutes make 372.
 */
export const MAX_CALLS_PER_HOUR = 450;

/** Pause after a 429, a 5xx, a timeout or an unreadable answer: 1 min, doubled, 6 h at most. */
export const PAUSE_MIN_MS = MINUTE;
export const PAUSE_MAX_MS = 6 * HOUR;

/** A 403 on one endpoint while the key works on the other: that endpoint waits, doubled up to 1 h. */
export const DENIED_MIN_MS = 2 * MINUTE;
export const DENIED_MAX_MS = HOUR;

/** A stop code the API does not know is asked again at most every 30 minutes. */
export const UNKNOWN_STOP_RETRY_MS = 30 * MINUTE;

/** The test button: once a minute at most, whatever the clicks. */
export const TEST_MIN_GAP_MS = MINUTE;

/** The search button reads the list of stops at most every 30 s. */
export const SEARCH_MIN_GAP_MS = 30 * SECOND;

/** The list of stops (for the search button) is kept a week. */
export const STOP_LIST_TTL_MS = 7 * 24 * HOUR;

/** /data: unreadable, it is read again on its own timer. */
export const STORE_RETRY_MS = 10 * SECOND;
export const STORE_TIMEOUT_MS = 5 * SECOND;

/** getConfig() that fails in `connected`: asked again, 5 s doubled up to 5 min. */
export const CONFIG_RETRY_MIN_MS = 5 * SECOND;
export const CONFIG_RETRY_MAX_MS = 5 * MINUTE;

/** States published per rolling minute, all devices together (Gladys allows 300). */
export const MAX_STATES_PER_MINUTE = 250;

/**
 * A board older than this (or twice the departures interval when longer) is
 * blanked: 999 and "no recent reading", in the states and the widget.
 */
export const BOARD_MAX_AGE_MS = 15 * MINUTE;

/** Stops watched at most (each one costs a call per interval). */
export const MAX_STOPS = 6;

/** "No departure in the list": a sentinel rather than a stale countdown. */
export const NO_DEPARTURE_MINUTES = 999;

/** The delay thresholds of the `departure_delayed` trigger, in minutes. */
export const DELAY_THRESHOLDS = [5, 10, 15, 30];

/** Memory of the scene events already fired, kept in /data. */
export const MAX_SEEN_ALERTS = 500;
export const MAX_FIRED = 500;
export const FIRED_TTL_MS = 24 * HOUR;

export const ACTIONS = {
  TEST: 'test_key',
  SEARCH: 'search_stops',
};

export const TRIGGERS = {
  DELAYED: 'departure_delayed',
  ALERT: 'service_alert',
};

export const DELAY_EVENTS = {
  DELAYED: 'delayed',
  CANCELLED: 'cancelled',
};

export const WIDGET_KEYS = {
  DEPARTURES: 'departures',
};

export const DEVICE_TYPES = {
  STOP: 'stop',
  ALERTS: 'alerts',
};

/** The one id of the alerts device. */
export const ALERTS_PLATFORM_ID = 'network';
