using System.Text.Json.Nodes;

namespace TelemetryMapper.Core.Tests;

internal static class TestMaps
{
    public static string LinearJson(int pointCount = 200) => $$"""
        {
          "track_id": 7,
          "track_name": "Silverstone",
          "track_length_m": 5891,
          "view_box": { "width": 1000, "height": 1000 },
          "rotation_deg": 15,
          "transform": { "min_x": 0, "min_z": 0, "scale": 1, "off_x": 0, "off_z": 0 },
          "sectors": [
            { "index": 1, "points": [{{Points(pointCount)}}] }
          ],
          "drs_zones": [],
          "speed_traps": [],
          "start_finish": [0, 0],
          "unknown_metadata": { "preserve": true }
        }
        """;

    public static TrackMapDocument LinearDocument(int pointCount = 200) =>
        TrackMapDocument.Parse(LinearJson(pointCount));

    public static JsonObject Header(string magic = "TNRD_V1", string? compression = null)
    {
        var header = new JsonObject
        {
            ["magic"] = magic,
            ["protocol"] = 2026,
            ["track_id"] = 7,
            ["track_name"] = "Silverstone",
            ["session_type"] = 10,
            ["session_name"] = "Race",
            ["start_time"] = 0,
        };
        if (compression is not null)
        {
            header["compression"] = compression;
        }
        return header;
    }

    public static JsonObject Position(double x, double z) => new()
    {
        ["type"] = "positions",
        ["player_idx"] = 1,
        ["cars"] = new JsonArray
        {
            new JsonObject { ["idx"] = 0, ["x"] = -1, ["z"] = -1 },
            new JsonObject { ["idx"] = 1, ["x"] = x, ["z"] = z },
        },
    };

    public static JsonObject Telemetry(double time, int slm) => new()
    {
        ["type"] = "telemetry",
        ["session_time"] = time,
        ["slm"] = slm,
    };

    private static string Points(int count) =>
        string.Join(",", Enumerable.Range(0, count).Select(index => $"[{index},0]"));
}
