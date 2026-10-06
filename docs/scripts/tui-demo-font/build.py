"""Build the Geist Mono subsets embedded in docs/public/tui-demo.svg.

    pnpm demo:font        (runs this through `uvx --from 'fonttools[woff]'`)

The demo SVG is loaded as an <img>, so it cannot use the page's web fonts and
would otherwise fall back to whatever monospace face the viewer's OS has. We
embed a small WOFF2 subset instead. Geist Mono lacks a few glyphs the app
draws through terminal font fallback (spinner braille, Claude Code's ⎿ ✻ ✶,
the ⋯ ▾ ✓ chrome glyphs); those are drawn here on Geist Mono's own metrics so
every cell of the demo comes from one consistent face.

Geist Mono is licensed under the SIL Open Font License 1.1; the subset keeps
its copyright and license records and is renamed as a modified version.
"""

import math
import sys
from pathlib import Path

from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.subset import Options, Subsetter
from fontTools.ttLib import TTFont

HERE = Path(__file__).resolve().parent
CHARS = (HERE / "chars.txt").read_text(encoding="utf-8").replace("\n", "")
FAMILY = "tmux-ide demo mono"

ADVANCE = 600
STROKE = 84  # Geist Mono's light box-drawing stem
MIDLINE = 310  # vertical centre of Geist Mono's box-drawing horizontals
SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"


def polygon(pen, points):
    """Closed contour, normalized to TrueType's clockwise outer winding."""
    area = sum(
        x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(points, points[1:] + points[:1])
    )
    if area > 0:
        points = list(reversed(points))
    pen.moveTo(tuple(round(v) for v in points[0]))
    for point in points[1:]:
        pen.lineTo(tuple(round(v) for v in point))
    pen.closePath()


def circle(pen, cx, cy, r):
    reach = r / math.cos(math.pi / 8)
    points = [
        (round(cx + reach * math.cos(-k * math.pi / 4)), round(cy + reach * math.sin(-k * math.pi / 4)))
        for k in range(8)
    ]
    pen.qCurveTo(*points, None)
    pen.closePath()


def stroke(pen, points, width=STROKE):
    half = width / 2
    for (x0, y0), (x1, y1) in zip(points, points[1:]):
        length = math.hypot(x1 - x0, y1 - y0)
        nx, ny = -(y1 - y0) / length * half, (x1 - x0) / length * half
        polygon(pen, [(x0 + nx, y0 + ny), (x1 + nx, y1 + ny), (x1 - nx, y1 - ny), (x0 - nx, y0 - ny)])
    for x, y in points:
        circle(pen, x, y, half)


def star(pen, points, outer, inner, cx=300, cy=MIDLINE + 20, turn=math.pi / 2):
    polygon(
        pen,
        [
            (
                cx + (outer if k % 2 == 0 else inner) * math.cos(turn + k * math.pi / points),
                cy + (outer if k % 2 == 0 else inner) * math.sin(turn + k * math.pi / points),
            )
            for k in range(points * 2)
        ],
    )


def braille(pen, char, weight):
    bits = ord(char) - 0x2800
    columns, rows = (170, 430), (850, 600, 350, 100)
    dots = [(0, 0), (0, 1), (0, 2), (1, 0), (1, 1), (1, 2), (0, 3), (1, 3)]
    for bit, (column, row) in enumerate(dots):
        if bits & (1 << bit):
            circle(pen, columns[column], rows[row], 88 + weight * 12)


def draw(char, weight):
    """weight: 0 regular, 1 bold."""
    pen = TTGlyphPen(None)
    w = STROKE + weight * 36
    if char == "⋯":
        for x in (100, 300, 500):
            circle(pen, x, MIDLINE, 46 + weight * 10)
    elif char == "⎿":
        polygon(pen, [(190, 760), (190 + w, 760), (190 + w, 160 + w), (560, 160 + w), (560, 160), (190, 160)])
    elif char == "▾":
        polygon(pen, [(140, 470), (460, 470), (300, 190)])
    elif char == "✓":
        stroke(pen, [(110, 360), (245, 190), (500, 590)], w)
    elif char == "✶":
        star(pen, 6, 280, 120)
    elif char == "✻":
        star(pen, 8, 290, 70, turn=math.pi / 2)
    elif char in SPINNER:
        braille(pen, char, weight)
    else:
        raise SystemExit(f"no drawing for {char!r}")
    return pen.glyph()


def build(source: Path, target: Path, style: str, weight: int):
    font = TTFont(source)
    cmap = font.getBestCmap()
    drawn = [char for char in dict.fromkeys(CHARS) if ord(char) not in cmap and char != "\n"]
    options = Options()
    options.layout_features = []
    options.hinting = False
    options.desubroutinize = True
    options.name_IDs = [0, 1, 2, 4, 6, 13, 14]
    options.notdef_outline = True
    options.drop_tables += ["meta", "STAT", "DSIG"]
    subsetter = Subsetter(options)
    subsetter.populate(unicodes=[ord(char) for char in CHARS if ord(char) in cmap])
    subsetter.subset(font)

    order = font.getGlyphOrder()
    for char in drawn:
        name = f"uni{ord(char):04X}"
        order.append(name)
        font["glyf"][name] = draw(char, weight)
        font["hmtx"][name] = (ADVANCE, font["glyf"][name].xMin if hasattr(font["glyf"][name], "xMin") else 0)
        for table in font["cmap"].tables:
            if table.isUnicode():
                table.cmap[ord(char)] = name
    font.setGlyphOrder(order)
    font["maxp"].numGlyphs = len(order)

    names = font["name"]
    for record in list(names.names):
        if record.nameID in (1, 4, 6, 16, 17):
            names.removeNames(nameID=record.nameID)
    names.setName(FAMILY, 1, 3, 1, 0x409)
    names.setName(style, 2, 3, 1, 0x409)
    names.setName(f"{FAMILY} {style}", 4, 3, 1, 0x409)
    names.setName(f"tmux-ide-demo-mono-{style}", 6, 3, 1, 0x409)

    font.flavor = "woff2"
    font.save(target)
    missing = [char for char in CHARS if ord(char) not in font.getBestCmap()]
    if missing:
        raise SystemExit(f"{target.name} is missing {''.join(missing)!r}")
    print(f"{target.relative_to(HERE.parent.parent.parent)}: {target.stat().st_size} bytes, drew {''.join(drawn)}")


if __name__ == "__main__":
    geist = Path(sys.argv[1])
    build(geist / "GeistMono-Regular.ttf", HERE / "regular.woff2", "Regular", 0)
    build(geist / "GeistMono-Bold.ttf", HERE / "bold.woff2", "Bold", 1)
