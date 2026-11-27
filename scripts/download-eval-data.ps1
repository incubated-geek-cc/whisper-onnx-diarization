<#
.SYNOPSIS
  Downloads AMI meeting recordings with human speaker labels into eval/, for npm run eval.

.DESCRIPTION
  AMI is the standard benchmark for meeting diarization (CC BY 4.0, University of Edinburgh).
  For each meeting this saves three files into eval/:
    NAME.wav   headset mix, 16 kHz mono     groups.inf.ed.ac.uk/ami
    NAME.rttm  who speaks when (reference)  github.com/pyannote/AMI-diarization-setup (only_words)
    NAME.uem   the part to score            same repository
  Files already present are skipped. eval/ is git-ignored.

.EXAMPLE
  .\scripts\download-eval-data.ps1                    # 4 test meetings, about 100 minutes, ~200 MB
.EXAMPLE
  .\scripts\download-eval-data.ps1 -All               # all 16 test meetings, about 9 hours, ~1 GB
.EXAMPLE
  .\scripts\download-eval-data.ps1 -Meetings ES2004a,IS1009a
#>
[CmdletBinding()]
param(
    [string[]]$Meetings = @('ES2004a', 'IS1009a', 'TS3003a', 'EN2002a'),   # one from each series
    [switch]$All
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'   # Invoke-WebRequest is much faster without the progress bar
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
. (Join-Path $PSScriptRoot 'models-common.ps1')

$TestMeetings = @(
    'IS1009a', 'IS1009b', 'IS1009c', 'IS1009d', 'ES2004a', 'ES2004b', 'ES2004c', 'ES2004d',
    'TS3003a', 'TS3003b', 'TS3003c', 'TS3003d', 'EN2002a', 'EN2002b', 'EN2002c', 'EN2002d'
)
if ($All) { $Meetings = $TestMeetings }
$unknown = @($Meetings | Where-Object { $TestMeetings -notcontains $_ })
if ($unknown.Count -gt 0) { throw "Not an AMI test meeting: $($unknown -join ', '). Choose from: $($TestMeetings -join ', ')" }

$AudioBase = 'https://groups.inf.ed.ac.uk/ami/AMICorpusMirror/amicorpus'
$LabelBase = 'https://raw.githubusercontent.com/pyannote/AMI-diarization-setup/main'
$Folder = Join-Path (Split-Path -Parent $PSScriptRoot) 'eval'
if (-not (Test-Path -LiteralPath $Folder)) { New-Item -ItemType Directory -Force -Path $Folder | Out-Null }
$headers = @{ 'User-Agent' = 'whisper-onnx-eval-downloader' }

function Save-File([string]$url, [string]$target) {
    if ((Test-Path -LiteralPath $target) -and (Get-Item -LiteralPath $target).Length -gt 0) {
        Write-Host "  [ok]   $(Split-Path -Leaf $target)" -ForegroundColor Green
        return [long]0
    }
    $part = "$target.part"
    for ($attempt = 1; $attempt -le 3; $attempt++) {
        try {
            if (Test-Path -LiteralPath $part) { Remove-Item -LiteralPath $part -Force }
            Invoke-WebRequest -Uri $url -Headers $headers -OutFile $part -UseBasicParsing
            $size = (Get-Item -LiteralPath $part).Length
            if ($size -eq 0) { throw 'empty file' }
            Move-Item -LiteralPath $part -Destination $target -Force
            Write-Host ("  [get]  {0}  ({1})" -f (Split-Path -Leaf $target), (Format-Size $size))
            return [long]$size
        } catch {
            if ($attempt -eq 3) { throw "Failed to download $url after 3 attempts: $($_.Exception.Message)" }
            Write-Host "    retry $attempt ($($_.Exception.Message))" -ForegroundColor Yellow
            Start-Sleep -Seconds (2 * $attempt)
        }
    }
}

Write-Host 'AMI meeting corpus: test meetings for npm run eval' -ForegroundColor Cyan
Write-Host "  Folder: $Folder`n"
$total = [long]0
$failed = New-Object System.Collections.Generic.List[string]
foreach ($m in $Meetings) {
    Write-Host "== $m" -ForegroundColor Cyan
    try {
        $total += Save-File "$LabelBase/only_words/rttms/test/$m.rttm" (Join-Path $Folder "$m.rttm")
        $total += Save-File "$LabelBase/uems/test/$m.uem" (Join-Path $Folder "$m.uem")
        $total += Save-File "$AudioBase/$m/audio/$m.Mix-Headset.wav" (Join-Path $Folder "$m.wav")
    } catch {
        Write-Host "  [fail] $($_.Exception.Message)" -ForegroundColor Red
        $failed.Add($m)
    }
}

@'
# Evaluation data

AMI Meeting Corpus, headset mix audio (https://groups.inf.ed.ac.uk/ami/corpus/), licensed CC BY 4.0.
Carletta, J. et al. (2005). The AMI Meeting Corpus: A Pre-announcement. MLMI 2005.

Reference speaker labels (only_words) and scoring regions from
https://github.com/pyannote/AMI-diarization-setup (Landini et al.), test split.

Downloaded by scripts/download-eval-data.ps1. Not part of the app and not committed (eval/ is git-ignored).
'@ | Set-Content -LiteralPath (Join-Path $Folder 'NOTICE.md') -Encoding UTF8

Write-Host ("`nDownloaded {0}." -f (Format-Size $total))
if ($failed.Count -gt 0) {
    Write-Host "Failed: $($failed -join ', '). Re-run the script to retry; finished files are skipped." -ForegroundColor Red
    exit 1
}
Write-Host 'Ready. Next: npm run eval' -ForegroundColor Green
