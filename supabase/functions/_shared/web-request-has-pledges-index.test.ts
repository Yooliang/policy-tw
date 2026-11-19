/**
 * web_request_has_pledges 改以 uuid 比對（migration 20261119180000）：語意不變、policies 以人物索引查。
 */
import { assert, assertEquals } from "jsr:@std/assert@1";
import { PGlite } from "npm:@electric-sql/pglite@0.2.17";
import { fnText, readMig } from "./arms-pglite.ts";

const MIG = await readMig("20261119180000_web_request_has_pledges_use_index.sql");
const OLD = await readMig("20261111010000_web_request_merge_gap.sql");

Deno.test("A 新定義不再把 politician_id 轉文字比", () => {
  const neu = fnText(MIG, "web_request_has_pledges");
  assert(!/politician_id::TEXT/i.test(neu));
  assert(/pl\.politician_id = CASE WHEN p_politician ~/.test(neu));
  assert(/politician_id::TEXT/i.test(fnText(OLD, "web_request_has_pledges")));
});

const P1 = "11111111-1111-1111-1111-111111111111";
const SCHEMA = `
CREATE TABLE policies (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), politician_id uuid NOT NULL, election_id integer, status text, origin text, removed_at timestamptz);
CREATE INDEX policies_visible_idx ON policies (politician_id) WHERE removed_at IS NULL;
CREATE FUNCTION campaign_election_id() RETURNS integer LANGUAGE sql IMMUTABLE AS $f$ SELECT 2026 $f$;
CREATE FUNCTION election_id_or_null(p text) RETURNS integer LANGUAGE sql IMMUTABLE AS $f$ SELECT NULLIF(p, '')::integer $f$;
CREATE FUNCTION is_campaign_pledge(p_status text, p_origin text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $f$ SELECT COALESCE(p_status, '') = 'Campaign Pledge' OR COALESCE(p_origin, '') = 'pledge' $f$;
INSERT INTO policies (politician_id, election_id, status) VALUES ('${P1}', 2026, 'Campaign Pledge'), ('${P1}', 2022, 'Other');
`;

async function run(sql: string) {
  const db = new PGlite();
  await db.exec(SCHEMA);
  await db.exec(fnText(sql, "web_request_has_pledges"));
  const has = async (p: string, e: string) =>
    (await db.query<{ r: boolean }>("SELECT web_request_has_pledges($1, $2) AS r", [p, e])).rows[0]!.r;
  const out = [await has(P1, ""), await has(P1, "2022"), await has(P1, "2018"),
    await has("22222222-2222-2222-2222-222222222222", ""), await has("not-a-uuid", "")];
  await db.close();
  return out;
}

Deno.test("B 新舊定義結果一致：當屆要承諾、他屆任何政見、查無、非 uuid 不報錯", async () => {
  const neu = await run(MIG);
  assertEquals(neu, [true, true, false, false, false]);
  assertEquals(neu, await run(OLD));
});
