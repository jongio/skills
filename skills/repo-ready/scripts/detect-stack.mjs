/**
 * detect-stack.mjs (re-export)
 *
 * Thin wrapper around the shared lib/detect-stack.mjs module.
 * Keeps this skill self-contained for imports while the source of truth
 * lives in lib/ at the repo root.
 *
 * Source of truth: lib/detect-stack.mjs
 */

export {
  STACK_MARKERS,
  STACK_META,
  detectStack,
  gitignoreTemplates,
  dependabotEcosystems,
} from '../../../lib/detect-stack.mjs';

import { detectStack } from '../../../lib/detect-stack.mjs';

// CLI entry point
if (process.argv[1] && process.argv[1].endsWith('detect-stack.mjs')) {
  const dir = process.argv[2] || process.cwd();
  const result = detectStack(dir);
  console.log(JSON.stringify(result, null, 2));
}
