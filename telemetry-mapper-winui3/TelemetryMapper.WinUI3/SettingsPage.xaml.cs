using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;

namespace TelemetryMapper.WinUI3;

public sealed partial class SettingsPage : Page
{
    private bool _isInitialized;

    public MapColorPalette MapColors => ((App)Application.Current).MapColors;

    public SettingsPage()
    {
        InitializeComponent();
        ThemeComboBox.SelectedIndex = ((App)Application.Current).SelectedTheme switch
        {
            ElementTheme.Light => 0,
            ElementTheme.Dark => 1,
            _ => 2,
        };
        _isInitialized = true;
    }

    private void OnThemeSelectionChanged(object sender, SelectionChangedEventArgs eventArgs)
    {
        if (!_isInitialized || ThemeComboBox.SelectedItem is not ComboBoxItem selectedItem)
        {
            return;
        }

        var theme = (selectedItem.Tag as string) switch
        {
            "Light" => ElementTheme.Light,
            "Dark" => ElementTheme.Dark,
            _ => ElementTheme.Default,
        };
        ((App)Application.Current).SetTheme(theme);
    }

    private void OnResetColorClicked(object sender, RoutedEventArgs eventArgs)
    {
        if (sender is Button { Tag: string key })
        {
            MapColors.ResetColor(key);
        }
    }
}
