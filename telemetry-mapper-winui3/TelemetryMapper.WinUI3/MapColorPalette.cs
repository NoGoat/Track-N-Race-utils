using System.ComponentModel;
using System.Text.Json;
using Microsoft.UI.Xaml.Media;
using Windows.Storage;
using Windows.UI;

namespace TelemetryMapper.WinUI3;

public sealed class MapColorDefinition : INotifyPropertyChanged
{
    private Color _color;

    public MapColorDefinition(string key, string label, string defaultHex)
    {
        Key = key;
        Label = label;
        DefaultColor = ParseHex(defaultHex);
        _color = DefaultColor;
    }

    public string Key { get; }

    public string Label { get; }

    public Color DefaultColor { get; }

    public Color Color
    {
        get => _color;
        set
        {
            var normalized = Opaque(value);
            if (_color.Equals(normalized))
            {
                return;
            }

            _color = normalized;
            OnPropertyChanged(nameof(Color));
            OnPropertyChanged(nameof(Hex));
            OnPropertyChanged(nameof(SwatchBrush));
        }
    }

    public string Hex => ToHex(Color);

    public string ColorPickerAutomationName => $"Choose {Label} color";

    public string ResetAutomationName => $"Reset {Label} color";

    public SolidColorBrush SwatchBrush => new(Color);

    public event PropertyChangedEventHandler? PropertyChanged;

    internal static Color ParseHex(string value)
    {
        var hex = value.Trim().TrimStart('#');
        if (hex.Length == 6 && uint.TryParse(hex, System.Globalization.NumberStyles.HexNumber, null, out var rgb))
        {
            return Color.FromArgb(255, (byte)(rgb >> 16), (byte)(rgb >> 8), (byte)rgb);
        }

        return Color.FromArgb(255, 0, 0, 0);
    }

    internal static string ToHex(Color color) =>
        $"#{color.R:X2}{color.G:X2}{color.B:X2}";

    private static Color Opaque(Color color) =>
        Color.FromArgb(255, color.R, color.G, color.B);

    private void OnPropertyChanged(string propertyName) =>
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(propertyName));
}

public sealed class MapColorPalette
{
    private const string SettingKey = "MapColors";

    private readonly IReadOnlyList<MapColorDefinition> _definitions;
    private readonly Dictionary<string, MapColorDefinition> _byKey;
    private bool _isLoading;

    public MapColorPalette()
    {
        Sectors =
        [
            new("sector_1", "Sector 1", "#5794F2"),
            new("sector_2", "Sector 2", "#73BF69"),
            new("sector_3", "Sector 3", "#FADE2A"),
        ];

        Zones =
        [
            new("drs_activation", "DRS activation", "#73BF69"),
            new("drs_deactivation", "DRS deactivation", "#F2495C"),
            new("slm_dry", "Straight Line Mode — dry", "#FFB86C"),
            new("slm_wet", "Straight Line Mode — wet", "#BD93F9"),
            new("custom_zone", "Custom zones", "#5794F2"),
        ];

        Points =
        [
            new("start_finish", "Start / finish", "#E10600"),
            new("speed_traps", "Speed traps", "#FADE2A"),
            new("overtake_detection_point", "Overtake detection", "#5794F2"),
            new("overtake_activation_point", "Overtake activation", "#FF9830"),
            new("drs_detection_points", "DRS detection", "#73BF69"),
            new("custom_point", "Custom points", "#96D98D"),
        ];

        _definitions = Sectors.Concat(Zones).Concat(Points).ToArray();
        _byKey = _definitions.ToDictionary(definition => definition.Key);
        foreach (var definition in _definitions)
        {
            definition.PropertyChanged += OnDefinitionPropertyChanged;
        }

        Load();
    }

    public IReadOnlyList<MapColorDefinition> Sectors { get; }

    public IReadOnlyList<MapColorDefinition> Zones { get; }

    public IReadOnlyList<MapColorDefinition> Points { get; }

    public event EventHandler? Changed;

    public Color GetSectorColor(int index) =>
        Sectors[index % Sectors.Count].Color;

    public Color GetPointColor(string key) => key switch
    {
        "start_finish" => GetColor("start_finish"),
        "speed_traps" => GetColor("speed_traps"),
        "overtake_detection_point" => GetColor("overtake_detection_point"),
        "overtake_activation_point" => GetColor("overtake_activation_point"),
        "drs_detection_points" => GetColor("drs_detection_points"),
        _ => GetColor("custom_point"),
    };

    public (Color Start, Color End) GetZoneColors(string key) => key switch
    {
        "drs_zones" => (GetColor("drs_activation"), GetColor("drs_deactivation")),
        "slm_dry" => (GetColor("slm_dry"), GetColor("slm_dry")),
        "slm_wet" => (GetColor("slm_wet"), GetColor("slm_wet")),
        _ => (GetColor("custom_zone"), GetColor("custom_zone")),
    };

    public Color GetColor(string key) =>
        _byKey.TryGetValue(key, out var definition)
            ? definition.Color
            : Color.FromArgb(255, 0, 0, 0);

    public bool SetColor(string key, Color color)
    {
        if (!_byKey.TryGetValue(key, out var definition))
        {
            return false;
        }

        definition.Color = color;
        return true;
    }

    public bool ResetColor(string key)
    {
        if (!_byKey.TryGetValue(key, out var definition))
        {
            return false;
        }

        definition.Color = definition.DefaultColor;
        return true;
    }

    private void Load()
    {
        if (ApplicationData.Current.LocalSettings.Values[SettingKey] is not string serialized)
        {
            return;
        }

        try
        {
            var saved = JsonSerializer.Deserialize<Dictionary<string, string>>(serialized);
            if (saved is null)
            {
                return;
            }

            _isLoading = true;
            foreach (var definition in _definitions)
            {
                if (saved.TryGetValue(definition.Key, out var value) &&
                    value is not null && IsValidHex(value))
                {
                    definition.Color = MapColorDefinition.ParseHex(value);
                }
            }
        }
        catch (JsonException)
        {
            // Invalid settings are ignored and the built-in defaults remain active.
        }
        finally
        {
            _isLoading = false;
        }
    }

    private void Save()
    {
        var values = _definitions.ToDictionary(
            definition => definition.Key,
            definition => definition.Hex,
            StringComparer.Ordinal);
        ApplicationData.Current.LocalSettings.Values[SettingKey] =
            JsonSerializer.Serialize(values);
    }

    private void OnDefinitionPropertyChanged(object? sender, PropertyChangedEventArgs args)
    {
        if (_isLoading || args.PropertyName != nameof(MapColorDefinition.Color))
        {
            return;
        }

        Save();
        Changed?.Invoke(this, EventArgs.Empty);
    }

    private static bool IsValidHex(string value)
    {
        var hex = value.Trim().TrimStart('#');
        return hex.Length == 6 &&
               uint.TryParse(hex, System.Globalization.NumberStyles.HexNumber, null, out _);
    }
}
