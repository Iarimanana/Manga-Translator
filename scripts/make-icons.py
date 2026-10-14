"""Draw the strawberry + speech-bubble toolbar icon at every size the manifest needs.

Run once with `python3 scripts/make-icons.py`; the PNGs are committed to src/assets/icons.
"""
import math
import pathlib

from PIL import Image, ImageDraw, ImageFilter

S = 1024
OUT = pathlib.Path(__file__).resolve().parent.parent / "src" / "assets" / "icons"


def body_mask() -> Image.Image:
    m = Image.new("L", (S, S), 0)
    d = ImageDraw.Draw(m)
    # Strawberry body: rounded top that tapers to a soft tip.
    pts = []
    for i in range(361):
        t = math.radians(i)
        x = math.sin(t)
        y = -math.cos(t)
        # Narrow the lower half towards the tip.
        k = 1.0 if y < 0 else 1.0 - 0.42 * y ** 1.35
        pts.append((480 + 330 * x * k, 520 + 340 * y + (60 * y if y > 0 else 0)))
    d.polygon(pts, fill=255)
    return m.filter(ImageFilter.GaussianBlur(6)).point(lambda v: 255 if v > 127 else 0)


def draw() -> Image.Image:
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    mask = body_mask()
    # Vertical red gradient for the berry.
    grad = Image.new("RGBA", (S, S))
    gd = ImageDraw.Draw(grad)
    for y in range(S):
        f = y / S
        gd.line([(0, y), (S, y)], fill=(int(255 - 40 * f), int(84 - 50 * f), int(110 - 50 * f), 255))
    img.paste(grad, (0, 0), mask)

    d = ImageDraw.Draw(img)
    # Seeds.
    for row, (y, xs) in enumerate([(360, [330, 480, 630]), (480, [260, 400, 560, 700]), (600, [330, 480, 630]), (720, [410, 550])]):
        for x in xs:
            if mask.getpixel((x, y)) == 255:
                d.ellipse([x - 16, y - 24, x + 16, y + 24], fill=(255, 226, 140, 255))
    # Leaves.
    cx, cy = 480, 200
    leaves = []
    for i in range(5):
        a = math.radians(-90 + i * 72)
        tip = (cx + 230 * math.cos(a), cy + 120 * math.sin(a) + 40)
        l1 = (cx + 70 * math.cos(a - 0.6), cy + 50 * math.sin(a - 0.6) + 40)
        l2 = (cx + 70 * math.cos(a + 0.6), cy + 50 * math.sin(a + 0.6) + 40)
        leaves.append([l1, tip, l2, (cx, cy + 40)])
    for leaf in leaves:
        d.polygon(leaf, fill=(46, 170, 90, 255))
    d.rounded_rectangle([cx - 22, cy - 120, cx + 22, cy + 40], radius=20, fill=(46, 150, 80, 255))

    # Speech bubble (bottom right) to signal translation.
    bx0, by0, bx1, by1 = 560, 600, 1000, 920
    d.rounded_rectangle([bx0, by0, bx1, by1], radius=110, fill=(255, 255, 255, 255), outline=(40, 30, 40, 255), width=26)
    d.polygon([(640, 900), (600, 1010), (740, 905)], fill=(255, 255, 255, 255))
    d.line([(640, 905), (600, 1010), (740, 912)], fill=(40, 30, 40, 255), width=26, joint="curve")
    for i, x in enumerate([680, 780, 880]):
        d.ellipse([x - 34, 760 - 34, x + 34, 760 + 34], fill=(40, 30, 40, 255))
    return img


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    big = draw()
    for size in (16, 32, 48, 128):
        big.resize((size, size), Image.LANCZOS).save(OUT / f"icon{size}.png")
    big.resize((512, 512), Image.LANCZOS).save(OUT / "icon512.png")


if __name__ == "__main__":
    main()
