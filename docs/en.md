# GO Transit

The next departures of your GO Transit stations (Toronto region), their delays and platforms, and
the service alerts of the network, from the official GO API of Metrolinx.

> Contains information licensed under the Open Government Licence – Ontario – Metrolinx
> ([licence](https://assets.metrolinx.com/image/upload/v1663237565/Documents/Metrolinx/Open-Government-Licence-Ontario-Metrolinx.pdf)).
> This integration is not affiliated with Metrolinx. It was never tested with a real key: the
> formats come from the API documentation (help pages and samples), and the first users may meet
> a field the samples did not show.

## 1. Get a key

1. Fill in the [registration form](https://api.openmetrolinx.com/OpenDataAPI/Help/Registration/en)
   of the GO API (free). Metrolinx handles the requests by hand: up to ten business days.
2. The key arrives by e-mail. It does not expire, but Metrolinx switches off a key that calls too
   much, by hand. The integration therefore keeps to its own limits (below).

## 2. Configure

- **GO API key**: paste the key. Kept by Gladys in its database, never shown again, sent only to
  `api.openmetrolinx.com` (in the address of each call, as the API asks), never written in the
  logs, the status or the integration files.
- **Stations and stops**: the GO stop codes, comma-separated, 6 at most: `UN` for Union Station,
  `OA` for Oakville… The **Find a stop** button at the bottom of the page gives the codes (it reads
  the list of stops once, then keeps it a week). After the code, an optional line filter (`@LW`,
  several joined by `+`: `@LW+LE`) and a name (`:Oakville to work`):
  `UN, OA@LW:Oakville to work`.
- **Watch the service alerts**: proposes the alerts device. **Lines of the alerts**: only the
  alerts of these lines (`LW, LE`); empty, every alert.
- **Advanced**: the refresh of the departures (60 s by default, 60 s at least), of the alerts
  (300 s, 120 s at least), the number of departures per station (1 to 5), the language of the
  values (the alerts come in English and French from Metrolinx).

Then open the **Discover** tab and add your stations and the alerts device. Only the devices you
added are read: a station left in the Discovery screen costs nothing.

## 3. What you get

For each station:

- **Next departure**, **Departure 2**…: minutes to wait (999 when there is no departure at that
  rank).
- **… line**: line and direction (`LW - Aldershot GO`).
- **… status**: `On time`, `+5 min`, `2 min early`, `Cancelled`, or `Scheduled` when the API gives
  only the timetable time; then the platform when known (`Pl. 4`).
- **Next departures**: one line for a dashboard (`LW 17:23 +5 min · Pl. 4 | LE 17:30 On time`),
  in Toronto time.

The **alerts** device: **Active alerts** (number, of the watched lines) and **Latest alert** (its
subject).

The **GO departures** dashboard widget shows the board of a station, counted down from the last
reading; a board older than 15 minutes is not shown.

### Scenes

- **GO departure delayed**: a departure of a station is late by at least 5, 10, 15 or 30 minutes,
  or is cancelled. Once per departure and per threshold (a departure that goes from 0 to 12 minutes
  fires 5 and 10). Filters: station, event, threshold, line. Variables: line, direction, trip
  number, delay, minutes to wait, times, status.
- **New GO service alert**: Metrolinx posted an alert for a watched line, one event per line of the
  alert (5 at most). The first reading after installing only learns the alerts already there, so you
  do not get them all at once. The alerts already announced are remembered across restarts.

## 4. Limits kept by the integration

- **One call at a time**, and **450 calls per rolling hour** at most, all together, counted before
  each call and kept across restarts (6 stations every minute and the alerts every 5 minutes make
  372).
- Each source is read **once per its interval**, restarts included.
- After a **429**, a **5xx**, no answer within **10 s** or an unreadable answer: every call pauses
  1 minute, then 2, 4… up to 6 hours (`Retry-After` honored), kept across restarts. A success
  resets the ladder.
- Answers bounded: 512 KB (2 MB for the list of stops), cut beyond.
- **Key refused** (403 while the key has read nothing else, or 401): reads stop, and the status says
  so. Kept in `/data` as 8 bits of a salted hash, never the key. Lifted by a new key or a successful
  **Test the key** click. Saving the same key again does not send it again. Rare limit: after a
  restart, a new key whose 8-bit mark matches the refused one (1 chance in 256) waits for one click
  on **Test the key**.
- A 403 on one kind of data while the key reads the other (the key lost one right): only that kind
  waits, 2 minutes doubled up to 1 hour.
- **Test the key**: once a minute at most; it counts in the hourly limit and is not sent during a
  pause (the answer says so).
- A stop code the API does not know is asked again every 30 minutes, and named in the status.
- `/data` unreadable: no call until it can be read (read again every 10 s); nothing written over it.

## 5. Status messages

The Configuration screen says what to do next: add the key, key refused, pause and its length,
hourly limit reached, codes ignored, stations unknown to the API, no access to the alerts.

## Privacy

The only service called is `api.openmetrolinx.com`. The location of your house is never read.
