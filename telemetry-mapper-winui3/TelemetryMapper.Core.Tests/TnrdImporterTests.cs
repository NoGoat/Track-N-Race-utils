using System.IO.Compression;
using System.Text;
using System.Text.Json.Nodes;
using ZstdSharp;

namespace TelemetryMapper.Core.Tests;

[TestClass]
public sealed class TnrdImporterTests
{
    [TestMethod]
    public async Task ReadsPlayerPositionAtSlmTransitions()
    {
        var path = await WriteGzipAsync(
            TestMaps.Header(),
            TestMaps.Position(10, 20),
            TestMaps.Telemetry(1, 0),
            TestMaps.Position(30, 40),
            TestMaps.Telemetry(2, 1),
            TestMaps.Position(50, 60),
            TestMaps.Telemetry(3, 0));
        try
        {
            var recording = await TnrdImporter.ReadAsync(path);

            Assert.AreEqual(7, TrackMapDocument.ReadInt(recording.Header["track_id"]));
            Assert.AreEqual(3, recording.TelemetrySamples);
            Assert.AreEqual(3, recording.PositionSamples);
            CollectionAssert.AreEqual(
                new[]
                {
                    new SlmEvent(true, 30, 40),
                    new SlmEvent(false, 50, 60),
                },
                recording.Events.ToArray());
        }
        finally
        {
            File.Delete(path);
        }
    }

    [TestMethod]
    public async Task DefersTransitionUntilFirstPosition()
    {
        var path = await WriteGzipAsync(
            TestMaps.Header(),
            TestMaps.Telemetry(1, 1),
            TestMaps.Position(10, 20),
            TestMaps.Telemetry(2, 0));
        try
        {
            var recording = await TnrdImporter.ReadAsync(path);
            CollectionAssert.AreEqual(
                new[]
                {
                    new SlmEvent(true, 10, 20),
                    new SlmEvent(false, 10, 20),
                },
                recording.Events.ToArray());
        }
        finally
        {
            File.Delete(path);
        }
    }

    [TestMethod]
    public async Task ReadsZstandardV2()
    {
        var path = await WriteZstdAsync(
            TestMaps.Header("TNRD_V2", "zstd"),
            TestMaps.Position(10, 20),
            TestMaps.Telemetry(1, 1),
            TestMaps.Telemetry(2, 0));
        try
        {
            var recording = await TnrdImporter.ReadAsync(path);
            Assert.HasCount(2, recording.Events);
        }
        finally
        {
            File.Delete(path);
        }
    }

    [TestMethod]
    public async Task RejectsHeaderContainerMismatch()
    {
        var path = await WriteGzipAsync(TestMaps.Header("TNRD_V2", "zstd"));
        try
        {
            var exception = await Assert.ThrowsAsync<TnrdImportException>(
                () => TnrdImporter.ReadAsync(path));
            StringAssert.Contains(exception.Message, "header/container mismatch");
        }
        finally
        {
            File.Delete(path);
        }
    }

    [TestMethod]
    public async Task TracksMissingPositionDataWithoutInventingEvents()
    {
        var path = await WriteGzipAsync(
            TestMaps.Header(),
            TestMaps.Telemetry(1, 1),
            TestMaps.Telemetry(2, 0));
        try
        {
            var recording = await TnrdImporter.ReadAsync(path);
            Assert.AreEqual(2, recording.TelemetrySamples);
            Assert.AreEqual(0, recording.PositionSamples);
            Assert.IsEmpty(recording.Events);
        }
        finally
        {
            File.Delete(path);
        }
    }

    private static async Task<string> WriteGzipAsync(params JsonObject[] rows)
    {
        var path = Path.Combine(Path.GetTempPath(), $"tnr_{Guid.NewGuid():N}.tnrd");
        await using var file = File.Create(path);
        await using var gzip = new GZipStream(file, CompressionLevel.SmallestSize);
        await WriteRowsAsync(gzip, rows);
        return path;
    }

    private static async Task<string> WriteZstdAsync(params JsonObject[] rows)
    {
        var path = Path.Combine(Path.GetTempPath(), $"tnr_{Guid.NewGuid():N}.tnrd");
        var text = string.Join("\n", rows.Select(row => row.ToJsonString())) + "\n";
        using var compressor = new Compressor();
        await File.WriteAllBytesAsync(path, compressor.Wrap(Encoding.UTF8.GetBytes(text)).ToArray());
        return path;
    }

    private static async Task WriteRowsAsync(Stream stream, IEnumerable<JsonObject> rows)
    {
        await using var writer = new StreamWriter(stream, Encoding.UTF8, leaveOpen: true);
        foreach (var row in rows)
        {
            await writer.WriteLineAsync(row.ToJsonString());
        }
    }
}
