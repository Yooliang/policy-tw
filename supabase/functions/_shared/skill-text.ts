/**
 * 測試用：協議全文＝public/skill.md（共通規則）＋public/skill-types.md（各型別，協議 1.93.0 起隨派工送）。
 * 守門測試要確認「協議有講到某件事」時讀這一份；要確認版號、檔頭這類只在 skill.md 的，照舊讀 skill.md。
 */
export async function readSkillWithTypes(): Promise<string> {
  const skill = await Deno.readTextFile(new URL("../../../public/skill.md", import.meta.url));
  const types = await Deno.readTextFile(new URL("../../../public/skill-types.md", import.meta.url));
  return `${skill}\n\n${types}`;
}
