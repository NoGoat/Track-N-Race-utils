using System.Collections.ObjectModel;
using System.Globalization;
using CommunityToolkit.Mvvm.ComponentModel;
using TelemetryMapper.Core;

namespace TelemetryMapper.WinUI3.ViewModels;

public sealed partial class EditorViewModel : ObservableObject
{
    private bool _loadingAttributes;
    private bool _loadingSinglePoint;

    public ObservableCollection<string> Collections { get; } = [];
    public ObservableCollection<LayerItemViewModel> Layers { get; } = [];
    public ObservableCollection<MarkerRowViewModel> Rows { get; } = [];

    public TrackMapDocument? Document { get; private set; }

    [ObservableProperty]
    public partial string? SelectedCollection { get; set; }

    [ObservableProperty]
    public partial MarkerRowViewModel? SelectedRow { get; set; }

    [ObservableProperty]
    public partial int SeekIndex { get; set; }

    [ObservableProperty]
    public partial bool IsLoaded { get; set; }

    [ObservableProperty]
    public partial bool IsBusy { get; set; }

    [ObservableProperty]
    public partial string InfoText { get; set; } = "No map loaded";

    [ObservableProperty]
    public partial string PositionText { get; set; } = "—";

    [ObservableProperty]
    public partial MapPoint? PendingStart { get; set; }

    [ObservableProperty]
    public partial MapPoint? PendingEnd { get; set; }

    [ObservableProperty]
    public partial string TrackName { get; set; } = string.Empty;

    [ObservableProperty]
    public partial string CircuitName { get; set; } = string.Empty;

    [ObservableProperty]
    public partial double TrackLengthMeters { get; set; }

    [ObservableProperty]
    public partial double PitTime { get; set; }

    [ObservableProperty]
    public partial double InlapPitTime { get; set; }

    [ObservableProperty]
    public partial double OutlapPitTime { get; set; }

    [ObservableProperty]
    public partial double RotationDegrees { get; set; }

    [ObservableProperty]
    public partial string SinglePointX { get; set; } = string.Empty;

    [ObservableProperty]
    public partial string SinglePointY { get; set; } = string.Empty;

    public int SeekMaximum => Math.Max(0, (Document?.Centerline.Count ?? 1) - 1);
    public bool IsDirty => Document?.IsDirty == true;
    public bool HasSelection => SelectedRow is not null;
    public MarkerKind? CurrentKind =>
        CurrentKey is not null && Document?.MarkerKinds.TryGetValue(CurrentKey, out var kind) == true
            ? kind
            : null;
    public bool IsZoneCollection => CurrentKind == MarkerKind.ZoneList;
    public bool IsPointListCollection => CurrentKind == MarkerKind.PointList;
    public bool IsSinglePointCollection => CurrentKind == MarkerKind.PointScalar;
    public bool IsPointCollection => CurrentKind is MarkerKind.PointList or MarkerKind.PointScalar;
    public string CurrentKindDescription => CurrentKind switch
    {
        MarkerKind.PointScalar => "Single map point",
        MarkerKind.PointList => "Point collection",
        MarkerKind.ZoneList => "Start / end zones",
        _ => string.Empty,
    };
    public string CurrentKey =>
        SelectedCollection is not null && SelectedCollection != TrackMapDocument.NewCollectionSentinel
            ? SelectedCollection
            : string.Empty;
    public string PendingText => $"start: {Format(PendingStart)}   end: {Format(PendingEnd)}";
    public string PointActionText => CurrentKind == MarkerKind.PointScalar
        ? "Set from marker"
        : "Add point at marker";

    public event EventHandler? CanvasChanged;
    public event EventHandler? DocumentChanged;

    public void Load(TrackMapDocument document)
    {
        if (Document is not null)
        {
            Document.Changed -= OnDocumentChanged;
        }
        Document = document;
        Document.Changed += OnDocumentChanged;
        IsLoaded = true;
        SeekIndex = 0;
        PendingStart = PendingEnd = null;

        _loadingAttributes = true;
        TrackName = document.TrackName == "?" ? string.Empty : document.TrackName;
        CircuitName = document.CircuitName == "?" ? string.Empty : document.CircuitName;
        TrackLengthMeters = document.TrackLengthMeters ?? 0;
        PitTime = document.PitTime ?? 0;
        InlapPitTime = document.InlapPitTime ?? 0;
        OutlapPitTime = document.OutlapPitTime ?? 0;
        RotationDegrees = document.RotationDegrees;
        _loadingAttributes = false;

        Collections.Clear();
        foreach (var key in document.MarkerKinds.Keys)
        {
            Collections.Add(key);
        }
        Collections.Add(TrackMapDocument.NewCollectionSentinel);

        Layers.Clear();
        foreach (var key in document.MarkerKinds.Keys)
        {
            var item = new LayerItemViewModel(key);
            item.VisibilityChanged += (_, _) => CanvasChanged?.Invoke(this, EventArgs.Empty);
            Layers.Add(item);
        }

        SelectedCollection = Collections.FirstOrDefault();
        UpdateInfo();
        UpdatePosition();
        RaiseDocumentProperties();
        CanvasChanged?.Invoke(this, EventArgs.Empty);
    }

    public bool IsLayerVisible(string key) =>
        Layers.FirstOrDefault(layer => layer.Name == key)?.IsVisible ?? true;

    public void SelectCollection(string key)
    {
        if (Collections.Contains(key))
        {
            SelectedCollection = key;
        }
    }

    public bool CreateCollection(string name, MarkerKind kind, out string error)
    {
        if (Document is null)
        {
            error = "Open a map before creating a collection.";
            return false;
        }
        if (!Document.TryCreateCollection(name, kind, out error))
        {
            return false;
        }

        var sentinelIndex = Math.Max(0, Collections.Count - 1);
        Collections.Insert(sentinelIndex, name.Trim());
        var layer = new LayerItemViewModel(name.Trim());
        layer.VisibilityChanged += (_, _) => CanvasChanged?.Invoke(this, EventArgs.Empty);
        Layers.Add(layer);
        SelectedCollection = name.Trim();
        RaiseDocumentProperties();
        return true;
    }

    public MapPoint? MarkedPoint =>
        Document is not null && Document.Centerline.Count > 0
            ? Document.Centerline[Math.Clamp(SeekIndex, 0, Document.Centerline.Count - 1)].Rounded()
            : null;

    public void AddOrSetPoint()
    {
        if (Document is null || CurrentKey.Length == 0 || MarkedPoint is not { } point)
        {
            return;
        }
        Document.SetOrAddPoint(CurrentKey, point);
        RefreshRows();
        CanvasChanged?.Invoke(this, EventArgs.Empty);
    }

    public void SetPending(bool start)
    {
        if (MarkedPoint is not { } point)
        {
            return;
        }
        if (start)
        {
            PendingStart = point;
        }
        else
        {
            PendingEnd = point;
        }
        OnPropertyChanged(nameof(PendingText));
        CanvasChanged?.Invoke(this, EventArgs.Empty);
    }

    public bool AddZone()
    {
        if (Document is null || CurrentKey.Length == 0 ||
            PendingStart is not { } start || PendingEnd is not { } end)
        {
            return false;
        }
        Document.AddZone(CurrentKey, start, end);
        PendingStart = PendingEnd = null;
        OnPropertyChanged(nameof(PendingText));
        RefreshRows();
        CanvasChanged?.Invoke(this, EventArgs.Empty);
        return true;
    }

    public void DeleteSelected()
    {
        if (Document is null || CurrentKey.Length == 0 || SelectedRow is null)
        {
            return;
        }
        Document.DeleteRow(CurrentKey, SelectedRow.Index);
        RefreshRows();
        CanvasChanged?.Invoke(this, EventArgs.Empty);
    }

    public void UpdateSelectedPoint()
    {
        if (Document is null || CurrentKey.Length == 0 ||
            SelectedRow is null || MarkedPoint is not { } point)
        {
            return;
        }
        var row = SelectedRow.Index;
        Document.UpdatePoint(CurrentKey, row, point);
        RefreshRows(row);
        CanvasChanged?.Invoke(this, EventArgs.Empty);
    }

    public void UpdateSelectedZone(bool start)
    {
        if (Document is null || CurrentKey.Length == 0 ||
            SelectedRow is null || MarkedPoint is not { } point)
        {
            return;
        }
        var row = SelectedRow.Index;
        Document.UpdateZoneEndpoint(CurrentKey, row, start, point);
        RefreshRows(row);
        CanvasChanged?.Invoke(this, EventArgs.Empty);
    }

    public void ReplaceZones(string key, IReadOnlyList<MapZone> zones)
    {
        Document?.ReplaceZones(key, zones);
        SelectCollection(key);
        var layer = Layers.FirstOrDefault(item => item.Name == key);
        if (layer is not null)
        {
            layer.IsVisible = true;
        }
        RefreshRows();
        CanvasChanged?.Invoke(this, EventArgs.Empty);
    }

    public void SetSeek(int index)
    {
        SeekIndex = Math.Clamp(index, 0, SeekMaximum);
    }

    public void Step(int delta) => SetSeek(SeekIndex + delta);

    private void RefreshRows(int? selectIndex = null)
    {
        Rows.Clear();
        if (Document is not null && CurrentKey.Length > 0)
        {
            foreach (var row in Document.GetRows(CurrentKey))
            {
                Rows.Add(new MarkerRowViewModel(row));
            }
        }
        SelectedRow = selectIndex is not null
            ? Rows.FirstOrDefault(row => row.Index == selectIndex.Value)
            : null;
        RefreshSinglePointFields();
        OnPropertyChanged(nameof(HasSelection));
    }

    private void RefreshSinglePointFields()
    {
        _loadingSinglePoint = true;
        var point = CurrentKind == MarkerKind.PointScalar
            ? Rows.FirstOrDefault()?.Row.Point
            : null;
        SinglePointX = point is { } value ? $"{value.X:g}" : string.Empty;
        SinglePointY = point is { } value2 ? $"{value2.Y:g}" : string.Empty;
        _loadingSinglePoint = false;
    }

    private void UpdateInfo()
    {
        if (Document is null)
        {
            InfoText = "No map loaded";
            return;
        }
        InfoText = $"{Document.TrackName}  ·  id {Document.TrackId?.ToString() ?? "?"}  ·  " +
                   $"{Document.TrackLengthMeters?.ToString("g") ?? "?"} m  ·  " +
                   $"{Document.Centerline.Count} pts  ·  rot {Document.RotationDegrees:g}°";
    }

    private void UpdatePosition()
    {
        if (Document is null || Document.Centerline.Count == 0)
        {
            PositionText = "—";
            return;
        }
        var end = Math.Max(1, Document.Centerline.Count - 1);
        var index = Math.Clamp(SeekIndex, 0, end);
        PositionText = $"IDX: {index}";
    }

    private void RaiseCollectionProperties()
    {
        OnPropertyChanged(nameof(CurrentKey));
        OnPropertyChanged(nameof(CurrentKind));
        OnPropertyChanged(nameof(CurrentKindDescription));
        OnPropertyChanged(nameof(IsZoneCollection));
        OnPropertyChanged(nameof(IsPointListCollection));
        OnPropertyChanged(nameof(IsSinglePointCollection));
        OnPropertyChanged(nameof(IsPointCollection));
        OnPropertyChanged(nameof(PointActionText));
        OnPropertyChanged(nameof(PendingText));
    }

    private void RaiseDocumentProperties()
    {
        OnPropertyChanged(nameof(Document));
        OnPropertyChanged(nameof(SeekMaximum));
        OnPropertyChanged(nameof(IsDirty));
        DocumentChanged?.Invoke(this, EventArgs.Empty);
    }

    private void OnDocumentChanged(object? sender, EventArgs eventArgs)
    {
        UpdateInfo();
        RaiseDocumentProperties();
        CanvasChanged?.Invoke(this, EventArgs.Empty);
    }

    partial void OnTrackNameChanged(string value) => SetTextAttribute("track_name", value);
    partial void OnCircuitNameChanged(string value) => SetTextAttribute("circuit_name", value);
    partial void OnTrackLengthMetersChanged(double value) => SetNumberAttribute("track_length_m", value);
    partial void OnPitTimeChanged(double value) => SetNumberAttribute("pit_time", value);
    partial void OnInlapPitTimeChanged(double value) => SetNumberAttribute("inlap_pit_time", value);
    partial void OnOutlapPitTimeChanged(double value) => SetNumberAttribute("outlap_pit_time", value);
    partial void OnRotationDegreesChanged(double value) => SetNumberAttribute("rotation_deg", value);
    partial void OnSinglePointXChanged(string value) => UpdateSinglePointFromFields();
    partial void OnSinglePointYChanged(string value) => UpdateSinglePointFromFields();

    private void UpdateSinglePointFromFields()
    {
        if (_loadingSinglePoint || Document is null || CurrentKind != MarkerKind.PointScalar ||
            !TryParseCoordinate(SinglePointX, out var x) || !TryParseCoordinate(SinglePointY, out var y))
        {
            return;
        }

        Document.UpdatePoint(CurrentKey, 0, new MapPoint(x, y));
        CanvasChanged?.Invoke(this, EventArgs.Empty);
    }

    private static bool TryParseCoordinate(string value, out double result) =>
        (double.TryParse(value, NumberStyles.Float, CultureInfo.CurrentCulture, out result) ||
         double.TryParse(value, NumberStyles.Float, CultureInfo.InvariantCulture, out result)) &&
        double.IsFinite(result);

    private void SetTextAttribute(string key, string value)
    {
        if (!_loadingAttributes)
        {
            Document?.SetTextAttribute(key, value);
        }
    }

    private void SetNumberAttribute(string key, double value)
    {
        if (!_loadingAttributes && double.IsFinite(value))
        {
            Document?.SetNumberAttribute(key, value);
        }
    }

    partial void OnSelectedCollectionChanged(string? value)
    {
        PendingStart = PendingEnd = null;
        RaiseCollectionProperties();
        RefreshRows();
        CanvasChanged?.Invoke(this, EventArgs.Empty);
    }

    partial void OnSelectedRowChanged(MarkerRowViewModel? value)
    {
        OnPropertyChanged(nameof(HasSelection));
        CanvasChanged?.Invoke(this, EventArgs.Empty);
    }

    partial void OnSeekIndexChanged(int value)
    {
        UpdatePosition();
        CanvasChanged?.Invoke(this, EventArgs.Empty);
    }

    private static string Format(MapPoint? point) => point?.ToString() ?? "—";
}
