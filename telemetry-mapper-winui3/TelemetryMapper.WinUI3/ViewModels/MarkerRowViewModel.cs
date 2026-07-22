using TelemetryMapper.Core;

namespace TelemetryMapper.WinUI3.ViewModels;

public sealed class MarkerRowViewModel
{
    public MarkerRowViewModel(MarkerRow row)
    {
        Row = row;
    }

    public MarkerRow Row { get; }
    public int Index => Row.Index;
    public string First => Format(Row.Point?.X ?? Row.Zone?.Start.X);
    public string Second => Format(Row.Point?.Y ?? Row.Zone?.Start.Y);
    public string Third => Format(Row.Zone?.End.X);
    public string Fourth => Format(Row.Zone?.End.Y);

    private static string Format(double? value) => value is null ? string.Empty : $"{value.Value:g}";
}
