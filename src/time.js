// -----------------------------------------------------------------------------
// The GO API writes its times in Toronto local time without an offset
// ("2026-11-15 17:23:00"). They are turned into instants here, with the
// daylight saving time of America/Toronto (Intl, full ICU in the Node image),
// and shown back in Toronto time whatever the time zone of the Gladys host.
// -----------------------------------------------------------------------------

export const TIME_ZONE = 'America/Toronto';

const LOCAL = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;
const WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

const parts = new Intl.DateTimeFormat('en-US', {
  timeZone: TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** Offset of Toronto from UTC at an instant, in ms (−5 h or −4 h). */
export function torontoOffset(instant) {
  const p = Object.fromEntries(
    parts.formatToParts(new Date(instant)).map((part) => [part.type, part.value]),
  );
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/**
 * "2026-11-15 17:23:00" (Toronto) -> epoch ms, or null when unreadable. A time
 * that carries its own offset is taken as such.
 */
export function parseTorontoTime(text) {
  if (typeof text !== 'string') return null;
  const value = text.trim();
  if (WITH_OFFSET.test(value)) {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : null;
  }
  const m = LOCAL.exec(value);
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map((v) => Number(v ?? 0));
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const asUtc = Date.UTC(y, mo - 1, d, h, mi, s);
  // Two passes: the offset at the guess, then at the result (DST changes).
  let t = asUtc - torontoOffset(asUtc);
  t = asUtc - torontoOffset(t);
  // A date that does not exist (Feb 30) comes back another day.
  const back = new Date(t + torontoOffset(t));
  if (back.getUTCDate() !== d || back.getUTCMonth() !== mo - 1) return null;
  return t;
}

/** "17:23" in Toronto time. */
export function torontoClock(instant) {
  const p = Object.fromEntries(
    parts.formatToParts(new Date(instant)).map((part) => [part.type, part.value]),
  );
  return `${p.hour}:${p.minute}`;
}
