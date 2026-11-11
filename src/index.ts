#!/usr/bin/env node

import { GodotMcpServer } from './server.js';
import { getErrorMessage } from './utils/error-response.js';

// The bin entry only constructs and runs the server; importing ./server.js starts nothing, so tests can load the tool list.
const server = new GodotMcpServer();
server.run().catch((error: unknown) => {
  console.error('Failed to run server:', getErrorMessage(error));
  process.exit(1);
});
