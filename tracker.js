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
    const H = p.length === 9 ? p : simToH(p);
    for (const f of feats) {
      const q = applyH(H, f.x, f.y), cx = Math.round(q[0]), cy = Math.round(q[1]);
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

  /* ---------- homography (handles phone tilt) ---------- */
  function simToH(p) { return [p[0], -p[1], p[2], p[1], p[0], p[3], 0, 0, 1]; }
  function applyH(H, x, y) {
    const z = H[6] * x + H[7] * y + H[8];
    return [(H[0] * x + H[1] * y + H[2]) / z, (H[3] * x + H[4] * y + H[5]) / z];
  }
  function mul3(A, B) {
    const C = new Array(9);
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) C[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
    return C;
  }
  function inv3(m) {
    const [a, b, c, d, e, f, g, h, i] = m, A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C; if (Math.abs(det) < 1e-12) return null;
    return [A / det, -(b * i - c * h) / det, (b * f - c * e) / det, B / det, (a * i - c * g) / det, -(a * f - c * d) / det, C / det, -(a * h - b * g) / det, (a * e - b * d) / det];
  }
  function solve(M, v) { // Gaussian elimination with partial pivoting, n x n
    const n = v.length;
    for (let c = 0; c < n; c++) {
      let piv = c; for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
      if (Math.abs(M[piv][c]) < 1e-12) return null;
      [M[c], M[piv]] = [M[piv], M[c]]; [v[c], v[piv]] = [v[piv], v[c]];
      for (let r = c + 1; r < n; r++) { const f = M[r][c] / M[c][c]; if (!f) continue; for (let k = c; k < n; k++) M[r][k] -= f * M[c][k]; v[r] -= f * v[c]; }
    }
    const x = new Array(n);
    for (let r = n - 1; r >= 0; r--) { let s = v[r]; for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k]; x[r] = s / M[r][r]; }
    return x;
  }
  function normT(pts) { // Hartley normalisation
    let mx = 0, my = 0; for (const [x, y] of pts) { mx += x; my += y; } mx /= pts.length; my /= pts.length;
    let d = 0; for (const [x, y] of pts) d += Math.hypot(x - mx, y - my); d = d / pts.length || 1;
    const s = Math.SQRT2 / d; return [s, 0, -s * mx, 0, s, -s * my, 0, 0, 1];
  }
  /* Least-squares homography from [x,y,u,v] pairs (>= 4). */
  function fitH(m) {
    const Ts = normT(m.map(q => [q[0], q[1]])), Td = normT(m.map(q => [q[2], q[3]]));
    const AtA = Array.from({ length: 8 }, () => new Array(8).fill(0)), Atb = new Array(8).fill(0);
    const add = (row, rhs) => { for (let i = 0; i < 8; i++) { Atb[i] += row[i] * rhs; for (let j = 0; j < 8; j++) AtA[i][j] += row[i] * row[j]; } };
    for (const [x0, y0, u0, v0] of m) {
      const x = Ts[0] * x0 + Ts[2], y = Ts[4] * y0 + Ts[5], u = Td[0] * u0 + Td[2], v = Td[4] * v0 + Td[5];
      add([x, y, 1, 0, 0, 0, -u * x, -u * y], u);
      add([0, 0, 0, x, y, 1, -v * x, -v * y], v);
    }
    const h = solve(AtA, Atb); if (!h) return null;
    const Tdi = inv3(Td); if (!Tdi) return null;
    const H = mul3(Tdi, mul3([...h, 1], Ts));
    return H.map(v => v / H[8]);
  }
  function plausibleH(H, w, h) {
    const c = [[0, 0], [w, 0], [w, h], [0, h]].map(([x, y]) => applyH(H, x, y));
    if (c.some(q => !isFinite(q[0]) || !isFinite(q[1]))) return false;
    let area = 0, sign = 0;
    for (let i = 0; i < 4; i++) {
      const a = c[i], b = c[(i + 1) % 4], d = c[(i + 2) % 4];
      const cr = (b[0] - a[0]) * (d[1] - b[1]) - (b[1] - a[1]) * (d[0] - b[0]);
      if (sign === 0) sign = Math.sign(cr); else if (Math.sign(cr) !== sign) return false; // must stay convex
      area += a[0] * b[1] - b[0] * a[1];
    }
    const ratio = Math.abs(area / 2) / (w * h);
    return ratio > 0.3 && ratio < 3;
  }
  /* Robust homography; falls back to similarity when too few points. */
  function robustFitH(m, w, h, prevH) {
    if (m.length >= 12) {
      let H = fitH(m), cur = m;
      for (let it = 0; it < 3 && H; it++) {
        const r = cur.map(([x, y, u, v]) => { const q = applyH(H, x, y); return Math.hypot(q[0] - u, q[1] - v); });
        const med = r.slice().sort((a, b) => a - b)[r.length >> 1], thr = Math.max(0.8, 2.5 * med);
        const inl = cur.filter((_, i) => r[i] <= thr);
        if (inl.length < 12) { H = null; break; }
        cur = inl; H = fitH(cur);
      }
      if (H && plausibleH(H, w, h)) return { H, inliers: cur.length, model: 'h' };
    }
    // too few points for full perspective: correct prev estimate by a similarity, keeping its tilt
    const base = prevH || simToH([1, 0, 0, 0]);
    const s = robustFit(m.map(([x, y, u, v]) => { const q = applyH(base, x, y); return [q[0], q[1], u, v]; }));
    return s ? { H: mul3(simToH(s.p), base), inliers: s.inliers, model: 's' } : null;
  }
  /* Homography from exactly 4 point pairs. */
  function fromCorners(src, dst) { return fitH(src.map((p, i) => [p[0], p[1], dst[i][0], dst[i][1]])); }

  /* One-Euro filter: heavy smoothing when still, low lag when moving. */
  function OneEuro(minCutoff, beta, dCutoff) { this.mc = minCutoff; this.beta = beta; this.dc = dCutoff || 1; this.x = null; }
  const alpha = (dt, fc) => 1 / (1 + 1 / (2 * Math.PI * fc * dt));
  OneEuro.prototype.filter = function (x, t) {
    if (this.x === null) { this.x = x; this.dx = 0; this.t = t; return x; }
    const dt = Math.max(1e-3, t - this.t); this.t = t;
    this.dx += alpha(dt, this.dc) * ((x - this.x) / dt - this.dx);
    this.x += alpha(dt, this.mc + this.beta * Math.abs(this.dx)) * (x - this.x);
    return this.x;
  };

  /* ================= v4 pipeline =================
     - brightness-proof matching: patches standardised (zero mean, unit std) => immune to auto-exposure
     - coarse-to-fine: half-res wide search fixes big shakes, full-res narrow search refines
     - after loss: much wider coarse search to re-acquire */
  function level(g, w, h) {
    const W = w + 1, I = new Float64Array(W * (h + 1)), I2 = new Float64Array(W * (h + 1));
    for (let y = 0; y < h; y++) {
      let s = 0, s2 = 0;
      for (let x = 0; x < w; x++) { const v = g[y * w + x]; s += v; s2 += v * v; I[(y + 1) * W + x + 1] = I[y * W + x + 1] + s; I2[(y + 1) * W + x + 1] = I2[y * W + x + 1] + s2; }
    }
    return { g, w, h, I, I2 };
  }
  function halve(g, w, h) {
    const w2 = w >> 1, h2 = h >> 1, o = new Float32Array(w2 * h2);
    for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) { const i = 2 * y * w + 2 * x; o[y * w2 + x] = (g[i] + g[i + 1] + g[i + w] + g[i + w + 1]) / 4; }
    return [o, w2, h2];
  }
  function stdTpl(L, x, y) {
    if (x - P < 0 || y - P < 0 || x + P >= L.w || y + P >= L.h) return null;
    const t = new Float32Array(N); let k = 0, m = 0, m2 = 0;
    for (let dy = -P; dy <= P; dy++) for (let dx = -P; dx <= P; dx++) { const v = L.g[(y + dy) * L.w + x + dx]; t[k++] = v; m += v; m2 += v * v; }
    m /= N; const sd = Math.sqrt(Math.max(0, m2 / N - m * m)); if (sd < 3) return null;
    for (k = 0; k < N; k++) t[k] = (t[k] - m) / sd;
    t.sd = sd; return t;
  }
  function ncost(L, t, x, y, limit, minSd) {
    const W = L.w + 1, x0 = x - P, y0 = y - P, x1 = x + P + 1, y1 = y + P + 1;
    const s1 = L.I[y1 * W + x1] - L.I[y0 * W + x1] - L.I[y1 * W + x0] + L.I[y0 * W + x0];
    const s2 = L.I2[y1 * W + x1] - L.I2[y0 * W + x1] - L.I2[y1 * W + x0] + L.I2[y0 * W + x0];
    const m = s1 / N, v = s2 / N - m * m;
    if (v < minSd * minSd) return Infinity;           // flat (blank paper / hand): not a match
    const inv = 1 / Math.sqrt(v), g = L.g, w = L.w;
    let s = 0, k = 0;
    for (let dy = -P; dy <= P; dy++) {
      const row = (y + dy) * w + x - P;
      for (let dx = 0; dx < PS; dx++) s += Math.abs((g[row + dx] - m) * inv - t[k++]);
      if (s >= limit) return s;
    }
    return s;
  }
  function search(L, t, px, py, R, maxCost) {
    const cx = Math.round(px), cy = Math.round(py);
    const xa = Math.max(P, cx - R), xb = Math.min(L.w - 1 - P, cx + R), ya = Math.max(P, cy - R), yb = Math.min(L.h - 1 - P, cy + R);
    if (xa > xb || ya > yb) return null;
    const minSd = Math.max(2, t.sd * 0.25);
    let best = Infinity, bx = 0, by = 0;
    for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) {
      const c = ncost(L, t, x, y, best, minSd); if (c < best) { best = c; bx = x; by = y; }
    }
    if (!(best / N <= maxCost)) return null;
    let ox = 0, oy = 0;
    if (bx > P && bx < L.w - 1 - P) { const l = ncost(L, t, bx - 1, by, Infinity, 0), r = ncost(L, t, bx + 1, by, Infinity, 0), d = l - 2 * best + r; if (d > 0) ox = Math.max(-.5, Math.min(.5, (l - r) / (2 * d))); }
    if (by > P && by < L.h - 1 - P) { const u = ncost(L, t, bx, by - 1, Infinity, 0), dn = ncost(L, t, bx, by + 1, Infinity, 0), d = u - 2 * best + dn; if (d > 0) oy = Math.max(-.5, Math.min(.5, (u - dn) / (2 * d))); }
    return [bx + ox, by + oy];
  }
  const ID = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  /* RANSAC similarity: survives >50% bad matches (noise patches, hand, pencil). */
  let rs = 12345; const rr = n => ((rs = (rs * 1103515245 + 12345) >>> 0) % n);
  function ransacSim(m, thr, minInl) {
    const n = m.length; if (n < minInl) return null;
    let best = null, bestN = 0;
    const iters = Math.min(120, n * (n - 1) / 2);
    for (let it = 0; it < iters; it++) {
      const i = rr(n); let j = rr(n); if (i === j) j = (j + 1) % n;
      const p = fit([m[i], m[j]]); if (!p) continue;
      const sc = Math.hypot(p[0], p[1]); if (sc < .6 || sc > 1.6) continue;
      let c = 0; for (const [x, y, u, v] of m) if (Math.hypot(p[0] * x - p[1] * y + p[2] - u, p[1] * x + p[0] * y + p[3] - v) < thr) c++;
      if (c > bestN) { bestN = c; best = p; }
    }
    if (!best || bestN < minInl) return null;
    let p = best, inl;
    for (let k = 0; k < 2; k++) {
      inl = m.filter(([x, y, u, v]) => Math.hypot(p[0] * x - p[1] * y + p[2] - u, p[1] * x + p[0] * y + p[3] - v) < thr);
      if (inl.length < minInl) return null;
      p = fit(inl) || p;
    }
    return { p, inl };
  }
  function createTracker(g, w, h, opt) {
    opt = opt || {};
    const L0 = level(g, w, h), [g1, w1, h1] = halve(g, w, h), L1 = level(g1, w1, h1);
    const gx = opt.gx || 8, gy = opt.gy || Math.max(4, Math.round(gx * h / w));
    const pos = select(g, w, h, 4, { gx, gy, minScore: 150 });
    const feats = [];
    for (const f of pos) {
      const t0 = stdTpl(L0, f.x, f.y), x1 = Math.round((f.x - .5) / 2), y1 = Math.round((f.y - .5) / 2), t1 = stdTpl(L1, x1, y1);
      if (t0) feats.push({ x: f.x, y: f.y, t0, x1, y1, kx1: 2 * x1 + .5, ky1: 2 * y1 + .5, t1 });
    }
    return { w, h, feats, H: ID.slice(), lost: 0 };
  }
  /* Process one frame. Updates st.H; returns {H, model, inliers, matched} or null when lost. */
  function step(st, g) {
    const { w, h, feats } = st, H = st.H;
    const L0 = level(g, w, h), [g1, w1, h1] = halve(g, w, h), L1 = level(g1, w1, h1);
    const R2 = st.lost > 2 ? 28 : 14;
    // coarse (half-res, wide): similarity correction on top of last H
    const cp = [];
    for (const f of feats) {
      if (!f.t1) continue;
      const q = applyH(H, f.kx1, f.ky1), m = search(L1, f.t1, (q[0] - .5) / 2, (q[1] - .5) / 2, R2, 0.7);
      if (m) cp.push([q[0], q[1], 2 * m[0] + .5, 2 * m[1] + .5]);
    }
    const c = ransacSim(cp, 3, 6);
    if (!c && st.lost > 0) { st.lost++; return null; }
    const Hc = c ? mul3(simToH(c.p), H) : H;
    // fine (full-res, narrow)
    const fp = [], qp = [];
    for (const f of feats) {
      const q = applyH(Hc, f.x, f.y), m = search(L0, f.t0, q[0], q[1], 4, 0.6);
      if (m) { fp.push([f.x, f.y, m[0], m[1]]); qp.push([q[0], q[1], m[0], m[1]]); }
    }
    const r = ransacSim(qp, 1.5, 5);
    if (r) {
      let Hn = mul3(simToH(r.p), Hc), model = 's', inl = r.inl.length;
      const set = new Set(r.inl), kin = fp.filter((_, i) => set.has(qp[i]));
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const [x, y] of kin) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      if (inl >= 15 && x1 - x0 > .45 * w && y1 - y0 > .45 * h) { // many, well-spread points: full perspective fit
        const Hh = fitH(kin);
        if (Hh && plausibleH(Hh, w, h)) {
          const res = kin.map(([x, y, u, v]) => { const z = applyH(Hh, x, y); return Math.hypot(z[0] - u, z[1] - v); });
          if (res.reduce((a, b) => a + b, 0) / res.length < 1.2) { Hn = Hh; model = 'h'; }
        }
      }
      st.H = Hn; st.lost = 0; return { H: Hn, model, inliers: inl, matched: fp.length };
    }
    if (c) { st.H = Hc; st.lost = 0; return { H: Hc, model: 'c', inliers: c.inl.length, matched: cp.length }; }
    st.lost++; return null;
  }

  const api = { select, track, robustFit, robustFitH, fit, fitH, applyH, inv3, mul3, simToH, fromCorners, OneEuro, createTracker, step, P };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.PaperTracker = api;
})(typeof self !== 'undefined' ? self : this);
