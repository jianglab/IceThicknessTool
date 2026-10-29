"""Fixtures for the hole-detection test.

1. tests/real_3ice.tif    -- test-image/3-ice.png converted to 8-bit TIFF so
                            the JS pipeline can decode it; ground truth comes
                            from the NumPy prototype (5 complete holes).
2. tests/synth_holes.tif   -- synthetic lattice with KNOWN circles, plus
                            decoys that must be rejected (border-clipped
                            circles, a rectangular blob, a small speck).
"""
import json

import numpy as np
from PIL import Image

# ---------------------------------------------------------------- real image
real = Image.open("test-image/3-ice.png").convert("L")
real.save("tests/real_3ice.tif")
print("wrote tests/real_3ice.tif", real.size)

# ------------------------------------------------------------ synthetic grid
W = H = 1024
rng = np.random.default_rng(7)
R = 90
BACKGROUND = 2000.0
HOLE = 4000.0

img = np.full((H, W), BACKGROUND)
# film texture so the threshold is not trivially clean
tex = 220 * np.sin(np.arange(W)[None, :] / 9.0) * np.sin(np.arange(H)[:, None] / 11.0)
img += tex
img += rng.normal(0, 70, (H, W))

full_holes = [
    (150, 150), (450, 150), (750, 150),
    (150, 450), (450, 450), (750, 450),
    (150, 750),
    # clipped by the frame: must NOT be detected. Kept well clear of the
    # complete holes above -- if a clipped hole touches one, the two merge
    # into a single border-touching blob and both are rejected.
    (-20, 950), (512, 1030),
]

yy, xx = np.ogrid[:H, :W]
for cx, cy in full_holes:
    img[(xx - cx) ** 2 + (yy - cy) ** 2 <= R ** 2] = HOLE + rng.normal(0, 70)

# decoy 1: bright rectangle (fails the circularity/fill test)
img[880:960, 300:600] = HOLE
# decoy 2: small bright speck (fails the size test)
img[(xx - 900) ** 2 + (yy - 520) ** 2 <= 8 ** 2] = HOLE
# decoy 3: dark blob (below threshold)
img[(xx - 640) ** 2 + (yy - 700) ** 2 <= 45 ** 2] = 400.0

img = np.clip(img, 0, 65535).astype(np.uint16)
Image.fromarray(img, mode="I;16").save("tests/synth_holes.tif")
print("wrote tests/synth_holes.tif", (W, H))

truth = {
    "synth_holes.tif": {
        "size": [W, H],
        "holes": [[float(cx), float(cy), float(R)] for cx, cy in full_holes[:7]],
        "must_not_detect": ["clipped holes", "rectangle", "small speck", "dark blob"],
    },
    "real_3ice.tif": {
        "size": list(real.size),
        # from tests/prototype_detect.py (NumPy reference implementation)
        "holes": [
            [1228.0, 224.0, 207.8],
            [214.0, 770.0, 203.0],
            [1006.0, 1008.0, 203.6],
            [1806.0, 1248.0, 207.2],
            [782.0, 1802.0, 208.5],
        ],
    },
}
with open("tests/detect_truth.json", "w") as fh:
    json.dump(truth, fh, indent=1)
print("wrote tests/detect_truth.json")
