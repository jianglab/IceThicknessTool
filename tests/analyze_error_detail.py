"""Follow-up error analysis: saturation, ROI-radius sensitivity, pedestal,
gamma, and JPEG error vs ROI size / placement.

   t = lambda * ln(I0 / Im)
"""
import io

import numpy as np
from PIL import Image

LAM = 350.0
SRC = "test-image/3-ice.png"
HOLES = [
    (1228.0, 224.0, 207.8),
    (214.0, 770.0, 203.0),
    (1006.0, 1008.0, 203.6),
    (1806.0, 1248.0, 207.2),
    (782.0, 1802.0, 208.5),
]
arr0 = np.asarray(Image.open(SRC).convert("L")).astype(np.float64)
H, W = arr0.shape


def circ(shape, cx, cy, r):
    yy, xx = np.ogrid[:shape[0], :shape[1]]
    return (xx - cx) ** 2 + (yy - cy) ** 2 <= r * r


def mean_in(a, cx, cy, r):
    return a[circ(a.shape, cx, cy, r)].mean()


def t_of(I0, Im):
    return LAM * np.log(I0 / Im)


print("=" * 74)
print("1. SATURATION / CLIPPING INSIDE THE ROI (this image is 8-bit)")
print("=" * 74)
print(f"{'hole':>5} {'mean(full r)':>13} {'%at255':>8} {'%at0':>7} "
      f"{'mean(.7r)':>10} {'%at255':>8}")
for i, (cx, cy, r) in enumerate(HOLES, 1):
    m = circ(arr0.shape, cx, cy, r)
    m7 = circ(arr0.shape, cx, cy, 0.7 * r)
    print(f"{i:>5} {arr0[m].mean():>13.2f} {100*(arr0[m] == 255).mean():>7.2f}% "
          f"{100*(arr0[m] == 0).mean():>6.2f}% {arr0[m7].mean():>10.2f} "
          f"{100*(arr0[m7] == 255).mean():>7.2f}%")

print(f"\nwhole image: {100*(arr0 == 255).mean():.2f}% at 255, "
      f"{100*(arr0 == 0).mean():.2f}% at 0  -> contrast-stretched 8-bit export")

print()
print("=" * 74)
print("2. ROI-RADIUS SENSITIVITY (radial profile inside a hole)")
print("=" * 74)
print("thickness as a function of the ROI radius fraction, all ROIs at the")
print("same fraction (reference = brightest hole at that same fraction):")
fracs = [0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0]
print(f"{'hole':>5} " + " ".join(f"{f:>7.1f}r" for f in fracs))
ref_vals = {}
for i, (cx, cy, r) in enumerate(HOLES, 1):
    ref_vals[i] = [mean_in(arr0, cx, cy, f * r) for f in fracs]
i0 = int(np.argmax([ref_vals[i][3] for i in range(1, 6)])) + 1
for i in range(1, 6):
    if i == i0:
        continue
    ts = [t_of(ref_vals[i0][k], ref_vals[i][k]) for k in range(len(fracs))]
    print(f"{i:>5} " + " ".join(f"{t:>8.1f}" for t in ts))
base = [t_of(ref_vals[i0][3], ref_vals[i][3]) for i in range(1, 6) if i != i0]
worst = 0.0
for k, f in enumerate(fracs):
    ts = [t_of(ref_vals[i0][k], ref_vals[i][k]) for i in range(1, 6) if i != i0]
    dev = max(abs(a - b) / b for a, b in zip(ts, base)) * 100
    worst = max(worst, dev)
print(f"-> choosing 0.4r instead of 0.7r changes a value by up to {worst:.1f}% "
      f"(rim contamination / Fresnel fringe)")

print()
print("=" * 74)
print("3. WHAT IF A NONLINEAR TONE CURVE WAS BAKED IN? (gamma)")
print("=" * 74)
for g in (1.0, 0.8, 0.5, 0.45):
    a = 255.0 * (arr0 / 255.0) ** g
    m = [mean_in(a, cx, cy, 0.7 * r) for cx, cy, r in HOLES]
    ts = [t_of(m[i0 - 1], m[i - 1]) for i in range(1, 6) if i != i0]
    print(f"  gamma = {g:<4} -> t = [" +
          ", ".join(f"{t:.1f}" for t in ts) + "] nm")

print()
print("=" * 74)
print("4. UNSHIFTED CAMERA PEDESTAL (offset not subtracted)")
print("=" * 74)
print("the formula needs intensity proportional to electron counts; any")
print("constant offset b biases the log ratio:")
print(f"{'b (levels)':>11} {'t (nm)':>9} {'delta':>9} {'delta %':>8}")
m0 = mean_in(arr0, HOLES[i0 - 1][0], HOLES[i0 - 1][1], 0.7 * HOLES[i0 - 1][2])
m1 = mean_in(arr0, HOLES[1][0], HOLES[1][1], 0.7 * HOLES[1][2])  # darkest hole
for b in (0, 2, 5, 10, 20):
    tt = t_of(m0 - b, m1 - b)
    print(f"{b:>11} {tt:>9.2f} {tt - t_of(m0, m1):>+9.2f} "
          f"{100*(tt/t_of(m0, m1) - 1):>+7.1f}%")

print()
print("=" * 74)
print("5. JPEG ERROR vs ROI SIZE AND PLACEMENT")
print("=" * 74)
# smooth interior of the darkest hole, textured carbon film, and a hole rim
cases = [
    ("hole interior r=100", HOLES[1][0], HOLES[1][1], 100),
    ("hole interior r=30", HOLES[1][0], HOLES[1][1], 30),
    ("hole interior r=10", HOLES[1][0], HOLES[1][1], 10),
    ("carbon film  r=100", 700, 1350, 100),
    ("carbon film  r=10", 700, 1350, 10),
    ("hole rim     r=10", HOLES[1][0] + 195, HOLES[1][1], 10),
]
print(f"{'case':>20} " + " ".join(f"{('Q' + str(q)):>8}" for q in (95, 90, 75, 50)))
for name, cx, cy, r in cases:
    base_m = mean_in(arr0, cx, cy, r)
    row = []
    for q in (95, 90, 75, 50):
        buf = io.BytesIO()
        Image.fromarray(arr0.astype(np.uint8)).save(buf, format="JPEG", quality=q)
        buf.seek(0)
        j = np.asarray(Image.open(buf).convert("L")).astype(np.float64)
        row.append(LAM * abs(np.log(mean_in(j, cx, cy, r) / base_m)))
    print(f"{name:>20} " + " ".join(f"{d:>8.2f}" for d in row) + "   (nm error)")

print()
print("=" * 74)
print("6. QUANTISATION: 8-BIT vs 16-BIT (correct LSB scaling)")
print("=" * 74)
i0m = mean_in(arr0, HOLES[i0 - 1][0], HOLES[i0 - 1][1], 0.7 * HOLES[i0 - 1][2])
imm = mean_in(arr0, HOLES[1][0], HOLES[1][1], 0.7 * HOLES[1][2])
tb = t_of(i0m, imm)
lsb16 = 255.0 / 65535.0            # one 16-bit level, in 8-bit units
print(f"pair I0={i0m:.2f}, Im={imm:.2f}  ->  t = {tb:.2f} nm")
hi8 = t_of(i0m + 0.5, imm - 0.5)
lo8 = t_of(i0m - 0.5, imm + 0.5)
print(f"  8-bit, +-0.5 level each : {lo8 - tb:+.2f} .. {hi8 - tb:+.2f} nm")
hi16 = t_of(i0m + 0.5 * lsb16, imm - 0.5 * lsb16)
lo16 = t_of(i0m - 0.5 * lsb16, imm + 0.5 * lsb16)
print(f"  16-bit, +-0.5 level each: {lo16 - tb:+.4f} .. {hi16 - tb:+.4f} nm "
      f"(1 LSB = {lsb16:.5f} of a level)")
