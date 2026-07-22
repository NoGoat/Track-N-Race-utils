# Track Map Marker Editor for WinUI 3

Native Windows replacement for `telemetry-mapper/map_editor.py`. It uses C#,
.NET 10, the Windows App SDK, WinUI 3 XAML, and Win2D. Python and Qt are not
runtime dependencies.

## Features

- Opens and saves finalized track-map JSON without dropping unknown keys.
- Renders rotated sector paths, marker collections, wrapped zones, selection,
  pending endpoints, and the animated seek marker with Win2D.
- Adds, updates, and deletes scalar points, point lists, zone lists, and custom
  collections.
- Shows or hides individual marker layers.
- Loads and aligns reference images from HTTP/HTTPS URLs or local files. WebP uses
  the Windows WIC WebP codec supplied by the Microsoft WebP Image Extension.
- Imports dry or wet Straight Line Mode zones from gzip TNRD V1 and Zstandard
  TNRD V2 recordings.
- Uses native Windows file pickers, dialogs, InfoBars, Mica, system theme, and
  system accent colors.

## Prerequisites

- Windows 10 version 2004 (build 19041) or newer; Windows 11 is recommended.
- .NET 10 SDK.
- Developer Mode for `dotnet run` package registration.

The official WinUI command-line templates can be installed with:

```powershell
dotnet new install Microsoft.WindowsAppSDK.WinUI.CSharp.Templates
```

## Build and run

From this directory:

```powershell
./run.ps1
```

To choose a configuration or reuse an existing build:

```powershell
./run.ps1 -Configuration Release
./run.ps1 -Configuration Release -NoBuild
```

The underlying build, test, and run commands are:

```powershell
dotnet build TelemetryMapper.WinUI3.slnx -c Debug
dotnet test TelemetryMapper.Core.Tests/TelemetryMapper.Core.Tests.csproj -c Debug
dotnet run --project TelemetryMapper.WinUI3/TelemetryMapper.WinUI3.csproj -c Debug
```

The app is an x64, framework-dependent, single-project MSIX application. The
Windows App SDK `winapp` tooling registers a debug package identity when run
from the command line.

## Projects

- `TelemetryMapper.Core`: JSON document model, map geometry, marker editing,
  gzip/Zstandard decoding, and SLM zone projection.
- `TelemetryMapper.Core.Tests`: importer, geometry, mutation, round-trip, and
  all-map fixture tests.
- `TelemetryMapper.WinUI3`: packaged WinUI 3 interface and Win2D renderer.
