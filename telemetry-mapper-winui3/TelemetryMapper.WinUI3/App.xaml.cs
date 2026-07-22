using Windows.ApplicationModel;
using Windows.ApplicationModel.Activation;
using Windows.Foundation;
using Windows.Foundation.Collections;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Data;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Navigation;
using Microsoft.UI.Xaml.Shapes;
using Windows.Storage;

// To learn more about WinUI, the WinUI project structure,
// and more about our project templates, see: http://aka.ms/winui-project-info.

namespace TelemetryMapper.WinUI3;

/// <summary>
/// Provides application-specific behavior to supplement the default Application class.
/// </summary>
public partial class App : Application
{
    private const string ThemeSettingKey = "AppTheme";

    public MainWindow MainWindow { get; private set; } = null!;
    public MapColorPalette MapColors { get; }
    public ElementTheme SelectedTheme { get; private set; }

    /// <summary>
    /// Initializes the singleton application object.  This is the first line of authored code
    /// executed, and as such is the logical equivalent of main() or WinMain().
    /// </summary>
    public App()
    {
        InitializeComponent();
        MapColors = new MapColorPalette();
        SelectedTheme = ReadSavedTheme();
    }

    public void SetTheme(ElementTheme theme)
    {
        if (theme is not (ElementTheme.Default or ElementTheme.Light or ElementTheme.Dark))
        {
            return;
        }

        SelectedTheme = theme;
        ApplicationData.Current.LocalSettings.Values[ThemeSettingKey] = theme.ToString();
        MainWindow?.ApplyTheme(theme);
    }

    private static ElementTheme ReadSavedTheme()
    {
        var value = ApplicationData.Current.LocalSettings.Values[ThemeSettingKey] as string;
        return Enum.TryParse<ElementTheme>(value, out var theme) &&
            theme is ElementTheme.Default or ElementTheme.Light or ElementTheme.Dark
                ? theme
                : ElementTheme.Default;
    }

    /// <summary>
    /// Invoked when the application is launched.
    /// </summary>
    /// <param name="args">Details about the launch request and process.</param>
    protected override void OnLaunched(Microsoft.UI.Xaml.LaunchActivatedEventArgs args)
    {
        MainWindow = new MainWindow();
        MainWindow.Activate();
    }
}
