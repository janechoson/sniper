#Requires -Version 7.0
# Generated test artifacts only. No application DB reset or bot control operations.
# Preview: .\scripts\clean-test-artifacts.ps1
# Delete:  .\scripts\clean-test-artifacts.ps1 -Apply
[CmdletBinding(SupportsShouldProcess)]
param([switch]$Apply)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path -LiteralPath (Split-Path $PSScriptRoot -Parent)).Path
if ((Get-Item -LiteralPath $projectRoot -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw 'Project root must not be a symlink or junction.'
}

# Parse only operational paths; never print keys, credentials or the .env contents.
$nodePath = Join-Path $projectRoot 'node_modules\node\bin\node.exe'
if (!(Test-Path -LiteralPath $nodePath -PathType Leaf)) { throw 'Pinned Node runtime is required to validate protected paths.' }
$configReader = @'
import {readFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {parse} from 'dotenv';
const root=process.argv[1];
const env=existsSync(resolve(root,'.env'))?parse(readFileSync(resolve(root,'.env'))):{};
const paths=['data/kronos.sqlite','runtime','logs','data/backups'];
for(const [key,fallback] of [['KRONOS_DATABASE_PATH','data/kronos.sqlite'],['KRONOS_RUNTIME','runtime'],['KRONOS_LOG_DIR','logs']]){
  paths.push(env[key]||fallback);
  if(process.env[key])paths.push(process.env[key]);
}
console.log(JSON.stringify(paths.map(p=>resolve(root,p))));
'@
Push-Location -LiteralPath $projectRoot
try {
    $configOutput = & $nodePath --input-type=module -e $configReader $projectRoot
    if ($LASTEXITCODE -ne 0) { throw 'Could not validate active database/runtime/log paths.' }
    $protectedPaths = @($configOutput | ConvertFrom-Json)
} finally { Pop-Location }

$runningTests = @(Get-CimInstance Win32_Process | Where-Object {
    $_.Name -eq 'node.exe' -and $_.CommandLine -match '(--test|test-env\.mjs|tests[/\\].*\.test\.|scripts[/\\](ui-test|screen-parity-ui-test|live-ui-test))'
})
if ($runningTests.Count -gt 0) { throw 'A test process is running. Wait for it to finish before cleaning fixtures.' }

function Get-VerifiedArtifact([string]$Path, [string]$Category) {
    $resolved = (Resolve-Path -LiteralPath $Path).Path
    if (!$resolved.StartsWith($projectRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Artifact is outside this project.' }
    foreach ($protected in $protectedPaths) {
        if ($resolved.Equals($protected, [StringComparison]::OrdinalIgnoreCase) -or
            $resolved.StartsWith($protected + '\', [StringComparison]::OrdinalIgnoreCase) -or
            $protected.StartsWith($resolved + '\', [StringComparison]::OrdinalIgnoreCase)) {
            throw ('Refusing to remove protected operational path: ' + $resolved)
        }
    }
    $relative = [IO.Path]::GetRelativePath($projectRoot, $resolved)
    if ($relative -notmatch '^(data\\test-[^\\]+|data\\wallet-header-build-check|docs\\previews|\.discovery-build-check|evidence\\discovery-batch-before|evidence\\[^\\]+)$') {
        throw 'Artifact does not match the generated-test allowlist.'
    }
    $total = 0L
    $files = 0
    $pending = [Collections.Generic.Stack[string]]::new()
    $pending.Push($resolved)
    while ($pending.Count -gt 0) {
        $entry = Get-Item -LiteralPath $pending.Pop() -Force
        if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw ('Symlink/junction rejected: ' + $entry.FullName) }
        if ($entry.PSIsContainer) {
            foreach ($child in Get-ChildItem -LiteralPath $entry.FullName -Force) { $pending.Push($child.FullName) }
        } else { $total += $entry.Length; $files++ }
    }
    [pscustomobject]@{ Path = $resolved; Category = $Category; Bytes = $total; Files = $files }
}

$targets = [Collections.Generic.List[object]]::new()
$dataPath = Join-Path $projectRoot 'data'
if (Test-Path -LiteralPath $dataPath) {
    foreach ($entry in Get-ChildItem -LiteralPath $dataPath -Directory -Force | Where-Object {
        $_.Name -like 'test-*' -or $_.Name -eq 'wallet-header-build-check'
    }) { $targets.Add((Get-VerifiedArtifact $entry.FullName 'Fixture/build')) }
}
foreach ($relative in @('docs\previews', '.discovery-build-check', 'evidence\discovery-batch-before')) {
    $target = Join-Path $projectRoot $relative
    if (Test-Path -LiteralPath $target) { $targets.Add((Get-VerifiedArtifact $target 'Preview/baseline/build')) }
}
$testEvidencePattern = '(?i)(test|fixture|format|typecheck|lint|build|\bui\b|screen-parity|model-regression|python-isolation|paperdao-theme-before|paperdao-theme-browser|paperdao-theme-kronos-regression|controlled-live-execution\.log|python-dependencies\.log|python-install\.log|python-venv\.log|install\.log|discovery-batch-)'
$evidencePath = Join-Path $projectRoot 'evidence'
if (Test-Path -LiteralPath $evidencePath) {
    foreach ($entry in Get-ChildItem -LiteralPath $evidencePath -File -Force | Where-Object { $_.Name -match $testEvidencePattern }) {
        $targets.Add((Get-VerifiedArtifact $entry.FullName 'Test log/payload'))
    }
}

$targets | Group-Object Category | ForEach-Object {
    [pscustomobject]@{ Category = $_.Name; Targets = $_.Count; MiB = [math]::Round(($_.Group | Measure-Object Bytes -Sum).Sum / 1MB, 2) }
} | Format-Table -AutoSize
$totalBytes = ($targets | Measure-Object Bytes -Sum).Sum
Write-Host ('Total: {0} targets, {1:N2} MiB logical size.' -f $targets.Count, ($totalBytes / 1MB))
if (!$Apply) {
    Write-Host 'Preview only; no files were removed. Use -Apply to delete the listed test artifacts.'
    return
}

# Revalidate the full set immediately before mutation. Never pass paths to another shell.
foreach ($target in $targets) { $null = Get-VerifiedArtifact $target.Path $target.Category }
$removed = 0
foreach ($target in $targets) {
    if ($PSCmdlet.ShouldProcess($target.Path, 'Delete generated test artifact')) {
        Remove-Item -LiteralPath $target.Path -Recurse -Force -ErrorAction Stop
        $removed++
    }
}
$remaining = @($targets | Where-Object { Test-Path -LiteralPath $_.Path }).Count
Write-Host ('Removed {0} targets; {1} targets remain. Production data and bot processes were not controlled.' -f $removed, $remaining)
