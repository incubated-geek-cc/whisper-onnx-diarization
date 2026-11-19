<#
.SYNOPSIS
  Copies the required model files from public/models to the private Backblaze B2 bucket.
  A file is uploaded only if the bucket doesn't have it yet (or has a different size).

.DESCRIPTION
  Before the first run:
    1. Copy .env.example to .env and fill in B2_KEY_ID, B2_APPLICATION_KEY, B2_BUCKET, B2_ENDPOINT
       (a key with read and write access to the bucket). .env is git-ignored.
    2. Install AWS CLI v2: winget install --id Amazon.AWSCLI -e   (no "aws configure" needed)
  The key is passed to the AWS CLI for this run only. Large files are split into parts automatically.

.EXAMPLE
  .\scripts\upload-models.ps1             # upload what the bucket is missing
.EXAMPLE
  .\scripts\upload-models.ps1 -DryRun     # show what would be uploaded, change nothing
.EXAMPLE
  .\scripts\upload-models.ps1 -Models whisper-base
#>
[CmdletBinding()]
param(
    [string[]]$Models = @(),
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'models-common.ps1')

$cfg = Get-BucketConfig
if (-not (Get-Command aws -ErrorAction SilentlyContinue)) {
    throw 'AWS CLI not found. Install it (winget install --id Amazon.AWSCLI -e), then open a new PowerShell window.'
}

# Certificates: AWS_CA_BUNDLE from .env if set; otherwise, on Windows, the certificates Windows
# trusts (needed behind a corporate proxy, see Export-WindowsCaBundle). Elsewhere, the CLI's own list.
$caBundle = $cfg.CaBundle
if (-not $caBundle) { $caBundle = Export-WindowsCaBundle }

# Credentials and settings for the AWS CLI, for this run only (restored at the end)
$awsEnv = @{
    AWS_CA_BUNDLE                    = $caBundle
    AWS_ACCESS_KEY_ID                = $cfg.KeyId
    AWS_SECRET_ACCESS_KEY            = $cfg.Key
    AWS_DEFAULT_REGION               = $cfg.Region
    AWS_PROFILE                      = $null          # ignore any saved profile
    AWS_REQUEST_CHECKSUM_CALCULATION = 'when_required' # newer AWS CLI checksums can be rejected
    AWS_RESPONSE_CHECKSUM_VALIDATION = 'when_required'
}
$savedEnv = @{}
foreach ($name in $awsEnv.Keys) {
    $savedEnv[$name] = [Environment]::GetEnvironmentVariable($name)
    Set-ProcessEnv $name $awsEnv[$name]
}
$awsArgs = @('--endpoint-url', $cfg.Endpoint)

try {
Write-Host 'Upload models to Backblaze B2 (private bucket)' -ForegroundColor Cyan
Write-Host "  From:   $ModelsFolder"
Write-Host "  To:     s3://$($cfg.Bucket)/$($cfg.Prefix)/  ($($cfg.Endpoint))"
if ($DryRun) { Write-Host '  Dry run: nothing will be uploaded' -ForegroundColor Yellow }
Write-Host ''

# What the bucket already has: key -> size (one listing call)
$inBucket = @{}
$listing = & aws s3api list-objects-v2 --bucket $cfg.Bucket --prefix "$($cfg.Prefix)/" `
    --query 'Contents[].[Key,Size]' --output text @awsArgs
if ($LASTEXITCODE -ne 0) { throw 'Could not list the bucket. Check B2_BUCKET, B2_ENDPOINT and the key in .env.' }
foreach ($line in @($listing)) {
    $parts = "$line" -split "`t"
    if ($parts.Count -eq 2) { $inBucket[$parts[0]] = [long]$parts[1] }
}

$uploaded = 0; $skipped = 0; $bytes = [long]0
$notLocal = New-Object System.Collections.Generic.List[string]
foreach ($model in (Select-Models (Get-ModelManifest) $Models)) {
    Write-Host "== $($model.id)" -ForegroundColor Cyan
    foreach ($file in $model.files) {
        $local = Get-LocalModelPath $model.id $file
        $key = "$($cfg.Prefix)/$($model.id)/$file"

        if (-not (Test-ModelFilePresent $local)) {
            # Not on this PC (or only a placeholder): can't upload it
            Write-Host "  [not here] $file  (run npm run models first)" -ForegroundColor Red
            $notLocal.Add("$($model.id)/$file")
            continue
        }
        $size = (Get-Item -LiteralPath $local).Length
        if ($inBucket.ContainsKey($key) -and $inBucket[$key] -eq $size) {
            # Already in the bucket with the same size: skip
            Write-Host "  [in bucket] $file" -ForegroundColor DarkGray
            $skipped++
            continue
        }

        Write-Host ("  [upload]   {0}  ({1})" -f $file, (Format-Size $size))
        if (-not $DryRun) {
            & aws s3 cp $local "s3://$($cfg.Bucket)/$key" --only-show-errors @awsArgs
            if ($LASTEXITCODE -ne 0) { throw "Upload failed: $file" }
        }
        $uploaded++; $bytes += $size
    }
}

$verb = if ($DryRun) { 'Would upload' } else { 'Uploaded' }
Write-Host ("`n{0} {1} file(s), {2}. Already in bucket: {3}." -f $verb, $uploaded, (Format-Size $bytes), $skipped) -ForegroundColor Green
if ($notLocal.Count -gt 0) {
    Write-Host "Not on this PC, so not uploaded: $($notLocal.Count) file(s). Run npm run models, then this script again." -ForegroundColor Red
    $exitCode = 1
} else {
    $exitCode = 0
}
} finally {
    foreach ($name in $savedEnv.Keys) { Set-ProcessEnv $name $savedEnv[$name] }
}
exit $exitCode
