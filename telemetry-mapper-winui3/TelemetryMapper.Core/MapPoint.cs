namespace TelemetryMapper.Core;

public readonly record struct MapPoint(double X, double Y)
{
    public MapPoint Rounded() => new(Math.Round(X, 2), Math.Round(Y, 2));

    public override string ToString() => $"[{X:g}, {Y:g}]";
}

public sealed record MapSector(int Index, IReadOnlyList<MapPoint> Points);

public sealed record MapZone(MapPoint Start, MapPoint End);

public enum MarkerKind
{
    PointScalar,
    PointList,
    ZoneList,
}

public sealed record MarkerRow(int Index, MarkerKind Kind, MapPoint? Point, MapZone? Zone);
