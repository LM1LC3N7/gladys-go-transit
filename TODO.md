# TODO

## Decisions

- Version 0.1.0 set by hand (package.json, lock, manifest, `docker_image`); the Release workflow
  owns the versions from now on.
- SDK `^0.16.0` (latest on npm on 2026-11-15). Manifest `gladys_version: ">=5.3.0"` because of
  `countries: ["CA"]`; category `services`; no `keywords`; `location` not declared (the house is
  never read).
- Source: the official GO API of Metrolinx only (help pages read on 2026-11-15). Errors come as
  HTTP 200 with `Metadata.ErrorCode` (checked live without a key: `401` without key, `403` with a
  wrong key), so both the HTTP status and the envelope are read. Times are Toronto local time
  without an offset, converted with Intl (`America/Toronto`).
- Key refusal: a 403/401 when no other kind of data (departures, alerts, stop list) has been read
  with this key; a 403 on one kind while another works only delays that kind (2 min doubled to 1 h),
  because Metrolinx disables a key by removing its capabilities by hand. Persisted as 8 bits of a
  salted SHA-256; compared exactly in memory within a session.
- Budget: 450 calls per rolling hour, one call in flight, 6 stations at most, departures every
  60 s at least, alerts every 120 s at least. Pause ladder 1 min to 6 h on 429/5xx/timeout/unreadable.
- Only the devices the user created are read (not the suggestions left in Discovery).
- Read by the integration's own timer (`should_poll: false`): the intervals go beyond the 60 s
  maximum of the core poller, and a restart must not read sooner than the interval.
- "No departure at this rank" is published as 999 minutes with empty texts (as gladys-ttc): a stale
  countdown would be worse. A delay is published only when the API gives both times; otherwise the
  status says "Scheduled".
- Cancellation is detected from the words of `DepartureStatus`/`Status` (`/cancel/i`): the API
  samples do not list the values.
- Scene events: delay thresholds 5/10/15/30 min and cancellation, once per departure (stop, line,
  trip, timetable time) and threshold, remembered 24 h in /data; new alerts fire one event per line
  (5 at most), the first reading ever only learns the current alerts.
- No scene action in v1.

## Not verified

- Never run against the real API with a key (registration is manual, up to ten business days):
  field values of `DepartureStatus`, `Status`, the platform fields, and the exact error code of a
  disabled key or of an unknown stop are taken from the documentation samples.

## Ideas

- Union Station departure board (`ServiceUpdate/UnionDepartures/All`).
- Information alerts (`ServiceUpdate/InformationAlert/All`) and UP Express.
- Fares between two stations as a scene action.
