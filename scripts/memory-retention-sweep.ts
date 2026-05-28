import { createDb } from "../packages/db/src/index.js";
import { loadConfig } from "../server/src/config.js";
import { memoryService } from "../server/src/services/memory.js";

const COMPANY_ID = process.env.COMPANY_ID ?? "b26d3647-3e6c-4a28-9c25-e9315696484d";
const LIMIT = Number(process.env.SWEEP_LIMIT ?? "500");

async function main() {
  const config = loadConfig();
  const databaseUrl = config.databaseUrl ?? "postgres://paperclip:paperclip@127.0.0.1:54329/paperclip";
  const db = createDb(databaseUrl);
  const memory = memoryService(db);

  console.log(`Running memory retention sweep for company ${COMPANY_ID} (limit ${LIMIT})...`);

  const result = await memory.sweepRetention(
    COMPANY_ID,
    { limit: LIMIT },
    { actorType: "agent", actorId: "maintenance-sweep", agentId: "maintenance-sweep" },
  );

  console.log(`Sweep complete.`);
  console.log(`  Expired record IDs (${result.expiredRecordIds.length}):`, result.expiredRecordIds);
  console.log(`  Operations logged (${result.operations.length}):`, result.operations.map(o => ({ id: o.id, operationType: o.operationType, bindingId: o.bindingId, recordCount: o.recordCount })));

  process.exit(0);
}

main().catch((err) => {
  console.error("Sweep failed:", err);
  process.exit(1);
});
