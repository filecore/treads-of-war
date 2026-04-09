#!/usr/bin/env python3
"""
Generate a 512×512 thumbnail for the Conqueror portal card.
Uses only Python stdlib — no Pillow required.
Palette: muted olive/earthy tones matching the game.
"""
import struct, zlib, math

W = H = 512

# ── Colour palette (RGB) ──────────────────────────────────────────────────────
BG_TOP    = (0x28, 0x35, 0x1A)   # very dark olive — sky/ground gradient top
BG_BTM    = (0x4E, 0x6E, 0x28)   # mid olive — ground
TITLE_COL = (0xFF, 0xF0, 0xB4)   # warm ivory — title text
SUB_COL   = (0xB8, 0xCC, 0xA0)   # muted sage — subtitle
HUD_COL   = (0x80, 0xA0, 0xC8)   # cool blue-grey — hud accent
TANK_COL  = (0x6B, 0x5A, 0x38)   # sandy brown — tank silhouette
TRACK_COL = (0x3A, 0x30, 0x1A)   # dark — track/shadow
MUZZLE    = (0xE8, 0xD8, 0x88)   # pale gold — muzzle highlight
FIRE_COL  = (0xFF, 0x88, 0x22)   # orange — gun flash
SMOKE_COL = (0x88, 0x90, 0x88)   # grey — smoke

# ── Canvas ────────────────────────────────────────────────────────────────────
pixels = [[(0, 0, 0)] * W for _ in range(H)]

def setpx(x, y, col):
    if 0 <= x < W and 0 <= y < H:
        pixels[y][x] = col

def fill_rect(x0, y0, x1, y1, col):
    for y in range(max(0, y0), min(H, y1)):
        for x in range(max(0, x0), min(W, x1)):
            pixels[y][x] = col

def lerp_col(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

# ── Background gradient ───────────────────────────────────────────────────────
for y in range(H):
    t   = y / H
    col = lerp_col(BG_TOP, BG_BTM, t)
    for x in range(W):
        pixels[y][x] = col

# ── Horizon line ─────────────────────────────────────────────────────────────
horizon = 300
for x in range(W):
    # undulating terrain line
    offs = int(math.sin(x * 0.018) * 10 + math.sin(x * 0.041) * 6)
    for y in range(horizon + offs, horizon + offs + 3):
        if 0 <= y < H:
            pixels[y][x] = (0x3A, 0x55, 0x20)

# ── Tank silhouette (centre, resting on terrain) ─────────────────────────────
tx, ty = 200, 285   # tank centre-left

def draw_tank(cx, ty, scale=1.0, col=TANK_COL, track_col=TRACK_COL):
    hw = int(70 * scale)   # hull half-width
    hh = int(18 * scale)   # hull half-height
    tw = int(80 * scale)   # track half-width
    th = int(10 * scale)   # track height
    # Tracks
    fill_rect(cx - tw, ty - th, cx + tw, ty + th, track_col)
    # Hull
    fill_rect(cx - hw, ty - hh - th, cx + hw, ty - th, col)
    # Turret
    turrw = int(32 * scale)
    turrh = int(14 * scale)
    fill_rect(cx - turrw, ty - hh - th - turrh, cx + turrw, ty - hh - th, lerp_col(col, (0xFF, 0xFF, 0xFF), 0.10))
    # Barrel (angled slightly up)
    blen = int(55 * scale)
    bw   = int(5 * scale)
    angle = -0.12
    for i in range(blen):
        bx = cx + int(math.cos(angle) * i)
        by = ty - hh - th - turrh // 2 + int(math.sin(angle) * i)
        fill_rect(bx - bw // 2, by - bw // 2, bx + bw // 2 + 1, by + bw // 2 + 1, MUZZLE)

draw_tank(190, horizon - 2, scale=1.00, col=TANK_COL, track_col=TRACK_COL)

# ── Second tank (enemy, right side, darker/receding) ──────────────────────────
draw_tank(360, horizon - 8, scale=0.72,
          col=(0x4A, 0x3E, 0x28), track_col=(0x28, 0x22, 0x10))

# ── Muzzle flash on player tank ───────────────────────────────────────────────
fx, fy = 235, horizon - 35
for dy in range(-8, 9):
    for dx in range(-8, 9):
        d = math.hypot(dx, dy)
        if d < 8:
            t = 1 - d / 8
            c = lerp_col(FIRE_COL, TITLE_COL, t * 0.5)
            setpx(fx + dx, fy + dy, c)

# ── Simple 5×7 bitmap font ────────────────────────────────────────────────────
GLYPHS = {
    'C': [0x0E,0x11,0x10,0x10,0x10,0x11,0x0E],
    'O': [0x0E,0x11,0x11,0x11,0x11,0x11,0x0E],
    'N': [0x11,0x19,0x15,0x13,0x11,0x11,0x11],
    'Q': [0x0E,0x11,0x11,0x11,0x15,0x12,0x0D],
    'U': [0x11,0x11,0x11,0x11,0x11,0x11,0x0E],
    'E': [0x1F,0x10,0x10,0x1E,0x10,0x10,0x1F],
    'R': [0x1E,0x11,0x11,0x1E,0x14,0x12,0x11],
    'T': [0x1F,0x04,0x04,0x04,0x04,0x04,0x04],
    'A': [0x0E,0x11,0x11,0x1F,0x11,0x11,0x11],
    'K': [0x11,0x12,0x14,0x18,0x14,0x12,0x11],
    'S': [0x0E,0x11,0x10,0x0E,0x01,0x11,0x0E],
    ' ': [0x00,0x00,0x00,0x00,0x00,0x00,0x00],
    '1': [0x04,0x0C,0x04,0x04,0x04,0x04,0x0E],
    '9': [0x0E,0x11,0x11,0x0F,0x01,0x11,0x0E],
    '8': [0x0E,0x11,0x11,0x0E,0x11,0x11,0x0E],
    'W': [0x11,0x11,0x11,0x15,0x15,0x1B,0x11],
    'I': [0x0E,0x04,0x04,0x04,0x04,0x04,0x0E],
    'M': [0x11,0x1B,0x15,0x15,0x11,0x11,0x11],
    'B': [0x1E,0x11,0x11,0x1E,0x11,0x11,0x1E],
    'L': [0x10,0x10,0x10,0x10,0x10,0x10,0x1F],
    'P': [0x1E,0x11,0x11,0x1E,0x10,0x10,0x10],
    'Y': [0x11,0x11,0x0A,0x04,0x04,0x04,0x04],
    'D': [0x1E,0x11,0x11,0x11,0x11,0x11,0x1E],
    'G': [0x0E,0x11,0x10,0x10,0x13,0x11,0x0E],
    'F': [0x1F,0x10,0x10,0x1E,0x10,0x10,0x10],
    'H': [0x11,0x11,0x11,0x1F,0x11,0x11,0x11],
    'V': [0x11,0x11,0x11,0x11,0x11,0x0A,0x04],
    'X': [0x11,0x11,0x0A,0x04,0x0A,0x11,0x11],
    '·': [0x00,0x00,0x00,0x04,0x00,0x00,0x00],
    '-': [0x00,0x00,0x00,0x1F,0x00,0x00,0x00],
    '.': [0x00,0x00,0x00,0x00,0x00,0x04,0x00],
    ',': [0x00,0x00,0x00,0x00,0x00,0x04,0x08],
    'Z': [0x1F,0x01,0x02,0x04,0x08,0x10,0x1F],
    'J': [0x0F,0x02,0x02,0x02,0x12,0x12,0x0C],
}

def draw_text(text, x, y, col, scale=1):
    cx = x
    for ch in text.upper():
        glyph = GLYPHS.get(ch, GLYPHS.get(' '))
        for row_i, row_bits in enumerate(glyph):
            for col_i in range(5):
                if row_bits & (0x10 >> col_i):
                    fill_rect(cx + col_i * scale,
                              y + row_i * scale,
                              cx + col_i * scale + scale,
                              y + row_i * scale + scale,
                              col)
        cx += 6 * scale

def text_width(text, scale):
    return len(text) * 6 * scale - scale  # last char has no trailing space

# ── Title: CONQUEROR ──────────────────────────────────────────────────────────
TITLE = 'CONQUEROR'
scale = 8
tw = text_width(TITLE, scale)
tx_title = (W - tw) // 2
draw_text(TITLE, tx_title + 2, 34 + 2, (0x20, 0x28, 0x10), scale)  # shadow
draw_text(TITLE, tx_title,     34,     TITLE_COL,            scale)

# ── Subtitle ─────────────────────────────────────────────────────────────────
SUB = 'WWII TANK COMBAT'
sw = text_width(SUB, 3)
draw_text(SUB, (W - sw) // 2, 108, SUB_COL, 3)

# ── Year / studio ─────────────────────────────────────────────────────────────
YEAR = 'SUPERIOR SOFTWARE  1988'
yw = text_width(YEAR, 2)
draw_text(YEAR, (W - yw) // 2, 132, HUD_COL, 2)

# ── Bottom bar ────────────────────────────────────────────────────────────────
fill_rect(0, H - 36, W, H, (0x18, 0x22, 0x0A))
BAR = 'ACORN ARCHIMEDES  -  BROWSER PORT'
bw = text_width(BAR, 2)
draw_text(BAR, (W - bw) // 2, H - 28, (0x70, 0x90, 0x58), 2)

# ── PNG writer (stdlib only) ──────────────────────────────────────────────────
def write_png(path, pixels, w, h):
    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)

    raw = b''
    for row in pixels:
        raw += b'\x00'   # filter type: none
        for r, g, b in row:
            raw += bytes([r, g, b])

    ihdr = struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0)
    idat = zlib.compress(raw, 9)

    png  = b'\x89PNG\r\n\x1a\n'
    png += chunk(b'IHDR', ihdr)
    png += chunk(b'IDAT', idat)
    png += chunk(b'IEND', b'')

    with open(path, 'wb') as f:
        f.write(png)

write_png('/mnt/c/Users/JasonTogneri/conqueror/thumbnail.png', pixels, W, H)
print('thumbnail.png written (512×512)')
