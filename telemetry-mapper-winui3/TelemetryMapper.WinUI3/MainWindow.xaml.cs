using Microsoft.UI.Windowing;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Media.Imaging;
using Microsoft.UI.Xaml.Navigation;
using Windows.Graphics;

namespace TelemetryMapper.WinUI3;

public sealed partial class MainWindow : Window
{
    private bool _allowClose;
    private bool _closePromptActive;

    public MainWindow()
    {
        InitializeComponent();
        RootLayout.RequestedTheme = ((App)Application.Current).SelectedTheme;

        ExtendsContentIntoTitleBar = true;
        AppWindow.TitleBar.PreferredHeightOption = TitleBarHeightOption.Tall;
        SetTitleBar(AppTitleBar);
        AppWindow.SetIcon(Path.Combine(AppContext.BaseDirectory, "Assets", "AppIcon.ico"));
        if (AppWindow.Presenter is OverlappedPresenter presenter)
        {
            presenter.PreferredMinimumWidth = 970;
            presenter.PreferredMinimumHeight = 700;
        }
        AppWindow.Resize(new SizeInt32(1440, 920));
        AppWindow.Closing += OnAppWindowClosing;

        RootFrame.Navigated += OnNavigated;
        RootLayout.Loaded += OnRootLayoutLoaded;
        RootLayout.ActualThemeChanged += OnActualThemeChanged;

        AppNavigationView.SelectedItem = MapEditorNavigationItem;
        NavigateToMapEditor();
    }

    public MainPage? EditorPage { get; private set; }

    public void SetEditorTitle(
        string? fileName,
        bool dirty)
    {
        var name = string.IsNullOrWhiteSpace(fileName) ? "untitled" : fileName;
        var star = dirty ? " *" : string.Empty;
        var title = $"Track N Race Map Editor — {name}{star}";
        Title = title;
        AppTitleBar.Title = title;
        AppTitleBar.Subtitle = string.Empty;
    }

    private void OnNavigated(object sender, NavigationEventArgs eventArgs)
    {
        if (eventArgs.Content is MainPage editorPage)
        {
            EditorPage = editorPage;
        }
    }

    private void OnNavigationSelectionChanged(
        NavigationView sender,
        NavigationViewSelectionChangedEventArgs args)
    {
        if (args.IsSettingsSelected)
        {
            NavigateToSettings();
        }
        else if (args.SelectedItemContainer?.Tag as string == "map-editor")
        {
            NavigateToMapEditor();
        }
        else if (args.SelectedItemContainer?.Tag as string == "live-mapper")
        {
            NavigateToLiveMapper();
        }
    }

    private void NavigateToMapEditor()
    {
        if (RootFrame.CurrentSourcePageType != typeof(MainPage))
        {
            RootFrame.Navigate(typeof(MainPage));
        }
    }

    private void NavigateToLiveMapper()
    {
        if (RootFrame.CurrentSourcePageType != typeof(RecorderPage))
        {
            RootFrame.Navigate(typeof(RecorderPage));
        }
    }

    private void NavigateToSettings()
    {
        if (RootFrame.CurrentSourcePageType != typeof(SettingsPage))
        {
            RootFrame.Navigate(typeof(SettingsPage));
        }
    }

    public void ApplyTheme(ElementTheme theme)
    {
        RootLayout.RequestedTheme = theme;
        UpdateTitleBarIcon();
    }

    private void OnRootLayoutLoaded(object sender, RoutedEventArgs args)
    {
        UpdateTitleBarIcon();
    }

    private void OnActualThemeChanged(FrameworkElement sender, object args)
    {
        UpdateTitleBarIcon();
    }

    private void UpdateTitleBarIcon()
    {
        var iconName = RootLayout.ActualTheme == ElementTheme.Light
            ? "icon_transparent_light.png"
            : "icon_transparent.png";

        TitleBarIconSource.ImageSource = new BitmapImage(
            new Uri($"ms-appx:///Assets/{iconName}"));
    }

    private void OnAppWindowClosing(AppWindow sender, AppWindowClosingEventArgs args)
    {
        if (_allowClose || EditorPage?.HasUnsavedChanges != true)
        {
            return;
        }
        args.Cancel = true;
        if (!_closePromptActive)
        {
            _ = ConfirmCloseAsync();
        }
    }

    private async Task ConfirmCloseAsync()
    {
        _closePromptActive = true;
        try
        {
            if (EditorPage is null || await EditorPage.ConfirmDiscardChangesAsync())
            {
                _allowClose = true;
                Close();
            }
        }
        finally
        {
            _closePromptActive = false;
        }
    }
}
