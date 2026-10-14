// Animated pixel scenes for a Raster. Each terminal cell is an upper-half block
// whose foreground is the top pixel and background the bottom one, so a
// `columns x rows` Raster holds a `columns x rows*2` picture.

type Painter = (px: Uint32Array, t: number) => void

export type SceneDef = {
  id: string
  name: string
  make: (w: number, h: number) => Painter
}

const HALF = 0x2580

function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const rgb = (r: number, g: number, b: number) =>
  ((Math.max(0, Math.min(255, r | 0)) << 16) | (Math.max(0, Math.min(255, g | 0)) << 8) | Math.max(0, Math.min(255, b | 0))) >>> 0

function mix(a: number, b: number, k: number): number {
  const q = Math.max(0, Math.min(1, k))
  return rgb(
    ((a >> 16) & 255) * (1 - q) + ((b >> 16) & 255) * q,
    ((a >> 8) & 255) * (1 - q) + ((b >> 8) & 255) * q,
    (a & 255) * (1 - q) + (b & 255) * q,
  )
}

function add(a: number, b: number, k: number): number {
  return rgb(
    ((a >> 16) & 255) + ((b >> 16) & 255) * k,
    ((a >> 8) & 255) + ((b >> 8) & 255) * k,
    (a & 255) + (b & 255) * k,
  )
}

/** Vertical gradient through evenly spaced stops. */
function gradient(stops: number[], k: number): number {
  const n = stops.length - 1
  const at = Math.max(0, Math.min(0.9999, k)) * n
  const i = Math.floor(at)
  return mix(stops[i] ?? 0, stops[i + 1] ?? stops[i] ?? 0, at - i)
}

function ridge(rand: () => number, w: number, base: number, rough: number): number[] {
  const ys: number[] = []
  let y = base
  let v = 0
  for (let x = 0; x < w; x++) {
    v = v * 0.85 + (rand() - 0.5) * rough
    y += v
    y += (base - y) * 0.08
    ys.push(y)
  }
  return ys
}

const rainCity: SceneDef = {
  id: 'rain',
  name: 'Rainy city',
  make(w, h) {
    const rand = rng(11)
    const base = new Uint32Array(w * h)
    for (let y = 0; y < h; y++) {
      const c = gradient([0x0a0e22, 0x1b1d40, 0x3a2752], y / h)
      for (let x = 0; x < w; x++) base[y * w + x] = c
    }
    const mx = Math.floor(w * 0.8)
    const my = Math.floor(h * 0.22)
    const mr = Math.max(2, h * 0.09)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const d = Math.hypot(x - mx, (y - my) * 1.0)
        const i = y * w + x
        if (d < mr) base[i] = 0xf1e6d2
        else if (d < mr * 3.5) base[i] = add(base[i] ?? 0, 0x6a5a90, 0.35 * (1 - (d - mr) / (mr * 2.5)))
      }
    const windows: { i: number; p: number }[] = []
    for (const [color, minH, maxH, lit] of [
      [0x1e1a3c, 0.25, 0.55, 0.08],
      [0x0e0b1f, 0.15, 0.4, 0.2],
    ] as const) {
      let x = 0
      while (x < w) {
        const bw = 3 + Math.floor(rand() * 7)
        const top = Math.floor(h - h * (minH + rand() * (maxH - minH)))
        for (let yy = top; yy < h; yy++)
          for (let xx = x; xx < Math.min(w, x + bw); xx++) {
            const i = yy * w + xx
            const isWindow = (xx - x) % 2 === 1 && (yy - top) % 2 === 1 && xx < x + bw - 1 && yy < h - 2
            if (isWindow && rand() < lit) {
              base[i] = rand() < 0.85 ? 0xffc46b : 0x8fc0ff
              if (color === 0x0e0b1f && rand() < 0.15) windows.push({ i, p: rand() * 100 })
            } else base[i] = color
          }
        x += bw + (rand() < 0.3 ? 1 : 0)
      }
    }
    const drops = Array.from({ length: Math.max(8, Math.floor((w * h) / 45)) }, () => ({
      x: rand() * w,
      y: rand() * h,
      v: 0.9 + rand() * 0.8,
    }))
    return (px, t) => {
      px.set(base)
      for (const win of windows) if (Math.sin(t * 0.6 + win.p) < -0.4) px[win.i] = 0x0e0b1f
      for (const d of drops) {
        d.y += d.v
        d.x += d.v * 0.15
        if (d.y >= h) {
          d.y = -2
          d.x = rand() * w
        }
        for (let k = 0; k < 2; k++) {
          const y = Math.floor(d.y) - k
          const x = Math.floor(d.x - k * 0.15)
          if (y >= 0 && y < h && x >= 0 && x < w) {
            const i = y * w + x
            px[i] = mix(px[i] ?? 0, 0x9fb4e8, k === 0 ? 0.55 : 0.3)
          }
        }
      }
    }
  },
}

const sunsetSea: SceneDef = {
  id: 'sunset',
  name: 'Sunset sea',
  make(w, h) {
    const rand = rng(5)
    const horizon = Math.floor(h * 0.62)
    const sx = w / 2
    const sr = Math.max(3, h * 0.28)
    const base = new Uint32Array(w * h)
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x
        if (y < horizon) {
          let c = gradient([0x24183f, 0x6b2d63, 0xd1607a, 0xffb27a], y / horizon)
          const d = Math.hypot(x - sx, (y - horizon) * 1.0)
          const slit = y > horizon - sr * 0.6 && (horizon - y) % 3 === 0
          if (d < sr && !slit) c = gradient([0xffe5a8, 0xffc27a, 0xff7f6b], 1 - (horizon - y) / sr)
          else if (d < sr * 2.2) c = add(c, 0x804030, 0.5 * (1 - d / (sr * 2.2)))
          base[i] = c
        } else base[i] = gradient([0x3a2450, 0x21173a, 0x120d24], (y - horizon) / (h - horizon))
      }
    const clouds = Array.from({ length: 4 }, () => ({ x: rand() * w, y: Math.floor(rand() * horizon * 0.6), l: 6 + Math.floor(rand() * 14), v: 0.03 + rand() * 0.05 }))
    const glints = Array.from({ length: Math.floor(w * 1.2) }, () => {
      const depth = rand()
      const y = horizon + 1 + Math.floor(depth * depth * (h - horizon - 1))
      return { x: sx + (rand() * 2 - 1) * sr * (0.5 + depth * 1.6), y, p: rand() * 6.28 }
    })
    return (px, t) => {
      px.set(base)
      for (const c of clouds) {
        c.x += c.v
        if (c.x > w + c.l) c.x = -c.l
        for (let k = 0; k < c.l; k++) {
          const x = Math.floor(c.x - k)
          if (x >= 0 && x < w) px[c.y * w + x] = mix(px[c.y * w + x] ?? 0, 0xffc0c8, 0.35)
        }
      }
      for (const g of glints) {
        const a = Math.sin(t * 1.4 + g.p)
        if (a < 0.3) continue
        const x = Math.floor(g.x + Math.sin(t * 0.7 + g.p) * 1.5)
        if (x >= 0 && x < w && g.y < h) px[g.y * w + x] = mix(px[g.y * w + x] ?? 0, 0xffd9a0, a)
      }
    }
  },
}

const fireflyForest: SceneDef = {
  id: 'forest',
  name: 'Firefly forest',
  make(w, h) {
    const rand = rng(99)
    const base = new Uint32Array(w * h)
    for (let y = 0; y < h; y++) {
      const c = gradient([0x0b2232, 0x12333a, 0x1a3a30], y / h)
      for (let x = 0; x < w; x++) base[y * w + x] = c
    }
    for (const [color, count, scale] of [
      [0x10292c, Math.ceil(w / 6), 0.7],
      [0x07171a, Math.ceil(w / 9), 1],
    ] as const) {
      for (let n = 0; n < count; n++) {
        const cx = rand() * w
        const th = h * (0.45 + rand() * 0.45) * scale
        const top = h - th
        for (let y = Math.max(0, Math.floor(top)); y < h; y++) {
          const k = (y - top) / th
          const half = Math.max(0.5, k * th * 0.28 * (0.75 + 0.25 * Math.sin(k * 18)))
          for (let x = Math.floor(cx - half); x <= cx + half; x++) if (x >= 0 && x < w) base[y * w + x] = color
        }
      }
    }
    const flies = Array.from({ length: Math.max(6, Math.floor(w / 3)) }, () => ({
      x: rand() * w,
      y: h * (0.3 + rand() * 0.65),
      a: rand() * 6.28,
      p: rand() * 6.28,
      f: 0.5 + rand() * 1.2,
    }))
    return (px, t) => {
      px.set(base)
      for (let y = Math.floor(h * 0.8); y < h; y++) {
        const k = ((y - h * 0.8) / (h * 0.2)) * (0.18 + 0.05 * Math.sin(t * 0.3))
        for (let x = 0; x < w; x++) px[y * w + x] = mix(px[y * w + x] ?? 0, 0x6f9c90, k)
      }
      for (const f of flies) {
        f.a += (rand() - 0.5) * 0.5
        f.x += Math.cos(f.a) * 0.25
        f.y += Math.sin(f.a) * 0.12
        if (f.x < 0) f.x = w - 1
        if (f.x >= w) f.x = 0
        if (f.y < h * 0.25 || f.y >= h - 1) f.a = -f.a
        const glow = Math.max(0, Math.sin(t * f.f + f.p)) ** 2
        if (glow < 0.05) continue
        const x = Math.floor(f.x)
        const y = Math.floor(f.y)
        for (const [dx, dy, k] of [[0, 0, 1], [1, 0, 0.35], [-1, 0, 0.35], [0, 1, 0.3], [0, -1, 0.3]] as const) {
          const xx = x + dx
          const yy = y + dy
          if (xx >= 0 && xx < w && yy >= 0 && yy < h) px[yy * w + xx] = mix(px[yy * w + xx] ?? 0, 0xeaff8a, glow * k)
        }
      }
    }
  },
}

const northernLights: SceneDef = {
  id: 'aurora',
  name: 'Northern lights',
  make(w, h) {
    const rand = rng(42)
    const stars = Array.from({ length: Math.floor((w * h) / 50) }, () => ({ i: Math.floor(rand() * h * 0.6) * w + Math.floor(rand() * w), p: rand() * 6.28 }))
    const ranges = [ridge(rand, w, h * 0.7, 0.9), ridge(rand, w, h * 0.84, 0.6)]
    const sky = new Uint32Array(w * h)
    for (let y = 0; y < h; y++) {
      const c = gradient([0x01040c, 0x071730, 0x123048], y / h)
      for (let x = 0; x < w; x++) sky[y * w + x] = c
    }
    const ribbons = [
      { y: 0.42, amp: 0.09, color: 0x50ffb0, len: 0.34, sp: 0.35, f: 1.6, s: rand() * 9 },
      { y: 0.28, amp: 0.05, color: 0xb070ff, len: 0.16, sp: 0.2, f: 1.1, s: rand() * 9 },
    ]
    return (px, t) => {
      px.set(sky)
      for (const s of stars) px[s.i] = mix(px[s.i] ?? 0, 0xffffff, 0.35 + 0.5 * (0.5 + 0.5 * Math.sin(t * 1.3 + s.p)))
      for (const r of ribbons)
        for (let x = 0; x < w; x++) {
          // Waves are per screen width, so the curtain keeps its shape at any size.
          const u = (x / w) * Math.PI * 2
          const yb = h * (r.y + r.amp * (Math.sin(u * r.f + t * r.sp + r.s) * 0.6 + Math.sin(u * r.f * 2.3 - t * r.sp * 0.7) * 0.4))
          const glow = 0.55 + 0.45 * Math.sin(u * 5 + t * 0.5 + r.s)
          const len = h * r.len * (0.6 + 0.4 * glow)
          // Brightest near the lower edge, fading up the curtain and quickly below it.
          const fall = Math.max(2, h * 0.05)
          for (let y = Math.max(0, Math.floor(yb - len)); y <= yb + fall && y < h; y++) {
            const k = y <= yb ? (y - (yb - len)) / len : 1 - (y - yb) / fall
            px[y * w + x] = add(px[y * w + x] ?? 0, r.color, 0.4 * glow * k * k)
          }
        }
      ranges.forEach((ys, n) => {
        const color = n === 0 ? 0x07101e : 0x020509
        for (let x = 0; x < w; x++) for (let y = Math.max(0, Math.floor(ys[x] ?? h)); y < h; y++) px[y * w + x] = color
      })
    }
  },
}

export const SCENES: SceneDef[] = [rainCity, sunsetSea, fireflyForest, northernLights]

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function base64(bytes: Uint8Array): string {
  const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64
  if (typeof native === 'function') return native.call(bytes)
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0)
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!
  }
  const rest = bytes.length - i
  if (rest === 1) {
    const n = (bytes[i] ?? 0) << 16
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + '=='
  } else if (rest === 2) {
    const n = ((bytes[i] ?? 0) << 16) | ((bytes[i + 1] ?? 0) << 8)
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + '='
  }
  return out
}

/** A running scene sized for one Raster; `frame()` advances it and returns its cells. */
export class SceneRun {
  private readonly px: Uint32Array
  private readonly cells: Uint32Array
  private readonly paint: Painter
  private t = 0

  constructor(
    readonly def: SceneDef,
    readonly columns: number,
    readonly rows: number,
  ) {
    this.px = new Uint32Array(columns * rows * 2)
    this.cells = new Uint32Array(columns * rows * 3)
    this.paint = def.make(columns, rows * 2)
  }

  frame(dt: number): string {
    this.t += dt
    this.paint(this.px, this.t)
    const w = this.columns
    for (let cy = 0; cy < this.rows; cy++)
      for (let cx = 0; cx < w; cx++) {
        const o = (cy * w + cx) * 3
        this.cells[o] = HALF
        this.cells[o + 1] = this.px[cy * 2 * w + cx] ?? 0
        this.cells[o + 2] = this.px[(cy * 2 + 1) * w + cx] ?? 0
      }
    return base64(new Uint8Array(this.cells.buffer))
  }
}
