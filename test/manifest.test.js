// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, so a key renamed on one side only fails here.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { BOUNDS, DEFAULTS, LANGUAGES, normalizeConfig } from '../src/config.js';
import {
  ACTIONS,
  DELAY_EVENTS,
  DELAY_THRESHOLDS,
  MAX_CALLS_PER_HOUR,
  MAX_STOPS,
  TRIGGERS,
  WIDGET_KEYS,
} from '../src/constants.js';
import { discoveredDevices } from '../src/devices.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const handlers = read('src/handlers.js');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, entry] of node.entries()) yield* texts(entry, `${path}[${i}]`);
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) yield* texts(value, `${path}.${key}`);
  }
}

test('the store basics: the same version everywhere, never pinned; countries need 5.3.0', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'device');
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-go-transit:${manifest.version}`);
  assert.equal(manifest.version, JSON.parse(read('package.json')).version);
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(manifest.version, lock.version);
  assert.equal(manifest.version, lock.packages[''].version);
  assert.match(manifest.gladys_version, /^>=/, 'a range, never a pinned version');
  assert.deepEqual(manifest.countries, ['CA']);
  assert.equal(manifest.gladys_version, '>=5.3.0', 'countries need gladys_version >= 5.3.0');
  assert.equal(manifest.keywords, undefined);
  assert.equal(manifest.location, undefined, 'the house is never read');
  assert.deepEqual(manifest.transports, ['cloud']);
  assert.deepEqual(manifest.categories, ['services']);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
    const flat = read(`docs/${lang}.md`).replace(/\n>?\s*/g, ' ');
    assert.match(flat, /Open Government Licence – Ontario – Metrolinx/);
    assert.match(flat, /not affiliated with Metrolinx|sans lien avec Metrolinx/i);
    assert.match(
      flat,
      lang === 'en' ? /never tested with a real key/i : /jamais testé avec une vraie clé/i,
    );
    assert.doesNotMatch(flat, /encrypt|chiffr/i, `docs/${lang}.md: nothing is encrypted`);
  }
  for (const file of [
    'README.md',
    'CHANGELOG.md',
    'TODO.md',
    'CLAUDE.md',
    'gladys-assistant-integration.json',
  ]) {
    assert.doesNotMatch(read(file), /encrypt|chiffr/i, `${file}: nothing is encrypted`);
  }
  assert.match(read('TODO.md'), /## Decisions/);
  assert.match(read('CHANGELOG.md'), /## \[Unreleased\]/);
  assert.match(read('CHANGELOG.md'), /countries/);
  assert.equal(JSON.parse(read('package.json')).scripts.test, 'node --test --test-timeout=60000');
});

test('the licenses ship with the image; LICENSE is the standard text, without a name', () => {
  const license = read('LICENSE');
  assert.match(license, /Apache License\s+Version 2\.0/);
  assert.match(license, /Copyright \[yyyy\] \[name of copyright owner\]/);
  assert.doesNotMatch(license, /Louis|lmilcent|LM1LC3N7|Milcent/i);
  assert.match(read('THIRD_PARTY_NOTICES.md'), /Open Government Licence – Ontario – Metrolinx/);
  const dockerfile = read('Dockerfile');
  assert.match(dockerfile, /COPY .*LICENSE/);
  assert.match(dockerfile, /COPY .*THIRD_PARTY_NOTICES\.md/);
  assert.match(dockerfile, /COPY package\.json/, 'the client reads its version from package.json');
  assert.match(dockerfile, /USER node/);
  const png = readFileSync(new URL('../cover.png', import.meta.url));
  assert.equal(png.readUInt32BE(16), 800);
  assert.equal(png.readUInt32BE(20), 534);
});

test('every text is in English and French', () => {
  for (const [path, text] of texts(manifest)) {
    for (const lang of ['en', 'fr']) assert.ok(text[lang]?.trim(), `${path} needs ${lang}`);
  }
});

test('the configuration matches the code; the key is a secret without default', () => {
  const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
  for (const key of Object.keys(fields)) assert.doesNotMatch(key, /^gladys_/i);
  for (const [key, value] of Object.entries(DEFAULTS)) {
    assert.ok(fields[key], `${key} is not in the config_schema`);
    assert.deepEqual(fields[key].default, value, key);
  }
  for (const [key, { min, max }] of Object.entries(BOUNDS)) {
    assert.deepEqual([fields[key].min, fields[key].max], [min, max], key);
  }
  assert.deepEqual(fields.language.options.map((o) => o.value).sort(), [...LANGUAGES].sort());
  assert.equal(fields.api_key.type, 'secret');
  assert.equal(fields.api_key.default, undefined, 'a secret never has a default');
  assert.equal(fields.api_key.placeholder, undefined);
  assert.match(
    fields.api_key.description.en,
    /Kept by Gladys in its database, never shown again, sent only to api\.openmetrolinx\.com/,
  );
  assert.match(
    fields.api_key.description.en,
    new RegExp(`under ${MAX_CALLS_PER_HOUR} calls an hour`),
  );
  assert.match(fields.stops.description.en, new RegExp(`${MAX_STOPS} at most`));
  // The example parses, and its name is not the id.
  const example = normalizeConfig({ stops: fields.stops.placeholder.en }).stops;
  assert.equal(example.length, 2);
  assert.notEqual(example[1].name, example[1].id);
  for (const field of manifest.config_schema) {
    if (field.placeholder !== undefined)
      assert.equal(typeof field.placeholder, 'object', field.key);
    if (field.type === 'section') {
      assert.equal(field.default, undefined);
      assert.equal(field.required, undefined);
    }
  }
  const intro = fields.intro;
  for (const lang of ['en', 'fr']) {
    assert.ok(intro.description[lang].length <= 1000, `intro.${lang} over 1000 characters`);
    assert.match(
      intro.description[lang],
      /Never tested with a real key|Jamais testé avec une vraie clé/,
    );
  }
  assert.ok(intro.links.length <= 5 && intro.links.every((l) => l.url.startsWith('https://')));
});

test('the keys of the manifest are the keys of the code', () => {
  assert.deepEqual(manifest.actions.map((a) => a.key).sort(), Object.values(ACTIONS).sort());
  for (const name of Object.keys(ACTIONS)) {
    assert.ok(handlers.includes(`onAction(ACTIONS.${name}`), `ACTIONS.${name} has no handler`);
  }
  for (const action of manifest.actions) {
    assert.ok(action.timeout_seconds >= 5 && action.timeout_seconds <= 120);
  }
  assert.deepEqual(
    manifest.widgets.map((w) => w.key),
    Object.values(WIDGET_KEYS),
  );
  for (const name of Object.keys(WIDGET_KEYS)) {
    assert.ok(handlers.includes(`onWidgetGet(WIDGET_KEYS.${name}`));
  }
  assert.deepEqual(
    manifest.scene_triggers.map((t) => t.key).sort(),
    Object.values(TRIGGERS).sort(),
  );
  const delayed = manifest.scene_triggers.find((t) => t.key === TRIGGERS.DELAYED);
  const options = (key) => delayed.fields.find((f) => f.key === key).options.map((o) => o.value);
  assert.deepEqual(options('event'), Object.values(DELAY_EVENTS));
  assert.deepEqual(options('threshold'), DELAY_THRESHOLDS.map(String));
  for (const declaration of [...manifest.scene_triggers, ...manifest.widgets]) {
    assert.match(declaration.key, /^[a-z0-9_]{2,32}$/);
    for (const text of Object.values(declaration.label)) {
      assert.ok(text.length >= 3 && text.length <= 30, text);
    }
    for (const entry of declaration.variables ?? []) {
      assert.ok(['string', 'number', 'boolean'].includes(entry.type));
    }
    for (const field of [...(declaration.fields ?? []), ...(declaration.settings ?? [])]) {
      assert.ok(!['secret', 'oauth2', 'account_link'].includes(field.type));
      if (field.key === 'stop') assert.equal(field.source, 'devices');
    }
  }
  assert.equal(manifest.scene_actions, undefined);
});

test('the published devices: read-only, never a switch, no supported_options; the core rules', () => {
  const gladys = createFakeGladys({ selector: 'go-transit' });
  const config = normalizeConfig({ stops: 'UN, OA@LW:Oakville', max_departures: 5 });
  const devices = discoveredDevices(gladys, config);
  assert.equal(devices.length, 3);
  const options = [];
  for (const device of devices) {
    assert.equal(device.should_poll, false);
    assert.equal(device.poll_frequency, undefined);
    for (const feature of device.features) {
      assert.ok(!['switch', 'binary'].includes(feature.type), feature.external_id);
      assert.equal(feature.read_only, true);
      assert.ok(Number.isFinite(feature.min) && Number.isFinite(feature.max), feature.external_id);
      assert.ok(feature.name.length <= 40, feature.name);
      if (feature.supported_options) options.push(...feature.supported_options);
    }
    assert.equal(new Set(device.features.map((f) => f.external_id)).size, device.features.length);
  }
  // No select feature: no option at all. If one ever appears, the core rules apply.
  assert.deepEqual(options, []);
  for (const option of options) {
    assert.equal(typeof option.label, 'string');
    assert.equal(option.label, option.label.trim());
  }
  const core = '/home/claude/code/Gladys/server/utils/normalizeSupportedOptions.js';
  if (existsSync(core) && options.length > 0) {
    const normalize = createRequire(import.meta.url)(core);
    const fn = normalize.normalizeSupportedOptions ?? normalize;
    assert.doesNotThrow(() => fn(options, { allowStringValues: true }));
  }
});
