/// <reference lib="deno.ns" />
import { assertEquals } from "jsr:@std/assert@1";
import { displayCurrentPosition, isCandidacyText, participationLabel } from "./participation-label.ts";

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

Deno.test("現職欄是參選描述就不顯示", () => {
  assertEquals(displayCurrentPosition("村里長候選人（2026 年，嘉義市西區大溪里）"), undefined);
  assertEquals(displayCurrentPosition("嘉義市西區大溪里村里長候選人（115年村里長選舉登記，無黨籍）"), undefined);
  assertEquals(displayCurrentPosition("擬參選2026縣市長"), undefined);
  assertEquals(displayCurrentPosition("爭取連任"), undefined);
});

Deno.test("多段只去掉參選那幾段", () => {
  assertEquals(displayCurrentPosition("里長、2026 里長候選人"), "里長");
  assertEquals(displayCurrentPosition("議員；登記參選立委"), "議員");
  assertEquals(displayCurrentPosition("里長, 市議員"), "里長、市議員");
  assertEquals(displayCurrentPosition("候選人、參選"), undefined);
});

Deno.test("正常職稱不被誤殺", () => {
  for (const t of ["議員", "里長", "台北市議員", "立法委員", "嘉義市西區大溪里長（連任中）"]) {
    assertEquals(isCandidacyText(t), false);
    assertEquals(displayCurrentPosition(t), t);
  }
});
