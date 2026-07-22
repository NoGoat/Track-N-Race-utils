using CommunityToolkit.Mvvm.ComponentModel;

namespace TelemetryMapper.WinUI3.ViewModels;

public sealed partial class LayerItemViewModel(string name, bool isVisible = true) : ObservableObject
{
    public string Name { get; } = name;

    [ObservableProperty]
    public partial bool IsVisible { get; set; } = isVisible;

    public event EventHandler? VisibilityChanged;

    partial void OnIsVisibleChanged(bool value) => VisibilityChanged?.Invoke(this, EventArgs.Empty);
}
