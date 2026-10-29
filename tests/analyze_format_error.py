"""Empirical error analysis for the log-ratio ice-thickness method.

  t = lambda * ln(I0 / Im)

A. What is test-image/3-ice.png really?  bit depth, clipping, level comb,
   JPEG heritage, per-hole statistics and statistical error on t.
B. JPEG quality sweep: how many nanometres does .jpg compression cost?
C. 8-bit quantisation: worst-case and typical bias at this image's levels.
"""
import io

import numpy as np
from PIL import Image

SRC = "test-image/3-ice.png"
LAM = 350.0          # 300 kV default used by the tool
HOLES = [            # from the detection reference (cx, cy, r)
    (1228.0, 224.0, 207.8),
    (214.0, 770.0, 203.0),
    (1006.0, 1008.0, 203.6),
    (1806.0, 1248.0, 207.2),
    (782.0, 1802.0, 208.5),
]


def mask_for(shape, cx, cy, r):
    yy, xx = np.ogrid[:shape[0], :shape[1]]
    return (xx - cx) ** 2 + (yy - cy) ** 2 <= r * r


def thickness(I0, Im):
    return LAM * np.log(I0 / Im)


print("=" * 72)
print("A. WHAT IS test-image/3-ice.png REALLY?")
print("=" * 72)
im = Image.open(SRC)
print(f"PIL mode: {im.mode}   size: {im.size}")
rgb = np.asarray(im.convert("RGB"))
arr = np.asarray(im.convert("L")).astype(np.float64)
print(f"R==G==B (true grayscale): {np.array_equal(rgb[:, :, 0], rgb[:, :, 1]) and np.array_equal(rgb[:, :, 1], rgb[:, :, 2])}")

u = np.unique(arr)
print(f"distinct grey levels used: {len(u)} of 256   min={u.min():.0f} max={u.max():.0f}")
print(f"pixels at 0 (clipped black): {(arr == 0).mean()*100:.3f} %")
print(f"pixels at 255 (clipped white): {(arr == 255).mean()*100:.3f} %")
print(f"pixels >=250: {(arr >= 250).mean()*100:.3f} %")

gaps = np.diff(u)
print(f"gaps between consecutive used levels: max={gaps.max():.0f}  "
      f"mean={gaps.mean():.2f}  (#gaps>1: {(gaps > 1).sum()})")
print("  -> a comb/gap pattern would indicate a 16->8-bit rescale with gain > 1")

# JPEG heritage: 8x8 block boundaries have extra discontinuities
for axis, name in ((1, "vertical"), (0, "horizontal")):
    d = np.abs(np.diff(arr, axis=axis))
    if axis == 1:
        blk, oth = d[:, 7::8].mean(), np.delete(d, np.s_[7::8], axis=1).mean()
    else:
        blk, oth = d[7::8, :].mean(), np.delete(d, np.s_[7::8], axis=0).mean()
    print(f"  {name} 8-px-boundary discontinuity / other: {blk/oth:.3f} "
          f"({blk:.3f} vs {oth:.3f} levels)")

print("\nPer-hole statistics (full radius r, and 70 % radius as the tool uses):")
print(f"{'hole':>5} {'mean(r)':>9} {'std':>7} {'SEM':>8} {'mean(.7r)':>10} "
      f"{'t(nm)':>8} {'+-stat':>8}")
stats = []
for i, (cx, cy, r) in enumerate(HOLES, 1):
    m = mask_for(arr.shape, cx, cy, r)
    vals = arr[m]
    m7 = mask_for(arr.shape, cx, cy, 0.7 * r)
    vals7 = arr[m7]
    stats.append({"mean": vals.mean(), "std": vals.std(),
                  "sem": vals.std() / np.sqrt(len(vals)),
                  "mean7": vals7.mean(), "n": len(vals)})
    print(f"{i:>5} {vals.mean():9.2f} {vals.std():7.2f} "
          f"{vals.std()/np.sqrt(len(vals)):8.4f} {vals7.mean():10.2f}")

i0 = int(np.argmax([s["mean7"] for s in stats]))
print(f"\nreference = hole {i0+1} (brightest, mean {stats[i0]['mean7']:.2f})")
for i, s in enumerate(stats, 1):
    if i - 1 == i0:
        continue
    t = thickness(stats[i0]["mean7"], s["mean7"])
    # statistical error propagated through t = lam*ln(I0/Im)
    rel = np.sqrt((stats[i0]["sem"] / stats[i0]["mean7"]) ** 2 +
                  (s["sem"] / s["mean7"]) ** 2)
    print(f"  hole {i}: t = {t:7.2f} nm   statistical +-{LAM*rel:.3f} nm")

print()
print("=" * 72)
print("B. JPEG QUALITY SWEEP (same pixels, lossy re-encode)")
print("=" * 72)
print(f"{'quality':>8} {'blockiness':>10} {'dMean(I0)':>10} {'dMean(Im)':>10} "
      f"{'t(nm)':>9} {'dt(nm)':>8} {'dt(%)':>7}")
base_means = [s["mean7"] for s in stats]
base_t = {i: thickness(base_means[i0], base_means[i]) for i in range(len(HOLES)) if i != i0}
for q in (95, 90, 85, 75, 60, 40):
    buf = io.BytesIO()
    im.convert("L").save(buf, format="JPEG", quality=q)
    buf.seek(0)
    j = np.asarray(Image.open(buf).convert("L")).astype(np.float64)
    means = [j[mask_for(j.shape, cx, cy, 0.7 * r)].mean() for cx, cy, r in HOLES]
    d = np.abs(np.diff(j, axis=1))
    blk, oth = d[:, 7::8].mean(), np.delete(d, np.s_[7::8], axis=1).mean()
    rows = []
    for i in range(len(HOLES)):
        if i == i0:
            continue
        t = thickness(means[i0], means[i])
        rows.append((t, t - base_t[i]))
    t_avg = np.mean([r[0] for r in rows])
    dt_avg = np.mean([r[1] for r in rows])
    print(f"{q:>8} {blk/oth:>10.3f} "
          f"{(means[i0]-base_means[i0]):>+10.3f} "
          f"{np.mean([means[i]-base_means[i] for i in range(len(HOLES)) if i != i0]):>+10.3f} "
          f"{t_avg:>9.2f} {dt_avg:>+8.2f} "
          f"{100*dt_avg/np.mean(list(base_t.values())):>+6.1f}%")

print()
print("=" * 72)
print("C. 8-BIT QUANTISATION ERROR (at this image's levels)")
print("=" * 72)
I0b, Imb = stats[i0]["mean7"], stats[max((i for i in range(len(HOLES)) if i != i0),
                                        key=lambda i: abs(stats[i]["mean7"] - stats[i0]["mean7"]))]["mean7"]
t_base = thickness(I0b, Imb)
print(f"example pair: I0 = {I0b:.2f}, Im = {Imb:.2f} (the thinnest, hardest case)")
print(f"  t = {t_base:.2f} nm")
hi = thickness(I0b + 0.5, Imb - 0.5)
lo = thickness(I0b - 0.5, Imb + 0.5)
print(f"  worst case +-0.5 level rounding: {lo:.2f} .. {hi:.2f} nm "
      f"({lo-t_base:+.2f} .. {hi-t_base:+.2f} nm)")
lsb16 = 255.0 / 65535.0   # one 16-bit level expressed in 8-bit units
hi16 = thickness(I0b + 0.5 * lsb16, Imb - 0.5 * lsb16)
lo16 = thickness(I0b - 0.5 * lsb16, Imb + 0.5 * lsb16)
print(f"  16-bit instead (1 LSB = {lsb16:.5f} of a level): "
      f"{lo16 - t_base:+.4f} .. {hi16 - t_base:+.4f} nm")

rng = np.random.default_rng(0)
n = 66000
print(f"\n  Monte Carlo, {n} pixels/ROI, 200 trials (noise sigma in grey levels):")
print(f"  {'sigma':>6} {'bias dt(nm)':>12} {'spread dt(nm)':>14}")
for sigma in (0.0, 0.1, 0.3, 1.0, 3.0):
    out = []
    for _ in range(200):
        a = np.clip(np.round(rng.normal(I0b, sigma, n)), 0, 255).mean()
        b = np.clip(np.round(rng.normal(Imb, sigma, n)), 0, 255).mean()
        out.append(thickness(a, b))
    out = np.array(out)
    print(f"  {sigma:>6.1f} {out.mean()-t_base:>+12.3f} {out.std():>14.3f}")

print("\nSensitivity rule of thumb:  dt = lambda * (relative error of I0/Im)")
for pct in (0.5, 1.0, 2.0, 5.0):
    print(f"  {pct:>4.1f}% ratio error  ->  {LAM*pct/100:5.2f} nm   (at lambda = {LAM:.0f} nm)")
print(f"  lambda uncertainty (+-20 %)  ->  +-{0.2*100:.0f}% of every value "
      f"(e.g. +-{0.2*t_base:.1f} nm on {t_base:.1f} nm)")
print(f"  tilt theta: path length t/cos(theta)  ->  +{100*(1/np.cos(np.radians(20))-1):.1f}% at 20 deg")
