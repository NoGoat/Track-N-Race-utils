"""Track Map Marker Editor (PyQt6).

A standalone GUI for inspecting and hand-editing the marker collections stored in
``telemetry-mapper/final_json/track_<id>.json`` maps against the actual track shape.

Features
--------
* Loads any final_json map and renders it exactly as the app draws it — rotating the
  view-box-space sectors by ``rotation_deg`` about the view-box centre and refitting to
  the widget, mirroring ``live_mapper._prepare_map_view`` / TrackMap.tsx's prepareMap().
* A seek bar scrubs a dot along the track centreline (the concatenation of every
  ``sectors[].points``), which is a closed loop starting and ending at the Start/Finish line.
* Marking captures the coordinate under the seek dot (snapped to the centreline) and adds
  it to a collection — single-point (speed traps, start/finish, custom) or start/end zone
  (DRS, SLM, custom).
* Existing markers are listed in a table; rows can be selected to highlight, delete, or move.
* Imports dry or wet Straight Line Mode zones from Track N Race ``.tnrd`` recordings.
* Saving prompts for a destination each time (in-place or a copy), preserving every other key.

Requires: PyQt6 and PyQt6-Fluent-Widgets. Importing current TNRD V2 files also
requires the ``zstandard`` Python package (or a ``zstd`` executable on PATH).
"""

from __future__ import annotations

import json
import math
from pathlib import Path
import sys

from PyQt6.QtCore import Qt, QTimer, QPointF, QRectF, QUrl
from PyQt6.QtGui import QColor, QPainter, QPen, QBrush, QPolygonF, QPixmap, QImage
from PyQt6.QtNetwork import QNetworkAccessManager, QNetworkRequest, QNetworkReply
from PyQt6.QtWidgets import (
    QApplication, QWidget, QVBoxLayout, QHBoxLayout, QTableWidgetItem,
    QSplitter, QFileDialog, QHeaderView, QAbstractItemView, QSizePolicy,
    QFormLayout, QFrame,
)
from qfluentwidgets import (
    FluentWidget, PushButton as QPushButton, PrimaryPushButton,
    ToolButton, Slider as QSlider, ComboBox as QComboBox,
    TableWidget as QTableWidget, CheckBox as QCheckBox,
    LineEdit as QLineEdit, DoubleSpinBox as QDoubleSpinBox,
    SpinBox as QSpinBox, SimpleCardWidget, ScrollArea,
    SubtitleLabel, BodyLabel, CaptionLabel,
    MessageBox, MessageBoxBase, InfoBar, InfoBarPosition,
    FluentIcon as FIF, Theme, setTheme, setThemeColor,
)
from qframelesswindow.utils import getSystemAccentColor

from tnrd_import import TnrdImportError, read_slm_recording, slm_zones_for_map


class FluentMessageBox:
    """Compatibility facade that presents every editor prompt as a Fluent dialog."""

    class StandardButton:
        Yes = 1
        No = 2

    @staticmethod
    def _alert(parent, title, content):
        dialog = MessageBox(title, content, parent)
        dialog.yesButton.setText('Close')
        dialog.cancelButton.hide()
        dialog.exec()

    @classmethod
    def information(cls, parent, title, content):
        cls._alert(parent, title, content)

    @classmethod
    def warning(cls, parent, title, content):
        cls._alert(parent, title, content)

    @classmethod
    def critical(cls, parent, title, content):
        cls._alert(parent, title, content)

    @classmethod
    def question(cls, parent, title, content, *_args):
        dialog = MessageBox(title, content, parent)
        dialog.yesButton.setText('Yes')
        dialog.cancelButton.setText('No')
        if len(_args) >= 2 and _args[1] == cls.StandardButton.No:
            dialog.cancelButton.setFocus()
        return cls.StandardButton.Yes if dialog.exec() else cls.StandardButton.No


class FluentInputDialog:
    """Small Fluent equivalents of the two QInputDialog calls used here."""

    @staticmethod
    def _exec(parent, title, label, control):
        dialog = MessageBoxBase(parent)
        dialog.widget.setMinimumWidth(420)
        dialog.viewLayout.addWidget(SubtitleLabel(title))
        description = BodyLabel(label)
        description.setWordWrap(True)
        dialog.viewLayout.addWidget(description)
        dialog.viewLayout.addWidget(control)
        return bool(dialog.exec())

    @classmethod
    def getText(cls, parent, title, label):
        edit = QLineEdit()
        edit.setClearButtonEnabled(True)
        accepted = cls._exec(parent, title, label, edit)
        return edit.text(), accepted

    @classmethod
    def getItem(cls, parent, title, label, items, current=0, _editable=False):
        combo = QComboBox()
        combo.addItems(list(items))
        combo.setCurrentIndex(current)
        accepted = cls._exec(parent, title, label, combo)
        return combo.currentText(), accepted


# Keep the editing logic below compact while replacing its legacy dialogs.
QMessageBox = FluentMessageBox
QInputDialog = FluentInputDialog

# ── Constants (kept in sync with live_mapper.py) ─────────────────────────────
VIEWBOX      = 1000
MAP_ROT_PAD  = 24            # padding around the rotated bounds (TrackMap.tsx's MAP_PAD)
FINAL_JSON_DIR = Path(__file__).parent / 'final_json'

BG_COLOR     = '#111216'
LAP_COLORS   = ['#5794F2', '#73BF69', '#FADE2A', '#F2495C', '#FF9830',
                '#B877D9', '#19B8C2', '#E05F73', '#8AB8FF', '#96D98D']
DRS_START_COLOR = '#73BF69'
DRS_END_COLOR   = '#F2495C'
SLM_DRY_COLOR   = '#FFB86C'
SLM_WET_COLOR   = '#BD93F9'
SF_COLOR        = '#e10600'
TRAP_COLOR      = '#FADE2A'
OT_DETECT_COLOR   = '#5794F2'   # overtake_detection_point  (blue square)
OT_ACTIVATE_COLOR = '#FF9830'   # overtake_activation_point (orange square)
DRS_DETECT_COLOR  = '#73BF69'   # drs_detection_points      (green square)
CUSTOM_ZONE_COLOR  = '#5794F2'
CUSTOM_POINT_COLOR = '#96D98D'
SEEK_COLOR      = '#19D3E6'
HIGHLIGHT_COLOR = '#ffffff'
PENDING_COLOR   = '#00E5FF'

# Keys that are never marker collections.
NON_MARKER_KEYS = {
    'track_id', 'track_name', 'circuit_name', 'track_length_m', 'pit_time',
    'inlap_pit_time', 'outlap_pit_time', 'view_box', 'rotation_deg', 'transform',
    'sectors',
}
# Known marker collections and their kinds. Offered even when absent so the user
# can start populating an empty one.
KNOWN_KINDS = {
    'drs_zones':                 'zone_list',
    'drs_detection_points':      'point_list',
    'slm_dry':                   'zone_list',
    'slm_wet':                   'zone_list',
    'speed_traps':               'point_list',
    'overtake_detection_point':  'point_scalar',
    'overtake_activation_point': 'point_scalar',
    'start_finish':              'point_scalar',
}

# Point collections drawn as squares (rather than the default circle / trap diamond).
SQUARE_POINT_KEYS = {
    'drs_detection_points', 'overtake_detection_point', 'overtake_activation_point',
}

NEW_COLLECTION_SENTINEL = '➕  New collection…'


# ── Geometry (ports of live_mapper's render transform) ───────────────────────
class MapView:
    """Rotation about the view-box centre + uniform scale/offset to fit the widget.

    Mirrors ``live_mapper._MapView``; ``to_canvas`` rotates then scales+offsets, and
    ``to_viewbox`` inverts it (used to snap mouse clicks back onto the centreline)."""

    def __init__(self, cos_r, sin_r, cx, cy, scale, ox, oy):
        self.cos_r, self.sin_r = cos_r, sin_r
        self.cx, self.cy = cx, cy
        self.scale, self.ox, self.oy = scale, ox, oy

    def _rotate(self, x, y):
        dx, dy = x - self.cx, y - self.cy
        return (self.cos_r * dx - self.sin_r * dy + self.cx,
                self.sin_r * dx + self.cos_r * dy + self.cy)

    def to_canvas(self, pt):
        rx, ry = self._rotate(pt[0], pt[1])
        return (rx * self.scale + self.ox, ry * self.scale + self.oy)

    def to_viewbox(self, px, py):
        rx = (px - self.ox) / self.scale
        ry = (py - self.oy) / self.scale
        # inverse rotation
        dx, dy = rx - self.cx, ry - self.cy
        return (self.cos_r * dx + self.sin_r * dy + self.cx,
                -self.sin_r * dx + self.cos_r * dy + self.cy)


def prepare_map_view(final_map: dict, canvas_w: int, canvas_h: int) -> MapView:
    """Faithful port of ``live_mapper._prepare_map_view`` — rotate the persisted
    sector points about the view-box centre by ``rotation_deg``, bound the rotated
    points, and fit them into the widget with MAP_ROT_PAD padding."""
    rot_rad = math.radians(final_map.get('rotation_deg', 0) or 0)
    cos_r, sin_r = math.cos(rot_rad), math.sin(rot_rad)
    view_box = final_map.get('view_box') or {'width': VIEWBOX, 'height': VIEWBOX}
    cx, cy = view_box['width'] / 2, view_box['height'] / 2

    def rot(pt):
        dx, dy = pt[0] - cx, pt[1] - cy
        return cos_r * dx - sin_r * dy + cx, sin_r * dx + cos_r * dy + cy

    min_x = min_y = float('inf')
    max_x = max_y = float('-inf')
    for sector in final_map.get('sectors', []):
        for p in sector['points']:
            rx, ry = rot(p)
            min_x, max_x = min(min_x, rx), max(max_x, rx)
            min_y, max_y = min(min_y, ry), max(max_y, ry)

    if min_x > max_x:  # no sector points — fall back to the full view_box
        min_x, min_y, max_x, max_y = 0, 0, view_box['width'], view_box['height']

    w = (max_x - min_x) or 1
    h = (max_y - min_y) or 1
    scale = min((canvas_w - 2 * MAP_ROT_PAD) / w, (canvas_h - 2 * MAP_ROT_PAD) / h)
    ox = (canvas_w - w * scale) / 2 - min_x * scale
    oy = (canvas_h - h * scale) / 2 - min_y * scale
    return MapView(cos_r, sin_r, cx, cy, scale, ox, oy)


def closest_idx(centerline, pt) -> int:
    """Index of the centreline point nearest ``pt`` (port of ``_closest_idx``)."""
    best_i, best_d = 0, float('inf')
    px, py = pt[0], pt[1]
    for i, (x, y) in enumerate(centerline):
        d = (x - px) ** 2 + (y - py) ** 2
        if d < best_d:
            best_d, best_i = d, i
    return best_i


def infer_kind(key: str, value) -> str | None:
    """Return the marker kind for a top-level key/value, or None if not a marker."""
    if key in KNOWN_KINDS:
        return KNOWN_KINDS[key]
    if key in NON_MARKER_KEYS:
        return None
    if isinstance(value, list) and value:
        first = value[0]
        if isinstance(first, dict) and 'start' in first and 'end' in first:
            return 'zone_list'
        if isinstance(first, (list, tuple)) and len(first) == 2 \
                and all(isinstance(n, (int, float)) for n in first):
            return 'point_list'
    if isinstance(value, list) and len(value) == 2 \
            and all(isinstance(n, (int, float)) for n in value):
        return 'point_scalar'
    return None


def build_centerline(data: dict):
    """Concatenate every sector's points into one ordered centreline, plus a
    per-index sector-label lookup."""
    centerline = []
    sector_of = []
    for sector in data.get('sectors', []):
        label = sector.get('index', len(sector_of) and sector_of[-1] or 1)
        for p in sector['points']:
            centerline.append((float(p[0]), float(p[1])))
            sector_of.append(label)
    return centerline, sector_of


# ── Map canvas ───────────────────────────────────────────────────────────────
class MapCanvas(QWidget):
    """Custom-painted track map. State is pushed in by the main window."""

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setMinimumSize(500, 500)
        self.data = None
        self.centerline = []
        self.kinds = {}                 # key -> kind
        self.view: MapView | None = None
        self.seek_index = 0
        self.selection = None           # (key, row) currently highlighted
        self.pending = {}               # {'start': [x,y], 'end': [x,y]} preview
        self.visible = {}               # key -> bool (render toggle)
        # Background reference overlay (e.g. an official FIA map) drawn behind the track.
        self.overlay = None             # QPixmap | None
        self.overlay_opacity = 0.5
        self.overlay_rot = 0.0          # degrees
        self.overlay_scale = 1.0
        self.overlay_dx = 0.0           # pixel offset from canvas centre
        self.overlay_dy = 0.0
        self._ov_drag = None            # right-drag reposition state
        self.on_overlay_moved = None    # callback(dx, dy) to sync the spin boxes
        self.setMouseTracking(False)

    def set_overlay(self, pixmap):
        self.overlay = pixmap
        self.update()

    def set_data(self, data, centerline, kinds):
        self.data = data
        self.centerline = centerline
        self.kinds = kinds
        self.visible = {k: True for k in kinds}
        self.seek_index = 0
        self.selection = None
        self.pending = {}
        self._recompute_view()
        self.update()

    def _recompute_view(self):
        if self.data and self.data.get('sectors'):
            self.view = prepare_map_view(self.data, self.width(), self.height())
        else:
            self.view = None

    def resizeEvent(self, event):
        self._recompute_view()
        super().resizeEvent(event)

    def mousePressEvent(self, event):
        """Left click seeks to the nearest centreline point; right-drag moves the overlay."""
        if event.button() == Qt.MouseButton.RightButton and self.overlay is not None:
            self._ov_drag = (event.position().x(), event.position().y(),
                             self.overlay_dx, self.overlay_dy)
            return
        if self.view and self.centerline and event.button() == Qt.MouseButton.LeftButton:
            vb = self.view.to_viewbox(event.position().x(), event.position().y())
            idx = closest_idx(self.centerline, vb)
            win = self.window()
            if isinstance(win, MainWindow):
                win.set_seek(idx)
        super().mousePressEvent(event)

    def mouseMoveEvent(self, event):
        if self._ov_drag is not None:
            x0, y0, dx0, dy0 = self._ov_drag
            self.overlay_dx = dx0 + (event.position().x() - x0)
            self.overlay_dy = dy0 + (event.position().y() - y0)
            if self.on_overlay_moved:
                self.on_overlay_moved(self.overlay_dx, self.overlay_dy)
            self.update()
            return
        super().mouseMoveEvent(event)

    def mouseReleaseEvent(self, event):
        if event.button() == Qt.MouseButton.RightButton and self._ov_drag is not None:
            self._ov_drag = None
            return
        super().mouseReleaseEvent(event)

    # -- drawing helpers --
    def _c(self, pt):
        x, y = self.view.to_canvas(pt)
        return QPointF(x, y)

    def paintEvent(self, event):
        p = QPainter(self)
        p.setRenderHint(QPainter.RenderHint.Antialiasing)
        p.setRenderHint(QPainter.RenderHint.SmoothPixmapTransform)
        p.fillRect(self.rect(), QColor(BG_COLOR))

        # Background reference overlay (drawn first, behind the track)
        if self.overlay is not None and not self.overlay.isNull():
            p.save()
            p.setOpacity(self.overlay_opacity)
            p.translate(self.width() / 2 + self.overlay_dx,
                        self.height() / 2 + self.overlay_dy)
            p.rotate(self.overlay_rot)
            p.scale(self.overlay_scale, self.overlay_scale)
            p.drawPixmap(QPointF(-self.overlay.width() / 2, -self.overlay.height() / 2),
                         self.overlay)
            p.restore()
            p.setOpacity(1.0)

        if not self.view or not self.data:
            p.setPen(QColor('#555'))
            p.drawText(self.rect(), Qt.AlignmentFlag.AlignCenter,
                       'Open a final_json track map to begin')
            return

        # Sector polylines
        for i, sector in enumerate(self.data.get('sectors', [])):
            pts = [self._c(pt) for pt in sector['points']]
            if len(pts) >= 2:
                p.setPen(QPen(QColor(LAP_COLORS[i % len(LAP_COLORS)]), 2))
                p.drawPolyline(QPolygonF(pts))

        # Marker collections (skip any toggled off)
        for key, kind in self.kinds.items():
            if not self.visible.get(key, True):
                continue
            self._draw_collection(p, key, kind)

        # Pending zone preview (being built in the add panel)
        if self.pending.get('start'):
            self._draw_ring(p, self.pending['start'], PENDING_COLOR, 7, filled=False)
        if self.pending.get('end'):
            self._draw_ring(p, self.pending['end'], PENDING_COLOR, 7, filled=False)

        # Seek dot
        if self.centerline:
            i = max(0, min(self.seek_index, len(self.centerline) - 1))
            c = self._c(self.centerline[i])
            p.setPen(QPen(QColor(HIGHLIGHT_COLOR), 1.5))
            p.setBrush(QBrush(QColor(SEEK_COLOR)))
            p.drawEllipse(c, 6, 6)

    def _draw_collection(self, p, key, kind):
        value = self.data.get(key)
        if kind == 'point_scalar':
            if value:
                self._draw_point(p, key, value, self._is_sel(key, 0))
        elif kind == 'point_list':
            for row, pt in enumerate(value or []):
                self._draw_point(p, key, pt, self._is_sel(key, row))
        elif kind == 'zone_list':
            for row, zone in enumerate(value or []):
                self._draw_zone(p, key, zone, self._is_sel(key, row))

    def _is_sel(self, key, row):
        return self.selection == (key, row)

    def _point_color(self, key):
        return {
            'start_finish':              SF_COLOR,
            'speed_traps':               TRAP_COLOR,
            'overtake_detection_point':  OT_DETECT_COLOR,
            'overtake_activation_point': OT_ACTIVATE_COLOR,
            'drs_detection_points':      DRS_DETECT_COLOR,
        }.get(key, CUSTOM_POINT_COLOR)

    def _zone_colors(self, key):
        if key == 'drs_zones':
            return DRS_START_COLOR, DRS_END_COLOR
        if key == 'slm_dry':
            return SLM_DRY_COLOR, SLM_DRY_COLOR
        if key == 'slm_wet':
            return SLM_WET_COLOR, SLM_WET_COLOR
        return CUSTOM_ZONE_COLOR, CUSTOM_ZONE_COLOR

    def _draw_point(self, p, key, pt, selected):
        color = self._point_color(key)
        c = self._c(pt)
        r = 8 if selected else 6
        p.setPen(QPen(QColor(HIGHLIGHT_COLOR), 2.5 if selected else 1.2))
        p.setBrush(QBrush(QColor(color)))
        if key == 'speed_traps':                     # diamond
            poly = QPolygonF([QPointF(c.x(), c.y() - r), QPointF(c.x() + r, c.y()),
                              QPointF(c.x(), c.y() + r), QPointF(c.x() - r, c.y())])
            p.drawPolygon(poly)
        elif key in SQUARE_POINT_KEYS:               # square
            p.drawRect(QRectF(c.x() - r, c.y() - r, 2 * r, 2 * r))
        else:                                         # circle
            p.drawEllipse(c, r, r)

    def _draw_zone(self, p, key, zone, selected):
        start, end = zone.get('start'), zone.get('end')
        if not start or not end:
            return
        c_start, c_end = self._zone_colors(key)
        # Highlighted centreline slice between nearest indices
        if self.centerline:
            si = closest_idx(self.centerline, start)
            ei = closest_idx(self.centerline, end)
            idxs = self._slice_indices(si, ei)
            pts = [self._c(self.centerline[k]) for k in idxs]
            if len(pts) >= 2:
                width = 6 if selected else 4
                col = QColor(c_start)
                col.setAlpha(200 if selected else 120)
                p.setPen(QPen(col, width, Qt.PenStyle.SolidLine, Qt.PenCapStyle.RoundCap))
                p.setBrush(Qt.BrushStyle.NoBrush)
                p.drawPolyline(QPolygonF(pts))
        # Endpoints
        self._draw_ring(p, start, c_start, 8 if selected else 6, filled=True,
                        outline=selected)
        self._draw_ring(p, end, c_end, 8 if selected else 6, filled=True,
                        outline=selected)

    def _slice_indices(self, si, ei):
        n = len(self.centerline)
        if n == 0:
            return []
        if si <= ei:
            return list(range(si, ei + 1))
        # wrap across the S/F line
        return list(range(si, n)) + list(range(0, ei + 1))

    def _draw_ring(self, p, pt, color, r, filled=True, outline=True):
        c = self._c(pt)
        p.setPen(QPen(QColor(HIGHLIGHT_COLOR), 2.5 if outline else 1.2))
        p.setBrush(QBrush(QColor(color)) if filled else Qt.BrushStyle.NoBrush)
        p.drawEllipse(c, r, r)


# ── Main window ──────────────────────────────────────────────────────────────
class MainWindow(FluentWidget):
    def __init__(self):
        super().__init__()
        self.setWindowTitle('Track Map Marker Editor')
        self.setWindowIcon(FIF.EDIT.icon())
        self.resize(1440, 920)
        self.setMinimumSize(1080, 700)

        self.data: dict | None = None
        self.path: Path | None = None
        self.centerline = []
        self.sector_of = []
        self.kinds: dict[str, str] = {}
        self.dirty = False
        self._suppress_combo = False
        self._net = QNetworkAccessManager(self)

        self._build_toolbar()
        self._build_body()
        self._build_seekbar()
        self._compose_interface()

        self.play_timer = QTimer(self)
        self.play_timer.setInterval(30)
        self.play_timer.timeout.connect(self._advance_play)

        self._set_controls_enabled(False)

    # -- UI construction --
    def _build_toolbar(self):
        self.action_card = SimpleCardWidget()
        self.action_card.setBorderRadius(8)
        card_layout = QVBoxLayout(self.action_card)
        card_layout.setContentsMargins(16, 14, 16, 14)
        card_layout.setSpacing(8)

        button_row = QHBoxLayout()
        button_row.setSpacing(8)

        self.btn_open = QPushButton('Open')
        self.btn_open.setIcon(FIF.FOLDER)
        self.btn_open.clicked.connect(self.open_file)
        button_row.addWidget(self.btn_open)

        self.btn_import_tnrd = QPushButton('Import')
        self.btn_import_tnrd.setIcon(FIF.DOWNLOAD)
        self.btn_import_tnrd.setToolTip(
            'Import Straight Line Mode zones from a Track N Race recording')
        self.btn_import_tnrd.clicked.connect(self.import_tnrd)
        button_row.addWidget(self.btn_import_tnrd)

        self.btn_save = PrimaryPushButton('Save')
        self.btn_save.setIcon(FIF.SAVE)
        self.btn_save.clicked.connect(self.save_file)
        button_row.addWidget(self.btn_save)

        card_layout.addLayout(button_row)

        self.info_label = CaptionLabel('No map loaded')
        self.info_label.setWordWrap(True)
        card_layout.addWidget(self.info_label)

    def _build_body(self):
        splitter = QSplitter(Qt.Orientation.Horizontal)
        splitter.setChildrenCollapsible(False)
        splitter.setHandleWidth(8)
        splitter.setStyleSheet('QSplitter::handle { background: transparent; }')

        self.canvas = MapCanvas()
        canvas_card = SimpleCardWidget()
        canvas_card.setBorderRadius(8)
        canvas_layout = QVBoxLayout(canvas_card)
        canvas_layout.setContentsMargins(6, 6, 6, 6)
        canvas_layout.addWidget(self.canvas)
        splitter.addWidget(canvas_card)

        panel = QWidget()
        panel.setObjectName('propertiesPanel')
        panel.setFixedWidth(372)
        v = QVBoxLayout(panel)
        v.setContentsMargins(0, 0, 8, 0)
        v.setSpacing(12)

        v.addWidget(self.action_card)

        collection_card = SimpleCardWidget()
        collection_card.setBorderRadius(8)
        collection_layout = QVBoxLayout(collection_card)
        collection_layout.setContentsMargins(16, 14, 16, 16)
        collection_layout.setSpacing(8)
        collection_layout.addWidget(SubtitleLabel('Marker collection'))
        collection_layout.addWidget(CaptionLabel(
            'Choose the points or zones you want to inspect and edit.'))
        self.collection_combo = QComboBox()
        self.collection_combo.currentIndexChanged.connect(self._on_collection_changed)
        collection_layout.addWidget(self.collection_combo)
        self.kind_label = CaptionLabel('')
        collection_layout.addWidget(self.kind_label)
        v.addWidget(collection_card)

        # Per-collection render toggles (rebuilt per loaded file)
        self.visibility_group = SimpleCardWidget()
        self.visibility_group.setBorderRadius(8)
        visibility_card_layout = QVBoxLayout(self.visibility_group)
        visibility_card_layout.setContentsMargins(16, 14, 16, 16)
        visibility_card_layout.setSpacing(7)
        visibility_card_layout.addWidget(SubtitleLabel('Map layers'))
        visibility_card_layout.addWidget(CaptionLabel(
            'Show or hide marker collections without changing map data.'))
        visibility_items = QWidget()
        self.visibility_layout = QVBoxLayout(visibility_items)
        self.visibility_layout.setContentsMargins(0, 4, 0, 0)
        self.visibility_layout.setSpacing(7)
        visibility_card_layout.addWidget(visibility_items)
        v.addWidget(self.visibility_group)

        edit_card = SimpleCardWidget()
        edit_card.setBorderRadius(8)
        edit_layout = QVBoxLayout(edit_card)
        edit_layout.setContentsMargins(16, 14, 16, 16)
        edit_layout.setSpacing(8)
        edit_layout.addWidget(SubtitleLabel('Points and zones'))
        edit_layout.addWidget(CaptionLabel(
            'Use the cyan seek marker as the position for additions or updates.'))

        # Point add controls
        self.point_add_box = QWidget()
        pv = QVBoxLayout(self.point_add_box)
        pv.setContentsMargins(0, 4, 0, 2)
        self.btn_add_point = PrimaryPushButton('Add point at marker')
        self.btn_add_point.setIcon(FIF.ADD)
        self.btn_add_point.clicked.connect(self._add_point_at_dot)
        pv.addWidget(self.btn_add_point)
        edit_layout.addWidget(self.point_add_box)

        # Zone add controls
        self.zone_add_box = QWidget()
        zv = QVBoxLayout(self.zone_add_box)
        zv.setContentsMargins(0, 4, 0, 2)
        zv.setSpacing(8)
        row = QHBoxLayout()
        self.btn_set_start = QPushButton('Set start')
        self.btn_set_start.setIcon(FIF.PIN)
        self.btn_set_start.clicked.connect(lambda: self._set_pending('start'))
        self.btn_set_end = QPushButton('Set end')
        self.btn_set_end.setIcon(FIF.FLAG)
        self.btn_set_end.clicked.connect(lambda: self._set_pending('end'))
        row.addWidget(self.btn_set_start)
        row.addWidget(self.btn_set_end)
        zv.addLayout(row)
        self.pending_label = CaptionLabel('start: —   end: —')
        zv.addWidget(self.pending_label)
        self.btn_add_zone = PrimaryPushButton('Add zone')
        self.btn_add_zone.setIcon(FIF.ADD)
        self.btn_add_zone.clicked.connect(self._add_zone)
        zv.addWidget(self.btn_add_zone)
        edit_layout.addWidget(self.zone_add_box)

        # Table
        self.table = QTableWidget()
        self.table.setMinimumHeight(230)
        self.table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.table.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self.table.itemSelectionChanged.connect(self._on_row_selected)
        edit_layout.addWidget(self.table)

        # Edit controls
        edit_row = QHBoxLayout()
        self.btn_delete = QPushButton('Delete')
        self.btn_delete.setIcon(FIF.DELETE)
        self.btn_delete.clicked.connect(self._delete_selected)
        edit_row.addWidget(self.btn_delete)
        self.btn_update_point = QPushButton('Update from marker')
        self.btn_update_point.setIcon(FIF.EDIT)
        self.btn_update_point.clicked.connect(self._update_point_from_dot)
        edit_row.addWidget(self.btn_update_point)
        edit_layout.addLayout(edit_row)

        zedit_row = QHBoxLayout()
        self.btn_update_start = QPushButton('Update start')
        self.btn_update_start.setIcon(FIF.EDIT)
        self.btn_update_start.clicked.connect(lambda: self._update_zone_from_dot('start'))
        self.btn_update_end = QPushButton('Update end')
        self.btn_update_end.setIcon(FIF.EDIT)
        self.btn_update_end.clicked.connect(lambda: self._update_zone_from_dot('end'))
        zedit_row.addWidget(self.btn_update_start)
        zedit_row.addWidget(self.btn_update_end)
        edit_layout.addLayout(zedit_row)
        v.addWidget(edit_card)

        v.addWidget(self._build_overlay_group())
        v.addStretch(1)

        panel_scroll = ScrollArea()
        panel_scroll.setWidgetResizable(True)
        panel_scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        panel_scroll.setFrameShape(QFrame.Shape.NoFrame)
        panel_scroll.setStyleSheet('QScrollArea { background: transparent; border: none; }')
        panel_scroll.viewport().setStyleSheet('background: transparent;')
        panel_scroll.setWidget(panel)
        panel_scroll.setFixedWidth(392)

        splitter.addWidget(panel_scroll)
        splitter.setStretchFactor(0, 1)
        splitter.setStretchFactor(1, 0)
        splitter.setSizes([1000, 392])
        self.body_splitter = splitter

    def _build_seekbar(self):
        bar = SimpleCardWidget()
        bar.setBorderRadius(8)
        h = QHBoxLayout(bar)
        h.setContentsMargins(14, 8, 16, 8)
        h.setSpacing(10)
        self.btn_step_back = ToolButton(FIF.PAGE_LEFT)
        self.btn_step_back.setToolTip('Back one tick')
        self.btn_step_back.setFixedSize(34, 34)
        self.btn_step_back.clicked.connect(lambda: self._step(-1))
        h.addWidget(self.btn_step_back)
        self.btn_play = ToolButton(FIF.PLAY)
        self.btn_play.setToolTip('Play')
        self.btn_play.setFixedSize(34, 34)
        self.btn_play.clicked.connect(self._toggle_play)
        h.addWidget(self.btn_play)
        self.btn_step_fwd = ToolButton(FIF.PAGE_RIGHT)
        self.btn_step_fwd.setToolTip('Forward one tick')
        self.btn_step_fwd.setFixedSize(34, 34)
        self.btn_step_fwd.clicked.connect(lambda: self._step(1))
        h.addWidget(self.btn_step_fwd)
        self.slider = QSlider(Qt.Orientation.Horizontal)
        self.slider.setMinimum(0)
        self.slider.setMaximum(0)
        self.slider.valueChanged.connect(self._on_slider)
        h.addWidget(self.slider, 1)
        self.pos_label = CaptionLabel('—')
        self.pos_label.setMinimumWidth(240)
        h.addWidget(self.pos_label)

        # Keep the seek bar to its natural (small) height so the canvas gets the rest.
        bar.setSizePolicy(bar.sizePolicy().horizontalPolicy(),
                          QSizePolicy.Policy.Fixed)

        self.seek_card = bar

    def _compose_interface(self):
        layout = QVBoxLayout(self)
        layout.setContentsMargins(18, self.titleBar.height() + 12, 18, 18)
        layout.setSpacing(12)
        layout.addWidget(self.body_splitter, 1)
        layout.addWidget(self.seek_card)

    def _build_overlay_group(self) -> SimpleCardWidget:
        """Reference-image overlay (e.g. an official FIA map) to trace against."""
        box = SimpleCardWidget()
        box.setBorderRadius(8)
        v = QVBoxLayout(box)
        v.setContentsMargins(16, 14, 16, 16)
        v.setSpacing(8)
        v.addWidget(SubtitleLabel('Reference overlay'))
        subtitle = CaptionLabel(
            'Align an FIA or circuit image behind the generated centreline.')
        subtitle.setWordWrap(True)
        v.addWidget(subtitle)

        self.overlay_url_edit = QLineEdit()
        self.overlay_url_edit.setPlaceholderText('https://…/map.webp')
        self.overlay_url_edit.returnPressed.connect(self._load_overlay)
        v.addWidget(self.overlay_url_edit)

        btn_row = QHBoxLayout()
        btn_load = QPushButton('Load')
        btn_load.setIcon(FIF.PHOTO)
        btn_load.clicked.connect(self._load_overlay)
        btn_clear = QPushButton('Clear')
        btn_clear.setIcon(FIF.REMOVE)
        btn_clear.clicked.connect(self._clear_overlay)
        btn_row.addWidget(btn_load)
        btn_row.addWidget(btn_clear)
        v.addLayout(btn_row)

        form = QFormLayout()
        form.setContentsMargins(0, 2, 0, 0)

        self.ov_opacity = QSlider(Qt.Orientation.Horizontal)
        self.ov_opacity.setRange(0, 100)
        self.ov_opacity.setValue(50)
        self.ov_opacity.valueChanged.connect(
            lambda val: self._set_overlay_attr('overlay_opacity', val / 100))
        form.addRow(CaptionLabel('Opacity'), self.ov_opacity)

        self.ov_rot = QDoubleSpinBox()
        self.ov_rot.setRange(-180.0, 180.0)
        self.ov_rot.setSingleStep(0.5)
        self.ov_rot.setSuffix(' °')
        self.ov_rot.valueChanged.connect(
            lambda val: self._set_overlay_attr('overlay_rot', val))
        form.addRow(CaptionLabel('Rotation'), self.ov_rot)

        self.ov_scale = QDoubleSpinBox()
        self.ov_scale.setRange(5.0, 1000.0)
        self.ov_scale.setSingleStep(1.0)
        self.ov_scale.setSuffix(' %')
        self.ov_scale.setValue(100.0)
        self.ov_scale.valueChanged.connect(
            lambda val: self._set_overlay_attr('overlay_scale', val / 100))
        form.addRow(CaptionLabel('Scale'), self.ov_scale)

        self.ov_x = QSpinBox()
        self.ov_x.setRange(-4000, 4000)
        self.ov_x.valueChanged.connect(
            lambda val: self._set_overlay_attr('overlay_dx', float(val)))
        form.addRow(CaptionLabel('Offset X'), self.ov_x)

        self.ov_y = QSpinBox()
        self.ov_y.setRange(-4000, 4000)
        self.ov_y.valueChanged.connect(
            lambda val: self._set_overlay_attr('overlay_dy', float(val)))
        form.addRow(CaptionLabel('Offset Y'), self.ov_y)

        v.addLayout(form)
        hint = CaptionLabel('Tip: right-drag on the map to reposition the overlay.')
        hint.setWordWrap(True)
        v.addWidget(hint)

        self.canvas.on_overlay_moved = self._on_overlay_moved
        return box

    def _set_overlay_attr(self, attr, value):
        setattr(self.canvas, attr, value)
        self.canvas.update()

    def _on_overlay_moved(self, dx, dy):
        for spin, val in ((self.ov_x, dx), (self.ov_y, dy)):
            spin.blockSignals(True)
            spin.setValue(int(round(val)))
            spin.blockSignals(False)

    def _load_overlay(self):
        url = self.overlay_url_edit.text().strip()
        if not url:
            self._clear_overlay()
            return
        reply = self._net.get(QNetworkRequest(QUrl(url)))
        reply.finished.connect(lambda: self._on_overlay_loaded(reply))

    def _on_overlay_loaded(self, reply):
        err = reply.error()
        data = bytes(reply.readAll())
        reply.deleteLater()
        if err != QNetworkReply.NetworkError.NoError:
            QMessageBox.warning(self, 'Overlay', f'Download failed:\n{reply.errorString()}')
            return
        img = QImage()
        if not img.loadFromData(data):
            QMessageBox.warning(
                self, 'Overlay',
                'Could not decode the image. Is the URL a valid WebP/PNG/JPG?')
            return
        self.canvas.set_overlay(QPixmap.fromImage(img))
        InfoBar.success(
            'Overlay loaded', 'The reference image is ready to align.',
            duration=2500, position=InfoBarPosition.TOP_RIGHT, parent=self)

    def _clear_overlay(self):
        self.canvas.set_overlay(None)

    # -- file I/O --
    def open_file(self):
        start_dir = str(FINAL_JSON_DIR if FINAL_JSON_DIR.exists() else Path.cwd())
        path, _ = QFileDialog.getOpenFileName(
            self, 'Open track map', start_dir, 'JSON files (*.json)')
        if not path:
            return
        try:
            data = json.loads(Path(path).read_text(encoding='utf-8'))
        except Exception as e:                          # noqa: BLE001
            QMessageBox.critical(self, 'Error', f'Failed to read file:\n{e}')
            return
        if not data.get('sectors'):
            QMessageBox.warning(self, 'No sectors',
                                'This file has no "sectors" — cannot render a track.')
            return
        self.data = data
        self.path = Path(path)
        self.centerline, self.sector_of = build_centerline(data)
        self.kinds = self._discover_kinds(data)
        self.dirty = False

        self.canvas.set_data(data, self.centerline, self.kinds)
        self.slider.setMaximum(max(0, len(self.centerline) - 1))
        self.slider.setValue(0)
        self._rebuild_visibility_checks()
        self._refresh_collection_combo()
        self._set_controls_enabled(True)
        self._update_title()
        self._update_info()
        self._update_pos_label(0)
        InfoBar.success(
            'Map loaded', self.path.name,
            duration=2500, position=InfoBarPosition.TOP_RIGHT, parent=self)

    def save_file(self):
        if not self.data:
            return
        default = str(self.path) if self.path else str(FINAL_JSON_DIR)
        path, _ = QFileDialog.getSaveFileName(
            self, 'Save track map', default, 'JSON files (*.json)')
        if not path:
            return
        try:
            Path(path).write_text(
                json.dumps(self.data, indent=2, ensure_ascii=False), encoding='utf-8')
        except Exception as e:                          # noqa: BLE001
            QMessageBox.critical(self, 'Error', f'Failed to save:\n{e}')
            return
        self.path = Path(path)
        self.dirty = False
        self._update_title()
        self.info_label.setText(f'Saved → {self.path.name}')
        InfoBar.success(
            'Map saved', self.path.name,
            duration=2500, position=InfoBarPosition.TOP_RIGHT, parent=self)

    def import_tnrd(self):
        """Import SLM transition points from a Track N Race recording."""
        if not self.data:
            return
        start_dir = str(self.path.parent if self.path else Path.cwd())
        path, _ = QFileDialog.getOpenFileName(
            self, 'Import Track N Race recording', start_dir,
            'Track N Race recordings (*.tnrd *.trnd)')
        if not path:
            return

        QApplication.setOverrideCursor(Qt.CursorShape.WaitCursor)
        try:
            recording = read_slm_recording(path)
        except TnrdImportError as exc:
            QMessageBox.critical(self, 'TNRD import failed', str(exc))
            return
        except Exception as exc:                       # noqa: BLE001
            QMessageBox.critical(self, 'TNRD import failed', f'Failed to read file:\n{exc}')
            return
        finally:
            QApplication.restoreOverrideCursor()

        if recording.telemetry_samples == 0:
            QMessageBox.warning(
                self, 'No Straight Line Mode data',
                'This recording has no telemetry rows containing Straight Line Mode data.')
            return
        if recording.position_samples == 0:
            QMessageBox.warning(
                self, 'No position data',
                'This recording has no player position rows, so its SLM points cannot be mapped.')
            return

        recorded_track = recording.header.get('track_id')
        map_track = self.data.get('track_id')
        if recorded_track is not None and map_track is not None \
                and recorded_track != map_track:
            response = QMessageBox.question(
                self, 'Track mismatch',
                f'The recording is for track {recorded_track}, but the open map is '
                f'track {map_track}. Import it anyway?',
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
                QMessageBox.StandardButton.No)
            if response != QMessageBox.StandardButton.Yes:
                return

        data_type, ok = QInputDialog.getItem(
            self, 'Import TNRD data', 'Data to import:',
            ['Straight Line Mode'], 0, False)
        if not ok or data_type != 'Straight Line Mode':
            return
        weather, ok = QInputDialog.getItem(
            self, 'Straight Line Mode', 'Session conditions:',
            ['Dry', 'Wet'], 0, False)
        if not ok:
            return
        target_key = 'slm_dry' if weather == 'Dry' else 'slm_wet'

        try:
            zones = slm_zones_for_map(self.data, recording)
        except TnrdImportError as exc:
            QMessageBox.critical(self, 'TNRD import failed', str(exc))
            return
        if not zones:
            QMessageBox.warning(
                self, 'No complete SLM zones',
                'Straight Line Mode samples were found, but the recording contains no '
                'complete activation/deactivation zones.')
            return

        existing = self.data.get(target_key) or []
        if existing:
            response = QMessageBox.question(
                self, 'Replace existing zones?',
                f'“{target_key}” already contains {len(existing)} zone(s). Replace them '
                f'with the {len(zones)} zone(s) imported from this recording?',
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No,
                QMessageBox.StandardButton.No)
            if response != QMessageBox.StandardButton.Yes:
                return

        self.data[target_key] = zones
        self.canvas.visible[target_key] = True
        idx = self.collection_combo.findText(target_key)
        if idx >= 0:
            self.collection_combo.setCurrentIndex(idx)
        self._mark_dirty()
        self._refresh_table()
        self._rebuild_visibility_checks()
        self.canvas.update()
        self.info_label.setText(
            f'Imported {len(zones)} {weather.lower()} SLM zone(s) from {Path(path).name}')
        InfoBar.success(
            'Straight Line Mode imported',
            f'{len(zones)} {weather.lower()} zone(s) added to {target_key}.',
            duration=3500, position=InfoBarPosition.TOP_RIGHT, parent=self)

    def _discover_kinds(self, data):
        kinds = {}
        for key in KNOWN_KINDS:            # always offer the known set
            kinds[key] = KNOWN_KINDS[key]
        for key, value in data.items():    # plus any editable custom keys
            if key in kinds:
                continue
            kind = infer_kind(key, value)
            if kind:
                kinds[key] = kind
        return kinds

    # -- collection combo --
    def _refresh_collection_combo(self):
        self._suppress_combo = True
        self.collection_combo.clear()
        for key in self.kinds:
            self.collection_combo.addItem(key)
        self.collection_combo.addItem(NEW_COLLECTION_SENTINEL)
        self._suppress_combo = False
        if self.collection_combo.count() > 1:
            self.collection_combo.setCurrentIndex(0)
            self._on_collection_changed(0)

    def _rebuild_visibility_checks(self):
        """One checkbox per collection (including custom ones), controlling
        whether it is rendered on the map."""
        while self.visibility_layout.count():
            item = self.visibility_layout.takeAt(0)
            w = item.widget()
            if w:
                w.deleteLater()
        for key in self.kinds:
            cb = QCheckBox(key)
            cb.setChecked(self.canvas.visible.get(key, True))
            cb.toggled.connect(lambda checked, k=key: self._set_visible(k, checked))
            self.visibility_layout.addWidget(cb)

    def _set_visible(self, key, checked):
        self.canvas.visible[key] = checked
        self.canvas.update()

    def _current_key(self):
        key = self.collection_combo.currentText()
        if key == NEW_COLLECTION_SENTINEL or key not in self.kinds:
            return None
        return key

    def _on_collection_changed(self, _index):
        if self._suppress_combo:
            return
        if self.collection_combo.currentText() == NEW_COLLECTION_SENTINEL:
            self._create_collection()
            return
        self.canvas.pending = {}
        key = self._current_key()
        kind_names = {
            'point_scalar': 'Single map point',
            'point_list': 'Point collection',
            'zone_list': 'Start / end zones',
        }
        self.kind_label.setText(kind_names.get(self.kinds.get(key), ''))
        self._update_pending_label()
        self._refresh_table()
        self._update_add_controls()

    def _create_collection(self):
        name, ok = QInputDialog.getText(self, 'New collection', 'Collection key (name):')
        name = (name or '').strip()
        if not ok or not name:
            self._reselect_first()
            return
        if name in self.data or name in NON_MARKER_KEYS:
            QMessageBox.warning(self, 'Invalid', f'"{name}" already exists or is reserved.')
            self._reselect_first()
            return
        kind_label, ok = QInputDialog.getItem(
            self, 'New collection', 'Type:',
            ['Single points', 'Start/end zones'], 0, False)
        if not ok:
            self._reselect_first()
            return
        kind = 'point_list' if kind_label == 'Single points' else 'zone_list'
        self.data[name] = []
        self.kinds[name] = kind
        self.canvas.visible[name] = True
        self._mark_dirty()
        self._rebuild_visibility_checks()
        self._refresh_collection_combo()
        idx = self.collection_combo.findText(name)
        if idx >= 0:
            self.collection_combo.setCurrentIndex(idx)

    def _reselect_first(self):
        if self.collection_combo.count() > 1:
            self.collection_combo.setCurrentIndex(0)

    # -- table --
    def _refresh_table(self):
        key = self._current_key()
        self.table.clearSelection()
        self.canvas.selection = None
        if not key:
            self.table.setRowCount(0)
            self.table.setColumnCount(0)
            self.canvas.update()
            return
        kind = self.kinds[key]
        value = self.data.get(key)
        if kind == 'zone_list':
            self.table.setColumnCount(5)
            self.table.setHorizontalHeaderLabels(['#', 'start x', 'start y', 'end x', 'end y'])
            rows = value or []
            self.table.setRowCount(len(rows))
            for r, z in enumerate(rows):
                s, e = z.get('start', ['', '']), z.get('end', ['', ''])
                self._set_cells(r, [r, s[0], s[1], e[0], e[1]])
        else:  # point_list or point_scalar
            self.table.setColumnCount(3)
            self.table.setHorizontalHeaderLabels(['#', 'x', 'y'])
            rows = self._point_rows(kind, value)
            self.table.setRowCount(len(rows))
            for r, pt in enumerate(rows):
                self._set_cells(r, [r, pt[0], pt[1]])
        self.table.horizontalHeader().setSectionResizeMode(
            QHeaderView.ResizeMode.Stretch)
        self.canvas.update()

    def _point_rows(self, kind, value):
        if kind == 'point_scalar':
            return [value] if value else []
        return value or []

    def _set_cells(self, row, values):
        for col, val in enumerate(values):
            text = str(val) if not isinstance(val, float) else f'{val:g}'
            item = QTableWidgetItem(text)
            item.setFlags(item.flags() & ~Qt.ItemFlag.ItemIsEditable)
            self.table.setItem(row, col, item)

    def _on_row_selected(self):
        key = self._current_key()
        rows = self.table.selectionModel().selectedRows()
        if key and rows:
            self.canvas.selection = (key, rows[0].row())
        else:
            self.canvas.selection = None
        self.canvas.update()
        self._update_edit_controls()

    def _selected_row(self):
        rows = self.table.selectionModel().selectedRows()
        return rows[0].row() if rows else None

    # -- marking / editing --
    def _marked_point(self):
        i = self.slider.value()
        if not self.centerline:
            return None
        x, y = self.centerline[max(0, min(i, len(self.centerline) - 1))]
        return [round(x, 2), round(y, 2)]

    def _add_point_at_dot(self):
        key = self._current_key()
        if not key:
            return
        pt = self._marked_point()
        if pt is None:
            return
        kind = self.kinds[key]
        if kind == 'point_scalar':
            self.data[key] = pt
        else:
            self.data.setdefault(key, []).append(pt)
        self._after_edit()

    def _set_pending(self, which):
        pt = self._marked_point()
        if pt is None:
            return
        self.canvas.pending[which] = pt
        self._update_pending_label()
        self.canvas.update()

    def _update_pending_label(self):
        s = self.canvas.pending.get('start')
        e = self.canvas.pending.get('end')
        self.pending_label.setText(
            f'start: {self._fmt(s)}   end: {self._fmt(e)}')

    @staticmethod
    def _fmt(pt):
        return '—' if not pt else f'[{pt[0]:g}, {pt[1]:g}]'

    def _add_zone(self):
        key = self._current_key()
        if not key:
            return
        s = self.canvas.pending.get('start')
        e = self.canvas.pending.get('end')
        if not s or not e:
            QMessageBox.information(self, 'Incomplete',
                                    'Set both a start and an end first.')
            return
        self.data.setdefault(key, []).append({'start': list(s), 'end': list(e)})
        self.canvas.pending = {}
        self._update_pending_label()
        self._after_edit()

    def _delete_selected(self):
        key = self._current_key()
        row = self._selected_row()
        if not key or row is None:
            return
        kind = self.kinds[key]
        if kind == 'point_scalar':
            self.data[key] = None
        else:
            try:
                del self.data[key][row]
            except (KeyError, IndexError):
                return
        self._after_edit()

    def _update_point_from_dot(self):
        key = self._current_key()
        row = self._selected_row()
        if not key or row is None:
            return
        kind = self.kinds[key]
        pt = self._marked_point()
        if pt is None:
            return
        if kind == 'point_scalar':
            self.data[key] = pt
        elif kind == 'point_list':
            self.data[key][row] = pt
        self._after_edit(keep_row=row)

    def _update_zone_from_dot(self, which):
        key = self._current_key()
        row = self._selected_row()
        if not key or row is None or self.kinds[key] != 'zone_list':
            return
        pt = self._marked_point()
        if pt is None:
            return
        self.data[key][row][which] = pt
        self._after_edit(keep_row=row)

    def _after_edit(self, keep_row=None):
        self._mark_dirty()
        self._refresh_table()
        if keep_row is not None and keep_row < self.table.rowCount():
            self.table.selectRow(keep_row)
        self.canvas.update()

    # -- seek / playback --
    def _on_slider(self, value):
        self.canvas.seek_index = value
        self.canvas.update()
        self._update_pos_label(value)

    def set_seek(self, index):
        self.slider.setValue(max(0, min(index, self.slider.maximum())))

    def _step(self, delta):
        """Nudge the seek dot by exactly one centreline index (pausing playback)."""
        if self.play_timer.isActive():
            self._toggle_play()
        self.slider.setValue(self.slider.value() + delta)  # QSlider clamps to range

    def _toggle_play(self):
        if self.play_timer.isActive():
            self.play_timer.stop()
            self.btn_play.setIcon(FIF.PLAY)
            self.btn_play.setToolTip('Play')
        else:
            if self.slider.maximum() > 0:
                self.play_timer.start()
                self.btn_play.setIcon(FIF.PAUSE)
                self.btn_play.setToolTip('Pause')

    def _advance_play(self):
        n = self.slider.maximum()
        if n <= 0:
            return
        step = max(1, (n + 1) // 400)
        nxt = self.slider.value() + step
        if nxt > n:
            nxt = 0
        self.slider.setValue(nxt)

    def _update_pos_label(self, index):
        n = max(1, len(self.centerline) - 1)
        pct = index / n * 100 if n else 0
        sector = self.sector_of[index] if index < len(self.sector_of) else '—'
        self.pos_label.setText(
            f'idx {index}/{n}   •   Sector {sector}   •   {pct:.1f}%')

    # -- control state --
    def _update_add_controls(self):
        key = self._current_key()
        kind = self.kinds.get(key) if key else None
        is_zone = kind == 'zone_list'
        self.zone_add_box.setVisible(is_zone)
        self.point_add_box.setVisible(kind in ('point_list', 'point_scalar'))
        if kind == 'point_scalar':
            self.btn_add_point.setText('Set from marker')
        else:
            self.btn_add_point.setText('Add point at marker')
        self._update_edit_controls()

    def _update_edit_controls(self):
        key = self._current_key()
        kind = self.kinds.get(key) if key else None
        has_row = self._selected_row() is not None
        is_zone = kind == 'zone_list'
        self.btn_delete.setEnabled(has_row)
        self.btn_update_point.setVisible(kind in ('point_list', 'point_scalar'))
        self.btn_update_point.setEnabled(has_row)
        self.btn_update_start.setVisible(is_zone)
        self.btn_update_end.setVisible(is_zone)
        self.btn_update_start.setEnabled(has_row)
        self.btn_update_end.setEnabled(has_row)

    def _set_controls_enabled(self, on):
        for w in (self.collection_combo, self.table, self.slider, self.btn_play,
                  self.btn_step_back, self.btn_step_fwd, self.btn_save,
                  self.btn_import_tnrd, self.btn_add_point, self.btn_set_start,
                  self.btn_set_end, self.btn_add_zone, self.btn_delete,
                  self.btn_update_point, self.btn_update_start, self.btn_update_end):
            w.setEnabled(on)
        if on:
            self._update_add_controls()

    # -- misc --
    def _mark_dirty(self):
        self.dirty = True
        self._update_title()

    def _update_title(self):
        name = self.path.name if self.path else 'untitled'
        star = ' *' if self.dirty else ''
        self.setWindowTitle(f'Track Map Marker Editor — {name}{star}')

    def _update_info(self):
        d = self.data
        self.info_label.setText(
            f"{d.get('track_name', '?')}  ·  id {d.get('track_id', '?')}  ·  "
            f"{d.get('track_length_m', '?')} m  ·  {len(self.centerline)} pts  ·  "
            f"rot {d.get('rotation_deg', 0)}°")

    def closeEvent(self, event):
        if self.dirty:
            resp = QMessageBox.question(
                self, 'Unsaved changes',
                'You have unsaved changes. Quit without saving?',
                QMessageBox.StandardButton.Yes | QMessageBox.StandardButton.No)
            if resp != QMessageBox.StandardButton.Yes:
                event.ignore()
                return
        event.accept()


def main():
    app = QApplication([])
    setTheme(Theme.AUTO)
    if sys.platform in ('win32', 'darwin'):
        accent = getSystemAccentColor()
        if accent.isValid():
            setThemeColor(accent, save=False)
    win = MainWindow()
    win.show()
    app.exec()


if __name__ == '__main__':
    main()
