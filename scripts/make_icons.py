"""Generates assets/icon.png, assets/icon.ico and web/icon.svg."""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
S = 1024
BARS = [0.30, 0.52, 0.78, 0.46, 0.92, 0.62, 0.38, 0.70, 0.44, 0.26]
HOT = 4

def render(size=S):
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    grad = Image.new("RGBA", (S, S))
    px = grad.load()
    a, b = (99, 102, 241), (168, 85, 247)
    for y in range(S):
        for x in range(S):
            t = (x + y) / (2 * S)
            px[x, y] = tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3)) + (255,)
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle([40, 40, S - 40, S - 40], radius=230, fill=255)
    img.paste(grad, (0, 0), mask)
    d = ImageDraw.Draw(img)
    n = len(BARS)
    w, gap = 52, 26
    total = n * w + (n - 1) * gap
    x0 = (S - total) // 2
    for i, h in enumerate(BARS):
        bh = int(560 * h)
        x = x0 + i * (w + gap)
        y = S // 2 - bh // 2
        color = (251, 191, 36, 255) if i == HOT else (255, 255, 255, 240)
        d.rounded_rectangle([x, y, x + w, y + bh], radius=w // 2, fill=color)
    return img.resize((size, size), Image.LANCZOS)

big = render()
(ROOT / "assets").mkdir(exist_ok=True)
big.resize((256, 256), Image.LANCZOS).save(ROOT / "assets" / "icon.png")
big.save(ROOT / "assets" / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])

# SVG favicon / logo
n = len(BARS); w, gap = 52, 26; total = n * w + (n - 1) * gap; x0 = (S - total) // 2
rects = []
for i, h in enumerate(BARS):
    bh = int(560 * h); x = x0 + i * (w + gap); y = S // 2 - bh // 2
    fill = "#fbbf24" if i == HOT else "#ffffff"
    rects.append(f'<rect x="{x}" y="{y}" width="{w}" height="{bh}" rx="26" fill="{fill}"/>')
svg = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {S} {S}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">'
       '<stop offset="0" stop-color="#6366f1"/><stop offset="1" stop-color="#a855f7"/></linearGradient></defs>'
       f'<rect x="40" y="40" width="{S-80}" height="{S-80}" rx="230" fill="url(#g)"/>{"".join(rects)}</svg>')
(ROOT / "web" / "icon.svg").write_text(svg)
print("ok")
