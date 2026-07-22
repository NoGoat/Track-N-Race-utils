namespace TelemetryMapper.Core.Tests;

[TestClass]
public sealed class MapGeometryTests
{
    [TestMethod]
    public void ForwardAndInverseTransformsRoundTrip()
    {
        var points = new[] { new MapPoint(100, 100), new MapPoint(900, 800) };
        var transform = MapViewTransform.Create(points, 1000, 1000, 37, 1200, 700);
        var source = new MapPoint(412.5, 711.25);

        var canvas = transform.ToCanvas(source);
        var roundTrip = transform.ToViewBox(canvas.X, canvas.Y);

        Assert.AreEqual(source.X, roundTrip.X, 0.000001);
        Assert.AreEqual(source.Y, roundTrip.Y, 0.000001);
    }

    [TestMethod]
    public void SliceIndicesWrapsAcrossStartFinish()
    {
        CollectionAssert.AreEqual(
            new[] { 4, 0, 1 },
            MapGeometry.SliceIndices(4, 1, 5).ToArray());
    }

    [TestMethod]
    public void ClosestIndexUsesSquaredDistance()
    {
        var points = new[] { new MapPoint(0, 0), new MapPoint(10, 0), new MapPoint(20, 0) };
        Assert.AreEqual(1, MapGeometry.ClosestIndex(points, new MapPoint(12, 3)));
    }
}
