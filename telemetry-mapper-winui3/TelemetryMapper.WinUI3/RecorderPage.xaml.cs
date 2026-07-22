using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.Windows.Storage.Pickers;
using TelemetryMapper.Core;
using TelemetryMapper.WinUI3.ViewModels;
using Windows.Storage;

namespace TelemetryMapper.WinUI3;

public sealed partial class RecorderPage : Page
{
    private const string FinalDirectorySetting = "LiveMapperFinalDirectory";
    private const string RawDirectorySetting = "LiveMapperRawDirectory";
    private TelemetryTrackRecorder _recorder = null!;
    private string? _finalDirectory;
    private string? _rawDirectory;
    private int _loadedFinalTrackId = int.MinValue;
    private TrackMapDocument? _existingFinalMap;
    public EditorViewModel ViewModel { get; } = new();
    public string StatusText { get; private set; } = "Listener stopped.";
    public string GameInfoText { get; private set; } = "Waiting for circuit information from the game";

    public RecorderPage()
    {
        InitializeComponent();
        RestoreSaveLocations();
        MapCanvas.Attach(ViewModel);
        AttachRecorder(new TelemetryTrackRecorder());
        Unloaded += async (_, _) => await _recorder.StopAsync();
    }

    private async void OnStartClicked(object sender, RoutedEventArgs args)
    {
        if (double.IsNaN(UdpPortBox.Value) || UdpPortBox.Value is < 1 or > 65535)
        {
            ShowInfo("Invalid UDP port", "Enter a port from 1 to 65535.", InfoBarSeverity.Warning);
            return;
        }
        var port = (int)UdpPortBox.Value;
        if (_recorder.IsListening && port != _recorder.Port)
        {
            await _recorder.StopAsync();
            AttachRecorder(new TelemetryTrackRecorder(port));
        }
        else if (!_recorder.IsListening && port != _recorder.Port)
        {
            AttachRecorder(new TelemetryTrackRecorder(port));
        }
        _recorder.Start();
    }
    private async void OnStopClicked(object sender, RoutedEventArgs args) => await _recorder.StopAsync();

    private async void OnChooseFinalDirectoryClicked(object sender, RoutedEventArgs args)
    {
        var picker = new FolderPicker(((App)Application.Current).MainWindow.AppWindow.Id)
        { Title = "Choose final map JSON folder", CommitButtonText = "Choose", SettingsIdentifier = "FinalMapFolder" };
        var folder = await picker.PickSingleFolderAsync();
        if (folder is null) return;
        _finalDirectory = folder.Path;
        FinalDirectoryBox.Text = folder.Path;
        ApplicationData.Current.LocalSettings.Values[FinalDirectorySetting] = folder.Path;
        _loadedFinalTrackId = int.MinValue;
        await LoadExistingFinalMapAsync();
    }

    private async void OnChooseRawDirectoryClicked(object sender, RoutedEventArgs args)
    {
        var picker = new FolderPicker(((App)Application.Current).MainWindow.AppWindow.Id)
        { Title = "Choose raw telemetry folder", CommitButtonText = "Choose", SettingsIdentifier = "RawTelemetryFolder" };
        var folder = await picker.PickSingleFolderAsync();
        if (folder is null) return;
        _rawDirectory = folder.Path;
        RawDirectoryBox.Text = folder.Path;
        ApplicationData.Current.LocalSettings.Values[RawDirectorySetting] = folder.Path;
    }

    private void AttachRecorder(TelemetryTrackRecorder recorder)
    {
        _recorder = recorder;
        _recorder.Updated += (_, _) => DispatcherQueue.TryEnqueue(OnRecorderUpdated);
        _recorder.StatusChanged += (_, text) => DispatcherQueue.TryEnqueue(() => { StatusText = text; Bindings.Update(); });
    }


    private void UpdateStatus()
    {
        GameInfoText = _recorder.TrackId < 0 ? "Waiting for circuit information from the game" :
            $"Track id {_recorder.TrackId}  ·  {_recorder.TrackLengthMeters} m  ·  " +
            $"SLM {(_recorder.ActiveAeroTrackStatus == 0 ? "Full / dry" : _recorder.ActiveAeroTrackStatus == 1 ? "Partial / wet" : "unavailable")}  ·  session {_recorder.SessionUid ?? "—"}";
        StatusText = _recorder.IsRecording
            ? $"Recording lap {_recorder.CurrentLap} · {_recorder.PointCount:N0} raw points retained"
            : $"Listening · {_recorder.PointCount:N0} raw points retained";
        Bindings.Update();
        _ = LoadExistingFinalMapAsync();
    }

    private void OnRecorderUpdated()
    {
        UpdateStatus();
        var recording = _recorder.Snapshot();
        if (recording.Points.Count == 0)
        {
            return;
        }
        try
        {
            // No timer or coalescing: each recorded point redraws the live route.
            var live = _existingFinalMap is null
                ? TelemetryTrackConverter.CreateLivePreview(recording)
                : TelemetryTrackConverter.MergeMissingFromRecording(_existingFinalMap, recording);
            ViewModel.Load(live);
        }
        catch (InvalidDataException)
        {
            // The first point has no visible line yet.
        }
    }

    private async void OnSaveClicked(object sender, RoutedEventArgs args)
    {
        var raw = _recorder.Snapshot();
        if (raw.Points.Count == 0) { ShowInfo("Nothing to save", "Drive a session first.", InfoBarSeverity.Warning); return; }
        if (string.IsNullOrWhiteSpace(TrackNameBox.Text) || string.IsNullOrWhiteSpace(CircuitNameBox.Text))
        { ShowInfo("Map details required", "Enter a track name and circuit name before saving.", InfoBarSeverity.Warning); return; }
        TrackMapDocument document;
        try
        {
            document = _existingFinalMap is null
                ? TelemetryTrackConverter.Convert(raw, TrackNameBox.Text, CircuitNameBox.Text)
                : TelemetryTrackConverter.MergeMissingFromRecording(_existingFinalMap, raw);
        }
        catch (Exception exception) { ShowInfo("Could not create map", exception.Message, InfoBarSeverity.Error); return; }

        if (string.IsNullOrWhiteSpace(_finalDirectory) || string.IsNullOrWhiteSpace(_rawDirectory))
        { ShowInfo("Save locations required", "Choose both the final JSON and raw telemetry folders first.", InfoBarSeverity.Warning); return; }
        try
        {
            var finalPath = Path.Combine(_finalDirectory, $"track_{raw.TrackId}.json");
            var rawPath = Path.Combine(_rawDirectory, $"track_{raw.TrackId}_{raw.SessionUid ?? "unknown"}_raw.json");
            await document.SaveAsAsync(finalPath);
            await _recorder.SaveRawAsync(rawPath);
            ViewModel.Load(document);
            ShowInfo("Map saved", $"Saved {document.FileName} and raw telemetry {Path.GetFileName(rawPath)}.", InfoBarSeverity.Success);
        }
        catch (Exception exception) { ShowInfo("Could not save map", exception.Message, InfoBarSeverity.Error); }
    }

    private void ShowInfo(string title, string message, InfoBarSeverity severity)
    {
        RecorderInfoBar.Title = title; RecorderInfoBar.Message = message; RecorderInfoBar.Severity = severity; RecorderInfoBar.IsOpen = true;
    }

    private async Task LoadExistingFinalMapAsync()
    {
        var trackId = _recorder.TrackId;
        if (trackId < 0 || string.IsNullOrWhiteSpace(_finalDirectory) || trackId == _loadedFinalTrackId) return;
        _loadedFinalTrackId = trackId;
        var path = Path.Combine(_finalDirectory, $"track_{trackId}.json");
        if (!File.Exists(path)) { _existingFinalMap = null; return; }
        try
        {
            _existingFinalMap = await TrackMapDocument.LoadAsync(path);
            TrackNameBox.Text = _existingFinalMap.TrackName == "?" ? string.Empty : _existingFinalMap.TrackName;
            CircuitNameBox.Text = _existingFinalMap.CircuitName == "?" ? string.Empty : _existingFinalMap.CircuitName;
            ViewModel.Load(_existingFinalMap);
        }
        catch (Exception exception)
        {
            _existingFinalMap = null;
            ShowInfo("Could not load existing map", exception.Message, InfoBarSeverity.Warning);
        }
    }

    private void RestoreSaveLocations()
    {
        _finalDirectory = ApplicationData.Current.LocalSettings.Values[FinalDirectorySetting] as string;
        _rawDirectory = ApplicationData.Current.LocalSettings.Values[RawDirectorySetting] as string;
        FinalDirectoryBox.Text = _finalDirectory ?? string.Empty;
        RawDirectoryBox.Text = _rawDirectory ?? string.Empty;
    }
}
