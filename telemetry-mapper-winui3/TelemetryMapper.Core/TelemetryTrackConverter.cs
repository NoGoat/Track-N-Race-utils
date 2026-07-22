using System.Text.Json.Nodes;

namespace TelemetryMapper.Core;

public static class TelemetryTrackConverter
{
    /// <summary>Preserves a pre-existing final map and adds only non-empty
    /// collections the existing file does not already define.</summary>
    public static TrackMapDocument MergeMissing(TrackMapDocument existing, TrackMapDocument recorded, bool includeStartFinish = true)
    {
        var root = existing.Root.DeepClone()!.AsObject();
        var keys = includeStartFinish
            ? new[] { "drs_zones", "slm_dry", "slm_wet", "speed_traps", "start_finish" }
            : new[] { "drs_zones", "slm_dry", "slm_wet", "speed_traps" };
        foreach (var key in keys)
        {
            if (!IsMissing(root[key]) || IsMissing(recorded.Root[key])) continue;
            root[key] = ProjectNode(recorded.Root[key], recorded, existing);
        }
        return TrackMapDocument.Parse(root.ToJsonString());
    }

    /// <summary>Adds live marker data to an existing final map. Unlike creating a
    /// new map, this uses the existing centerline and therefore needs no complete
    /// recorded lap.</summary>
    public static TrackMapDocument MergeMissingFromRecording(TrackMapDocument existing, RawTrackRecording recording)
    {
        if (!existing.HasTransform) return existing;
        var root = existing.Root.DeepClone()!.AsObject();
        var line = existing.Centerline.Select(point => new RawTrackPoint(point.X, 0, point.Y, 0)).ToList();
        JsonArray Zones(IEnumerable<(int Start, int End)> zones)
        {
            var result = new JsonArray();
            foreach (var (start, end) in zones)
                result.Add(new JsonObject { ["start"] = PointNode(existing.Centerline[start]), ["end"] = PointNode(existing.Centerline[end]) });
            return result;
        }
        AeroTransition Transition(string type, double x, double z)
        {
            var point = ProjectRawPoint(x, z, existing);
            return new AeroTransition(type, point.X, point.Y);
        }

        var drs = Zones(ConsolidateZones(recording.DrsEvents.Select(e => Transition(e.Type, e.X, e.Z)), line, "unlock", "lock"));
        var slm = Zones(ConsolidateZones(recording.SlmEvents.Select(e => Transition(e.Type, e.X, e.Z)), line, "activate", "deactivate"));
        var speedTraps = new JsonArray(ConsolidateByProximity(recording.SpeedTraps)
            .Select(trap => PointNode(ProjectRawPoint(trap.X, trap.Z, existing))).ToArray());
        if (IsMissing(root["drs_zones"]) && !IsMissing(drs)) root["drs_zones"] = drs;
        if (IsMissing(root["speed_traps"]) && !IsMissing(speedTraps)) root["speed_traps"] = speedTraps;
        if (recording.ActiveAeroTrackStatus == 0 && IsMissing(root["slm_dry"]) && !IsMissing(slm)) root["slm_dry"] = slm;
        if (recording.ActiveAeroTrackStatus == 1 && IsMissing(root["slm_wet"]) && !IsMissing(slm)) root["slm_wet"] = slm;
        return TrackMapDocument.Parse(root.ToJsonString());
    }

    /// <summary>Creates the immediate on-screen trace from the current lap. This is
    /// intentionally separate from final conversion: it includes lap one and is
    /// called for every received recorded point.</summary>
    public static TrackMapDocument CreateLivePreview(RawTrackRecording recording)
    {
        if (recording.Points.Count == 0)
        {
            throw new InvalidDataException("No live points are available yet.");
        }

        var currentLap = recording.Points[^1].Lap;
        var line = recording.Points.Where(point => point.Lap == currentLap).ToList();
        var minX = line.Min(point => point.X); var maxX = line.Max(point => point.X);
        var minZ = line.Min(point => point.Z); var maxZ = line.Max(point => point.Z);
        var scale = Math.Min(900 / Math.Max(1, maxX - minX), 900 / Math.Max(1, maxZ - minZ));
        var offX = (1000 - (maxX - minX) * scale) / 2; var offZ = (1000 - (maxZ - minZ) * scale) / 2;
        JsonArray Point(RawTrackPoint point) => [Math.Round((point.X - minX) * scale + offX, 2), Math.Round((point.Z - minZ) * scale + offZ, 2)];
        JsonArray ZoneNodes(IEnumerable<(int Start, int End)> zones)
        {
            var nodes = new JsonArray();
            foreach (var (start, end) in zones)
                nodes.Add(new JsonObject { ["start"] = Point(line[start]), ["end"] = Point(line[end]) });
            return nodes;
        }
        var liveDrsZones = ZoneNodes(ConsolidateZones(
            recording.DrsEvents.Select(e => new AeroTransition(e.Type, e.X, e.Z)), line, "unlock", "lock"));
        var liveSlmZones = ZoneNodes(ConsolidateZones(
            recording.SlmEvents.Select(e => new AeroTransition(e.Type, e.X, e.Z)), line, "activate", "deactivate"));
        var root = new JsonObject
        {
            ["track_id"] = recording.TrackId,
            ["track_name"] = "Live recording",
            ["circuit_name"] = "",
            ["track_length_m"] = recording.TrackLengthMeters,
            ["view_box"] = new JsonObject { ["width"] = 1000, ["height"] = 1000 },
            ["rotation_deg"] = 0,
            ["transform"] = new JsonObject { ["min_x"] = Math.Round(minX, 4), ["min_z"] = Math.Round(minZ, 4), ["scale"] = Math.Round(scale, 6), ["off_x"] = Math.Round(offX, 4), ["off_z"] = Math.Round(offZ, 4) },
            ["sectors"] = new JsonArray { new JsonObject { ["index"] = 1, ["points"] = new JsonArray(line.Select(Point).ToArray()) } },
            ["drs_zones"] = liveDrsZones,
            ["start_finish"] = Point(line[0])
        };
        if (recording.ActiveAeroTrackStatus == 0) root["slm_dry"] = liveSlmZones;
        else if (recording.ActiveAeroTrackStatus == 1) root["slm_wet"] = liveSlmZones;
        return TrackMapDocument.Parse(root.ToJsonString());
    }

    /// <summary>Builds the application's current, endpoint-only map JSON. The first
    /// reported lap is discarded because the game commonly initializes it with a
    /// partial or displaced trace.</summary>
    public static TrackMapDocument Convert(RawTrackRecording recording, string trackName, string circuitName)
    {
        var firstLap = recording.Points.Select(p => p.Lap).DefaultIfEmpty().Min();
        var usable = CleanPoints(recording.Points.Where(p => p.Lap > firstLap), recording.TrackLengthMeters);
        if (usable.Count < 4) throw new InvalidDataException("Record at least one complete lap after the initial lap.");
        var reference = usable.GroupBy(p => p.Lap).OrderByDescending(g => g.Count()).First().ToList();
        var line = Deduplicate(reference);
        if (line.Count < 4) throw new InvalidDataException("The recorded lap does not contain enough distinct points.");

        var minX = line.Min(p => p.X); var maxX = line.Max(p => p.X);
        var minZ = line.Min(p => p.Z); var maxZ = line.Max(p => p.Z);
        var scale = Math.Min(900 / Math.Max(1, maxX - minX), 900 / Math.Max(1, maxZ - minZ));
        var offX = (1000 - (maxX - minX) * scale) / 2; var offZ = (1000 - (maxZ - minZ) * scale) / 2;
        JsonArray Point(RawTrackPoint p) => [Math.Round((p.X - minX) * scale + offX, 2), Math.Round((p.Z - minZ) * scale + offZ, 2)];

        var crossings = ConsolidateSectorCrossings(recording.SectorCrossings.Where(c => c.Lap > firstLap));
        var s12 = crossings.FirstOrDefault(c => c.FromSector == 0 && c.ToSector == 1);
        var s23 = crossings.FirstOrDefault(c => c.FromSector == 1 && c.ToSector == 2);
        var s12Index = s12 is null ? -1 : Closest(line, s12.X, s12.Z);
        var s23Index = s23 is null ? -1 : Closest(line, s23.X, s23.Z);
        if (s12Index >= 0 && s23Index >= 0 && s12Index > s23Index) (s12Index, s23Index) = (-1, -1);

        JsonArray Slice(int start, int end, bool close = false)
        {
            var points = new JsonArray(line.Skip(start).Take(end - start).Select(Point).ToArray());
            if (close) points.Add(Point(line[0]));
            return points;
        }
        var sectors = new JsonArray();
        if (s12Index > 0 && s23Index > s12Index)
        {
            sectors.Add(new JsonObject { ["index"] = 1, ["points"] = Slice(0, s12Index) });
            sectors.Add(new JsonObject { ["index"] = 2, ["points"] = Slice(s12Index, s23Index) });
            sectors.Add(new JsonObject { ["index"] = 3, ["points"] = Slice(s23Index, line.Count, true) });
        }
        else sectors.Add(new JsonObject { ["index"] = 1, ["points"] = Slice(0, line.Count, true) });

        // Exact port of telemetry-mapper/live_mapper.py's _consolidate_zones:
        // it combines samples from all laps, fills small straight-line gaps, and
        // keeps multiple distinct zones separate. Only the resulting endpoints persist.
        JsonArray ZoneNodes(IEnumerable<(int Start, int End)> zones)
        {
            var nodes = new JsonArray();
            foreach (var (start, end) in zones)
            {
                nodes.Add(new JsonObject { ["start"] = Point(line[start]), ["end"] = Point(line[end]) });
            }
            return nodes;
        }
        var drsZones = ZoneNodes(ConsolidateZones(
            recording.DrsEvents.Select(e => new AeroTransition(e.Type, e.X, e.Z)), line, "unlock", "lock"));
        var slmZones = ZoneNodes(ConsolidateZones(
            recording.SlmEvents.Select(e => new AeroTransition(e.Type, e.X, e.Z)), line, "activate", "deactivate"));
        var speedTraps = new JsonArray(ConsolidateByProximity(recording.SpeedTraps)
            .Select(trap => Point(new RawTrackPoint(trap.X, trap.Y, trap.Z, trap.Lap))).ToArray());

        var root = new JsonObject
        {
            ["track_id"] = recording.TrackId, ["track_name"] = trackName.Trim(), ["circuit_name"] = circuitName.Trim(),
            ["track_length_m"] = recording.TrackLengthMeters, ["view_box"] = new JsonObject { ["width"] = 1000, ["height"] = 1000 },
            ["rotation_deg"] = 0, ["transform"] = new JsonObject { ["min_x"] = Math.Round(minX, 4), ["min_z"] = Math.Round(minZ, 4), ["scale"] = Math.Round(scale, 6), ["off_x"] = Math.Round(offX, 4), ["off_z"] = Math.Round(offZ, 4) },
            ["sectors"] = sectors, ["drs_zones"] = drsZones, ["speed_traps"] = speedTraps, ["start_finish"] = Point(line[0])
        };
        if (recording.ActiveAeroTrackStatus == 0)
        {
            root["slm_dry"] = slmZones;
        }
        else if (recording.ActiveAeroTrackStatus == 1)
        {
            root["slm_wet"] = slmZones;
        }
        return TrackMapDocument.Parse(root.ToJsonString());
    }

    private static List<RawTrackPoint> Deduplicate(IEnumerable<RawTrackPoint> input)
    {
        var output = new List<RawTrackPoint>();
        foreach (var point in input)
            if (output.Count == 0 || double.Hypot(point.X - output[^1].X, point.Z - output[^1].Z) >= 1) output.Add(point);
        return output;
    }

    // Direct port of telemetry-mapper/convert_track.py's _clean_points.
    private static List<RawTrackPoint> CleanPoints(IEnumerable<RawTrackPoint> source, double trackLengthMeters)
    {
        var points = source.ToList();
        if (points.Count < 4) return points;

        var (xLow, xHigh) = IqrBounds(points.Select(point => point.X));
        var (zLow, zHigh) = IqrBounds(points.Select(point => point.Z));
        var iqrClean = points.Where(point => point.X >= xLow && point.X <= xHigh && point.Z >= zLow && point.Z <= zHigh).ToList();
        var maxJump = (trackLengthMeters == 0 ? 10_000 : trackLengthMeters) * 0.5;
        var jumpClean = new List<RawTrackPoint>();
        foreach (var point in iqrClean)
        {
            if (jumpClean.Count > 0 && double.Hypot(point.X - jumpClean[^1].X, point.Z - jumpClean[^1].Z) > maxJump) continue;
            jumpClean.Add(point);
        }
        if (jumpClean.Count == 0) return jumpClean;

        var segments = new List<List<RawTrackPoint>> { new() { jumpClean[0] } };
        foreach (var point in jumpClean.Skip(1))
        {
            if (double.Hypot(point.X - segments[^1][^1].X, point.Z - segments[^1][^1].Z) > 50) segments.Add([]);
            segments[^1].Add(point);
        }
        var minPoints = Math.Max(20, jumpClean.Count / 100);
        return segments.Where(segment => segment.Count >= minPoints).SelectMany(segment => segment).ToList();
    }

    private static (double Low, double High) IqrBounds(IEnumerable<double> source)
    {
        var values = source.OrderBy(value => value).ToList();
        var q1 = values[values.Count / 4];
        var q3 = values[(3 * values.Count) / 4];
        var iqr = q3 - q1;
        return (q1 - 3.5 * iqr, q3 + 3.5 * iqr);
    }

    // Direct port of _consolidate_sector_crossings / _consolidate_by_proximity.
    private static IReadOnlyList<RawSectorCrossing> ConsolidateSectorCrossings(IEnumerable<RawSectorCrossing> source)
    {
        var result = new List<RawSectorCrossing>();
        foreach (var (fromSector, toSector) in new[] { (0, 1), (1, 2) })
        {
            var crossings = source.Where(crossing => crossing.FromSector == fromSector && crossing.ToSector == toSector).ToList();
            if (crossings.Count == 0) continue;
            var clusters = new List<List<RawSectorCrossing>>();
            foreach (var crossing in crossings)
            {
                var cluster = clusters.FirstOrDefault(group => double.Hypot(crossing.X - group[0].X, crossing.Z - group[0].Z) < 100);
                if (cluster is null) clusters.Add([crossing]); else cluster.Add(crossing);
            }
            result.Add(clusters[0][0]);
        }
        return result;
    }
    private static int Closest(IReadOnlyList<RawTrackPoint> line, double x, double z)
    {
        var bestIndex = 0; var bestDistance = double.PositiveInfinity;
        for (var i = 0; i < line.Count; i++)
        {
            var distance = Math.Pow(line[i].X - x, 2) + Math.Pow(line[i].Z - z, 2);
            if (distance < bestDistance) { bestDistance = distance; bestIndex = i; }
        }
        return bestIndex;
    }

    private static IReadOnlyList<(int Start, int End)> ConsolidateZones(
        IEnumerable<AeroTransition> source,
        IReadOnlyList<RawTrackPoint> centerline,
        string onType,
        string offType)
    {
        var events = source.ToList();
        if (events.Count == 0 || centerline.Count == 0) return [];

        var instances = new List<(AeroTransition On, AeroTransition Off)>();
        for (var i = 0; i < events.Count;)
        {
            if (events[i].Type != onType) { i++; continue; }
            var next = i + 1;
            while (next < events.Count && events[next].Type != offType) next++;
            if (next >= events.Count) { i++; continue; }
            instances.Add((events[i], events[next]));
            i = next + 1;
        }
        if (instances.Count == 0) return [];

        var count = centerline.Count;
        var isZone = new bool[count];
        foreach (var instance in instances)
        {
            var start = Closest(centerline, instance.On.X, instance.On.Z);
            var end = Closest(centerline, instance.Off.X, instance.Off.Z);
            for (var current = start;; current = (current + 1) % count)
            {
                isZone[current] = true;
                if (current == end) break;
            }
        }

        var startIndex = -1;
        for (var i = 0; i < count; i++)
            if (isZone[i] && !isZone[(i - 1 + count) % count]) { startIndex = i; break; }
        if (startIndex == -1)
            return isZone.Any(value => value) ? [(0, count - 1)] : [];

        var filled = (bool[])isZone.Clone();
        var index = startIndex;
        var visited = 0;
        while (visited < count)
        {
            if (filled[index]) { index = (index + 1) % count; visited++; continue; }
            var gapStart = index;
            var gapLength = 0;
            while (!filled[index] && visited < count) { gapLength++; index = (index + 1) % count; visited++; }
            if (gapLength >= 120) continue;

            var previous = (gapStart - 1 + count) % count;
            var referenceX = centerline[gapStart].X - centerline[previous].X;
            var referenceZ = centerline[gapStart].Z - centerline[previous].Z;
            var referenceLength = double.Hypot(referenceX, referenceZ);
            var straight = true;
            if (referenceLength > 0)
            {
                referenceX /= referenceLength; referenceZ /= referenceLength;
                var current = gapStart;
                for (var step = 0; step < gapLength; step++)
                {
                    var next = (current + 1) % count;
                    var dx = centerline[next].X - centerline[current].X;
                    var dz = centerline[next].Z - centerline[current].Z;
                    var length = double.Hypot(dx, dz);
                    if (length > 0 && referenceX * dx / length + referenceZ * dz / length < 0.92) { straight = false; break; }
                    current = next;
                }
            }
            if (!straight) continue;
            for (int current = gapStart, step = 0; step < gapLength; step++, current = (current + 1) % count) filled[current] = true;
        }

        var zones = new List<(int Start, int End)>();
        index = startIndex; visited = 0;
        while (visited < count)
        {
            if (!filled[index]) { index = (index + 1) % count; visited++; continue; }
            var zoneStart = index;
            while (filled[index] && visited < count) { index = (index + 1) % count; visited++; }
            zones.Add((zoneStart, (index - 1 + count) % count));
        }
        if (zones.Count > 1 && (zones[^1].End + 1) % count == zones[0].Start)
        {
            zones[0] = (zones[^1].Start, zones[0].End);
            zones.RemoveAt(zones.Count - 1);
        }
        return zones;
    }

    private static IReadOnlyList<RawSpeedTrap> ConsolidateByProximity(IEnumerable<RawSpeedTrap> source)
    {
        var clusters = new List<List<RawSpeedTrap>>();
        foreach (var trap in source)
        {
            var cluster = clusters.FirstOrDefault(group => double.Hypot(trap.X - group[0].X, trap.Z - group[0].Z) < 100);
            if (cluster is null) clusters.Add([trap]); else cluster.Add(trap);
        }
        return clusters.Select(group => group[0]).ToList();
    }

    private sealed record AeroTransition(string Type, double X, double Z);

    private static bool IsMissing(JsonNode? node) => node is null ||
        (node is JsonArray array && array.Count == 0);

    private static JsonNode? ProjectNode(JsonNode? node, TrackMapDocument source, TrackMapDocument target)
    {
        if (node is JsonArray point && TrackMapDocument.ReadPoint(point) is { } mapPoint)
        {
            return PointNode(ProjectPoint(mapPoint, source, target));
        }
        if (node is JsonArray array)
        {
            var copy = new JsonArray();
            foreach (var item in array) copy.Add(ProjectNode(item, source, target));
            return copy;
        }
        if (node is JsonObject obj)
        {
            var copy = new JsonObject();
            foreach (var pair in obj) copy[pair.Key] = ProjectNode(pair.Value, source, target);
            return copy;
        }
        return node?.DeepClone();
    }

    private static MapPoint ProjectPoint(MapPoint point, TrackMapDocument source, TrackMapDocument target)
    {
        if (!source.HasTransform || !target.HasTransform) return point;
        var rawX = (point.X - source.RequireTransformValue("off_x")) / source.RequireTransformValue("scale") + source.RequireTransformValue("min_x");
        var rawZ = (point.Y - source.RequireTransformValue("off_z")) / source.RequireTransformValue("scale") + source.RequireTransformValue("min_z");
        return new MapPoint(
            (rawX - target.RequireTransformValue("min_x")) * target.RequireTransformValue("scale") + target.RequireTransformValue("off_x"),
            (rawZ - target.RequireTransformValue("min_z")) * target.RequireTransformValue("scale") + target.RequireTransformValue("off_z")).Rounded();
    }

    private static JsonArray PointNode(MapPoint point) => [point.X, point.Y];

    private static MapPoint ProjectRawPoint(double rawX, double rawZ, TrackMapDocument target) =>
        new MapPoint(
            (rawX - target.RequireTransformValue("min_x")) * target.RequireTransformValue("scale") + target.RequireTransformValue("off_x"),
            (rawZ - target.RequireTransformValue("min_z")) * target.RequireTransformValue("scale") + target.RequireTransformValue("off_z")).Rounded();
}
