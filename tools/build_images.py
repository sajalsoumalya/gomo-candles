"""Build web-ready product photos for the GoMo shop from assets/images (originals) into assets/img (WebP).

Studio shots (white background) are cropped tightly around the product; lifestyle shots are resized; the combo
cut-out keeps its transparency. Re-run after replacing any original:  python3 tools/build_images.py
"""
from pathlib import Path
from PIL import Image, ImageChops

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'assets' / 'images'
OUT = ROOT / 'assets' / 'img'
OUT.mkdir(exist_ok=True)

STUDIO = {'candle': 'evil_eye_candle.jpg', 'sachet': 'evil_eye_sachet.jpg', 'mist': 'bed_mist.jpg'}
LIFESTYLE = {
    'candle-desk': 'evil_eye_candle_2.jpg', 'sachet-wardrobe': 'evil_eye_sachet_2.jpg', 'mist-bed': 'bed_mist_2.jpg',
    'gift-open': 'combo_gift_box_open.jpg', 'gift-closed': 'combo_gift_box_closed.jpg',
}


def save(im, name, width, quality=82):
    im = im.copy()
    if im.width > width:
        im = im.resize((width, round(im.height * width / im.width)), Image.LANCZOS)
    path = OUT / f'{name}-{width}.webp'
    im.save(path, 'WEBP', quality=quality, method=6)
    print(f'{path.name:32} {im.width}x{im.height} {path.stat().st_size // 1024} KB')


def product_box(im, threshold=236):
    """Bounding box of everything that is not (near) white — the product plus its soft shadow."""
    gray = im.convert('L')
    mask = gray.point(lambda v: 255 if v < threshold else 0)
    return mask.getbbox()


def crop_to(im, box, aspect, pad):
    """Expand box by `pad` (fraction of its size), then to `aspect` (w/h), clamped to the image."""
    l, t, r, b = box
    w, h = r - l, b - t
    cx, cy = (l + r) / 2, (t + b) / 2
    w, h = w * (1 + 2 * pad), h * (1 + 2 * pad)
    if w / h < aspect:
        w = h * aspect
    else:
        h = w / aspect
    w, h = min(w, im.width), min(h, im.height)
    l = max(0, min(im.width - w, cx - w / 2))
    t = max(0, min(im.height - h, cy - h / 2))
    return im.crop((round(l), round(t), round(l + w), round(t + h)))


for name, file in STUDIO.items():
    im = Image.open(SRC / file).convert('RGB')
    box = product_box(im)
    card = crop_to(im, box, 1.17, 0.16)   # product cards / gallery (matches the 4-column card shape)
    save(card, name, 1400)
    save(card, name, 700)
    square = crop_to(im, box, 1.0, 0.10)  # category tiles, packs, cart, hero avatars
    save(square, f'{name}-sq', 480)
    save(square, f'{name}-sq', 160)

for name, file in LIFESTYLE.items():
    im = Image.open(SRC / file).convert('RGB')
    save(im, name, 1600, 80)
    save(im, name, 800, 80)

# square gift-box thumbnail (category tile, hero avatars): centred on the box
gift = Image.open(SRC / 'combo_gift_box_closed.jpg').convert('RGB')
side = round(gift.height * 0.78)
cx, cy = gift.width * 0.49, gift.height * 0.6
gift = gift.crop((round(cx - side / 2), round(cy - side / 2), round(cx + side / 2), round(cy + side / 2)))
save(gift, 'gift-sq', 480)
save(gift, 'gift-sq', 160)

combo = Image.open(SRC / '3_combo.png').convert('RGBA')
box = combo.getchannel('A').point(lambda a: 255 if a > 8 else 0).getbbox()
l, t, r, b = box
pad = round((r - l) * 0.04)
combo = combo.crop((max(0, l - pad), max(0, t - pad), min(combo.width, r + pad), min(combo.height, b + pad)))
save(combo, 'combo-trio', 1200, 85)
save(combo, 'combo-trio', 480, 85)
sq = Image.new('RGBA', (max(combo.size),) * 2, (0, 0, 0, 0))
sq.paste(combo, ((sq.width - combo.width) // 2, (sq.height - combo.height) // 2), combo)
save(sq, 'combo-trio-sq', 160, 85)
