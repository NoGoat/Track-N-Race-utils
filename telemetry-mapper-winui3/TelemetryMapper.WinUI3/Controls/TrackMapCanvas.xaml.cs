using System.Numerics;
using Microsoft.Graphics.Canvas;
using Microsoft.Graphics.Canvas.Geometry;
using Microsoft.Graphics.Canvas.UI.Xaml;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;
using Microsoft.UI.Xaml.Media.Imaging;
using TelemetryMapper.Core;
using TelemetryMapper.WinUI3.ViewModels;
using Windows.Foundation;
using Windows.UI;

namespace TelemetryMapper.WinUI3.Controls;

public sealed partial class TrackMapCanvas : UserControl
{
    public static readonly DependencyProperty EmptyMessageProperty = DependencyProperty.Register(
        nameof(EmptyMessage), typeof(string), typeof(TrackMapCanvas),
        new PropertyMetadata("Open a final_json track map to begin", OnEmptyMessageChanged));
    private readonly RectangleGeometry _boundsClip = new();

    private static readonly Color HighlightColor = ColorFromHex("#ffffff");
    private static readonly Color SeekColor = ColorFromHex("#19D3E6");
    private static readonly Color PendingColor = ColorFromHex("#00E5FF");

    private uint? _overlayPointerId;
    private Point _overlayDragStart;
    private double _overlayStartX;
    private double _overlayStartY;

    public TrackMapCanvas()
    {
        InitializeComponent();
        ((App)Application.Current).MapColors.Changed += OnMapColorsChanged;
        Clip = _boundsClip;
        SizeChanged += (_, args) =>
        {
            _boundsClip.Rect = new Rect(0, 0, args.NewSize.Width, args.NewSize.Height);
            Invalidate();
        };
    }

    public EditorViewModel? ViewModel { get; private set; }

    public string EmptyMessage
    {
        get => (string)GetValue(EmptyMessageProperty);
        set => SetValue(EmptyMessageProperty, value);
    }

    public double OverlayOpacity
    {
        get => OverlayImage.Opacity;
        set => OverlayImage.Opacity = Math.Clamp(value, 0, 1);
    }

    public double OverlayRotation
    {
        get => OverlayTransform.Rotation;
        set => OverlayTransform.Rotation = value;
    }

    public double OverlayScale
    {
        get => OverlayTransform.ScaleX;
        set => OverlayTransform.ScaleX = OverlayTransform.ScaleY = Math.Clamp(value, 0.05, 10);
    }

    public double OverlayOffsetX
    {
        get => OverlayTransform.TranslateX;
        set => OverlayTransform.TranslateX = value;
    }

    public double OverlayOffsetY
    {
        get => OverlayTransform.TranslateY;
        set => OverlayTransform.TranslateY = value;
    }

    public event EventHandler<int>? SeekRequested;
    public event EventHandler? OverlayMoved;

    public void Attach(EditorViewModel viewModel)
    {
        if (ViewModel is not null)
        {
            ViewModel.CanvasChanged -= OnCanvasChanged;
        }
        ViewModel = viewModel;
        ViewModel.CanvasChanged += OnCanvasChanged;
        EmptyText.Visibility = viewModel.IsLoaded ? Visibility.Collapsed : Visibility.Visible;
        Invalidate();
    }

    public void Invalidate()
    {
        EmptyText.Visibility = ViewModel?.IsLoaded == true ? Visibility.Collapsed : Visibility.Visible;
        Canvas.Invalidate();
    }

    public async Task LoadOverlayAsync(string url, CancellationToken cancellationToken = default)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) ||
            uri.Scheme is not ("http" or "https"))
        {
            throw new InvalidOperationException("Enter a valid HTTP or HTTPS image URL.");
        }

        var bitmap = new BitmapImage();
        var completion = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        RoutedEventHandler loaded = (_, _) => completion.TrySetResult();
        ExceptionRoutedEventHandler failed = (_, args) => completion.TrySetException(
            new InvalidOperationException(
                $"Windows could not decode this image. For WebP, install the Microsoft WebP Image Extension. {args.ErrorMessage}"));
        bitmap.ImageOpened += loaded;
        bitmap.ImageFailed += failed;
        try
        {
            OverlayImage.Source = bitmap;
            bitmap.UriSource = uri;
            await completion.Task.WaitAsync(TimeSpan.FromSeconds(30), cancellationToken);
        }
        finally
        {
            bitmap.ImageOpened -= loaded;
            bitmap.ImageFailed -= failed;
        }
    }

    public async Task LoadOverlayFromFileAsync(string imagePath, CancellationToken cancellationToken = default)
    {
        if (!File.Exists(imagePath))
        {
            throw new FileNotFoundException("The selected image could not be found.", imagePath);
        }

        var bitmap = new BitmapImage();
        var completion = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        RoutedEventHandler loaded = (_, _) => completion.TrySetResult();
        ExceptionRoutedEventHandler failed = (_, args) => completion.TrySetException(
            new InvalidOperationException(
                $"Windows could not decode this image. For WebP, install the Microsoft WebP Image Extension. {args.ErrorMessage}"));
        bitmap.ImageOpened += loaded;
        bitmap.ImageFailed += failed;
        try
        {
            OverlayImage.Source = bitmap;
            bitmap.UriSource = new Uri(imagePath, UriKind.Absolute);
            await completion.Task.WaitAsync(TimeSpan.FromSeconds(30), cancellationToken);
        }
        finally
        {
            bitmap.ImageOpened -= loaded;
            bitmap.ImageFailed -= failed;
        }
    }

    public void ClearOverlay() => OverlayImage.Source = null;

    private static void OnEmptyMessageChanged(DependencyObject sender, DependencyPropertyChangedEventArgs args)
    {
        if (sender is TrackMapCanvas canvas && args.NewValue is string message)
        {
            canvas.EmptyText.Text = message;
        }
    }

    private void OnCanvasChanged(object? sender, EventArgs eventArgs) => Invalidate();

    private void OnMapColorsChanged(object? sender, EventArgs eventArgs) => Invalidate();

    private void OnDraw(CanvasControl sender, CanvasDrawEventArgs args)
    {
        var viewModel = ViewModel;
        var document = viewModel?.Document;
        if (document is null || document.Centerline.Count == 0 ||
            sender.ActualWidth <= 0 || sender.ActualHeight <= 0)
        {
            return;
        }

        var transform = CreateTransform(document);
        var drawing = args.DrawingSession;
        var palette = ((App)Application.Current).MapColors;

        for (var sectorIndex = 0; sectorIndex < document.Sectors.Count; sectorIndex++)
        {
            DrawPolyline(
                drawing,
                document.Sectors[sectorIndex].Points,
                transform,
                palette.GetSectorColor(sectorIndex),
                2);
        }

        foreach (var pair in document.MarkerKinds)
        {
            if (!viewModel!.IsLayerVisible(pair.Key))
            {
                continue;
            }
            DrawCollection(drawing, document, viewModel, transform, pair.Key, pair.Value);
        }

        if (viewModel!.PendingStart is { } pendingStart)
        {
            DrawRing(drawing, transform.ToCanvas(pendingStart), PendingColor, 7, false, true);
        }
        if (viewModel.PendingEnd is { } pendingEnd)
        {
            DrawRing(drawing, transform.ToCanvas(pendingEnd), PendingColor, 7, false, true);
        }

        var seek = document.Centerline[Math.Clamp(viewModel.SeekIndex, 0, document.Centerline.Count - 1)];
        var seekCanvas = transform.ToCanvas(seek);
        drawing.FillCircle(ToVector(seekCanvas), 6, SeekColor);
        drawing.DrawCircle(ToVector(seekCanvas), 6, HighlightColor, 1.5f);
    }

    private void DrawCollection(
        CanvasDrawingSession drawing,
        TrackMapDocument document,
        EditorViewModel viewModel,
        MapViewTransform transform,
        string key,
        MarkerKind kind)
    {
        foreach (var row in document.GetRows(key))
        {
            var selected = viewModel.CurrentKey == key && viewModel.SelectedRow?.Index == row.Index;
            if (kind == MarkerKind.ZoneList && row.Zone is { } zone)
            {
                DrawZone(drawing, document, transform, key, zone, selected);
            }
            else if (row.Point is { } point)
            {
                DrawPoint(drawing, transform, key, point, selected);
            }
        }
    }

    private void DrawPoint(
        CanvasDrawingSession drawing,
        MapViewTransform transform,
        string key,
        MapPoint point,
        bool selected)
    {
        var color = ((App)Application.Current).MapColors.GetPointColor(key);
        var canvasPoint = transform.ToCanvas(point);
        var center = ToVector(canvasPoint);
        var radius = selected ? 8f : 6f;
        var outline = selected ? 2.5f : 1.2f;

        if (key == "speed_traps")
        {
            var vertices = new[]
            {
                new Vector2(center.X, center.Y - radius),
                new Vector2(center.X + radius, center.Y),
                new Vector2(center.X, center.Y + radius),
                new Vector2(center.X - radius, center.Y),
            };
            using var geometry = CanvasGeometry.CreatePolygon(drawing, vertices);
            drawing.FillGeometry(geometry, color);
            drawing.DrawGeometry(geometry, HighlightColor, outline);
        }
        else if (key is "drs_detection_points" or "overtake_detection_point" or "overtake_activation_point")
        {
            var rectangle = new Rect(center.X - radius, center.Y - radius, radius * 2, radius * 2);
            drawing.FillRectangle(rectangle, color);
            drawing.DrawRectangle(rectangle, HighlightColor, outline);
        }
        else
        {
            drawing.FillCircle(center, radius, color);
            drawing.DrawCircle(center, radius, HighlightColor, outline);
        }
    }

    private void DrawZone(
        CanvasDrawingSession drawing,
        TrackMapDocument document,
        MapViewTransform transform,
        string key,
        MapZone zone,
        bool selected)
    {
        var (startColor, endColor) = ((App)Application.Current).MapColors.GetZoneColors(key);
        var startIndex = MapGeometry.ClosestIndex(document.Centerline, zone.Start);
        var endIndex = MapGeometry.ClosestIndex(document.Centerline, zone.End);
        var indices = MapGeometry.SliceIndices(startIndex, endIndex, document.Centerline.Count).ToList();
        var lineColor = Color.FromArgb(selected ? (byte)200 : (byte)120, startColor.R, startColor.G, startColor.B);
        for (var index = 1; index < indices.Count; index++)
        {
            var previous = transform.ToCanvas(document.Centerline[indices[index - 1]]);
            var current = transform.ToCanvas(document.Centerline[indices[index]]);
            drawing.DrawLine(ToVector(previous), ToVector(current), lineColor, selected ? 6 : 4);
        }
        DrawRing(drawing, transform.ToCanvas(zone.Start), startColor, selected ? 8 : 6, true, selected);
        DrawRing(drawing, transform.ToCanvas(zone.End), endColor, selected ? 8 : 6, true, selected);
    }

    private static void DrawPolyline(
        CanvasDrawingSession drawing,
        IReadOnlyList<MapPoint> points,
        MapViewTransform transform,
        Color color,
        float width)
    {
        for (var index = 1; index < points.Count; index++)
        {
            drawing.DrawLine(
                ToVector(transform.ToCanvas(points[index - 1])),
                ToVector(transform.ToCanvas(points[index])),
                color,
                width);
        }
    }

    private static void DrawRing(
        CanvasDrawingSession drawing,
        MapPoint point,
        Color color,
        float radius,
        bool filled,
        bool outlined)
    {
        var center = ToVector(point);
        if (filled)
        {
            drawing.FillCircle(center, radius, color);
        }
        drawing.DrawCircle(center, radius, HighlightColor, outlined ? 2.5f : 1.2f);
    }

    private MapViewTransform CreateTransform(TrackMapDocument document) =>
        MapViewTransform.Create(
            document.Centerline,
            document.ViewBoxWidth,
            document.ViewBoxHeight,
            document.RotationDegrees,
            Canvas.ActualWidth,
            Canvas.ActualHeight);

    private void OnPointerPressed(object sender, PointerRoutedEventArgs args)
    {
        var point = args.GetCurrentPoint(InputSurface);
        if (point.Properties.IsRightButtonPressed && OverlayImage.Source is not null)
        {
            _overlayPointerId = point.PointerId;
            _overlayDragStart = point.Position;
            _overlayStartX = OverlayOffsetX;
            _overlayStartY = OverlayOffsetY;
            InputSurface.CapturePointer(args.Pointer);
            args.Handled = true;
            return;
        }

        if (point.Properties.IsLeftButtonPressed && ViewModel?.Document is { } document &&
            document.Centerline.Count > 0)
        {
            var transform = CreateTransform(document);
            var viewBoxPoint = transform.ToViewBox(point.Position.X, point.Position.Y);
            var index = MapGeometry.ClosestIndex(document.Centerline, viewBoxPoint);
            SeekRequested?.Invoke(this, index);
            args.Handled = true;
        }
    }

    private void OnPointerMoved(object sender, PointerRoutedEventArgs args)
    {
        if (_overlayPointerId is null)
        {
            return;
        }
        var point = args.GetCurrentPoint(InputSurface);
        if (point.PointerId != _overlayPointerId)
        {
            return;
        }
        OverlayOffsetX = _overlayStartX + point.Position.X - _overlayDragStart.X;
        OverlayOffsetY = _overlayStartY + point.Position.Y - _overlayDragStart.Y;
        OverlayMoved?.Invoke(this, EventArgs.Empty);
        args.Handled = true;
    }

    private void OnPointerReleased(object sender, PointerRoutedEventArgs args)
    {
        if (_overlayPointerId != args.Pointer.PointerId)
        {
            return;
        }
        InputSurface.ReleasePointerCapture(args.Pointer);
        _overlayPointerId = null;
        args.Handled = true;
    }

    private static Vector2 ToVector(MapPoint point) => new((float)point.X, (float)point.Y);

    private static Color ColorFromHex(string hex)
    {
        var value = Convert.ToUInt32(hex.TrimStart('#'), 16);
        return Color.FromArgb(255, (byte)(value >> 16), (byte)(value >> 8), (byte)value);
    }
}
