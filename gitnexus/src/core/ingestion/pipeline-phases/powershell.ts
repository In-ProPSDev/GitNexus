/**
 * Phase: powershell
 *
 * Processes PowerShell files with a dependency-free parser.
 *
 * @deps    structure
 * @reads   scannedFiles, allPaths (from structure phase)
 * @writes  graph (PowerShell symbols, imports, and resolved local calls)
 */

import type { PipelinePhase, PipelineContext, PhaseResult } from './types.js';
import { getPhaseOutput } from './types.js';
import { readFileContents } from '../filesystem-walker.js';
import {
  isPowerShellFile,
  processPowerShell,
  type PowerShellResult,
} from '../powershell-processor.js';
import type { StructureOutput } from './structure.js';
import { isDev } from '../utils/env.js';
import { logger } from '../../logger.js';

export type PowerShellOutput = PowerShellResult;

export const powershellPhase: PipelinePhase<PowerShellOutput> = {
  name: 'powershell',
  deps: ['structure'],

  async execute(
    ctx: PipelineContext,
    deps: ReadonlyMap<string, PhaseResult<unknown>>,
  ): Promise<PowerShellOutput> {
    const { scannedFiles, allPathSet } = getPhaseOutput<StructureOutput>(deps, 'structure');
    const psScanned = scannedFiles.filter((f) => isPowerShellFile(f.path));

    if (psScanned.length === 0) {
      return { functions: 0, classes: 0, imports: 0, calls: 0 };
    }

    const psContents = await readFileContents(
      ctx.repoPath,
      psScanned.map((f) => f.path),
    );
    const psFiles = psScanned
      .filter((f) => psContents.has(f.path))
      .map((f) => ({ path: f.path, content: psContents.get(f.path)! }));

    const result = processPowerShell(ctx.graph, psFiles, allPathSet);

    if (isDev) {
      logger.info(
        '  PowerShell: ' +
          result.functions +
          ' functions, ' +
          result.classes +
          ' classes, ' +
          result.imports +
          ' imports, ' +
          result.calls +
          ' calls from ' +
          psFiles.length +
          ' files',
      );
    }

    return result;
  },
};
