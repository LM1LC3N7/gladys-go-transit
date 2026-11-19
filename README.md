# gladys-go-transit

[Gladys Assistant](https://gladysassistant.com) external integration for **GO Transit** (Toronto
region): next departures of your stations, delays, cancellations, platforms and service alerts,
from the official GO API of Metrolinx with your own free key.

- User guide: [English](docs/en.md) · [Français](docs/fr.md)
- Countries: Canada (`countries: ["CA"]`, Gladys 5.3.0 or later)
- Never tested with a real key (the key is granted by hand by Metrolinx).

Contains information licensed under the Open Government Licence – Ontario – Metrolinx. Not
affiliated with Metrolinx.

## Development

```bash
npm install
npm test            # node --test, against the SDK's fake Gladys (no network)
npm run lint
npm run format:check
node scripts/mutants.mjs   # mutation check of the guards (use memcap)
node scripts/cover.mjs cover.png
```

See [CLAUDE.md](CLAUDE.md) for the architecture and the rules, [TODO.md](TODO.md) for the
decisions.

## License

Apache-2.0, see [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
