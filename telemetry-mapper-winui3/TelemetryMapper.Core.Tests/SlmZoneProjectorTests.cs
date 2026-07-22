using System.Text.Json.Nodes;

namespace TelemetryMapper.Core.Tests;

[TestClass]
public sealed class SlmZoneProjectorTests
{
    [TestMethod]
    public void ProjectsImportedZoneOntoExistingMap()
    {
        var map = TestMaps.LinearDocument();
        var recording = new SlmRecording(
            TestMaps.Header(),
            [new SlmEvent(true, 10, 0), new SlmEvent(false, 30, 0)],
            2,
            2);

        var zones = SlmZoneProjector.Project(map, recording);

        CollectionAssert.AreEqual(
            new[] { new MapZone(new MapPoint(10, 0), new MapPoint(30, 0)) },
            zones.ToArray());
    }

    [TestMethod]
    public void IgnoresIncompleteActivation()
    {
        var recording = new SlmRecording(
            TestMaps.Header(),
            [new SlmEvent(true, 10, 0)],
            1,
            1);

        Assert.IsEmpty(SlmZoneProjector.Project(TestMaps.LinearDocument(), recording));
    }

    [TestMethod]
    public void RequiresWorldTransform()
    {
        var root = JsonNode.Parse(TestMaps.LinearJson())!.AsObject();
        root.Remove("transform");
        var map = TrackMapDocument.Parse(root.ToJsonString());
        var recording = new SlmRecording(
            TestMaps.Header(),
            [new SlmEvent(true, 10, 0), new SlmEvent(false, 30, 0)],
            2,
            2);

        var exception = Assert.Throws<TnrdImportException>(
            () => SlmZoneProjector.Project(map, recording));
        StringAssert.Contains(exception.Message, "no world-to-map transform");
    }

    [TestMethod]
    public void MergesShortStraightGapsAcrossRepeatedSamples()
    {
        var recording = new SlmRecording(
            TestMaps.Header(),
            [
                new SlmEvent(true, 10, 0), new SlmEvent(false, 40, 0),
                new SlmEvent(true, 70, 0), new SlmEvent(false, 100, 0),
            ],
            4,
            4);

        var zones = SlmZoneProjector.Project(TestMaps.LinearDocument(300), recording);

        CollectionAssert.AreEqual(
            new[] { new MapZone(new MapPoint(10, 0), new MapPoint(100, 0)) },
            zones.ToArray());
    }

    [TestMethod]
    public void DoesNotMergeGapAcrossSharpCorner()
    {
        var map = CornerDocument();
        var recording = new SlmRecording(
            TestMaps.Header(),
            [
                new SlmEvent(true, 10, 0), new SlmEvent(false, 50, 0),
                new SlmEvent(true, 60, 10), new SlmEvent(false, 60, 40),
            ],
            4,
            4);

        var zones = SlmZoneProjector.Project(map, recording);

        Assert.HasCount(2, zones);
        Assert.AreEqual(new MapZone(new MapPoint(10, 0), new MapPoint(50, 0)), zones[0]);
        Assert.AreEqual(new MapZone(new MapPoint(60, 10), new MapPoint(60, 40)), zones[1]);
    }

    [TestMethod]
    public void PreservesZoneThatWrapsAcrossStartFinish()
    {
        var recording = new SlmRecording(
            TestMaps.Header(),
            [new SlmEvent(true, 180, 0), new SlmEvent(false, 20, 0)],
            2,
            2);

        var zones = SlmZoneProjector.Project(TestMaps.LinearDocument(), recording);

        CollectionAssert.AreEqual(
            new[] { new MapZone(new MapPoint(180, 0), new MapPoint(20, 0)) },
            zones.ToArray());
    }

    private static TrackMapDocument CornerDocument()
    {
        var root = JsonNode.Parse(TestMaps.LinearJson())!.AsObject();
        var points = new JsonArray();
        for (var x = 0; x <= 60; x++)
        {
            points.Add(new JsonArray(x, 0));
        }
        for (var z = 1; z <= 60; z++)
        {
            points.Add(new JsonArray(60, z));
        }
        root["sectors"]![0]!["points"] = points;
        return TrackMapDocument.Parse(root.ToJsonString());
    }
}
