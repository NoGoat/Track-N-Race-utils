using Microsoft.UI.Dispatching;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Controls.Primitives;
using Microsoft.UI.Xaml.Input;
using Microsoft.Windows.Storage.Pickers;
using TelemetryMapper.Core;
using TelemetryMapper.WinUI3.ViewModels;

namespace TelemetryMapper.WinUI3;

public sealed partial class MainPage : Page
{
    private readonly Microsoft.UI.Dispatching.DispatcherQueueTimer _playTimer;
    private readonly ScrollViewer[] _inspectorPanels;
    private int _selectedInspectorPanelIndex = -1;
    private int _infoGeneration;

    public MainPage()
    {
        InitializeComponent();
        _inspectorPanels =
        [
            CollectionPanel,
            AttributesPanel,
            LayersPanel,
            OverlayPanel,
        ];
        SelectInspectorPanel(0);

        MapCanvas.Attach(ViewModel);
        ViewModel.DocumentChanged += (_, _) => UpdateWindowTitle();

        _playTimer = DispatcherQueue.CreateTimer();
        _playTimer.Interval = TimeSpan.FromMilliseconds(30);
        _playTimer.Tick += (_, _) => AdvancePlayback();
    }

    public EditorViewModel ViewModel { get; } = new();

    public bool HasUnsavedChanges => ViewModel.IsDirty;

    private void OnInspectorSelectorSelectionChanged(SelectorBar sender, SelectorBarSelectionChangedEventArgs eventArgs)
    {
        // IsSelected can be applied while InitializeComponent is still building
        // the page, before the panel lookup table has been initialized.
        if (_inspectorPanels is null)
        {
            return;
        }

        var selectedIndex = sender.Items.IndexOf(sender.SelectedItem);
        if ((uint)selectedIndex >= (uint)_inspectorPanels.Length)
        {
            return;
        }

        SelectInspectorPanel(selectedIndex);
    }

    private void SelectInspectorPanel(int selectedIndex)
    {
        if (selectedIndex == _selectedInspectorPanelIndex)
        {
            return;
        }

        foreach (var panel in _inspectorPanels)
        {
            panel.Visibility = Visibility.Collapsed;
            if (InspectorContentHost.Children.Contains(panel))
            {
                InspectorContentHost.Children.Remove(panel);
            }
        }

        var selectedPanel = _inspectorPanels[selectedIndex];
        selectedPanel.Visibility = Visibility.Visible;
        InspectorContentHost.Children.Add(selectedPanel);
        _selectedInspectorPanelIndex = selectedIndex;
    }

    private async void OnOpenClicked(object sender, RoutedEventArgs args)
    {
        await OpenAsync();
    }

    private async void OnImportClicked(object sender, RoutedEventArgs args)
    {
        await ImportAsync();
    }

    private async void OnSaveClicked(object sender, RoutedEventArgs args)
    {
        await SaveAsync();
    }

    public async Task<bool> ConfirmDiscardChangesAsync()
    {
        if (!HasUnsavedChanges)
        {
            return true;
        }
        return await ConfirmAsync(
            "Unsaved changes",
            "You have unsaved changes. Discard them?",
            "Discard",
            "Cancel");
    }

    public async Task OpenAsync()
    {
        if (!await ConfirmDiscardChangesAsync())
        {
            return;
        }

        var picker = new FileOpenPicker(AppWindow.Id)
        {
            Title = "Open track map",
            CommitButtonText = "Open",
            SettingsIdentifier = "TrackMapJson",
        };
        picker.FileTypeFilter.Add(".json");
        var result = await picker.PickSingleFileAsync();
        if (result is null)
        {
            return;
        }

        try
        {
            var document = await TrackMapDocument.LoadAsync(result.Path);
            ViewModel.Load(document);
            ShowInfo("Map loaded", document.FileName, InfoBarSeverity.Success);
        }
        catch (Exception exception)
        {
            await ShowMessageAsync("Could not open map", exception.Message);
        }
    }

    public async Task SaveAsync()
    {
        if (ViewModel.Document is not { } document)
        {
            return;
        }

        var picker = new FileSavePicker(AppWindow.Id)
        {
            Title = "Save track map",
            CommitButtonText = "Save",
            SettingsIdentifier = "TrackMapJson",
            SuggestedFileName = document.FileName,
            DefaultFileExtension = ".json",
            ShowOverwritePrompt = true,
        };
        picker.FileTypeChoices.Add("JSON map", [".json"]);
        var result = await picker.PickSaveFileAsync();
        if (result is null)
        {
            return;
        }

        try
        {
            await document.SaveAsAsync(result.Path);
            ShowInfo("Map saved", document.FileName, InfoBarSeverity.Success);
        }
        catch (Exception exception)
        {
            await ShowMessageAsync("Could not save map", exception.Message);
        }
    }

    public async Task ImportAsync()
    {
        if (ViewModel.Document is not { } map)
        {
            return;
        }

        var picker = new FileOpenPicker(AppWindow.Id)
        {
            Title = "Import Track N Race recording",
            CommitButtonText = "Import",
            SettingsIdentifier = "TrackNRaceRecording",
        };
        picker.FileTypeFilter.Add(".tnrd");
        picker.FileTypeFilter.Add(".trnd");
        var result = await picker.PickSingleFileAsync();
        if (result is null)
        {
            return;
        }

        SlmRecording recording;
        ViewModel.IsBusy = true;
        try
        {
            recording = await TnrdImporter.ReadAsync(result.Path);
        }
        catch (Exception exception)
        {
            await ShowMessageAsync("TNRD import failed", exception.Message);
            return;
        }
        finally
        {
            ViewModel.IsBusy = false;
        }

        if (recording.TelemetrySamples == 0)
        {
            await ShowMessageAsync(
                "No Straight Line Mode data",
                "This recording has no telemetry rows containing Straight Line Mode data.");
            return;
        }
        if (recording.PositionSamples == 0)
        {
            await ShowMessageAsync(
                "No position data",
                "This recording has no player position rows, so its SLM points cannot be mapped.");
            return;
        }

        var recordedTrack = TrackMapDocument.ReadInt(recording.Header["track_id"]);
        if (recordedTrack is not null && map.TrackId is not null && recordedTrack != map.TrackId &&
            !await ConfirmAsync(
                "Track mismatch",
                $"The recording is for track {recordedTrack}, but the open map is track {map.TrackId}. Import it anyway?",
                "Import anyway",
                "Cancel"))
        {
            return;
        }

        var weather = await ChooseWeatherAsync();
        if (weather is null)
        {
            return;
        }
        var targetKey = weather == "Dry" ? "slm_dry" : "slm_wet";

        IReadOnlyList<MapZone> zones;
        ViewModel.IsBusy = true;
        try
        {
            zones = await Task.Run(() => SlmZoneProjector.Project(map, recording));
        }
        catch (Exception exception)
        {
            await ShowMessageAsync("TNRD import failed", exception.Message);
            return;
        }
        finally
        {
            ViewModel.IsBusy = false;
        }

        if (zones.Count == 0)
        {
            await ShowMessageAsync(
                "No complete SLM zones",
                "Straight Line Mode samples were found, but the recording contains no complete activation/deactivation zones.");
            return;
        }

        var existingCount = map.GetRows(targetKey).Count;
        if (existingCount > 0 && !await ConfirmAsync(
                "Replace existing zones?",
                $"“{targetKey}” already contains {existingCount} zone(s). Replace them with the {zones.Count} imported zone(s)?",
                "Replace",
                "Cancel"))
        {
            return;
        }

        ViewModel.ReplaceZones(targetKey, zones);
        ShowInfo(
            "Straight Line Mode imported",
            $"{zones.Count} {weather.ToLowerInvariant()} zone(s) added to {targetKey}.",
            InfoBarSeverity.Success);
    }

    private async void OnCollectionSelectionChanged(object sender, SelectionChangedEventArgs eventArgs)
    {
        if (CollectionCombo.SelectedItem as string != TrackMapDocument.NewCollectionSentinel)
        {
            return;
        }
        await CreateCollectionAsync();
    }

    private async Task CreateCollectionAsync()
    {
        var nameBox = new TextBox { PlaceholderText = "collection_key" };
        var typeBox = new ComboBox
        {
            HorizontalAlignment = HorizontalAlignment.Stretch,
            ItemsSource = new[] { "Single points", "Start/end zones" },
            SelectedIndex = 0,
        };
        var panel = new StackPanel { Spacing = 10 };
        panel.Children.Add(new TextBlock { Text = "Collection key (name):" });
        panel.Children.Add(nameBox);
        panel.Children.Add(new TextBlock { Text = "Type:" });
        panel.Children.Add(typeBox);

        var dialog = new ContentDialog
        {
            XamlRoot = XamlRoot,
            Title = "New collection",
            Content = panel,
            PrimaryButtonText = "Create",
            CloseButtonText = "Cancel",
            DefaultButton = ContentDialogButton.Primary,
        };
        if (await dialog.ShowAsync() != ContentDialogResult.Primary)
        {
            ViewModel.SelectCollection(ViewModel.Collections.FirstOrDefault() ?? string.Empty);
            return;
        }

        var kind = typeBox.SelectedIndex == 0 ? MarkerKind.PointList : MarkerKind.ZoneList;
        if (!ViewModel.CreateCollection(nameBox.Text, kind, out var error))
        {
            await ShowMessageAsync("Invalid collection", error);
        }
    }

    private void OnAddPointClicked(object sender, RoutedEventArgs eventArgs) => ViewModel.AddOrSetPoint();
    private void OnSetStartClicked(object sender, RoutedEventArgs eventArgs) => ViewModel.SetPending(true);
    private void OnSetEndClicked(object sender, RoutedEventArgs eventArgs) => ViewModel.SetPending(false);

    private async void OnAddZoneClicked(object sender, RoutedEventArgs eventArgs)
    {
        if (!ViewModel.AddZone())
        {
            await ShowMessageAsync("Incomplete zone", "Set both a start and an end first.");
        }
    }

    private void OnDeleteClicked(object sender, RoutedEventArgs eventArgs) => ViewModel.DeleteSelected();
    private void OnUpdatePointClicked(object sender, RoutedEventArgs eventArgs) => ViewModel.UpdateSelectedPoint();
    private void OnUpdateStartClicked(object sender, RoutedEventArgs eventArgs) => ViewModel.UpdateSelectedZone(true);
    private void OnUpdateEndClicked(object sender, RoutedEventArgs eventArgs) => ViewModel.UpdateSelectedZone(false);

    private void OnCanvasSeekRequested(object? sender, int index)
    {
        ViewModel.SetSeek(index);
    }

    private void OnStepBackClicked(object sender, RoutedEventArgs eventArgs)
    {
        StopPlayback();
        ViewModel.Step(-1);
    }

    private void OnStepForwardClicked(object sender, RoutedEventArgs eventArgs)
    {
        StopPlayback();
        ViewModel.Step(1);
    }

    private void OnPlayClicked(object sender, RoutedEventArgs eventArgs)
    {
        if (_playTimer.IsRunning)
        {
            StopPlayback();
        }
        else if (ViewModel.SeekMaximum > 0)
        {
            _playTimer.Start();
            PlayIcon.Glyph = "\uE769";
            ToolTipService.SetToolTip(PlayButton, "Pause");
        }
    }

    private void AdvancePlayback()
    {
        var maximum = ViewModel.SeekMaximum;
        if (maximum <= 0)
        {
            return;
        }
        var step = Math.Max(1, (maximum + 1) / 400);
        var next = ViewModel.SeekIndex + step;
        ViewModel.SetSeek(next > maximum ? 0 : next);
    }

    private void StopPlayback()
    {
        _playTimer.Stop();
        PlayIcon.Glyph = "\uE768";
        ToolTipService.SetToolTip(PlayButton, "Play");
    }

    private async void OnLoadOverlayClicked(object sender, RoutedEventArgs eventArgs) =>
        await LoadOverlayAsync();

    private async void OnBrowseOverlayClicked(object sender, RoutedEventArgs eventArgs)
    {
        var picker = new FileOpenPicker(AppWindow.Id)
        {
            Title = "Choose reference image",
            CommitButtonText = "Load",
            SettingsIdentifier = "TrackMapOverlayImage",
        };
        picker.FileTypeFilter.Add(".png");
        picker.FileTypeFilter.Add(".jpg");
        picker.FileTypeFilter.Add(".jpeg");
        picker.FileTypeFilter.Add(".bmp");
        picker.FileTypeFilter.Add(".gif");
        picker.FileTypeFilter.Add(".tif");
        picker.FileTypeFilter.Add(".tiff");
        picker.FileTypeFilter.Add(".webp");

        var imageFile = await picker.PickSingleFileAsync();
        if (imageFile is null)
        {
            return;
        }

        try
        {
            await MapCanvas.LoadOverlayFromFileAsync(imageFile.Path);
            ShowInfo("Overlay loaded", "The reference image is ready to align.", InfoBarSeverity.Success);
        }
        catch (Exception exception)
        {
            await ShowMessageAsync("Overlay failed", exception.Message);
        }
    }

    private async void OnOverlayUrlKeyDown(object sender, KeyRoutedEventArgs eventArgs)
    {
        if (eventArgs.Key == Windows.System.VirtualKey.Enter)
        {
            eventArgs.Handled = true;
            await LoadOverlayAsync();
        }
    }

    private async Task LoadOverlayAsync()
    {
        var url = OverlayUrlBox.Text.Trim();
        if (url.Length == 0)
        {
            MapCanvas.ClearOverlay();
            return;
        }
        try
        {
            await MapCanvas.LoadOverlayAsync(url);
            ShowInfo("Overlay loaded", "The reference image is ready to align.", InfoBarSeverity.Success);
        }
        catch (Exception exception)
        {
            await ShowMessageAsync("Overlay failed", exception.Message);
        }
    }

    private void OnClearOverlayClicked(object sender, RoutedEventArgs eventArgs) => MapCanvas.ClearOverlay();
    private void OnOverlayOpacityChanged(object sender, RangeBaseValueChangedEventArgs eventArgs) => MapCanvas.OverlayOpacity = eventArgs.NewValue / 100;

    private void OnOverlayRotationChanged(NumberBox sender, NumberBoxValueChangedEventArgs eventArgs)
    {
        if (!double.IsNaN(eventArgs.NewValue))
        {
            MapCanvas.OverlayRotation = eventArgs.NewValue;
        }
    }

    private void OnOverlayScaleChanged(NumberBox sender, NumberBoxValueChangedEventArgs eventArgs)
    {
        if (!double.IsNaN(eventArgs.NewValue))
        {
            MapCanvas.OverlayScale = eventArgs.NewValue / 100;
        }
    }

    private void OnOverlayOffsetChanged(NumberBox sender, NumberBoxValueChangedEventArgs eventArgs)
    {
        if (!double.IsNaN(OverlayXBox.Value))
        {
            MapCanvas.OverlayOffsetX = OverlayXBox.Value;
        }
        if (!double.IsNaN(OverlayYBox.Value))
        {
            MapCanvas.OverlayOffsetY = OverlayYBox.Value;
        }
    }

    private void OnOverlayMoved(object? sender, EventArgs eventArgs)
    {
        OverlayXBox.Value = Math.Round(MapCanvas.OverlayOffsetX);
        OverlayYBox.Value = Math.Round(MapCanvas.OverlayOffsetY);
    }

    private async Task<string?> ChooseWeatherAsync()
    {
        var weather = new ComboBox
        {
            HorizontalAlignment = HorizontalAlignment.Stretch,
            ItemsSource = new[] { "Dry", "Wet" },
            SelectedIndex = 0,
        };
        var panel = new StackPanel { Spacing = 10 };
        panel.Children.Add(new TextBlock { Text = "Data to import: Straight Line Mode" });
        panel.Children.Add(new TextBlock { Text = "Session conditions:" });
        panel.Children.Add(weather);
        var dialog = new ContentDialog
        {
            XamlRoot = XamlRoot,
            Title = "Import TNRD data",
            Content = panel,
            PrimaryButtonText = "Continue",
            CloseButtonText = "Cancel",
            DefaultButton = ContentDialogButton.Primary,
        };
        return await dialog.ShowAsync() == ContentDialogResult.Primary
            ? weather.SelectedItem as string
            : null;
    }

    private async Task<bool> ConfirmAsync(
        string title,
        string message,
        string primaryText,
        string closeText)
    {
        var dialog = new ContentDialog
        {
            XamlRoot = XamlRoot,
            Title = title,
            Content = new TextBlock { Text = message, TextWrapping = TextWrapping.Wrap },
            PrimaryButtonText = primaryText,
            CloseButtonText = closeText,
            DefaultButton = ContentDialogButton.Close,
        };
        return await dialog.ShowAsync() == ContentDialogResult.Primary;
    }

    private async Task ShowMessageAsync(string title, string message)
    {
        var dialog = new ContentDialog
        {
            XamlRoot = XamlRoot,
            Title = title,
            Content = new TextBlock { Text = message, TextWrapping = TextWrapping.Wrap },
            CloseButtonText = "Close",
        };
        await dialog.ShowAsync();
    }

    private void ShowInfo(string title, string message, InfoBarSeverity severity)
    {
        var generation = ++_infoGeneration;
        StatusInfoBar.Title = title;
        StatusInfoBar.Message = message;
        StatusInfoBar.Severity = severity;
        StatusInfoBar.IsOpen = true;
        _ = CloseInfoLaterAsync(generation);
    }

    private async Task CloseInfoLaterAsync(int generation)
    {
        await Task.Delay(TimeSpan.FromSeconds(3));
        if (_infoGeneration == generation)
        {
            StatusInfoBar.IsOpen = false;
        }
    }

    private void UpdateWindowTitle()
    {
        if (Application.Current is App app)
        {
            app.MainWindow.SetEditorTitle(
                ViewModel.Document?.FileName,
                ViewModel.IsDirty);
        }
    }

    private Microsoft.UI.Windowing.AppWindow AppWindow =>
        ((App)Application.Current).MainWindow.AppWindow;
}
