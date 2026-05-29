#!/usr/bin/env python3
"""Generate app icons (PNG) with no third-party deps.

Draws a rounded-square indigo->violet gradient with a white calendar card
and three "review" dots (one highlighted). Produces 192 and 512 px PNGs
plus a maskable 512 (extra padding so Android masks don't clip the glyph).
"""
import struct, zlib, math

def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))

def rounded_alpha(x, y, w, h, r):
    """Soft 0..1 coverage for a rounded rect (simple AA)."""
    cx = min(max(x, r), w - 1 - r)
    cy = min(max(y, r), h - 1 - r)
    dx = x - cx
    dy = y - cy
    if dx == 0 and dy == 0:
        return 1.0
    if abs(dx) <= 0 or abs(dy) <= 0:
        # on straight edges
        return 1.0
    d = math.hypot(dx, dy)
    return max(0.0, min(1.0, r - d + 0.5))

def make(size, pad_frac=0.0):
    w = h = size
    buf = bytearray(w * h * 4)
    c_top = (99, 102, 241)    # indigo-500
    c_bot = (139, 92, 246)    # violet-500
    inset = int(size * pad_frac)
    iw = size - inset * 2
    radius = int(iw * 0.22)

    def px(x, y, rgb, a):
        i = (y * w + x) * 4
        a = max(0, min(255, int(a)))
        buf[i] = rgb[0]; buf[i+1] = rgb[1]; buf[i+2] = rgb[2]; buf[i+3] = a

    # background rounded square with vertical gradient
    for y in range(h):
        for x in range(w):
            lx = x - inset
            ly = y - inset
            if lx < 0 or ly < 0 or lx >= iw or ly >= iw:
                continue
            cov = rounded_alpha(lx, ly, iw, iw, radius)
            if cov <= 0:
                continue
            t = ly / max(1, iw - 1)
            px(x, y, lerp(c_top, c_bot, t), 255 * cov)

    # white calendar card
    white = (255, 255, 255)
    cw = int(iw * 0.56)
    ch = int(iw * 0.50)
    cx0 = inset + (iw - cw) // 2
    cy0 = inset + int(iw * 0.27)
    cr = int(cw * 0.12)
    for y in range(cy0, cy0 + ch):
        for x in range(cx0, cx0 + cw):
            cov = rounded_alpha(x - cx0, y - cy0, cw, ch, cr)
            if cov > 0:
                px(x, y, white, 255 * cov)

    # header bar of the calendar (accent)
    accent = (79, 70, 229)
    hb = int(ch * 0.26)
    for y in range(cy0, cy0 + hb):
        for x in range(cx0, cx0 + cw):
            cov = rounded_alpha(x - cx0, y - cy0, cw, ch, cr)
            # only round the top corners: clamp bottom to square
            if y > cy0 + cr:
                cov = 1.0 if (cx0 <= x < cx0 + cw) else 0.0
            if cov > 0:
                px(x, y, accent, 255 * cov)

    # two binder rings
    ring = (79, 70, 229)
    rr = max(2, int(cw * 0.035))
    for ringx in (cx0 + int(cw * 0.30), cx0 + int(cw * 0.70)):
        ringy = cy0 - int(hb * 0.25)
        for yy in range(ringy - rr, ringy + rr + 1):
            for xx in range(ringx - rr, ringx + rr + 1):
                if (xx - ringx) ** 2 + (yy - ringy) ** 2 <= rr * rr:
                    px(xx, yy, ring, 255)

    # three review dots in the body (spaced repetition), middle highlighted
    body_y = cy0 + hb + int((ch - hb) * 0.45)
    dot_r = max(3, int(cw * 0.085))
    gap = int(cw * 0.26)
    centers = [cx0 + cw // 2 - gap, cx0 + cw // 2, cx0 + cw // 2 + gap]
    colors = [(203, 213, 225), (139, 92, 246), (203, 213, 225)]
    for cxd, col in zip(centers, colors):
        for yy in range(body_y - dot_r, body_y + dot_r + 1):
            for xx in range(cxd - dot_r, cxd + dot_r + 1):
                d = math.hypot(xx - cxd, yy - body_y)
                if d <= dot_r + 0.5:
                    cov = max(0.0, min(1.0, dot_r - d + 0.5))
                    px(xx, yy, col, 255 * cov)

    return bytes(buf), w, h

def write_png(path, raw, w, h):
    def chunk(typ, data):
        c = typ + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xffffffff)
    # add filter byte (0) per scanline
    stride = w * 4
    out = bytearray()
    for y in range(h):
        out.append(0)
        out += raw[y * stride:(y + 1) * stride]
    comp = zlib.compress(bytes(out), 9)
    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", comp)
    png += chunk(b"IEND", b"")
    with open(path, "wb") as f:
        f.write(png)

if __name__ == "__main__":
    import os
    here = os.path.dirname(os.path.abspath(__file__))
    for name, size, pad in [("icon-192.png", 192, 0.0),
                            ("icon-512.png", 512, 0.0),
                            ("icon-maskable-512.png", 512, 0.14)]:
        raw, w, h = make(size, pad)
        write_png(os.path.join(here, name), raw, w, h)
        print("wrote", name)
