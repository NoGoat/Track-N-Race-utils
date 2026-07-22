using System.Net;
using System.Net.Sockets;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace TelemetryMapper.Core;

/// <summary>Listens to the Codemasters F1 UDP stream and retains an unmodified,
/// session-scoped recording.  Conversion deliberately happens later, so users never
/// lose the source telemetry when the map needs to be adjusted.</summary>
public sealed class TelemetryTrackRecorder : IAsyncDisposable
{
    public const int DefaultPort = 20777;
    private readonly int _port;
    private readonly object _gate = new();
    private readonly List<RawTrackPoint> _points = [];
    private readonly List<RawSectorCrossing> _sectorCrossings = [];
    private readonly List<RawDrsEvent> _drsEvents = [];
    private readonly List<RawSlmEvent> _slmEvents = [];
    private readonly List<RawSpeedTrap> _speedTraps = [];
    private CancellationTokenSource? _cancellation;
    private Task? _listenTask;
    private int _playerCarIndex;
    private int _currentLap;
    private RawTrackPoint? _lastPosition;
    private int _lastSector = -1;
    private byte _drs;
    private byte? _activeAero;

    public TelemetryTrackRecorder(int port = DefaultPort) => _port = port;
    public bool IsListening => _listenTask is { IsCompleted: false };
    public int Port => _port;
    public bool IsRecording { get; private set; }
    public int TrackId { get; private set; } = -1;
    public string? SessionUid { get; private set; }
    public int TrackLengthMeters { get; private set; }
    public int ActiveAeroTrackStatus { get; private set; } = -1;
    public int CurrentLap { get { lock (_gate) return _currentLap; } }
    public int PointCount { get { lock (_gate) return _points.Count; } }
    public event EventHandler? Updated;
    public event EventHandler<string>? StatusChanged;

    public void Start()
    {
        if (IsListening) return;
        // A user can press Listen after the game has already sent SSTA. Start
        // retaining telemetry immediately; a subsequent SSTA resets at the
        // proper game-session boundary.
        BeginManualSession();
        _cancellation = new CancellationTokenSource();
        _listenTask = Task.Run(() => ListenAsync(_cancellation.Token));
        StatusChanged?.Invoke(this, $"Recording on UDP {_port}.");
    }

    public async Task StopAsync()
    {
        _cancellation?.Cancel();
        if (_listenTask is not null)
        {
            try { await _listenTask.ConfigureAwait(false); }
            catch (OperationCanceledException) { }
        }
        _listenTask = null;
        IsRecording = false;
        _cancellation?.Dispose();
        _cancellation = null;
    }

    public RawTrackRecording Snapshot()
    {
        lock (_gate)
        {
            return new RawTrackRecording(TrackId, SessionUid, TrackLengthMeters,
                [.. _points], [.. _sectorCrossings], [.. _drsEvents], [.. _slmEvents], [.. _speedTraps], ActiveAeroTrackStatus);
        }
    }

    public async Task SaveRawAsync(string path, CancellationToken cancellationToken = default)
    {
        var options = new JsonSerializerOptions { WriteIndented = true };
        await File.WriteAllTextAsync(path, JsonSerializer.Serialize(Snapshot(), options), cancellationToken);
    }

    private async Task ListenAsync(CancellationToken cancellationToken)
    {
        using var client = new UdpClient(_port);
        while (!cancellationToken.IsCancellationRequested)
        {
            var receive = client.ReceiveAsync(cancellationToken);
            UdpReceiveResult result;
            try { result = await receive.ConfigureAwait(false); }
            catch (OperationCanceledException) { break; }
            HandlePacket(result.Buffer);
        }
    }

    private void HandlePacket(byte[] data)
    {
        if (data.Length < 29) return;
        var packetId = data[6];
        _playerCarIndex = data[27];
        if (packetId == 1 && data.Length > 36)
        {
            TrackLengthMeters = BitConverter.ToUInt16(data, 33);
            TrackId = unchecked((sbyte)data[36]);
            SessionUid = BitConverter.ToUInt64(data, 7).ToString("x16");
            ActiveAeroTrackStatus = data.Length >= 754 && (data[753] is 0 or 1) ? data[753] : -1;
            Updated?.Invoke(this, EventArgs.Empty);
            return;
        }
        if (packetId == 3 && data.Length >= 33)
        {
            var code = System.Text.Encoding.ASCII.GetString(data, 29, 4);
            if (code == "SSTA") BeginSession();
            else if (code == "SEND" && IsRecording)
            {
                IsRecording = false;
                StatusChanged?.Invoke(this, "Session ended. Recording is ready to save.");
                Updated?.Invoke(this, EventArgs.Empty);
            }
            else if (code == "SPTP") HandleSpeedTrap(data);
            return;
        }
        if (packetId == 2) HandleLapData(data);
        else if (packetId == 0) HandleMotion(data);
        else if (packetId == 6) HandleTelemetry(data);
        else if (packetId == 16) HandleActiveAero(data);
    }

    private void BeginSession()
    {
        lock (_gate)
        {
            _points.Clear(); _sectorCrossings.Clear(); _currentLap = 0;
            _lastPosition = null; _lastSector = -1; _drs = 0; _activeAero = null;
            _drsEvents.Clear(); _slmEvents.Clear(); _speedTraps.Clear();
        }
        IsRecording = true;
        StatusChanged?.Invoke(this, $"Recording track {TrackId} ({TrackLengthMeters} m).");
        Updated?.Invoke(this, EventArgs.Empty);
    }

    private void BeginManualSession()
    {
        lock (_gate)
        {
            _points.Clear(); _sectorCrossings.Clear(); _currentLap = 0;
            _lastPosition = null; _lastSector = -1; _drs = 0; _activeAero = null;
            _drsEvents.Clear(); _slmEvents.Clear(); _speedTraps.Clear();
        }
        IsRecording = true;
        StatusChanged?.Invoke(this, "Recording started; waiting for game session metadata.");
        Updated?.Invoke(this, EventArgs.Empty);
    }

    private void HandleLapData(byte[] data)
    {
        var offset = 29 + _playerCarIndex * 57;
        if (data.Length < offset + 37) return;
        lock (_gate)
        {
            _currentLap = data[offset + 33];
            var sector = data[offset + 36];
            if (IsRecording && _lastPosition is { } position && _lastSector >= 0 && sector != _lastSector)
                _sectorCrossings.Add(new RawSectorCrossing(_lastSector, sector, position.X, position.Y, position.Z, _currentLap));
            _lastSector = sector;
        }
        Updated?.Invoke(this, EventArgs.Empty);
    }

    private void HandleMotion(byte[] data)
    {
        // F1 25 supports the original 22-car layout and 2026's 24-car layout.
        var stride = CarStride(data, 1325, 60, 54);
        var offset = 29 + _playerCarIndex * stride;
        if (data.Length < offset + 12) return;
        var point = new RawTrackPoint(Math.Round(BitConverter.ToSingle(data, offset), 2),
            Math.Round(BitConverter.ToSingle(data, offset + 4), 2), Math.Round(BitConverter.ToSingle(data, offset + 8), 2), CurrentLap);
        lock (_gate)
        {
            _lastPosition = point;
            if (!IsRecording) return;
            if (_points.Count == 0 || Distance(_points[^1], point) >= 2)
                _points.Add(point);
        }
        Updated?.Invoke(this, EventArgs.Empty);
    }

    private void HandleTelemetry(byte[] data)
    {
        var stride = CarStride(data, 1448, 60, 59);
        var offset = 29 + _playerCarIndex * stride;
        if (data.Length < offset + 19) return;
        lock (_gate)
        {
            if (!IsRecording || _lastPosition is not { } point) return;
            var drs = data[offset + 18];
            if (drs == _drs) return;
            _drs = drs;
            _drsEvents.Add(new RawDrsEvent(drs == 1 ? "unlock" : "lock", point.X, point.Y, point.Z, _currentLap));
        }
        Updated?.Invoke(this, EventArgs.Empty);
    }

    private void HandleActiveAero(byte[] data)
    {
        var offset = 29 + _playerCarIndex * 10;
        if (data.Length < offset + 1) return;
        lock (_gate)
        {
            if (!IsRecording || _lastPosition is not { } point) return;
            var activeAero = data[offset]; // 0 = Corner, 1 = Straight Line Mode
            // The first packet establishes the current state; it is not an event.
            if (_activeAero is null) { _activeAero = activeAero; return; }
            if (activeAero == _activeAero.Value) return;
            _activeAero = activeAero;
            _slmEvents.Add(new RawSlmEvent(activeAero == 1 ? "activate" : "deactivate", point.X, point.Y, point.Z, _currentLap));
        }
        Updated?.Invoke(this, EventArgs.Empty);
    }

    private void HandleSpeedTrap(byte[] data)
    {
        lock (_gate)
        {
            if (!IsRecording || _lastPosition is not { } point || data.Length < 39 || data[33] != _playerCarIndex) return;
            _speedTraps.Add(new RawSpeedTrap(point.X, point.Y, point.Z, _currentLap, Math.Round(BitConverter.ToSingle(data, 34), 1)));
        }
        Updated?.Invoke(this, EventArgs.Empty);
    }

    private static int CarStride(byte[] data, int knownPacketLength, int legacyStride, int season2026Stride)
    {
        if (data.Length == knownPacketLength) return season2026Stride;
        return BitConverter.ToUInt16(data, 0) >= 2026 ? season2026Stride : legacyStride;
    }

    private static double Distance(RawTrackPoint a, RawTrackPoint b) => double.Hypot(a.X - b.X, a.Z - b.Z);
    public async ValueTask DisposeAsync() => await StopAsync();
}

public sealed record RawTrackRecording(
    [property: JsonPropertyName("track_id")] int TrackId,
    [property: JsonPropertyName("session_uid")] string? SessionUid,
    [property: JsonPropertyName("track_length_m")] int TrackLengthMeters,
    [property: JsonPropertyName("points")] IReadOnlyList<RawTrackPoint> Points,
    [property: JsonPropertyName("sector_crossings")] IReadOnlyList<RawSectorCrossing> SectorCrossings,
    [property: JsonPropertyName("drs_events")] IReadOnlyList<RawDrsEvent> DrsEvents,
    [property: JsonPropertyName("slm_events")] IReadOnlyList<RawSlmEvent> SlmEvents,
    [property: JsonPropertyName("speed_traps")] IReadOnlyList<RawSpeedTrap> SpeedTraps,
    [property: JsonPropertyName("active_aero_track_status")] int ActiveAeroTrackStatus);

public sealed record RawTrackPoint([property: JsonPropertyName("x")] double X, [property: JsonPropertyName("y")] double Y, [property: JsonPropertyName("z")] double Z, [property: JsonPropertyName("lap")] int Lap);
public sealed record RawSectorCrossing([property: JsonPropertyName("from_s")] int FromSector, [property: JsonPropertyName("to_s")] int ToSector, [property: JsonPropertyName("x")] double X, [property: JsonPropertyName("y")] double Y, [property: JsonPropertyName("z")] double Z, [property: JsonPropertyName("lap")] int Lap);
public sealed record RawDrsEvent([property: JsonPropertyName("type")] string Type, [property: JsonPropertyName("x")] double X, [property: JsonPropertyName("y")] double Y, [property: JsonPropertyName("z")] double Z, [property: JsonPropertyName("lap")] int Lap);
public sealed record RawSlmEvent([property: JsonPropertyName("type")] string Type, [property: JsonPropertyName("x")] double X, [property: JsonPropertyName("y")] double Y, [property: JsonPropertyName("z")] double Z, [property: JsonPropertyName("lap")] int Lap);
public sealed record RawSpeedTrap([property: JsonPropertyName("x")] double X, [property: JsonPropertyName("y")] double Y, [property: JsonPropertyName("z")] double Z, [property: JsonPropertyName("lap")] int Lap, [property: JsonPropertyName("speed_kph")] double SpeedKph);
