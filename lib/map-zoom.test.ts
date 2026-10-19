/**
 * 參選地圖滾輪縮放（lib/map-zoom.ts）：以游標為中心、門檻切層、縮小回上一層、不跳層。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  ZOOM_AFTER_DRILL_DOWN, ZOOM_AFTER_DRILL_UP, ZOOM_DRILL_AT, ZOOM_MAX, ZOOM_MIN, clampCenter, resolveWheel, zoomAround, zoomStep,
  type Pt, type WheelState,
} from "./map-zoom.ts";

const W = 200, H = 300;
const base = (over: Partial<WheelState> = {}): WheelState => ({
  zoom: 1, center: [W / 2, H / 2], w: W, h: H, canDrillDown: true, canDrillUp: false, ...over,
});

Deno.test("zoomStep：往上滾（deltaY<0）放大、往下滾縮小；捏合（ctrlKey）更靈敏；單次變化有上限", () => {
  assert(zoomStep(2, -100) > 2);
  assert(zoomStep(2, 100) < 2);
  assert(zoomStep(2, -5, true) - 2 > zoomStep(2, -5, false) - 2);
  assertEquals(zoomStep(2, -100000), zoomStep(2, -200), "單次事件的變化被夾住，慣性滾輪不會一次衝過頭");
});

Deno.test("zoomAround：游標下那一點在縮放前後留在螢幕上同一個位置", () => {
  const center: Pt = [100, 150];
  const point: Pt = [40, 60];
  for (const [from, to] of [[1, 2], [2, 4], [4, 2.5]] as const) {
    const c2 = zoomAround(center, from, to, point);
    // 螢幕位置＝(畫布座標 − 檢視左上角) × 縮放；檢視左上角＝center − 視窗/2
    const screen = (c: Pt, k: number) => [(point[0] - (c[0] - W / k / 2)) * k, (point[1] - (c[1] - H / k / 2)) * k];
    const a = screen(center, from);
    const b = screen(c2, to);
    assert(Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9, `${from}→${to}`);
  }
});

Deno.test("clampCenter：檢視窗不會跑出畫布", () => {
  assertEquals(clampCenter([0, 0], 2, W, H), [50, 75]);
  assertEquals(clampCenter([999, 999], 2, W, H), [150, 225]);
  assertEquals(clampCenter([100, 150], 1, W, H), [100, 150]);
  assertEquals(clampCenter([-5, 400], 1, W, H), [100, 150], "倍率 1 時只剩一個位置");
});

Deno.test("resolveWheel：一般放大只改倍率與中心，中心夾在畫布內；倍率有上下限", () => {
  const a = resolveWheel(base({ canDrillDown: false }), -100, false, [20, 30]);
  assertEquals(a.type, "zoom");
  if (a.type === "zoom") {
    assert(a.zoom > 1 && a.zoom < ZOOM_DRILL_AT);
    assert(a.center[0] >= W / a.zoom / 2 && a.center[1] >= H / a.zoom / 2);
  }
  const top = resolveWheel(base({ zoom: ZOOM_MAX, canDrillDown: false }), -200, false, [50, 50]);
  assert(top.type === "zoom" && top.zoom === ZOOM_MAX);
  const bottom = resolveWheel(base({ zoom: 1.2, canDrillUp: false }), 200, false, [50, 50]);
  assert(bottom.type === "zoom" && bottom.zoom === ZOOM_MIN, "最上層縮到底就停在 1 倍");
});

Deno.test("resolveWheel：放大到門檻且游標下有行政區、還有下一層 → 往下切；沒有下一層或游標在海上 → 停在倍率上", () => {
  const near = base({ zoom: ZOOM_DRILL_AT - 0.1 });
  assertEquals(resolveWheel(near, -100, false, [50, 50]).type, "drillDown");
  assertEquals(resolveWheel({ ...near, canDrillDown: false }, -100, false, [50, 50]).type, "zoom", "最底層（村里）只放大");
  const below = resolveWheel(base({ zoom: 1.5 }), -50, false, [50, 50]);
  assertEquals(below.type, "zoom", "還沒到門檻不切層");
});

Deno.test("resolveWheel：縮小要先到最小倍率，再縮一格才回上一層；全國層不會往上；放大中的縮小不會直接跳層", () => {
  const atMin = base({ canDrillUp: true });
  assertEquals(resolveWheel(atMin, 100, false, [50, 50]).type, "drillUp");
  assertEquals(resolveWheel({ ...atMin, canDrillUp: false }, 100, false, [50, 50]).type, "zoom");
  const zoomedIn = base({ canDrillUp: true, zoom: 2 });
  assertEquals(resolveWheel(zoomedIn, 200, false, [50, 50]).type, "zoom");
  assertEquals(resolveWheel(base({ canDrillUp: true, zoom: 1.2 }), 200, false, [50, 50]).type, "zoom", "1.2 倍時一大格也只縮到 1 倍");
});

Deno.test("切層後的起始倍率都低於門檻，不會一落地又切一層（不會來回跳）", () => {
  assert(ZOOM_AFTER_DRILL_DOWN < ZOOM_DRILL_AT);
  assert(ZOOM_AFTER_DRILL_UP < ZOOM_DRILL_AT);
  assert(ZOOM_AFTER_DRILL_DOWN > ZOOM_MIN, "往下切之後留有縮小的空間，下一格滾輪不會立刻回上一層");
});
