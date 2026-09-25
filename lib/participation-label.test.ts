/// <reference lib="deno.ns" />
import { assertEquals } from "jsr:@std/assert@1";
import { displayCurrentPosition, participationLabel } from "./participation-label.ts";

// 2026-09-25：苗博雅 2026 那列存的是「111年直轄市議員選舉」，要顯示成這一屆實際的職稱
Deno.test("從選舉別與縣市組出職稱，不照抄存的文字", () => {
  assertEquals(participationLabel({ electionType: "縣市議員", region: "台北市", position: "111年直轄市議員選舉" }), "台北市議員");
  assertEquals(participationLabel({ electionType: "縣市長", region: "嘉義縣", position: "111年縣市長選舉" }), "嘉義縣長");
  assertEquals(participationLabel({ electionType: "立法委員", region: "台北市", position: "立委候選人" }), "台北市立委");
  assertEquals(participationLabel({ electionType: "立法委員", region: "全國" }), "不分區立委");
  assertEquals(participationLabel({ electionType: "鄉鎮市長", region: "彰化縣", subRegion: "彰化市" }), "彰化市長");
  assertEquals(participationLabel({ electionType: "村里長", region: "高雄市", subRegion: "前鎮區", village: "瑞北里" }), "前鎮區瑞北里長");
  assertEquals(participationLabel({ electionType: "總統副總統", position: "副總統候選人" }), "副總統");
});

Deno.test("沒有選舉別的舊資料才用存的文字", () => {
  assertEquals(participationLabel({ position: "某某候選人" }), "某某候選人");
});

Deno.test("現職存的是選舉名稱就不顯示", () => {
  assertEquals(displayCurrentPosition("111年直轄市議員選舉"), undefined);
  assertEquals(displayCurrentPosition("台北市議員"), "台北市議員");
  assertEquals(displayCurrentPosition(null), undefined);
});
