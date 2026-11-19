<#
.SYNOPSIS
  Checks that every model file the app loads is in public/models, and downloads only the missing ones from Hugging Face.

.DESCRIPTION
  The required files are listed in scripts/models-manifest.json.
  Step 1 (no network): each file is checked in public/models/<owner>/<model>/.
          Present = exists, not empty, not a Git LFS placeholder.
  Step 2 (only if something is missing): gets sizes and SHA-256 from Hugging Face,
          downloads the missing files, verifies them, then moves them into place.
  If every file is present, nothing is fetched.

.EXAMPLE
  .\scripts\download-models.ps1                         # check, then fetch whatever is missing
.EXAMPLE
  .\scripts\download-models.ps1 -CheckOnly              # report only
.EXAMPLE
  .\scripts\download-models.ps1 -Models whisper-tiny.en,pyannote-segmentation-3.0
.EXAMPLE
  $env:HF_ENDPOINT = 'https://hf-mirror.com'; .\scripts\download-models.ps1   # behind a firewall
#>
[CmdletBinding()]
param(
    [string[]]$Models = @(),   # short names or full ids; empty = all
    [string]$Revision = 'main',
    [string]$Endpoint = $(if ($env:HF_ENDPOINT) { $env:HF_ENDPOINT } else { 'https://huggingface.co' }),
    [string]$Token = $env:HF_TOKEN,
    [switch]$CheckOnly,        # report what is missing, download nothing
    [switch]$Force             # download every file again
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is much faster without the progress bar
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
. (Join-Path $PSScriptRoot 'models-common.ps1')

$Endpoint = $Endpoint.TrimEnd('/')
$headers = @{ 'User-Agent' = 'whisper-onnx-model-downloader' }
if ($Token) { $headers['Authorization'] = "Bearer $Token" }

# Sizes and SHA-256 of a model's files, from the Hugging Face API
function Get-RemoteInfo([string]$repo) {
    $url = "$Endpoint/api/models/$repo/tree/$Revision`?recursive=true"
    try { $items = Invoke-RestMethod -Uri $url -Headers $headers -UseBasicParsing }
    catch { throw "Could not list files for $repo ($url): $($_.Exception.Message)" }
    $info = @{}
    foreach ($f in @($items)) {
        if ($f.type -ne 'file') { continue }
        $sha = $null
        if ($f.PSObject.Properties.Name -contains 'lfs' -and $f.lfs) { $sha = [string]$f.lfs.oid }
        $info[[string]$f.path] = [pscustomobject]@{ Size = [long]$f.size; Sha256 = $sha }
    }
    return $info
}

function Save-RemoteFile([string]$repo, [string]$file, $entry, [string]$target) {
    $dir = Split-Path -Parent $target
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    $encodedPath = ($file -split '/' | ForEach-Object { [uri]::EscapeDataString($_) }) -join '/'
    $url = "$Endpoint/$repo/resolve/$Revision/$encodedPath"
    $part = "$target.part"
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            if (Test-Path -LiteralPath $part) { Remove-Item -LiteralPath $part -Force }
            Invoke-WebRequest -Uri $url -Headers $headers -OutFile $part -UseBasicParsing
            $got = (Get-Item -LiteralPath $part).Length
            if ($entry.Size -gt 0 -and $got -ne $entry.Size) { throw "size mismatch: expected $($entry.Size) bytes, got $got" }
            if ($entry.Sha256) {
                if ((Get-Sha256 $part) -ne $entry.Sha256.ToLowerInvariant()) { throw 'SHA-256 mismatch' }
            }
            if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force }
            Move-Item -LiteralPath $part -Destination $target
            return
        } catch {
            if ($attempt -eq 3) { throw "Failed to download $url after 3 attempts: $($_.Exception.Message)" }
            Write-Host "    retry $attempt ($($_.Exception.Message))" -ForegroundColor Yellow
            Start-Sleep -Seconds (2 * $attempt)
        }
    }
}

$selected = Select-Models (Get-ModelManifest) $Models
Write-Host 'Whisper ONNX models (source: Hugging Face)' -ForegroundColor Cyan
Write-Host "  Folder: $ModelsFolder`n"

# Step 1: what is already here (no network)
$missing = [ordered]@{}
foreach ($model in $selected) {
    $need = @($model.files | Where-Object { $Force -or -not (Test-ModelFilePresent (Get-LocalModelPath $model.id $_)) })
    if ($need.Count -eq 0) {
        Write-Host ("  [ok]      {0}  ({1}/{1} files)  {2}" -f $model.id, @($model.files).Count, $model.mode) -ForegroundColor Green
    } else {
        Write-Host ("  [missing] {0}  ({1} of {2} files)  {3}" -f $model.id, $need.Count, @($model.files).Count, $model.mode) -ForegroundColor Yellow
        foreach ($f in $need) { Write-Host "            - $f" -ForegroundColor DarkYellow }
        $missing[$model.id] = $need
    }
}

if ($missing.Count -eq 0) {
    Write-Host "`nAll model files are present. Nothing to download." -ForegroundColor Green
    exit 0
}
if ($CheckOnly) {
    Write-Host "`nSome files are missing. Run without -CheckOnly (npm run models) to download them." -ForegroundColor Yellow
    exit 0
}

# Step 2: download only the missing files
Write-Host "`nDownloading missing files from $Endpoint (revision $Revision)" -ForegroundColor Cyan
$failed = New-Object System.Collections.Generic.List[string]
$totalBytes = [long]0
foreach ($repo in $missing.Keys) {
    Write-Host "== $repo" -ForegroundColor Cyan
    try {
        $remote = Get-RemoteInfo $repo
        foreach ($file in $missing[$repo]) {
            if (-not $remote.ContainsKey($file)) { throw "$file is not published in $repo" }
            $entry = $remote[$file]
            Write-Host ("  [get]  {0}  ({1})" -f $file, (Format-Size $entry.Size))
            Save-RemoteFile $repo $file $entry (Get-LocalModelPath $repo $file)
            $totalBytes += $entry.Size
        }
        Write-Host "  [ok]   $repo ready" -ForegroundColor Green
    } catch {
        Write-Host "  [fail] $($_.Exception.Message)" -ForegroundColor Red
        $failed.Add($repo)
    }
}

Write-Host ("`nDownloaded {0}." -f (Format-Size $totalBytes))
if ($failed.Count -gt 0) {
    Write-Host "Failed: $($failed -join ', '). Re-run the script to retry; finished files are skipped." -ForegroundColor Red
    exit 1
}
Write-Host 'Model licenses: see public/models/NOTICE.md.'
Write-Host 'All models ready. Next: npm run build, then npm run preview.' -ForegroundColor Green
