namespace TelemetryMapper.Core;

public static class SlmZoneProjector
{
    private const int GapLimit = 120;
    private const double StraightDotThreshold = 0.92;

    private readonly record struct WorldPoint(double X, double Z);
    private readonly record struct WorldZone(WorldPoint Start, WorldPoint End);

    public static IReadOnlyList<MapZone> Project(
        TrackMapDocument map,
        SlmRecording recording)
    {
        if (!map.HasTransform)
        {
            throw new TnrdImportException(
                "The open map has no world-to-map transform, so TNRD points cannot be imported.");
        }

        try
        {
            var minX = map.RequireTransformValue("min_x");
            var minZ = map.RequireTransformValue("min_z");
            var scale = map.RequireTransformValue("scale");
            var offsetX = map.RequireTransformValue("off_x");
            var offsetZ = map.RequireTransformValue("off_z");
            if (scale == 0)
            {
                throw new InvalidDataException("The map transform scale is zero.");
            }

            var worldCenterline = map.Centerline
                .Select(point => new WorldPoint(
                    (point.X - offsetX) / scale + minX,
                    (point.Y - offsetZ) / scale + minZ))
                .ToList();
            var worldZones = Consolidate(recording.Events, worldCenterline);
            return worldZones.Select(zone => new MapZone(
                Transform(zone.Start, minX, minZ, scale, offsetX, offsetZ),
                Transform(zone.End, minX, minZ, scale, offsetX, offsetZ))).ToList();
        }
        catch (TnrdImportException)
        {
            throw;
        }
        catch (Exception exception) when (exception is InvalidDataException or OverflowException)
        {
            throw new TnrdImportException(
                $"Could not project the TNRD points onto this map: {exception.Message}", exception);
        }
    }

    private static IReadOnlyList<WorldZone> Consolidate(
        IReadOnlyList<SlmEvent> events,
        IReadOnlyList<WorldPoint> centerline)
    {
        if (events.Count == 0 || centerline.Count == 0)
        {
            return [];
        }

        var instances = new List<(SlmEvent Start, SlmEvent End)>();
        for (var index = 0; index < events.Count; index++)
        {
            if (!events[index].IsActivation)
            {
                continue;
            }
            var end = index + 1;
            while (end < events.Count && events[end].IsActivation)
            {
                end++;
            }
            if (end < events.Count)
            {
                instances.Add((events[index], events[end]));
                index = end;
            }
        }
        if (instances.Count == 0)
        {
            return [];
        }

        var covered = new bool[centerline.Count];
        foreach (var instance in instances)
        {
            var start = ClosestWorldIndex(centerline, instance.Start.X, instance.Start.Z);
            var end = ClosestWorldIndex(centerline, instance.End.X, instance.End.Z);
            foreach (var index in MapGeometry.SliceIndices(start, end, centerline.Count))
            {
                covered[index] = true;
            }
        }

        FillStraightGaps(covered, centerline);
        return ExtractZones(covered, centerline);
    }

    private static void FillStraightGaps(bool[] covered, IReadOnlyList<WorldPoint> centerline)
    {
        if (!covered.Any(value => value) || covered.All(value => value))
        {
            return;
        }
        var start = FindStartBoundary(covered);
        var visited = 0;
        var current = start;
        while (visited < covered.Length)
        {
            if (covered[current])
            {
                current = (current + 1) % covered.Length;
                visited++;
                continue;
            }

            var gapStart = current;
            var gapLength = 0;
            while (!covered[current] && visited + gapLength < covered.Length)
            {
                gapLength++;
                current = (current + 1) % covered.Length;
            }
            visited += gapLength;
            if (gapLength < GapLimit && IsStraightGap(gapStart, gapLength, centerline))
            {
                var fill = gapStart;
                for (var count = 0; count < gapLength; count++)
                {
                    covered[fill] = true;
                    fill = (fill + 1) % covered.Length;
                }
            }
        }
    }

    private static bool IsStraightGap(
        int gapStart,
        int gapLength,
        IReadOnlyList<WorldPoint> centerline)
    {
        var count = centerline.Count;
        var previous = (gapStart - 1 + count) % count;
        var referenceDx = centerline[gapStart].X - centerline[previous].X;
        var referenceDz = centerline[gapStart].Z - centerline[previous].Z;
        var referenceLength = Math.Sqrt(referenceDx * referenceDx + referenceDz * referenceDz);
        if (referenceLength == 0)
        {
            return true;
        }
        referenceDx /= referenceLength;
        referenceDz /= referenceLength;

        var current = gapStart;
        for (var countInGap = 0; countInGap < gapLength; countInGap++)
        {
            var next = (current + 1) % count;
            var dx = centerline[next].X - centerline[current].X;
            var dz = centerline[next].Z - centerline[current].Z;
            var length = Math.Sqrt(dx * dx + dz * dz);
            if (length > 0)
            {
                var dot = referenceDx * dx / length + referenceDz * dz / length;
                if (dot < StraightDotThreshold)
                {
                    return false;
                }
            }
            current = next;
        }
        return true;
    }

    private static IReadOnlyList<WorldZone> ExtractZones(
        bool[] covered,
        IReadOnlyList<WorldPoint> centerline)
    {
        if (!covered.Any(value => value))
        {
            return [];
        }
        if (covered.All(value => value))
        {
            return [new WorldZone(centerline[0], centerline[^1])];
        }

        var zones = new List<WorldZone>();
        var start = FindStartBoundary(covered);
        var current = start;
        var visited = 0;
        while (visited < covered.Length)
        {
            if (!covered[current])
            {
                current = (current + 1) % covered.Length;
                visited++;
                continue;
            }

            var zoneStart = current;
            var zoneLength = 0;
            while (covered[current] && visited + zoneLength < covered.Length)
            {
                zoneLength++;
                current = (current + 1) % covered.Length;
            }
            visited += zoneLength;
            var zoneEnd = (zoneStart + zoneLength - 1) % covered.Length;
            zones.Add(new WorldZone(centerline[zoneStart], centerline[zoneEnd]));
        }
        return zones;
    }

    private static int FindStartBoundary(bool[] values)
    {
        for (var index = 0; index < values.Length; index++)
        {
            if (values[index] && !values[(index - 1 + values.Length) % values.Length])
            {
                return index;
            }
        }
        return 0;
    }

    private static int ClosestWorldIndex(
        IReadOnlyList<WorldPoint> centerline,
        double x,
        double z)
    {
        var bestIndex = 0;
        var bestDistance = double.PositiveInfinity;
        for (var index = 0; index < centerline.Count; index++)
        {
            var dx = centerline[index].X - x;
            var dz = centerline[index].Z - z;
            var distance = dx * dx + dz * dz;
            if (distance < bestDistance)
            {
                bestIndex = index;
                bestDistance = distance;
            }
        }
        return bestIndex;
    }

    private static MapPoint Transform(
        WorldPoint point,
        double minX,
        double minZ,
        double scale,
        double offsetX,
        double offsetZ) =>
        new(
            Math.Round((point.X - minX) * scale + offsetX, 2),
            Math.Round((point.Z - minZ) * scale + offsetZ, 2));
}
