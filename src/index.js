import dotenv from 'dotenv';

import { OrderIndexer } from '@bronlabs/intents-sdk';

import { loadConfig } from './config.js';
import { SolverProcessor } from './solver.js';

dotenv.config();
const config = loadConfig();


const indexer = new OrderIndexer(config);
const solver = new SolverProcessor(config);

indexer.addProcessor(async (event) => {
  await solver.process(event.data.orderId, event.data.status);
})

indexer.start().catch(error => {
  console.error('Failed to start indexer:', error);
  process.exit(1);
});

['SIGINT', 'SIGTERM'].forEach(signal =>
  process.on(signal, async () => {
    console.log(`Received ${signal}, shutting down gracefully...`);

    await indexer.stop();
    await solver.stop();

    process.exit(0);
  })
);
