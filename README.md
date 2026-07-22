# Track-N-Race-utils
All the random ultility scripts I wrote to aid me with creating Track-N-Race

## Native telemetry map editor

The supported Windows editor is the C# WinUI 3 application:

```powershell
cd telemetry-mapper-winui3
dotnet build TelemetryMapper.WinUI3.slnx -c Debug
dotnet run --project TelemetryMapper.WinUI3/TelemetryMapper.WinUI3.csproj -c Debug
```

See [`telemetry-mapper-winui3/README.md`](telemetry-mapper-winui3/README.md)
for prerequisites, tests, and architecture.

## Legacy Python editor

The map editor uses PyQt6-Fluent-Widgets for its WinUI-style interface.

```powershell
python -m pip install -r telemetry-mapper/requirements.txt
python telemetry-mapper/map_editor.py
```
