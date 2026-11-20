/* TraceLens paper tracker.
 * Tracks a similarity transform (move + rotate + zoom) of the scene between a
 * keyframe and the live frame, using textured patches on the paper/table.
 * Pure functions on grayscale Float32Array images; no DOM.
 *   p = [a, b, tx, ty]  :  x' = a*x - b*y + tx ;  y' = b*x + a*y + ty
 */
(function (root) {
  'use strict';
  const P = 5, PS = 2 * P + 1, N = PS * PS;

  function integral(src, w, h) {
    const W = w + 1, I = new Float64Array(W * (h + 1));
    for (let y = 0; y < h; y++) {
      let s = 0;
      for (let x = 0; x < w; x++) { s += src[y * w + x]; I[(y + 1) * W + x + 1] = I[y * W + x + 1] + s; }
    }
    return I;
  }
  // sum over [x0,x1) x [y0,y1)
  function box(I, w, x0, y0, x1, y1) {
    const W = w + 1;
    return I[y1 * W + x1] - I[y0 * W + x1] - I[y1 * W + x0] + I[y0 * W + x0];
  }

  /* Pick well-textured corner-like patches spread over a grid (Shi-Tomasi score). */
  function select(g, w, h, R, opt) {
    opt = opt || {};
    const gx = opt.gx || 8, gy = opt.gy || 6, minScore = opt.minScore || 300;
    const n = w * h, xx = new Float32Array(n), yy = new Float32Array(n), xy = new Float32Array(n);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x, ix = (g[i + 1] - g[i - 1]) / 2, iy = (g[i + w] - g[i - w]) / 2;
      xx[i] = ix * ix; yy[i] = iy * iy; xy[i] = ix * iy;
    }
    const Ixx = integral(xx, w, h), Iyy = integral(yy, w, h), Ixy = integral(xy, w, h);
    const m = P + R + 2, cands = [];
    let maxS = 0;
    for (let cy = 0; cy < gy; cy++) for (let cx = 0; cx < gx; cx++) {
      const x0 = Math.max(m, Math.floor(cx * w / gx)), x1 = Math.min(w - m, Math.floor((cx + 1) * w / gx));
      const y0 = Math.max(m, Math.floor(cy * h / gy)), y1 = Math.min(h - m, Math.floor((cy + 1) * h / gy));
      let best = 0, bx = -1, by = -1;
      for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) {
        const a = box(Ixx, w, x - P, y - P, x + P + 1, y + P + 1);
        const c = box(Iyy, w, x - P, y - P, x + P + 1, y + P + 1);
        const b = box(Ixy, w, x - P, y - P, x + P + 1, y + P + 1);
        const s = (a + c) / 2 - Math.sqrt(((a - c) / 2) ** 2 + b * b);
        if (s > best) { best = s; bx = x; by = y; }
      }
      if (bx >= 0) { cands.push({ x: bx, y: by, s: best }); if (best > maxS) maxS = best; }
    }
    const feats = [];
    for (const c of cands) {
      if (c.s < minScore || c.s < maxS * 0.04) continue;
      const t = new Float32Array(N); let k = 0, mean = 0;
      for (let dy = -P; dy <= P; dy++) for (let dx = -P; dx <= P; dx++) mean += (t[k++] = g[(c.y + dy) * w + c.x + dx]);
      mean /= N; let e = 0; for (k = 0; k < N; k++) { t[k] -= mean; e += Math.abs(t[k]); }
      feats.push({ x: c.x, y: c.y, t, e });
    }
    return feats;
  }

  // zero-mean SAD of template t at centre (x,y); stops early once >= limit
  function cost(g, w, I, t, x, y, limit) {
    const mean = box(I, w, x - P, y - P, x + P + 1, y + P + 1) / N;
    let s = 0, k = 0;
    for (let dy = -P; dy <= P; dy++) {
      const row = (y + dy) * w + x - P;
      for (let dx = 0; dx < PS; dx++) s += Math.abs(g[row + dx] - mean - t[k++]);
      if (s >= limit) return s;
    }
    return s;
  }

  /* Find each keyframe patch in the new frame, searching ±R px around where the
     current transform p predicts it. Returns [kx, ky, nx, ny] pairs. */
  function track(g, w, h, feats, p, R, maxAvg) {
    maxAvg = maxAvg || 6;
    const I = integral(g, w, h), out = [];
    const [a, b, tx, ty] = p;
    for (const f of feats) {
      const cx = Math.round(a * f.x - b * f.y + tx), cy = Math.round(b * f.x + a * f.y + ty);
      if (cx - R - P < 1 || cy - R - P < 1 || cx + R + P > w - 2 || cy + R + P > h - 2) continue;
      let best = Infinity, bx = 0, by = 0;
      for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
        const s = cost(g, w, I, f.t, cx + dx, cy + dy, best);
        if (s < best) { best = s; bx = cx + dx; by = cy + dy; }
      }
      // reject if no better than half the patch's own contrast: occluded (hand/pencil) or changed
      if (best > Math.max(maxAvg * N, 0.5 * f.e)) continue;
      const c0 = best;
      const cl = cost(g, w, I, f.t, bx - 1, by, Infinity), cr = cost(g, w, I, f.t, bx + 1, by, Infinity);
      const cu = cost(g, w, I, f.t, bx, by - 1, Infinity), cd = cost(g, w, I, f.t, bx, by + 1, Infinity);
      const ddx = cl - 2 * c0 + cr, ddy = cu - 2 * c0 + cd;
      const ox = ddx > 0 ? Math.max(-.5, Math.min(.5, (cl - cr) / (2 * ddx))) : 0;
      const oy = ddy > 0 ? Math.max(-.5, Math.min(.5, (cu - cd) / (2 * ddy))) : 0;
      out.push([f.x, f.y, bx + ox, by + oy]);
    }
    return out;
  }

  function fit(m) {
    let px = 0, py = 0, qx = 0, qy = 0; const n = m.length;
    for (const [a, b, c, d] of m) { px += a; py += b; qx += c; qy += d; }
    px /= n; py /= n; qx /= n; qy /= n;
    let num1 = 0, num2 = 0, den = 0;
    for (const [a, b, c, d] of m) {
      const ux = a - px, uy = b - py, vx = c - qx, vy = d - qy;
      num1 += ux * vx + uy * vy; num2 += ux * vy - uy * vx; den += ux * ux + uy * uy;
    }
    if (den < 1e-6) return null;
    const A = num1 / den, B = num2 / den;
    return [A, B, qx - (A * px - B * py), qy - (B * px + A * py)];
  }
  function residuals(m, p) {
    return m.map(([x, y, u, v]) => Math.hypot(p[0] * x - p[1] * y + p[2] - u, p[1] * x + p[0] * y + p[3] - v));
  }
  /* Least-squares similarity with two rounds of outlier rejection. */
  function robustFit(m, minInl) {
    minInl = minInl || 4;
    if (m.length < minInl) return null;
    let p = fit(m), cur = m;
    for (let it = 0; it < 2 && p; it++) {
      const r = residuals(cur, p), med = r.slice().sort((a, b) => a - b)[r.length >> 1];
      const thr = Math.max(1, 3 * med);
      const inl = cur.filter((_, i) => r[i] <= thr);
      if (inl.length < minInl) return null;
      cur = inl; p = fit(cur);
    }
    if (!p) return null;
    const s = Math.hypot(p[0], p[1]);
    if (s < 0.5 || s > 2) return null;             // implausible jump
    return { p, inliers: cur.length };
  }

  const api = { select, track, robustFit, fit, P };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.PaperTracker = api;
})(typeof self !== 'undefined' ? self : this);
