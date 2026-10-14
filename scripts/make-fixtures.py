"""Generate the small synthetic manga pages used by the end-to-end tests.

Run with `python3 scripts/make-fixtures.py`; outputs are committed under tests/fixtures.
"""
import io
import pathlib
import zipfile

from PIL import Image, ImageDraw

OUT = pathlib.Path(__file__).resolve().parent.parent / "tests" / "fixtures"


def page(w: int, h: int, bubbles: list[tuple[int, int, int, int]], tone: bool = True) -> Image.Image:
    img = Image.new("RGB", (w, h), "white")
    d = ImageDraw.Draw(img)
    # Panel borders and a little screentone so the page is not blank.
    d.rectangle([20, 20, w - 20, h - 20], outline="black", width=6)
    if tone:
        for y in range(30, h - 30, 9):
            for x in range(30 + (y // 9 % 2) * 4, w - 30, 9):
                d.ellipse([x, y, x + 2, y + 2], fill=(150, 150, 150))
    for (x0, y0, x1, y1) in bubbles:
        d.ellipse([x0, y0, x1, y1], fill="white", outline="black", width=5)
        # Vertical "text" columns.
        cx = (x0 + x1) // 2
        for i, dx in enumerate((-18, 18)):
            for k in range(5):
                yy = y0 + (y1 - y0) // 4 + k * 22
                d.rectangle([cx + dx - 7, yy, cx + dx + 7, yy + 14], fill="black")
    return img


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    p1 = page(800, 1200, [(250, 80, 550, 420), (80, 700, 360, 1000)])
    p2 = page(800, 1200, [(420, 120, 720, 460)])
    p1.save(OUT / "page1.png", optimize=True)
    p2.save(OUT / "page2.png", optimize=True)
    page(600, 3600, [(150, 200, 450, 500), (150, 1700, 450, 2000), (150, 3100, 450, 3400)], tone=False).save(
        OUT / "strip.png", optimize=True
    )
    Image.new("RGB", (64, 64), (230, 57, 80)).save(OUT / "icon.png")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name, img in (("chapter/010.png", p2), ("chapter/002.png", p1)):
            b = io.BytesIO()
            img.save(b, format="PNG", optimize=True)
            z.writestr(name, b.getvalue())
        z.writestr("__MACOSX/chapter/._002.png", b"junk")
        z.writestr("chapter/readme.txt", b"not a page")
    (OUT / "chapter.cbz").write_bytes(buf.getvalue())

    # Plain greyscale pages (no screentone) keep the PDF small.
    q1 = page(800, 1200, [(250, 80, 550, 420)], tone=False).convert("L")
    q2 = page(800, 1200, [(420, 120, 720, 460)], tone=False).convert("L")
    q1.save(OUT / "volume.pdf", save_all=True, append_images=[q2], resolution=100)


if __name__ == "__main__":
    main()
