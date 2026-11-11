// Launched by a spawned game's bridge when its server died without running its exit hook. It runs the repair a headless call would, so project.godot keeps one mutator.
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { BridgeManager } from './utils/bridge-manager.js';

const USAGE_EXIT_CODE = 2;

const projectPath = process.argv[2];
if (projectPath === undefined || projectPath === '') {
  console.error('usage: sweep-stranded <projectPath>');
  process.exit(USAGE_EXIT_CODE);
}

const bridgeTemplatePath = join(
  dirname(fileURLToPath(import.meta.url)),
  'scripts',
  'mcp_bridge.gd',
);
new BridgeManager(bridgeTemplatePath).repairOrphaned(resolve(projectPath));
