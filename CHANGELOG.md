# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

## [Unreleased]

### Added

- First version: next departures of up to 6 GO Transit stations (minutes to wait, line, delay or
  cancellation, platform, one-line board), service alerts of the watched lines, from the official
  GO API of Metrolinx with the user's own key.
- Scene triggers "GO departure delayed" and "New GO service alert", dashboard widget "GO
  departures", "Test the key" and "Find a stop" buttons.
- Limits kept for the key: one call at a time, 450 calls per hour, pause on 429/5xx/timeout,
  refusal kept without the key.
- `countries: ["CA"]` in the manifest (requires Gladys 5.3.0 or later).
