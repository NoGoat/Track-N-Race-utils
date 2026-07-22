using System.Text.Json.Nodes;

namespace TelemetryMapper.Core.Tests;

[TestClass]
public sealed class TrackMapDocumentTests
{
    [TestMethod]
    public void DiscoversKnownAndCustomKinds()
    {
        var root = JsonNode.Parse(TestMaps.LinearJson())!.AsObject();
        root["custom_points"] = new JsonArray
        {
            new JsonArray(1, 2),
            new JsonArray(3, 4),
        };
        root["custom_zones"] = new JsonArray
        {
            new JsonObject
            {
                ["start"] = new JsonArray(1, 2),
                ["end"] = new JsonArray(3, 4),
            },
        };

        var document = TrackMapDocument.Parse(root.ToJsonString());

        Assert.AreEqual(MarkerKind.PointScalar, document.MarkerKinds["start_finish"]);
        Assert.AreEqual(MarkerKind.PointList, document.MarkerKinds["custom_points"]);
        Assert.AreEqual(MarkerKind.ZoneList, document.MarkerKinds["custom_zones"]);
    }

    [TestMethod]
    public async Task RoundTripPreservesUnknownMetadata()
    {
        var document = TestMaps.LinearDocument();
        document.SetOrAddPoint("speed_traps", new MapPoint(15.126, 8.994));
        var path = Path.Combine(Path.GetTempPath(), $"map_{Guid.NewGuid():N}.json");
        try
        {
            await document.SaveAsAsync(path);
            var reloaded = await TrackMapDocument.LoadAsync(path);

            Assert.IsTrue(reloaded.Root["unknown_metadata"]?["preserve"]?.GetValue<bool>());
            Assert.AreEqual(new MapPoint(15.13, 8.99), reloaded.GetRows("speed_traps")[0].Point);
            Assert.IsFalse(document.IsDirty);
        }
        finally
        {
            File.Delete(path);
        }
    }

    [TestMethod]
    public void SupportsAllMarkerMutations()
    {
        var document = TestMaps.LinearDocument();
        Assert.IsTrue(document.TryCreateCollection("custom", MarkerKind.PointList, out _));
        document.SetOrAddPoint("custom", new MapPoint(1, 2));
        document.UpdatePoint("custom", 0, new MapPoint(3, 4));
        Assert.AreEqual(new MapPoint(3, 4), document.GetRows("custom")[0].Point);
        document.DeleteRow("custom", 0);
        Assert.IsEmpty(document.GetRows("custom"));

        document.AddZone("slm_dry", new MapPoint(10, 0), new MapPoint(20, 0));
        document.UpdateZoneEndpoint("slm_dry", 0, false, new MapPoint(25, 0));
        Assert.AreEqual(new MapPoint(25, 0), document.GetRows("slm_dry")[0].Zone?.End);
    }

    [TestMethod]
    public void SupportsEditableMapAttributes()
    {
        var document = TestMaps.LinearDocument();

        document.SetTextAttribute("track_name", "Hungarian Grand Prix");
        document.SetTextAttribute("circuit_name", "Hungaroring");
        document.SetNumberAttribute("track_length_m", 4378);
        document.SetNumberAttribute("pit_time", 22.5);
        document.SetNumberAttribute("inlap_pit_time", 9);
        document.SetNumberAttribute("outlap_pit_time", 11);

        Assert.AreEqual("Hungarian Grand Prix", document.TrackName);
        Assert.AreEqual("Hungaroring", document.CircuitName);
        Assert.AreEqual(4378, document.TrackLengthMeters);
        Assert.AreEqual(22.5, document.PitTime);
        Assert.AreEqual(9, document.InlapPitTime);
        Assert.AreEqual(11, document.OutlapPitTime);
        Assert.IsTrue(document.IsDirty);
    }

    [TestMethod]
    public void LoadsEveryRepositoryMap()
    {
        var root = FindRepositoryRoot();
        var paths = Directory.GetFiles(Path.Combine(root, "telemetry-mapper", "final_json"), "*.json");
        Assert.IsGreaterThan(20, paths.Length);
        foreach (var path in paths)
        {
            var document = TrackMapDocument.Parse(File.ReadAllText(path), path);
            Assert.IsNotEmpty(document.Centerline, Path.GetFileName(path));
            Assert.IsLessThan(10_000, document.Centerline.Count, Path.GetFileName(path));
        }
    }

    private static string FindRepositoryRoot()
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory);
             directory is not null;
             directory = directory.Parent)
        {
            if (Directory.Exists(Path.Combine(directory.FullName, "telemetry-mapper", "final_json")))
            {
                return directory.FullName;
            }
        }
        throw new DirectoryNotFoundException("Could not locate telemetry-mapper/final_json.");
    }
}
