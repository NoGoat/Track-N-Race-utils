using System.IO.Compression;
using System.Text.Json.Nodes;
using ZstdSharp;

namespace TelemetryMapper.Core;

public sealed class TnrdImportException(string message, Exception? inner = null)
    : Exception(message, inner);

public sealed record SlmEvent(bool IsActivation, double X, double Z);

public sealed record SlmRecording(
    JsonObject Header,
    IReadOnlyList<SlmEvent> Events,
    int TelemetrySamples,
    int PositionSamples);

public static class TnrdImporter
{
    private static readonly byte[] GzipMagic = [0x1f, 0x8b];
    private static readonly byte[] ZstdMagic = [0x28, 0xb5, 0x2f, 0xfd];

    public static async Task<SlmRecording> ReadAsync(
        string path,
        CancellationToken cancellationToken = default)
    {
        try
        {
            await using var source = new FileStream(
                path,
                FileMode.Open,
                FileAccess.Read,
                FileShare.Read,
                128 * 1024,
                FileOptions.Asynchronous | FileOptions.SequentialScan);

            var signature = new byte[4];
            var signatureBytes = await source.ReadAsync(signature, cancellationToken)
                .ConfigureAwait(false);
            source.Position = 0;

            string codec;
            Stream decompressed;
            if (signatureBytes >= 2 && signature.AsSpan(0, 2).SequenceEqual(GzipMagic))
            {
                codec = "gzip";
                decompressed = new GZipStream(source, CompressionMode.Decompress, leaveOpen: true);
            }
            else if (signatureBytes == 4 && signature.AsSpan().SequenceEqual(ZstdMagic))
            {
                codec = "zstd";
                decompressed = new DecompressionStream(source, leaveOpen: true);
            }
            else
            {
                throw new TnrdImportException("Unknown TNRD compression signature.");
            }

            await using (decompressed)
            using (var reader = new StreamReader(decompressed))
            {
                var headerLine = await reader.ReadLineAsync(cancellationToken).ConfigureAwait(false);
                if (string.IsNullOrWhiteSpace(headerLine))
                {
                    throw new TnrdImportException("The TNRD file is empty.");
                }
                var header = ParseObject(headerLine, 1);
                ValidateHeader(header, codec);

                MapPoint? latestPosition = null;
                bool? pendingActivation = null;
                var lastSlm = false;
                var events = new List<SlmEvent>();
                var telemetrySamples = 0;
                var positionSamples = 0;
                var lineNumber = 1;

                while (await reader.ReadLineAsync(cancellationToken).ConfigureAwait(false) is { } line)
                {
                    lineNumber++;
                    if (string.IsNullOrWhiteSpace(line))
                    {
                        continue;
                    }
                    var row = ParseObject(line, lineNumber);
                    var rowType = ReadString(row["type"]);
                    if (rowType == "positions")
                    {
                        var position = ReadPlayerPosition(row);
                        if (position is null)
                        {
                            continue;
                        }
                        latestPosition = position;
                        positionSamples++;
                        if (pendingActivation is not null)
                        {
                            events.Add(new SlmEvent(
                                pendingActivation.Value,
                                position.Value.X,
                                position.Value.Y));
                            pendingActivation = null;
                        }
                        continue;
                    }

                    if (rowType != "telemetry" || row["slm"] is null)
                    {
                        continue;
                    }
                    telemetrySamples++;
                    var slm = ReadSlm(row["slm"], lineNumber);
                    if (slm == lastSlm)
                    {
                        continue;
                    }
                    if (latestPosition is null)
                    {
                        pendingActivation = slm;
                    }
                    else
                    {
                        events.Add(new SlmEvent(slm, latestPosition.Value.X, latestPosition.Value.Y));
                    }
                    lastSlm = slm;
                }

                return new SlmRecording(header, events, telemetrySamples, positionSamples);
            }
        }
        catch (TnrdImportException)
        {
            throw;
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (InvalidDataException exception)
        {
            throw new TnrdImportException($"Cannot decompress the TNRD file: {exception.Message}", exception);
        }
        catch (IOException exception)
        {
            throw new TnrdImportException($"Cannot read the recording: {exception.Message}", exception);
        }
    }

    private static JsonObject ParseObject(string line, int lineNumber)
    {
        try
        {
            return JsonNode.Parse(line) as JsonObject
                ?? throw new TnrdImportException(
                    $"Invalid TNRD row at decompressed line {lineNumber}: expected an object.");
        }
        catch (System.Text.Json.JsonException exception)
        {
            throw new TnrdImportException(
                $"Invalid JSON in the TNRD file at decompressed line {lineNumber}: {exception.Message}",
                exception);
        }
    }

    private static void ValidateHeader(JsonObject header, string codec)
    {
        var expectedMagic = codec == "zstd" ? "TNRD_V2" : "TNRD_V1";
        var magic = ReadString(header["magic"]);
        if (magic != expectedMagic)
        {
            throw new TnrdImportException(
                $"TNRD header/container mismatch: expected {expectedMagic}, found {magic ?? "no magic value"}.");
        }
        var compression = ReadString(header["compression"]);
        if (codec == "zstd" && compression != "zstd")
        {
            throw new TnrdImportException("The TNRD V2 header does not declare Zstandard compression.");
        }
        if (codec == "gzip" && compression is not null and not "gzip")
        {
            throw new TnrdImportException("The TNRD V1 header does not match gzip compression.");
        }
    }

    private static MapPoint? ReadPlayerPosition(JsonObject row)
    {
        var playerIndex = TrackMapDocument.ReadInt(row["player_idx"]);
        if (playerIndex is null || row["cars"] is not JsonArray cars)
        {
            return null;
        }
        for (var arrayIndex = 0; arrayIndex < cars.Count; arrayIndex++)
        {
            if (cars[arrayIndex] is not JsonObject car)
            {
                continue;
            }
            if ((TrackMapDocument.ReadInt(car["idx"]) ?? arrayIndex) != playerIndex)
            {
                continue;
            }
            var x = TrackMapDocument.ReadNumber(car["x"]);
            var z = TrackMapDocument.ReadNumber(car["z"]);
            return x is null || z is null ? null : new MapPoint(x.Value, z.Value);
        }
        return null;
    }

    private static bool ReadSlm(JsonNode? node, int lineNumber)
    {
        if (node is JsonValue value)
        {
            if (value.TryGetValue<bool>(out var boolean))
            {
                return boolean;
            }
            var number = TrackMapDocument.ReadNumber(value);
            if (number is not null)
            {
                return number != 0;
            }
        }
        throw new TnrdImportException(
            $"Invalid Straight Line Mode value at decompressed line {lineNumber}.");
    }

    private static string? ReadString(JsonNode? node) =>
        node is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;
}
