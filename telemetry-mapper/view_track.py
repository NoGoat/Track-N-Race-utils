import json
import math
import tkinter as tk
from tkinter import filedialog, messagebox
from pathlib import Path

CANVAS_W = 900
CANVAS_H = 800
PADDING  = 60

LAP_COLORS = ['#5794F2', '#73BF69', '#FADE2A', '#F2495C', '#FF9830',
              '#B877D9', '#19B8C2', '#E05F73', '#8AB8FF', '#96D98D']


def rotate_point(x, z, cx, cz, angle_rad):
    dx = x - cx
    dz = z - cz
    rx = dx * math.cos(angle_rad) - dz * math.sin(angle_rad)
    rz = dx * math.sin(angle_rad) + dz * math.cos(angle_rad)
    return rx + cx, rz + cz


def iqr_bounds(values, k=3.5):
    s = sorted(values)
    n = len(s)
    q1 = s[n // 4]
    q3 = s[(3 * n) // 4]
    iqr = q3 - q1
    return q1 - k * iqr, q3 + k * iqr


def clean_points(points, track_length_m):
    if len(points) < 4:
        return points

    xs = [p[0] for p in points]
    zs = [p[2] for p in points]
    x_lo, x_hi = iqr_bounds(xs)
    z_lo, z_hi = iqr_bounds(zs)

    iqr_clean = [p for p in points if x_lo <= p[0] <= x_hi and z_lo <= p[2] <= z_hi]

    max_jump = (track_length_m or 10000) * 0.5
    jump_clean = []
    for p in iqr_clean:
        if jump_clean and math.hypot(p[0] - jump_clean[-1][0], p[2] - jump_clean[-1][2]) > max_jump:
            continue
        jump_clean.append(p)

    if not jump_clean:
        return jump_clean

    segments: list[list] = [[jump_clean[0]]]
    for p in jump_clean[1:]:
        if math.hypot(p[0] - segments[-1][-1][0], p[2] - segments[-1][-1][2]) > 50:
            segments.append([])
        segments[-1].append(p)

    min_pts = max(20, len(jump_clean) // 100)
    return [p for seg in segments if len(seg) >= min_pts for p in seg]


def make_transform(points, width, height, pad):
    xs = [p[0] for p in points]
    zs = [p[2] for p in points]
    min_x, max_x = min(xs), max(xs)
    min_z, max_z = min(zs), max(zs)
    span_x = max_x - min_x or 1
    span_z = max_z - min_z or 1
    scale  = min((width - 2 * pad) / span_x, (height - 2 * pad) / span_z)
    off_x  = (width  - scale * span_x) / 2
    off_z  = (height - scale * span_z) / 2
    def _t(x, z):
        return ((x - min_x) * scale + off_x, (z - min_z) * scale + off_z)
    return _t


def normalize(points, width, height, pad):
    t = make_transform(points, width, height, pad)
    return [t(p[0], p[2]) for p in points], t


def consolidate_drs_zones(events, points):
    """
    Group raw DRS events into zones across multiple laps.
    Unifies disjoint DRS segments on the same straight using circular gap merging.
    """
    if not events or not points:
        return []

    # Extract reference centerline from points
    lap_groups = {}
    for p in points:
        lap = p[3] if len(p) > 3 else 0
        lap_groups.setdefault(lap, []).append(p)
    ref_lap_pts = max(lap_groups.values(), key=len)
    centerline = [ref_lap_pts[0]]
    for p in ref_lap_pts[1:]:
        if math.hypot(p[0] - centerline[-1][0], p[2] - centerline[-1][2]) >= 1.0:
            centerline.append(p)

    instances = []
    i = 0
    while i < len(events):
        if events[i]['type'] == 'unlock':
            unlock = events[i]
            j = i + 1
            while j < len(events) and events[j]['type'] != 'lock':
                j += 1
            if j < len(events):
                instances.append({'unlock': unlock, 'lock': events[j]})
                i = j + 1
            else:
                i += 1
        else:
            i += 1

    if not instances:
        return []

    def _closest_idx(cl, raw_x, raw_z):
        best_i, best_d = 0, float('inf')
        for idx, pt in enumerate(cl):
            d = math.hypot(pt[0] - raw_x, pt[2] - raw_z)
            if d < best_d:
                best_d, best_i = d, idx
        return best_i

    # Map each instance to centerline index range
    N = len(centerline)
    is_drs = [False] * N
    for inst in instances:
        u_idx = _closest_idx(centerline, inst['unlock']['x'], inst['unlock']['z'])
        l_idx = _closest_idx(centerline, inst['lock']['x'],   inst['lock']['z'])
        
        curr = u_idx
        while True:
            is_drs[curr] = True
            if curr == l_idx:
                break
            curr = (curr + 1) % N

    # Fill circular gaps (threshold: 120 meters/indices)
    gap_limit = 120
    
    # Circular gap-filling
    start_idx = -1
    for i in range(N):
        if is_drs[i] and not is_drs[(i - 1) % N]:
            start_idx = i
            break

    if start_idx == -1:
        if any(is_drs):
            return [{'unlock': {'x': centerline[0][0], 'z': centerline[0][2]}, 'lock': {'x': centerline[-1][0], 'z': centerline[-1][2]}}]
        return []

    filled = list(is_drs)
    i = start_idx
    visited_count = 0
    while visited_count < N:
        if not filled[i]:
            gap_start = i
            gap_len = 0
            while not filled[i] and visited_count < N:
                gap_len += 1
                i = (i + 1) % N
                visited_count += 1
            if gap_len < gap_limit:
                is_straight = True
                ref_idx = (gap_start - 1) % N
                ref_dx = centerline[gap_start][0] - centerline[ref_idx][0]
                ref_dz = centerline[gap_start][2] - centerline[ref_idx][2]
                ref_len = math.hypot(ref_dx, ref_dz)
                if ref_len > 0:
                    ref_ux = ref_dx / ref_len
                    ref_uz = ref_dz / ref_len
                    
                    curr = gap_start
                    for _ in range(gap_len):
                        next_curr = (curr + 1) % N
                        dx = centerline[next_curr][0] - centerline[curr][0]
                        dz = centerline[next_curr][2] - centerline[curr][2]
                        leng = math.hypot(dx, dz)
                        if leng > 0:
                            ux = dx / leng
                            uz = dz / leng
                            dot = ref_ux * ux + ref_uz * uz
                            if dot < 0.92:  # turns by more than ~23 degrees
                                is_straight = False
                                break
                        curr = next_curr
                
                if is_straight:
                    curr = gap_start
                    for _ in range(gap_len):
                        filled[curr] = True
                        curr = (curr + 1) % N
        else:
            i = (i + 1) % N
            visited_count += 1

    # Extract contiguous True segments
    zones = []
    i = start_idx
    visited_count = 0
    while visited_count < N:
        if filled[i]:
            zone_start = i
            zone_len = 0
            while filled[i] and visited_count < N:
                zone_len += 1
                i = (i + 1) % N
                visited_count += 1
            zone_end = (zone_start + zone_len - 1) % N
            zones.append((zone_start, zone_end))
        else:
            i = (i + 1) % N
            visited_count += 1

    # Merge circular wrap-around zones
    if len(zones) > 1:
        if (zones[-1][1] + 1) % N == zones[0][0]:
            merged_zone = (zones[-1][0], zones[0][1])
            zones = [merged_zone] + zones[1:-1]

    # Convert centerline zones back to standard format
    result = []
    for u_idx, l_idx in zones:
        result.append({
            'unlock': {'x': centerline[u_idx][0], 'z': centerline[u_idx][2]},
            'lock': {'x': centerline[l_idx][0], 'z': centerline[l_idx][2]},
        })
    return result


def consolidate_by_proximity(events, key_x='x', key_z='z', threshold=100):
    clusters = []
    for ev in events:
        ex, ez = ev[key_x], ev[key_z]
        placed = False
        for cl in clusters:
            fx, fz = cl[0][key_x], cl[0][key_z]
            if math.hypot(ex - fx, ez - fz) < threshold:
                cl.append(ev)
                placed = True
                break
        if not placed:
            clusters.append([ev])
    return [cl[0] for cl in clusters]


def consolidate_sector_crossings(events):
    result = []
    for key in ((0, 1), (1, 2)):
        subset = [e for e in events if e['from_s'] == key[0] and e['to_s'] == key[1]]
        if subset:
            result.append(consolidate_by_proximity(subset)[0])
    return result


def find_sf_line(points, data=None):
    for i in range(1, len(points)):
        if len(points[i]) > 3 and len(points[i - 1]) > 3:
            if points[i][3] != points[i - 1][3]:
                return i
    if data and 'sector_crossings' in data:
        sf_crossings = [c for c in data['sector_crossings'] if c.get('from_s') == 2 and c.get('to_s') == 0]
        if sf_crossings:
            sf_c = sf_crossings[0]
            best_i, best_d = 0, float('inf')
            for idx, pt in enumerate(points):
                d = math.hypot(pt[0] - sf_c['x'], pt[2] - sf_c['z'])
                if d < best_d:
                    best_d, best_i = d, idx
            return best_i
    if points:
        return 0
    return None


def build_svg(data, points, coords, xform=None, angle_deg=0.0):
    w, h = 900, 800
    lines = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" '
        f'style="background:#111216">',
        f'  <title>Track {data["track_id"]} - {data["track_length_m"]} m</title>',
    ]

    xs = [p[0] for p in points]
    zs = [p[2] for p in points]
    cx = sum(xs) / len(points) if points else 0
    cz = sum(zs) / len(points) if points else 0
    angle_rad = math.radians(angle_deg)

    rotated_points = []
    for p in points:
        rx, rz = rotate_point(p[0], p[2], cx, cz, angle_rad)
        rotated_points.append([rx, p[1], rz] + p[3:])

    segments = {}
    for i, p in enumerate(rotated_points):
        lap = p[3] if len(p) > 3 else 0
        segments.setdefault(lap, []).append(i)

    for lap, indices in sorted(segments.items()):
        color = LAP_COLORS[lap % len(LAP_COLORS)]
        pts_list = [f'{coords[i][0]:.1f},{coords[i][1]:.1f}' for i in indices]
        if len(indices) > 2:
            pts_list.append(f'{coords[indices[0]][0]:.1f},{coords[indices[0]][1]:.1f}')
        pts_str = ' '.join(pts_list)
        lines.append(
            f'  <polyline points="{pts_str}" '
            f'stroke="{color}" stroke-width="2" fill="none" '
            f'stroke-linecap="round" stroke-linejoin="round"/>'
        )

    sf = find_sf_line(points, data)
    if sf is not None:
        cx_sf, cy_sf = coords[sf]
        lines.append(
            f'  <circle cx="{cx_sf:.1f}" cy="{cy_sf:.1f}" r="6" '
            f'fill="#e10600" stroke="#ffffff" stroke-width="1.5"/>'
        )
        lines.append(
            f'  <text x="{cx_sf + 10:.1f}" y="{cy_sf + 4:.1f}" '
            f'font-family="monospace" font-size="11" fill="#e10600">S/F</text>'
        )

    drs_zones = []
    traps = []
    crossings = []

    if xform:
        drs_zones = consolidate_drs_zones(data.get('drs_events', []), points)
        for zone in drs_zones:
            rx_u, rz_u = rotate_point(zone['unlock']['x'], zone['unlock']['z'], cx, cz, angle_rad)
            rx_l, rz_l = rotate_point(zone['lock']['x'],   zone['lock']['z'],   cx, cz, angle_rad)
            ux, uy = xform(rx_u, rz_u)
            lx, ly = xform(rx_l, rz_l)
            u_pts = f'{ux:.1f},{uy - 8:.1f} {ux - 6:.1f},{uy + 4:.1f} {ux + 6:.1f},{uy + 4:.1f}'
            l_pts = f'{lx:.1f},{ly + 8:.1f} {lx - 6:.1f},{ly - 4:.1f} {lx + 6:.1f},{ly - 4:.1f}'
            lines.append(f'  <polygon points="{u_pts}" fill="#73BF69" stroke="#ffffff" stroke-width="1"/>')
            lines.append(f'  <polygon points="{l_pts}" fill="#F2495C" stroke="#ffffff" stroke-width="1"/>')

        traps = consolidate_by_proximity(data.get('speed_traps', []))
        for t in traps:
            rx_t, rz_t = rotate_point(t['x'], t['z'], cx, cz, angle_rad)
            tx, ty = xform(rx_t, rz_t)
            t_pts = f'{tx:.1f},{ty - 8:.1f} {tx + 6:.1f},{ty:.1f} {tx:.1f},{ty + 8:.1f} {tx - 6:.1f},{ty:.1f}'
            lines.append(f'  <polygon points="{t_pts}" fill="#FADE2A" stroke="#ffffff" stroke-width="1"/>')
            lines.append(
                f'  <text x="{tx + 10:.1f}" y="{ty + 4:.1f}" '
                f'font-family="monospace" font-size="10" fill="#FADE2A">SPTP</text>'
            )

        crossings = consolidate_sector_crossings(data.get('sector_crossings', []))
        sector_labels = {(0, 1): 'S1/S2', (1, 2): 'S2/S3'}
        for c in crossings:
            rx_c, rz_c = rotate_point(c['x'], c['z'], cx, cz, angle_rad)
            cx2, cy2 = xform(rx_c, rz_c)
            label = sector_labels.get((c['from_s'], c['to_s']), '')
            lines.append(
                f'  <line x1="{cx2 - 4:.1f}" y1="{cy2 - 8:.1f}" '
                f'x2="{cx2 + 4:.1f}" y2="{cy2 + 8:.1f}" '
                f'stroke="#ffffff" stroke-width="1.5"/>'
            )
            lines.append(
                f'  <text x="{cx2 + 8:.1f}" y="{cy2 + 4:.1f}" '
                f'font-family="monospace" font-size="10" fill="#ffffff">{label}</text>'
            )

    extras = ''
    if drs_zones:
        extras += f'  |  {len(drs_zones)} DRS zone(s)'
    if traps:
        extras += f'  |  {len(traps)} trap(s)'
    if crossings:
        extras += f'  |  {len(crossings)} sector(s)'
    lines.append(
        f'  <text x="16" y="22" font-family="monospace" font-size="12" fill="#888">'
        f'Track {data["track_id"]}  |  {data["track_length_m"]} m  |  '
        f'{len(points)} pts{extras}</text>'
    )

    lines.append('</svg>')
    return '\n'.join(lines)


def filter_track_data(raw: dict) -> dict:
    points = raw.get('points', [])
    laps_in_points = {p[3] for p in points if len(p) > 3}
    if laps_in_points:
        complete_laps = {lap for lap in laps_in_points if lap > 1 and (lap + 1) in laps_in_points}
        filtered_points = [p for p in points if len(p) > 3 and p[3] in complete_laps]
        filtered_drs = raw.get('drs_events', [])  # Revert: keep all DRS events (including Lap 1 and incomplete laps)
        filtered_traps = [ev for ev in raw.get('speed_traps', []) if ev.get('lap') in complete_laps]
        filtered_crossings = [ev for ev in raw.get('sector_crossings', []) if ev.get('lap') in complete_laps]
    else:
        filtered_points = points
        filtered_drs = raw.get('drs_events', [])
        filtered_traps = raw.get('speed_traps', [])
        filtered_crossings = raw.get('sector_crossings', [])

    return {
        **raw,
        'points': filtered_points,
        'drs_events': filtered_drs,
        'speed_traps': filtered_traps,
        'sector_crossings': filtered_crossings,
    }


class App:
    def __init__(self, root: tk.Tk):
        self.root  = root
        self.data  = None
        self.file  = None

        root.title('Track Map Viewer')
        root.resizable(False, False)
        root.configure(bg='#111216')

        toolbar = tk.Frame(root, bg='#1c1e26', pady=6)
        toolbar.pack(fill='x')

        tk.Button(
            toolbar, text='Open JSON...', command=self.open_file,
            bg='#2a2d3a', fg='#e0e0e0', relief='flat',
            padx=12, pady=4, cursor='hand2',
        ).pack(side='left', padx=8)

        self.save_btn = tk.Button(
            toolbar, text='Save SVG', command=self.save_svg,
            bg='#2a2d3a', fg='#888', relief='flat',
            padx=12, pady=4, cursor='hand2', state='disabled',
        )
        self.save_btn.pack(side='left', padx=4)

        # Rotation UI
        self.rot_label = tk.Label(
            toolbar, text='Rotation (°):',
            bg='#1c1e26', fg='#aaa',
            font=('Consolas', 10),
        )
        self.rot_label.pack(side='left', padx=(16, 4))

        self.rot_entry = tk.Entry(
            toolbar, bg='#2a2d3a', fg='#e0e0e0',
            insertbackground='#e0e0e0', relief='flat',
            width=6, font=('Consolas', 10), justify='center',
        )
        self.rot_entry.insert(0, '0')
        self.rot_entry.pack(side='left', padx=4)
        self.rot_entry.bind('<Return>', lambda e: self.render())

        self.rot_btn = tk.Button(
            toolbar, text='Rotate', command=self.render,
            bg='#2a2d3a', fg='#e0e0e0', relief='flat',
            padx=8, pady=2, cursor='hand2', font=('Consolas', 9),
        )
        self.rot_btn.pack(side='left', padx=4)

        self.info = tk.Label(
            toolbar, text='No file loaded',
            bg='#1c1e26', fg='#666',
            font=('Consolas', 10),
        )
        self.info.pack(side='right', padx=16)

        self.canvas = tk.Canvas(
            root, width=CANVAS_W, height=CANVAS_H,
            bg='#111216', highlightthickness=0,
        )
        self.canvas.pack()

        self._draw_placeholder()

    def _draw_placeholder(self):
        self.canvas.create_text(
            CANVAS_W // 2, CANVAS_H // 2,
            text='Open a track JSON file to view the map',
            fill='#444', font=('Consolas', 13),
        )

    def open_file(self):
        path = filedialog.askopenfilename(
            title='Select track JSON',
            filetypes=[('JSON files', '*.json'), ('All files', '*.*')],
        )
        if not path:
            return
        try:
            self.data = filter_track_data(json.loads(Path(path).read_text()))
            self.file = Path(path)
        except Exception as e:
            messagebox.showerror('Error', f'Failed to read file:\n{e}')
            return

        self.render()
        self.save_btn.config(state='normal', fg='#e0e0e0')

    def render(self):
        data   = self.data
        raw    = data['points']
        if not raw:
            messagebox.showwarning('Empty', 'No points in this file.')
            return

        points  = clean_points(raw, data.get('track_length_m', 0))
        dropped = len(raw) - len(points)

        angle_deg = 0.0
        try:
            angle_deg = float(self.rot_entry.get())
        except ValueError:
            pass
        angle_rad = math.radians(angle_deg)

        xs = [p[0] for p in points]
        zs = [p[2] for p in points]
        cx = sum(xs) / len(points) if points else 0
        cz = sum(zs) / len(points) if points else 0

        rotated_points = []
        for p in points:
            rx, rz = rotate_point(p[0], p[2], cx, cz, angle_rad)
            rotated_points.append([rx, p[1], rz] + p[3:])

        coords, xform = normalize(rotated_points, CANVAS_W, CANVAS_H, PADDING)

        self.canvas.delete('all')
        self._coords = coords
        self._xform  = xform

        segments = {}
        for i, p in enumerate(rotated_points):
            lap = p[3] if len(p) > 3 else 0
            segments.setdefault(lap, []).append(i)

        for lap, indices in sorted(segments.items()):
            color = LAP_COLORS[lap % len(LAP_COLORS)]
            flat  = []
            for i in indices:
                flat.extend(coords[i])
            if len(flat) >= 4:
                if len(indices) > 2:
                    flat.extend(coords[indices[0]])
                self.canvas.create_line(flat, fill=color, width=2,
                                        smooth=True, capstyle='round')

        sf = find_sf_line(points, data)
        if sf is not None:
            cx_sf, cy_sf = coords[sf]
            self.canvas.create_oval(cx_sf - 6, cy_sf - 6, cx_sf + 6, cy_sf + 6,
                                    fill='#e10600', outline='#ffffff', width=1.5)
            self.canvas.create_text(cx_sf + 14, cy_sf, text='S/F',
                                    fill='#e10600', font=('Consolas', 9), anchor='w')

        drs_zones = consolidate_drs_zones(data.get('drs_events', []), points)
        for zone in drs_zones:
            rx_u, rz_u = rotate_point(zone['unlock']['x'], zone['unlock']['z'], cx, cz, angle_rad)
            rx_l, rz_l = rotate_point(zone['lock']['x'],   zone['lock']['z'],   cx, cz, angle_rad)
            ux, uy = xform(rx_u, rz_u)
            lx, ly = xform(rx_l, rz_l)
            self.canvas.create_polygon(
                ux, uy - 8, ux - 6, uy + 4, ux + 6, uy + 4,
                fill='#73BF69', outline='#ffffff', width=1,
            )
            self.canvas.create_polygon(
                lx, ly + 8, lx - 6, ly - 4, lx + 6, ly - 4,
                fill='#F2495C', outline='#ffffff', width=1,
            )

        traps = consolidate_by_proximity(data.get('speed_traps', []))
        for t in traps:
            rx_t, rz_t = rotate_point(t['x'], t['z'], cx, cz, angle_rad)
            tx, ty = xform(rx_t, rz_t)
            self.canvas.create_polygon(
                tx, ty - 8, tx + 6, ty, tx, ty + 8, tx - 6, ty,
                fill='#FADE2A', outline='#ffffff', width=1,
            )
            self.canvas.create_text(tx + 10, ty, text='SPTP',
                                    fill='#FADE2A', font=('Consolas', 8), anchor='w')

        crossings = consolidate_sector_crossings(data.get('sector_crossings', []))
        sector_labels = {(0, 1): 'S1/S2', (1, 2): 'S2/S3'}
        for c in crossings:
            rx_c, rz_c = rotate_point(c['x'], c['z'], cx, cz, angle_rad)
            cx2, cy2 = xform(rx_c, rz_c)
            label = sector_labels.get((c['from_s'], c['to_s']), '')
            self.canvas.create_line(cx2 - 4, cy2 - 8, cx2 + 4, cy2 + 8,
                                    fill='#ffffff', width=1.5)
            self.canvas.create_text(cx2 + 8, cy2, text=label,
                                    fill='#ffffff', font=('Consolas', 8), anchor='w')

        laps     = sorted(set(p[3] if len(p) > 3 else 0 for p in rotated_points))
        drop_str = f'  |  {dropped} outliers removed' if dropped else ''
        drs_str  = f'  |  {len(drs_zones)} DRS zone(s)' if drs_zones else ''
        trap_str = f'  |  {len(traps)} trap(s)' if traps else ''
        sec_str  = f'  |  {len(crossings)} sector(s)' if crossings else ''
        self.info.config(
            text=(f'Track {data["track_id"]}  |  {data["track_length_m"]} m  |  '
                  f'{len(rotated_points)} pts  |  laps {laps[0]}-{laps[-1]}'
                  f'{drop_str}{drs_str}{trap_str}{sec_str}'),
            fg='#aaa',
        )

    def save_svg(self):
        if not self.data or not hasattr(self, '_coords'):
            return
        out = self.file.with_suffix('.svg')
        raw = self.data['points']
        clean = clean_points(raw, self.data.get('track_length_m', 0))
        angle_deg = 0.0
        try:
            angle_deg = float(self.rot_entry.get())
        except ValueError:
            pass
        svg = build_svg(self.data, clean, self._coords, self._xform, angle_deg)
        out.write_text(svg)
        self.info.config(text=f'Saved -> {out.name}', fg='#73BF69')
        self.root.after(3000, lambda: self.render())


root = tk.Tk()
App(root)
root.mainloop()
