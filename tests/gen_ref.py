"""Generate synthetic TIFF test images + ground-truth ROI means.

The means are computed with the exact same circular-mask formula as the
desktop tool (LocalApp/roi_gui_tool.py) so the web app's JS math can be
verified numerically.
"""
import json
import struct
import numpy as np
from PIL import Image

W, H = 256, 256
X = np.arange(W, dtype=np.float64)[None, :]
Y = np.arange(H, dtype=np.float64)[:, None]
img = 1000 + 800 * np.sin(X / 40.0) + 400 * np.sin(Y / 60.0) + 3.0 * X + 1.5 * Y
img = np.clip(img, 0, 65535)

ROIS = [(60, 80, 20), (150, 140, 35), (200, 60, 15)]
LAM = 350.0  # 300 kV default


def means(arr):
    """Ground-truth means, circular mask like the desktop tool."""
    yy, xx = np.ogrid[: arr.shape[0], : arr.shape[1]]
    out = []
    for cx, cy, r in ROIS:
        mask = (xx - cx) ** 2 + (yy - cy) ** 2 <= r ** 2
        out.append(float(np.mean(arr[mask])))
    return out


ref = {}

u16 = img.astype(np.uint16)
Image.fromarray(u16, mode="I;16").save("tests/t16_uncompressed.tif")
ref["t16_uncompressed.tif"] = means(u16.astype(np.float64))

Image.fromarray(u16, mode="I;16").save(
    "tests/t16_deflate.tif", compression="tiff_deflate"
)
ref["t16_deflate.tif"] = means(u16.astype(np.float64))

f32 = img.astype(np.float32)
Image.fromarray(f32, mode="F").save("tests/t_float32.tif")
ref["t_float32.tif"] = means(f32.astype(np.float64))

u8 = (img / 257.0).astype(np.uint8)
Image.fromarray(u8, mode="L").save("tests/t8.tif")
ref["t8.tif"] = means(u8.astype(np.float64))


# --- big-endian TIFFs (DigitalMicrograph / ImageJ style) ------------------
def write_tiff(path, arr, bps, sfmt=None):
    """Minimal single-strip big-endian grayscale TIFF writer."""
    h, w = arr.shape
    if bps == 16:
        strip = arr.astype(">u2").tobytes()
    else:
        strip = arr.astype(">f4").tobytes()
    tags = [
        (256, 4, 1, w),          # ImageWidth
        (257, 4, 1, h),          # ImageLength
        (258, 3, 1, bps),        # BitsPerSample
        (259, 3, 1, 1),          # Compression = none
        (262, 3, 1, 1),          # Photometric = BlackIsZero
        (273, 4, 1, 0),          # StripOffsets (patched below)
        (277, 3, 1, 1),          # SamplesPerPixel
        (278, 4, 1, h),          # RowsPerStrip
        (279, 4, 1, len(strip)), # StripByteCounts
        (284, 3, 1, 1),          # PlanarConfiguration = chunky
    ]
    if sfmt is not None:
        tags.append((339, 3, 1, sfmt))  # SampleFormat
    ntags = len(tags)
    ifd_size = 2 + ntags * 12 + 4
    strip_offset = 8 + ifd_size
    tags = [t for t in tags if t[0] != 273] + [(273, 4, 1, strip_offset)]
    out = b"MM" + struct.pack(">H", 42) + struct.pack(">I", 8)
    out += struct.pack(">H", ntags)
    for tag, typ, cnt, val in sorted(tags):
        out += struct.pack(">HHI", tag, typ, cnt)
        if typ == 3:
            out += struct.pack(">H", val) + b"\x00\x00"
        else:
            out += struct.pack(">I", val)
    out += struct.pack(">I", 0)
    out += strip
    with open(path, "wb") as fh:
        fh.write(out)


write_tiff("tests/t16_bigendian.tif", u16, 16)
ref["t16_bigendian.tif"] = means(u16.astype(np.float64))

write_tiff("tests/t_float32_bigendian.tif", f32, 32, sfmt=3)
ref["t_float32_bigendian.tif"] = means(f32.astype(np.float64))

# Expected thicknesses: lam * ln(I0 / Im) with ROI 0 as reference
for name in ref:
    m = ref[name]
    ref[name] = {
        "means": m,
        "thickness": [
            None if i == 0 else LAM * np.log(m[0] / mi)
            for i, mi in enumerate(m)
        ],
    }

with open("tests/ref_means.json", "w") as fh:
    json.dump(ref, fh, indent=1)

print("generated:", list(ref.keys()))
for name, d in ref.items():
    print(f"{name}: means={[round(v, 3) for v in d['means']]} "
          f"thickness={[None if t is None else round(t, 3) for t in d['thickness']]}")
