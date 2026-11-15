import * as THREE from 'three';

/**
 * Generates an equirectangular procedural lunar regolith & crater relief CanvasTexture
 * used as both bump/normal relief AND immediate zero-latency base layer while live
 * NASA Moon Trek WMTS tiles stream onto the atlas canvas.
 */
export function createProceduralLunarAtlas(width = 1024, height = 512): {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  bumpTexture: THREE.CanvasTexture;
  albedoTexture: THREE.CanvasTexture;
} {
  const albedoCanvas = document.createElement('canvas');
  albedoCanvas.width = width;
  albedoCanvas.height = height;
  const ctx = albedoCanvas.getContext('2d')!;

  // Base basaltic mare & highland regolith gradient
  ctx.fillStyle = '#6f737a';
  ctx.fillRect(0, 0, width, height);

  // Draw deterministic major lunar maria silhouettes (equirectangular UV: u=0.5 is 0° lon)
  const maria: Array<{ lon: number; lat: number; rx: number; ry: number; shade: string }> = [
    { lon: -20, lat: 24, rx: 140, ry: 85, shade: 'rgba(54, 58, 66, 0.72)' }, // Mare Imbrium
    { lon: 18, lat: 26, rx: 90, ry: 55, shade: 'rgba(58, 62, 70, 0.68)' }, // Mare Serenitatis
    { lon: 31, lat: 8, rx: 105, ry: 60, shade: 'rgba(48, 52, 60, 0.72)' }, // Mare Tranquillitatis
    { lon: 59, lat: 17, rx: 65, ry: 50, shade: 'rgba(44, 48, 56, 0.78)' }, // Mare Crisium
    { lon: -48, lat: 12, rx: 165, ry: 120, shade: 'rgba(50, 54, 62, 0.70)' }, // Oceanus Procellarum
    { lon: -16, lat: -22, rx: 85, ry: 50, shade: 'rgba(56, 60, 68, 0.62)' }, // Mare Nubium
    { lon: 148, lat: -53, rx: 185, ry: 110, shade: 'rgba(64, 68, 76, 0.55)' }, // South Pole-Aitken Basin
  ];

  for (const m of maria) {
    const cx = ((m.lon + 180) / 360) * width;
    const cy = ((90 - m.lat) / 180) * height;
    const grad = ctx.createRadialGradient(cx, cy, 4, cx, cy, m.rx);
    grad.addColorStop(0, m.shade);
    grad.addColorStop(1, 'rgba(60, 64, 72, 0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.ellipse(cx, cy, m.rx, m.ry, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  // Procedural multi-scale craters for relief bump map
  const bumpCanvas = document.createElement('canvas');
  bumpCanvas.width = width;
  bumpCanvas.height = height;
  const bCtx = bumpCanvas.getContext('2d')!;
  bCtx.fillStyle = '#808080';
  bCtx.fillRect(0, 0, width, height);

  let seed = 133742;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };

  for (let i = 0; i < 650; i++) {
    const x = rand() * width;
    const y = rand() * height;
    const r = 2 + Math.pow(rand(), 3.2) * 34;

    // Albedo rim & floor contrast
    const alGrad = ctx.createRadialGradient(x, y, r * 0.1, x, y, r);
    alGrad.addColorStop(0, 'rgba(78, 82, 88, 0.25)');
    alGrad.addColorStop(0.75, 'rgba(130, 134, 140, 0.18)');
    alGrad.addColorStop(1, 'rgba(110, 114, 120, 0)');
    ctx.fillStyle = alGrad;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();

    // Bump height crater bowl + raised rim
    const bGrad = bCtx.createRadialGradient(x, y, 0, x, y, r);
    bGrad.addColorStop(0, 'rgba(40, 40, 40, 0.55)');
    bGrad.addColorStop(0.72, 'rgba(95, 95, 95, 0.35)');
    bGrad.addColorStop(0.88, 'rgba(215, 215, 215, 0.55)');
    bGrad.addColorStop(1, 'rgba(128, 128, 128, 0)');
    bCtx.fillStyle = bGrad;
    bCtx.beginPath();
    bCtx.arc(x, y, r, 0, Math.PI * 2);
    bCtx.fill();
  }

  const albedoTexture = new THREE.CanvasTexture(albedoCanvas);
  albedoTexture.colorSpace = THREE.SRGBColorSpace;
  albedoTexture.wrapS = THREE.RepeatWrapping;
  albedoTexture.wrapT = THREE.ClampToEdgeWrapping;

  const bumpTexture = new THREE.CanvasTexture(bumpCanvas);
  bumpTexture.wrapS = THREE.RepeatWrapping;
  bumpTexture.wrapT = THREE.ClampToEdgeWrapping;

  return {
    canvas: albedoCanvas,
    ctx,
    albedoTexture,
    bumpTexture,
  };
}

/**
 * Streams real NASA Moon Trek WMTS level-2 equirectangular tiles through our Express
 * caching proxy (/api/wmts/:layer/2/:row/:col) into the lunar globe atlas texture.
 * NASA Moon Trek EQ TileMatrix 2 = 8 cols (0..7) x 4 rows (0..3).
 */
export async function streamMoonTrekAtlas(
  layer: 'lroc_wac' | 'lola_clr',
  canvas: HTMLCanvasElement,
  ctx: CanvasRenderingContext2D,
  texture: THREE.CanvasTexture,
  onProgress: (info: { loaded: number; total: number; cacheHits: number; liveTiles: number }) => void,
  abortSignal?: AbortSignal
): Promise<void> {
  const cols = 8;
  const rows = 4;
  const total = cols * rows;
  const tileW = canvas.width / cols;
  const tileH = canvas.height / rows;

  let loaded = 0;
  let cacheHits = 0;
  let liveTiles = 0;

  const jobs: Promise<void>[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const url = `/api/wmts/${layer}/2/${r}/${c}`;
      const job = fetch(url, { signal: abortSignal })
        .then(async (res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          if (res.headers.get('X-Cache') === 'HIT') cacheHits++;
          liveTiles++;
          const blob = await res.blob();
          const bmp = await createImageBitmap(blob);
          ctx.drawImage(bmp, c * tileW, r * tileH, tileW, tileH);
          bmp.close();
          texture.needsUpdate = true;
        })
        .catch(() => {
          // Retain procedural regolith base under failed tile if offline
        })
        .finally(() => {
          loaded++;
          onProgress({ loaded, total, cacheHits, liveTiles });
        });
      jobs.push(job);
    }
  }

  await Promise.all(jobs);
}
