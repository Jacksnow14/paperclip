import { pgTable, uuid, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { companies } from "./companies.js";
import { memoryBindings } from "./memory_bindings.js";
import type { MemoryBindingTargetType } from "@paperclipai/shared";

export const memoryBindingTargets = pgTable(
  "memory_binding_targets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    bindingId: uuid("binding_id").notNull().references(() => memoryBindings.id, { onDelete: "cascade" }),
    targetType: text("target_type").$type<MemoryBindingTargetType>().notNull(),
    targetId: uuid("target_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyTargetUniqueIdx: uniqueIndex("memory_binding_targets_company_target_idx").on(
      table.companyId,
      table.targetType,
      table.targetId,
    ),
    companyBindingIdx: index("memory_binding_targets_company_binding_idx").on(table.companyId, table.bindingId),
  }),
);
