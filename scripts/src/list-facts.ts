import { db } from "@workspace/db";
import { factsTable, hashtagsTable, factHashtagsTable } from "@workspace/db/schema";
import { eq } from "drizzle-orm";

async function main() {
  const facts = await db.select({ id: factsTable.id, text: factsTable.text }).from(factsTable).orderBy(factsTable.id);
  const tagged = await db.select({ factId: factHashtagsTable.factId, name: hashtagsTable.name })
    .from(factHashtagsTable).innerJoin(hashtagsTable, eq(factHashtagsTable.hashtagId, hashtagsTable.id));

  const tagMap = new Map<number, string[]>();
  for (const t of tagged) {
    if (!tagMap.has(t.factId)) tagMap.set(t.factId, []);
    tagMap.get(t.factId)!.push(t.name);
  }

  for (const f of facts) {
    const tags = tagMap.get(f.id) || [];
    console.log(`${f.id} | [${tags.join(",")}] | ${f.text.substring(0, 80)}`);
  }
}

main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
