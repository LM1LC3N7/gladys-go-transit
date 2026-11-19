// -----------------------------------------------------------------------------
// The SDK handlers, wired to the app. Shared by index.js and the tests, so the
// tests drive the same wiring as the container.
// -----------------------------------------------------------------------------

import { logger as sdkLogger } from '@gladysassistant/integration-sdk';
import { ACTIONS, WIDGET_KEYS } from './constants.js';

export function wire(gladys, app, logger = sdkLogger) {
  gladys.onScanRequest(() => app.scan());
  gladys.onDeviceCreated(() => app.onDeviceChanged());
  gladys.onDeviceUpdated(() => app.onDeviceChanged());
  gladys.onDeviceDeleted(() => app.onDeviceChanged());

  gladys.onAction(ACTIONS.TEST, () => app.testKey());
  gladys.onAction(ACTIONS.SEARCH, (fields) => app.searchStopsAction(fields));

  gladys.onWidgetGet(WIDGET_KEYS.DEPARTURES, (request) => app.widgetDepartures(request));

  gladys.onConfigUpdated((config) => {
    logger.info('Configuration updated');
    return app.start(config);
  });

  gladys.on('connected', () => {
    app.connected().catch((err) => logger.error(`Start failed (${err?.name ?? 'Error'})`));
  });
  gladys.on('disconnected', () => {
    app.stop().catch(() => {});
  });
}
