import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { z } from "zod";
import { badRequest, forbidden } from "../errors.js";
import { validate } from "../middleware/validate.js";
import { assertCompanyAccess } from "./authz.js";

const DDL_PATTERN = /^\s*(DROP|CREATE|ALTER|TRUNCATE|GRANT|REVOKE)\b/i;

const migratePatchSchema = z.object({
  sql: z.string().min(1, "sql is required"),
  params: z.array(z.unknown()).optional(),
});

function bindSql(statement: string, params: readonly unknown[]): SQL {
  if (params.length === 0) return sql.raw(statement);
  const chunks: SQL[] = [];
  let cursor = 0;
  const placeholderPattern = /\$(\d+)/g;
  const seen = new Set<number>();

  for (const match of statement.matchAll(placeholderPattern)) {
    const index = Number(match[1]);
    if (!Number.isInteger(index) || index < 1 || index > params.length) {
      throw badRequest(`SQL placeholder $${match[1]} has no matching parameter`);
    }
    chunks.push(sql.raw(statement.slice(cursor, match.index)));
    chunks.push(sql`${params[index - 1]}`);
    seen.add(index);
    cursor = match.index! + match[0].length;
  }
  chunks.push(sql.raw(statement.slice(cursor)));
  if (seen.size !== params.length) {
    throw badRequest("Every parameter must be referenced by a $n placeholder");
  }
  return sql.join(chunks, sql.raw(""));
}

export function dbMigratePatchRoutes(db: Db) {
  const router = Router();

  router.post("/companies/:companyId/db/migrate-patch", validate(migratePatchSchema), async (req, res) => {
    const { companyId } = req.params;
    assertCompanyAccess(req, companyId);
    if (req.actor.type !== "board") {
      throw forbidden("Board access required");
    }

    const { sql: statement, params = [] } = req.body as z.infer<typeof migratePatchSchema>;

    if (DDL_PATTERN.test(statement.trim())) {
      throw badRequest("DDL statements (DROP, CREATE, ALTER, TRUNCATE, GRANT, REVOKE) are not allowed");
    }

    const query = bindSql(statement, params);
    const result = await db.execute(query);

    const rows = Array.from(result as Iterable<unknown>);
    const rowsAffected = Number((result as { count?: number | string }).count ?? rows.length);

    res.json({ rowsAffected, rows });
  });

  return router;
}
