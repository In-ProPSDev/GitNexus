/**
 * PowerShell processor.
 *
 * Extracts a conservative graph from .ps1/.psm1/.psd1 files without adding a
 * tree-sitter dependency. It intentionally focuses on stable top-level signals:
 * function/class declarations, dot-sourced or module file imports, and calls to
 * functions discovered in the same processed PowerShell file set.
 */

import path from 'node:path';
import { generateId } from '../../lib/utils.js';
import type { GraphNode } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../graph/types.js';

const POWERSHELL_EXTENSIONS = new Set(['.ps1', '.psm1', '.psd1']);
const FUNCTION_RE = /^\s*function\s+(?:global:|script:|local:|private:)?([A-Za-z_][\w-]*)\b/i;
const CLASS_RE = /^\s*class\s+([A-Za-z_][\w]*)\b/i;
const DOT_SOURCE_RE = /^\s*\.\s+(.+?)(?:\s|$)/i;
const IMPORT_MODULE_RE = /^\s*Import-Module\s+(.+?)(?:\s|$)/i;
const COMMAND_RE = /(?:^|[;|{}])\s*&?\s*([A-Za-z_][\w]*(?:-[A-Za-z_][\w-]*)?)\b/g;

const KEYWORDS = new Set([
  'begin',
  'break',
  'catch',
  'class',
  'continue',
  'data',
  'do',
  'dynamicparam',
  'else',
  'elseif',
  'end',
  'exit',
  'filter',
  'finally',
  'for',
  'foreach',
  'from',
  'function',
  'if',
  'in',
  'param',
  'process',
  'return',
  'switch',
  'throw',
  'trap',
  'try',
  'until',
  'using',
  'while',
]);

const BUILT_IN_COMMANDS = new Set([
  'Write-Host',
  'Write-Output',
  'Write-Error',
  'Write-Warning',
  'Write-Verbose',
  'Write-Debug',
  'Get-ChildItem',
  'Where-Object',
  'ForEach-Object',
  'Select-Object',
  'Sort-Object',
  'Group-Object',
  'Measure-Object',
  'Remove-Item',
  'Copy-Item',
  'Move-Item',
  'New-Item',
  'Set-Item',
  'Get-Item',
  'Test-Path',
  'Join-Path',
  'Split-Path',
  'Resolve-Path',
  'Import-Module',
  'Export-ModuleMember',
]);

export interface PowerShellFile {
  path: string;
  content: string;
}

export interface PowerShellResult {
  functions: number;
  classes: number;
  imports: number;
  calls: number;
}

interface SymbolDef {
  id: string;
  filePath: string;
  name: string;
  startLine: number;
}

interface PendingCall {
  sourceFileId: string;
  sourceSymbolId: string | null;
  command: string;
  filePath: string;
  line: number;
}

export const isPowerShellFile = (filePath: string): boolean =>
  POWERSHELL_EXTENSIONS.has(path.extname(filePath).toLowerCase());

export function processPowerShell(
  graph: KnowledgeGraph,
  files: readonly PowerShellFile[],
  allPathSet: ReadonlySet<string>,
): PowerShellResult {
  let functions = 0;
  let classes = 0;
  let imports = 0;
  let calls = 0;
  const symbolsByName = new Map<string, SymbolDef[]>();
  const pendingCalls: PendingCall[] = [];

  for (const file of files) {
    if (!isPowerShellFile(file.path)) continue;
    const fileNodeId = generateId('File', file.path);
    if (!graph.getNode(fileNodeId)) continue;

    const lines = file.content.split(/\r\n|\r|\n/);
    let currentFunction: SymbolDef | null = null;
    let currentDepth = 0;

    for (let i = 0; i < lines.length; i++) {
      const lineNum = i + 1;
      const rawLine = lines[i] ?? '';
      const line = stripLineComment(rawLine);
      const fnMatch = line.match(FUNCTION_RE);
      if (fnMatch) {
        const name = fnMatch[1]!;
        const symbol = addSymbol(graph, fileNodeId, file.path, 'Function', name, lineNum);
        addSymbolIndex(symbolsByName, symbol);
        functions++;
        currentFunction = symbol;
        currentDepth = braceDelta(line);
        continue;
      }

      const classMatch = line.match(CLASS_RE);
      if (classMatch) {
        const name = classMatch[1]!;
        addSymbol(graph, fileNodeId, file.path, 'Class', name, lineNum);
        classes++;
        currentDepth += braceDelta(line);
        continue;
      }

      const importTarget = extractImportTarget(line);
      if (importTarget !== null) {
        const targetPath = resolvePowerShellImport(file.path, importTarget, allPathSet);
        if (targetPath !== null) {
          graph.addRelationship({
            id: generateId('IMPORTS', file.path + ':' + lineNum + '->' + targetPath),
            type: 'IMPORTS',
            sourceId: fileNodeId,
            targetId: generateId('File', targetPath),
            confidence: 0.85,
            reason:
              importTarget.kind === 'dot-source'
                ? 'powershell-dot-source'
                : 'powershell-import-module',
          });
          imports++;
        }
      }

      for (const command of extractCommands(line)) {
        if (shouldSkipCommand(command)) continue;
        pendingCalls.push({
          sourceFileId: fileNodeId,
          sourceSymbolId: currentFunction?.id ?? null,
          command,
          filePath: file.path,
          line: lineNum,
        });
      }

      if (currentFunction !== null) {
        currentDepth += braceDelta(line);
        if (currentDepth <= 0) currentFunction = null;
      }
    }
  }

  for (const pending of pendingCalls) {
    const target = resolveSymbol(symbolsByName, pending.command, pending.filePath);
    if (target === null) continue;
    const sourceId = pending.sourceSymbolId ?? pending.sourceFileId;
    if (sourceId === target.id) continue;
    graph.addRelationship({
      id: generateId('CALLS', sourceId + ':' + pending.filePath + ':' + pending.line + '->' + target.id),
      type: 'CALLS',
      sourceId,
      targetId: target.id,
      confidence: 0.75,
      reason: 'powershell-call',
    });
    calls++;
  }

  return { functions, classes, imports, calls };
}

function addSymbol(
  graph: KnowledgeGraph,
  fileNodeId: string,
  filePath: string,
  label: 'Function' | 'Class',
  name: string,
  startLine: number,
): SymbolDef {
  const id = generateId(label, filePath + ':' + name + ':' + startLine);
  const node: GraphNode = {
    id,
    label,
    properties: {
      name,
      filePath,
      startLine,
      endLine: startLine,
      language: 'powershell',
    },
  };
  graph.addNode(node);
  graph.addRelationship({
    id: generateId('CONTAINS', fileNodeId + '->' + id),
    type: 'CONTAINS',
    sourceId: fileNodeId,
    targetId: id,
    confidence: 1.0,
    reason: 'powershell-symbol',
  });
  return { id, filePath, name, startLine };
}

function addSymbolIndex(index: Map<string, SymbolDef[]>, symbol: SymbolDef): void {
  const key = symbol.name.toLowerCase();
  const existing = index.get(key);
  if (existing !== undefined) {
    existing.push(symbol);
  } else {
    index.set(key, [symbol]);
  }
}

function resolveSymbol(
  index: ReadonlyMap<string, readonly SymbolDef[]>,
  name: string,
  callerFilePath: string,
): SymbolDef | null {
  const matches = index.get(name.toLowerCase());
  if (matches === undefined || matches.length === 0) return null;
  return matches.find((m) => m.filePath === callerFilePath) ?? matches[0] ?? null;
}

function extractCommands(line: string): string[] {
  const out: string[] = [];
  COMMAND_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = COMMAND_RE.exec(line)) !== null) {
    const command = match[1];
    if (command !== undefined) out.push(command);
  }
  return out;
}

function shouldSkipCommand(command: string): boolean {
  if (KEYWORDS.has(command.toLowerCase())) return true;
  if (BUILT_IN_COMMANDS.has(command)) return true;
  return false;
}

function extractImportTarget(
  line: string,
): { kind: 'dot-source' | 'import-module'; rawPath: string } | null {
  const dot = line.match(DOT_SOURCE_RE);
  if (dot?.[1]) return { kind: 'dot-source', rawPath: dot[1] };

  const moduleImport = line.match(IMPORT_MODULE_RE);
  if (moduleImport?.[1]) return { kind: 'import-module', rawPath: moduleImport[1] };

  return null;
}

function resolvePowerShellImport(
  fromFile: string,
  target: { rawPath: string },
  allPathSet: ReadonlySet<string>,
): string | null {
  const fromDir = path.posix.dirname(fromFile.replace(/\\/g, '/'));
  let rawPath = target.rawPath.trim().replace(/^['"]|['"]$/g, '');
  rawPath = rawPath.replace(/^\$PSScriptRoot[\\/]/i, '');
  rawPath = rawPath.replace(/^\$PSScriptRoot$/i, '');
  rawPath = rawPath.replace(/\\/g, '/');
  rawPath = rawPath.replace(/^\.\//, '');
  if (rawPath === '' || rawPath.startsWith('-')) return null;

  const candidate = path.posix.normalize(path.posix.join(fromDir, rawPath));
  if (allPathSet.has(candidate)) return candidate;

  const ext = path.extname(candidate).toLowerCase();
  if (ext === '') {
    for (const candidateExt of ['.psm1', '.ps1', '.psd1']) {
      const withExt = candidate + candidateExt;
      if (allPathSet.has(withExt)) return withExt;
    }
  }

  return null;
}

function stripLineComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if ((ch === '"' || ch === "'") && (i === 0 || line[i - 1] !== '`')) {
      quote = quote === ch ? null : quote ?? ch;
      continue;
    }
    if (ch === '#' && quote === null) return line.slice(0, i);
  }
  return line;
}

function braceDelta(line: string): number {
  let delta = 0;
  for (const ch of line) {
    if (ch === '{') delta++;
    if (ch === '}') delta--;
  }
  return delta;
}
