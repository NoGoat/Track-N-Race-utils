using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace TelemetryMapper.Core;

public sealed class TrackMapDocument
{
    public const string NewCollectionSentinel = "New collection";

    public static readonly IReadOnlyDictionary<string, MarkerKind> KnownKinds =
        new Dictionary<string, MarkerKind>(StringComparer.Ordinal)
        {
            ["drs_zones"] = MarkerKind.ZoneList,
            ["drs_detection_points"] = MarkerKind.PointList,
            ["slm_dry"] = MarkerKind.ZoneList,
            ["slm_wet"] = MarkerKind.ZoneList,
            ["speed_traps"] = MarkerKind.PointList,
            ["overtake_detection_point"] = MarkerKind.PointScalar,
            ["overtake_activation_point"] = MarkerKind.PointScalar,
            ["start_finish"] = MarkerKind.PointScalar,
        };

    public static readonly ISet<string> NonMarkerKeys = new HashSet<string>(StringComparer.Ordinal)
    {
        "track_id", "track_name", "circuit_name", "track_length_m", "pit_time",
        "inlap_pit_time", "outlap_pit_time", "view_box", "rotation_deg", "transform",
        "sectors",
    };

    private readonly Dictionary<string, MarkerKind> _markerKinds = new(StringComparer.Ordinal);

    private TrackMapDocument(JsonObject root, string? path)
    {
        Root = root;
        Path = path;
        RebuildDerivedData();
    }

    public JsonObject Root { get; }
    public string? Path { get; private set; }
    public bool IsDirty { get; private set; }
    public IReadOnlyList<MapSector> Sectors { get; private set; } = [];
    public IReadOnlyList<MapPoint> Centerline { get; private set; } = [];
    public IReadOnlyList<int> SectorByPoint { get; private set; } = [];
    public IReadOnlyDictionary<string, MarkerKind> MarkerKinds => _markerKinds;
    public string FileName => string.IsNullOrWhiteSpace(Path) ? "untitled" : System.IO.Path.GetFileName(Path);
    public string TrackName => ReadString(Root["track_name"]) ?? "?";
    public string CircuitName => ReadString(Root["circuit_name"]) ?? "?";
    public int? TrackId => ReadInt(Root["track_id"]);
    public double? TrackLengthMeters => ReadNumber(Root["track_length_m"]);
    public double? PitTime => ReadNumber(Root["pit_time"]);
    public double? InlapPitTime => ReadNumber(Root["inlap_pit_time"]);
    public double? OutlapPitTime => ReadNumber(Root["outlap_pit_time"]);
    public double RotationDegrees => ReadNumber(Root["rotation_deg"]) ?? 0;
    public double ViewBoxWidth => ReadNumber(Root["view_box"]?["width"]) ?? 1000;
    public double ViewBoxHeight => ReadNumber(Root["view_box"]?["height"]) ?? 1000;

    public event EventHandler? Changed;

    public static TrackMapDocument Parse(string json, string? path = null)
    {
        var root = JsonNode.Parse(json) as JsonObject
            ?? throw new InvalidDataException("The map JSON root must be an object.");
        var document = new TrackMapDocument(root, path);
        if (document.Sectors.Count == 0 || document.Centerline.Count == 0)
        {
            throw new InvalidDataException("This map has no readable sector points.");
        }

        return document;
    }

    public static async Task<TrackMapDocument> LoadAsync(
        string path,
        CancellationToken cancellationToken = default)
    {
        var json = await File.ReadAllTextAsync(path, cancellationToken).ConfigureAwait(false);
        return Parse(json, path);
    }

    public async Task SaveAsAsync(string path, CancellationToken cancellationToken = default)
    {
        var options = new JsonSerializerOptions
        {
            WriteIndented = true,
            Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        };
        await File.WriteAllTextAsync(path, Root.ToJsonString(options), cancellationToken);
        Path = path;
        IsDirty = false;
        Changed?.Invoke(this, EventArgs.Empty);
    }

    public IReadOnlyList<MarkerRow> GetRows(string key)
    {
        if (!_markerKinds.TryGetValue(key, out var kind))
        {
            return [];
        }

        var rows = new List<MarkerRow>();
        if (kind == MarkerKind.PointScalar)
        {
            var point = ReadPoint(Root[key]);
            if (point is not null)
            {
                rows.Add(new MarkerRow(0, kind, point, null));
            }
            return rows;
        }

        if (Root[key] is not JsonArray values)
        {
            return rows;
        }

        for (var index = 0; index < values.Count; index++)
        {
            if (kind == MarkerKind.PointList)
            {
                var point = ReadPoint(values[index]);
                if (point is not null)
                {
                    rows.Add(new MarkerRow(index, kind, point, null));
                }
            }
            else if (values[index] is JsonObject zone)
            {
                var start = ReadPoint(zone["start"]);
                var end = ReadPoint(zone["end"]);
                if (start is not null && end is not null)
                {
                    rows.Add(new MarkerRow(index, kind, null, new MapZone(start.Value, end.Value)));
                }
            }
        }

        return rows;
    }

    public bool TryCreateCollection(string name, MarkerKind kind, out string error)
    {
        name = name.Trim();
        if (string.IsNullOrWhiteSpace(name))
        {
            error = "Enter a collection name.";
            return false;
        }
        if (kind == MarkerKind.PointScalar)
        {
            error = "Custom collections must contain a list of points or zones.";
            return false;
        }
        if (Root.ContainsKey(name) || NonMarkerKeys.Contains(name))
        {
            error = $"\"{name}\" already exists or is reserved.";
            return false;
        }

        Root[name] = new JsonArray();
        _markerKinds[name] = kind;
        MarkDirty();
        error = string.Empty;
        return true;
    }

    public void SetTextAttribute(string key, string value)
    {
        if (key is not ("track_name" or "circuit_name"))
        {
            throw new ArgumentOutOfRangeException(nameof(key), key, "This map attribute is not editable text.");
        }
        if (ReadString(Root[key]) == value)
        {
            return;
        }

        Root[key] = value;
        MarkDirty();
    }

    public void SetNumberAttribute(string key, double value)
    {
        if (key is not ("track_length_m" or "pit_time" or "inlap_pit_time" or "outlap_pit_time" or "rotation_deg"))
        {
            throw new ArgumentOutOfRangeException(nameof(key), key, "This map attribute is not editable numeric data.");
        }
        if (!double.IsFinite(value) || (key != "rotation_deg" && value < 0))
        {
            throw new ArgumentOutOfRangeException(nameof(value), value, "Map attributes must be finite, non-negative numbers.");
        }
        if (ReadNumber(Root[key]) == value)
        {
            return;
        }

        Root[key] = value;
        MarkDirty();
    }

    public void SetOrAddPoint(string key, MapPoint point)
    {
        var kind = RequireKind(key);
        var node = PointNode(point.Rounded());
        if (kind == MarkerKind.PointScalar)
        {
            Root[key] = node;
        }
        else if (kind == MarkerKind.PointList)
        {
            EnsureArray(key).Add(node);
        }
        else
        {
            throw new InvalidOperationException($"{key} contains zones, not points.");
        }
        MarkDirty();
    }

    public void AddZone(string key, MapPoint start, MapPoint end)
    {
        if (RequireKind(key) != MarkerKind.ZoneList)
        {
            throw new InvalidOperationException($"{key} does not contain zones.");
        }

        EnsureArray(key).Add(new JsonObject
        {
            ["start"] = PointNode(start.Rounded()),
            ["end"] = PointNode(end.Rounded()),
        });
        MarkDirty();
    }

    public void DeleteRow(string key, int row)
    {
        var kind = RequireKind(key);
        if (kind == MarkerKind.PointScalar)
        {
            Root[key] = null;
        }
        else
        {
            var values = EnsureArray(key);
            if (row < 0 || row >= values.Count)
            {
                throw new ArgumentOutOfRangeException(nameof(row));
            }
            values.RemoveAt(row);
        }
        MarkDirty();
    }

    public void UpdatePoint(string key, int row, MapPoint point)
    {
        var kind = RequireKind(key);
        var node = PointNode(point.Rounded());
        if (kind == MarkerKind.PointScalar)
        {
            Root[key] = node;
        }
        else if (kind == MarkerKind.PointList)
        {
            var values = EnsureArray(key);
            values[row] = node;
        }
        else
        {
            throw new InvalidOperationException($"{key} contains zones, not points.");
        }
        MarkDirty();
    }

    public void UpdateZoneEndpoint(string key, int row, bool start, MapPoint point)
    {
        if (RequireKind(key) != MarkerKind.ZoneList)
        {
            throw new InvalidOperationException($"{key} does not contain zones.");
        }
        if (EnsureArray(key)[row] is not JsonObject zone)
        {
            throw new InvalidDataException($"Zone {row} in {key} is invalid.");
        }
        zone[start ? "start" : "end"] = PointNode(point.Rounded());
        MarkDirty();
    }

    public void ReplaceZones(string key, IEnumerable<MapZone> zones)
    {
        if (!_markerKinds.TryGetValue(key, out var kind) || kind != MarkerKind.ZoneList)
        {
            throw new InvalidOperationException($"{key} is not a zone collection.");
        }
        var array = new JsonArray();
        foreach (var zone in zones)
        {
            array.Add(new JsonObject
            {
                ["start"] = PointNode(zone.Start.Rounded()),
                ["end"] = PointNode(zone.End.Rounded()),
            });
        }
        Root[key] = array;
        MarkDirty();
    }

    public bool HasTransform => Root["transform"] is JsonObject;

    public double RequireTransformValue(string name)
    {
        return ReadNumber(Root["transform"]?[name])
            ?? throw new InvalidDataException($"The map transform has no numeric {name} value.");
    }

    public static MapPoint? ReadPoint(JsonNode? node)
    {
        if (node is not JsonArray array || array.Count != 2)
        {
            return null;
        }
        var x = ReadNumber(array[0]);
        var y = ReadNumber(array[1]);
        return x is null || y is null ? null : new MapPoint(x.Value, y.Value);
    }

    public static double? ReadNumber(JsonNode? node)
    {
        if (node is not JsonValue value)
        {
            return null;
        }
        if (value.TryGetValue<double>(out var number))
        {
            return number;
        }
        if (value.TryGetValue<int>(out var integer))
        {
            return integer;
        }
        if (value.TryGetValue<long>(out var longInteger))
        {
            return longInteger;
        }
        return null;
    }

    public static int? ReadInt(JsonNode? node)
    {
        var value = ReadNumber(node);
        return value is null ? null : checked((int)value.Value);
    }

    private void RebuildDerivedData()
    {
        var sectors = new List<MapSector>();
        var centerline = new List<MapPoint>();
        var sectorByPoint = new List<int>();
        if (Root["sectors"] is JsonArray sectorNodes)
        {
            var fallbackIndex = 1;
            foreach (var node in sectorNodes.OfType<JsonObject>())
            {
                var index = ReadInt(node["index"]) ?? fallbackIndex;
                var points = new List<MapPoint>();
                if (node["points"] is JsonArray pointNodes)
                {
                    foreach (var pointNode in pointNodes)
                    {
                        var point = ReadPoint(pointNode);
                        if (point is null)
                        {
                            continue;
                        }
                        points.Add(point.Value);
                        centerline.Add(point.Value);
                        sectorByPoint.Add(index);
                    }
                }
                if (points.Count > 0)
                {
                    sectors.Add(new MapSector(index, points));
                }
                fallbackIndex++;
            }
        }
        Sectors = sectors;
        Centerline = centerline;
        SectorByPoint = sectorByPoint;

        _markerKinds.Clear();
        foreach (var pair in KnownKinds)
        {
            _markerKinds[pair.Key] = pair.Value;
        }
        foreach (var pair in Root)
        {
            if (_markerKinds.ContainsKey(pair.Key))
            {
                continue;
            }
            var inferred = InferKind(pair.Key, pair.Value);
            if (inferred is not null)
            {
                _markerKinds[pair.Key] = inferred.Value;
            }
        }
    }

    private static MarkerKind? InferKind(string key, JsonNode? value)
    {
        if (KnownKinds.TryGetValue(key, out var known))
        {
            return known;
        }
        if (NonMarkerKeys.Contains(key) || value is not JsonArray array)
        {
            return null;
        }
        if (ReadPoint(array) is not null)
        {
            return MarkerKind.PointScalar;
        }
        if (array.Count == 0)
        {
            return null;
        }
        if (array[0] is JsonObject zone && zone.ContainsKey("start") && zone.ContainsKey("end"))
        {
            return MarkerKind.ZoneList;
        }
        return ReadPoint(array[0]) is not null ? MarkerKind.PointList : null;
    }

    private MarkerKind RequireKind(string key)
    {
        return _markerKinds.TryGetValue(key, out var kind)
            ? kind
            : throw new KeyNotFoundException($"Unknown marker collection {key}.");
    }

    private JsonArray EnsureArray(string key)
    {
        if (Root[key] is JsonArray array)
        {
            return array;
        }
        array = new JsonArray();
        Root[key] = array;
        return array;
    }

    private void MarkDirty()
    {
        IsDirty = true;
        Changed?.Invoke(this, EventArgs.Empty);
    }

    private static JsonArray PointNode(MapPoint point) => [point.X, point.Y];

    private static string? ReadString(JsonNode? node) =>
        node is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;
}
