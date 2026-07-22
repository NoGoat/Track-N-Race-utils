[CmdletBinding()]
param(
    [ValidateSet('Debug', 'Release')]
    [string] $Configuration = 'Debug',

    [switch] $NoBuild
)

$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$projectPath = Join-Path $projectRoot 'TelemetryMapper.WinUI3\TelemetryMapper.WinUI3.csproj'

$userDotnetPath = Join-Path $env:USERPROFILE '.dotnet\dotnet.exe'
if (Test-Path -LiteralPath $userDotnetPath) {
    $dotnetPath = $userDotnetPath
}
else {
    $dotnetCommand = Get-Command dotnet -ErrorAction SilentlyContinue
    if (-not $dotnetCommand) {
        throw 'The .NET 10 SDK was not found. Install it from https://dotnet.microsoft.com/download/dotnet/10.0.'
    }
    $dotnetPath = $dotnetCommand.Source
}

$runArguments = @(
    'run'
    '--project', $projectPath
    '--configuration', $Configuration
)
if ($NoBuild) {
    $runArguments += '--no-build'
}

Push-Location $projectRoot
try {
    & $dotnetPath @runArguments
    if ($LASTEXITCODE -ne 0) {
        throw "Track N Race Map Editor exited with code $LASTEXITCODE."
    }
}
finally {
    Pop-Location
}
