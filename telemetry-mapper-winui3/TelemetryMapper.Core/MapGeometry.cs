namespace TelemetryMapper.Core;

public sealed class MapViewTransform
{
    public const double Padding = 24;

    private readonly double _cos;
    private readonly double _sin;
    private readonly double _centerX;
    private readonly double _centerY;

    private MapViewTransform(
        double cos,
        double sin,
        double centerX,
        double centerY,
        double scale,
        double offsetX,
        double offsetY)
    {
        _cos = cos;
        _sin = sin;
        _centerX = centerX;
        _centerY = centerY;
        Scale = scale;
        OffsetX = offsetX;
        OffsetY = offsetY;
    }

    public double Scale { get; }
    public double OffsetX { get; }
    public double OffsetY { get; }

    public static MapViewTransform Create(
        IEnumerable<MapPoint> points,
        double viewBoxWidth,
        double viewBoxHeight,
        double rotationDegrees,
        double canvasWidth,
        double canvasHeight)
    {
        var radians = rotationDegrees * Math.PI / 180.0;
        var cos = Math.Cos(radians);
        var sin = Math.Sin(radians);
        var centerX = viewBoxWidth / 2.0;
        var centerY = viewBoxHeight / 2.0;
        var materialized = points.ToList();

        var minX = double.PositiveInfinity;
        var minY = double.PositiveInfinity;
        var maxX = double.NegativeInfinity;
        var maxY = double.NegativeInfinity;

        foreach (var point in materialized)
        {
            var rotated = Rotate(point, cos, sin, centerX, centerY);
            minX = Math.Min(minX, rotated.X);
            minY = Math.Min(minY, rotated.Y);
            maxX = Math.Max(maxX, rotated.X);
            maxY = Math.Max(maxY, rotated.Y);
        }

        if (materialized.Count == 0)
        {
            minX = minY = 0;
            maxX = viewBoxWidth;
            maxY = viewBoxHeight;
        }

        var width = Math.Max(1, maxX - minX);
        var height = Math.Max(1, maxY - minY);
        var availableWidth = Math.Max(1, canvasWidth - 2 * Padding);
        var availableHeight = Math.Max(1, canvasHeight - 2 * Padding);
        var scale = Math.Min(availableWidth / width, availableHeight / height);
        var offsetX = (canvasWidth - width * scale) / 2.0 - minX * scale;
        var offsetY = (canvasHeight - height * scale) / 2.0 - minY * scale;

        return new MapViewTransform(cos, sin, centerX, centerY, scale, offsetX, offsetY);
    }

    public MapPoint ToCanvas(MapPoint point)
    {
        var rotated = Rotate(point, _cos, _sin, _centerX, _centerY);
        return new MapPoint(
            rotated.X * Scale + OffsetX,
            rotated.Y * Scale + OffsetY);
    }

    public MapPoint ToViewBox(double canvasX, double canvasY)
    {
        var rotatedX = (canvasX - OffsetX) / Scale;
        var rotatedY = (canvasY - OffsetY) / Scale;
        var dx = rotatedX - _centerX;
        var dy = rotatedY - _centerY;
        return new MapPoint(
            _cos * dx + _sin * dy + _centerX,
            -_sin * dx + _cos * dy + _centerY);
    }

    private static MapPoint Rotate(
        MapPoint point,
        double cos,
        double sin,
        double centerX,
        double centerY)
    {
        var dx = point.X - centerX;
        var dy = point.Y - centerY;
        return new MapPoint(
            cos * dx - sin * dy + centerX,
            sin * dx + cos * dy + centerY);
    }
}

public static class MapGeometry
{
    public static int ClosestIndex(IReadOnlyList<MapPoint> centerline, MapPoint point)
    {
        if (centerline.Count == 0)
        {
            return -1;
        }

        var bestIndex = 0;
        var bestDistance = double.PositiveInfinity;
        for (var index = 0; index < centerline.Count; index++)
        {
            var dx = centerline[index].X - point.X;
            var dy = centerline[index].Y - point.Y;
            var distance = dx * dx + dy * dy;
            if (distance < bestDistance)
            {
                bestDistance = distance;
                bestIndex = index;
            }
        }

        return bestIndex;
    }

    public static IEnumerable<int> SliceIndices(int start, int end, int count)
    {
        if (count <= 0 || start < 0 || end < 0 || start >= count || end >= count)
        {
            yield break;
        }

        var current = start;
        while (true)
        {
            yield return current;
            if (current == end)
            {
                yield break;
            }

            current = (current + 1) % count;
        }
    }
}
