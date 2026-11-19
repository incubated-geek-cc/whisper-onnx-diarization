# Shared helpers for download-models.ps1 and upload-models.ps1. Dot-source it: . "$PSScriptRoot/models-common.ps1"
# Works on Windows PowerShell 5.1 and PowerShell 7+.

# Windows PowerShell 5.1 started from PowerShell 7 (e.g. npm in a PS7 terminal) inherits PS7's module
# path, so some built-in commands and the Cert: drive go missing. Reset it to 5.1's own folders.
if ($PSVersionTable.PSEdition -eq 'Desktop') {
    $env:PSModulePath = @(
        (Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'WindowsPowerShell\Modules'),
        (Join-Path $env:ProgramFiles 'WindowsPowerShell\Modules'),
        [Environment]::GetEnvironmentVariable('PSModulePath', 'Machine')
    ) -join ';'
}

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ModelsFolder = Join-Path $ProjectRoot 'public/models'

# The list of required files (scripts/models-manifest.json)
function Get-ModelManifest {
    $path = Join-Path $PSScriptRoot 'models-manifest.json'
    return @((Get-Content -LiteralPath $path -Raw | ConvertFrom-Json).models)
}

# Reads KEY=value lines from the project's .env (if there is one). Real environment variables win.
function Get-DotEnv {
    $values = @{}
    $path = Join-Path $ProjectRoot '.env'
    if (Test-Path -LiteralPath $path) {
        foreach ($line in Get-Content -LiteralPath $path) {
            $trimmed = $line.Trim()
            if ($trimmed -eq '' -or $trimmed.StartsWith('#') -or -not $trimmed.Contains('=')) { continue }
            $name, $value = $trimmed -split '=', 2
            $values[$name.Trim()] = $value.Trim().Trim('"').Trim("'")
        }
    }
    return $values
}

# Private bucket settings from .env (or environment variables). Stops if something is missing.
function Get-BucketConfig {
    $dotenv = Get-DotEnv
    $get = {
        param($name, $default)
        $fromEnv = [Environment]::GetEnvironmentVariable($name)
        if ($fromEnv) { return $fromEnv }
        if ($dotenv.ContainsKey($name) -and $dotenv[$name]) { return $dotenv[$name] }
        return $default
    }
    $cfg = [pscustomobject]@{
        KeyId    = & $get 'B2_KEY_ID' ''
        Key      = & $get 'B2_APPLICATION_KEY' ''
        Bucket   = & $get 'B2_BUCKET' ''
        Endpoint = ([string](& $get 'B2_ENDPOINT' '')).TrimEnd('/')
        Prefix   = ([string](& $get 'B2_PREFIX' 'models')).Trim('/')
        CaBundle = & $get 'AWS_CA_BUNDLE' ''
    }
    $unset = @()
    if (-not $cfg.KeyId -or $cfg.KeyId -match 'REPLACE') { $unset += 'B2_KEY_ID' }
    if (-not $cfg.Key -or $cfg.Key -match 'REPLACE') { $unset += 'B2_APPLICATION_KEY' }
    if (-not $cfg.Bucket -or $cfg.Bucket -match 'REPLACE') { $unset += 'B2_BUCKET' }
    if (-not $cfg.Endpoint -or $cfg.Endpoint -match 'REPLACE') { $unset += 'B2_ENDPOINT' }
    if ($unset.Count -gt 0) {
        throw "Set $($unset -join ', ') in .env (copy .env.example to .env and fill it in)."
    }
    # Region for request signing: https://s3.<region>.backblazeb2.com
    $cfg | Add-Member -NotePropertyName Region -NotePropertyValue ($(if ($cfg.Endpoint -match '//s3\.([^.]+)\.') { $Matches[1] } else { 'us-east-1' }))
    return $cfg
}

# On Windows, writes every trusted root/intermediate certificate from the Windows certificate store
# into one PEM file and returns its path. The AWS CLI uses its own certificate list, so behind a
# corporate proxy that re-signs HTTPS it fails with "self-signed certificate in certificate chain".
# Pointing AWS_CA_BUNDLE at this file makes it trust what Windows (and your browser) already trust.
function Export-WindowsCaBundle {
    if ($env:OS -ne 'Windows_NT') { return $null }
    # Read the stores through .NET directly (works even when the Cert: drive isn't available)
    $seen = @{}
    $pem = New-Object System.Text.StringBuilder
    foreach ($location in 'CurrentUser', 'LocalMachine') {
        foreach ($storeName in 'Root', 'CA') {
            $store = New-Object System.Security.Cryptography.X509Certificates.X509Store($storeName, $location)
            try { $store.Open('ReadOnly') } catch { continue }
            foreach ($cert in $store.Certificates) {
                if ($seen.ContainsKey($cert.Thumbprint)) { continue }
                $seen[$cert.Thumbprint] = $true
                [void]$pem.AppendLine('-----BEGIN CERTIFICATE-----')
                [void]$pem.AppendLine([Convert]::ToBase64String($cert.RawData, 'InsertLineBreaks'))
                [void]$pem.AppendLine('-----END CERTIFICATE-----')
            }
            $store.Close()
        }
    }
    if ($seen.Count -eq 0) { return $null }   # nothing found: let the AWS CLI use its own list
    $path = Join-Path ([IO.Path]::GetTempPath()) 'whisper-onnx-ca-bundle.pem'
    [IO.File]::WriteAllText($path, $pem.ToString(), (New-Object System.Text.UTF8Encoding($false)))
    return $path
}

# SHA-256 of a file, lower-case hex. Uses .NET directly: Get-FileHash can be missing when
# Windows PowerShell 5.1 is started from PowerShell 7 (it inherits PS7's module path).
function Get-Sha256([string]$path) {
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $stream = [System.IO.File]::OpenRead($path)
    try { return ([System.BitConverter]::ToString($sha.ComputeHash($stream)) -replace '-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $sha.Dispose() }
}

function Get-LocalModelPath([string]$repo, [string]$file, [string]$root = $ModelsFolder) {
    return Join-Path (Join-Path $root $repo) ($file -replace '/', [IO.Path]::DirectorySeparatorChar)
}

# Present = exists, not empty, and not a Git LFS pointer (the ~130-byte placeholder a clone without LFS leaves)
function Test-ModelFilePresent([string]$path) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return $false }
    $item = Get-Item -LiteralPath $path
    if ($item.Length -eq 0) { return $false }
    if ($item.Length -lt 1024) {
        $firstLine = Get-Content -LiteralPath $path -TotalCount 1 -ErrorAction SilentlyContinue
        if ($firstLine -like 'version https://git-lfs*') { return $false }
    }
    return $true
}

# Picks models by short name (whisper-tiny.en) or full id (Xenova/whisper-tiny.en). Empty = all.
function Select-Models($manifest, [string[]]$names) {
    $names = @($names | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    if ($names.Count -eq 0) { return $manifest }
    $picked = @()
    foreach ($name in $names) {
        $match = @($manifest | Where-Object { $_.id -eq $name -or ($_.id -split '/')[1] -eq $name })
        if ($match.Count -eq 0) {
            throw "Unknown model '$name'. Choose from: $(($manifest | ForEach-Object { ($_.id -split '/')[1] }) -join ', ')"
        }
        $picked += $match
    }
    return $picked
}

# Sets an environment variable for this process; $null or '' removes it. (Setting '' would leave an
# empty value behind in PowerShell 7, which e.g. the AWS CLI reads as "profile named ''".)
function Set-ProcessEnv([string]$name, $value) {
    if ($null -eq $value -or "$value" -eq '') { Remove-Item -Path "Env:$name" -ErrorAction SilentlyContinue }
    else { Set-Item -Path "Env:$name" -Value "$value" }
}

function Format-Size([long]$bytes) {
    if ($bytes -ge 1MB) { return '{0:N1} MB' -f ($bytes / 1MB) }
    if ($bytes -ge 1KB) { return '{0:N1} KB' -f ($bytes / 1KB) }
    return "$bytes B"
}
