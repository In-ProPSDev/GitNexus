/**
 * PowerShell language provider.
 *
 * PowerShell is indexed by a dedicated regex-based pipeline phase instead of
 * tree-sitter. The available tree-sitter-powershell package currently targets
 * tree-sitter 0.25.x while GitNexus pins 0.21.x for grammar ABI compatibility.
 */
import { SupportedLanguages } from 'gitnexus-shared';
import { defineLanguage } from '../language-provider.js';

const BUILT_INS: ReadonlySet<string> = new Set([
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
  'param',
  'return',
]);

export const powershellProvider = defineLanguage({
  id: SupportedLanguages.PowerShell,
  parseStrategy: 'standalone',
  extensions: ['.ps1', '.psm1', '.psd1'],
  entryPointPatterns: [/^Invoke-/i, /^Start-/i, /^Main$/i],
  astFrameworkPatterns: [],
  treeSitterQueries: '',
  typeConfig: {
    declarationNodeTypes: new Set(),
    extractDeclaration: () => null,
    extractParameter: () => null,
  },
  exportChecker: () => false,
  importResolver: () => null,
  builtInNames: BUILT_INS,
});
