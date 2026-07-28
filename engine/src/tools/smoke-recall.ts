import { openDefaultDb } from "../db.js";
import { recallHybrid } from "../tools.js";

const db = openDefaultDb();
const queries = ["deploy docker", "espejo del alma", "decisiones arquitectura", "sesion cierre", "misMEM protocolo"];
for (const q of queries) {
  const { hits } = await recallHybrid(db, { query: q, limit: 3 });
  console.log(`\n=== ${q} (${hits.length}) ===`);
  for (const h of hits) {
    const preview = h.text.replace(/\s+/g, " ").slice(0, 120);
    console.log(`[${h.layer}] ${h.scope}: ${preview}`);
  }
}
