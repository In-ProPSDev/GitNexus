import { describe, expect, it } from 'vitest';
import { createKnowledgeGraph } from '../../src/core/graph/graph.js';
import { processPowerShell } from '../../src/core/ingestion/powershell-processor.js';
import { generateId } from '../../src/lib/utils.js';
import type { GraphNode } from 'gitnexus-shared';

function addFile(graph: ReturnType<typeof createKnowledgeGraph>, filePath: string): void {
  graph.addNode({
    id: generateId('File', filePath),
    label: 'File',
    properties: {
      name: filePath.split('/').pop() ?? filePath,
      filePath,
    },
  } satisfies GraphNode);
}

describe('processPowerShell', () => {
  it('extracts functions, classes, imports, and resolved calls', () => {
    const graph = createKnowledgeGraph();
    addFile(graph, 'scripts/deploy.ps1');
    addFile(graph, 'scripts/helpers.ps1');

    const result = processPowerShell(
      graph,
      [
        {
          path: 'scripts/deploy.ps1',
          content: [
            '. "$PSScriptRoot/helpers.ps1"',
            'function Invoke-Deploy {',
            '  Get-Helper -Name api',
            '  Write-Host "done"',
            '}',
            'class DeploymentPlan {',
            '}',
            'Invoke-Deploy',
          ].join('\n'),
        },
        {
          path: 'scripts/helpers.ps1',
          content: ['function Get-Helper {', '  param($Name)', '  return $Name', '}'].join('\n'),
        },
      ],
      new Set(['scripts/deploy.ps1', 'scripts/helpers.ps1']),
    );

    expect(result).toEqual({ functions: 2, classes: 1, imports: 1, calls: 2 });

    const functionNames = graph.nodes
      .filter((n) => n.label === 'Function')
      .map((n) => n.properties.name)
      .sort();
    expect(functionNames).toEqual(['Get-Helper', 'Invoke-Deploy']);

    const classNames = graph.nodes.filter((n) => n.label === 'Class').map((n) => n.properties.name);
    expect(classNames).toEqual(['DeploymentPlan']);

    const importEdges = graph.relationships.filter((r) => r.type === 'IMPORTS');
    expect(importEdges).toHaveLength(1);
    expect(importEdges[0]?.reason).toBe('powershell-dot-source');

    const callTargets = graph.relationships
      .filter((r) => r.type === 'CALLS')
      .map((r) => graph.getNode(r.targetId)?.properties.name)
      .sort();
    expect(callTargets).toEqual(['Get-Helper', 'Invoke-Deploy']);
  });

  it('ignores common built-in commands and comment-only lines', () => {
    const graph = createKnowledgeGraph();
    addFile(graph, 'scripts/cleanup.ps1');

    const result = processPowerShell(
      graph,
      [
        {
          path: 'scripts/cleanup.ps1',
          content: [
            '# Invoke-Cleanup',
            'function Invoke-Cleanup {',
            '  Get-ChildItem . | Where-Object { $_.Name -like "*.tmp" }',
            '  Remove-Item ./old.tmp',
            '}',
          ].join('\n'),
        },
      ],
      new Set(['scripts/cleanup.ps1']),
    );

    expect(result).toEqual({ functions: 1, classes: 0, imports: 0, calls: 0 });
    expect(graph.relationships.filter((r) => r.type === 'CALLS')).toHaveLength(0);
  });
});
