// -----------------------------------------------------------------------------
// Entry point: wires the SDK to the app (src/app.js). No logic here.
//
// Environment variables provided by the Gladys supervisor to the container
// (GLADYS_HOST_API_URL, GLADYS_INTEGRATION_TOKEN, GLADYS_INTEGRATION_SELECTOR)
// are read by the SDK: `new GladysIntegration()` is enough.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { GoApp } from './src/app.js';
import { wire } from './src/handlers.js';

const gladys = new GladysIntegration();
const app = new GoApp({ gladys });

wire(gladys, app, logger);
gladys.handleShutdown(() => app.stop());

// A forgotten promise must not kill the container: logged, the next tick reads again.
process.on('unhandledRejection', (reason) => {
  logger.error(`Unhandled promise rejection (${reason?.name ?? 'Error'})`);
});

logger.info('Starting the GO Transit integration...');
gladys.connect().catch((err) => {
  logger.error(`Initial connection failed (${err?.name ?? 'Error'})`);
  process.exit(1);
});
