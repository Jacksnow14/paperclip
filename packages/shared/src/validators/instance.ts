import { z } from "zod";
import { DEFAULT_FEEDBACK_DATA_SHARING_PREFERENCE } from "../types/feedback.js";
import {
  DAILY_RETENTION_PRESETS,
  WEEKLY_RETENTION_PRESETS,
  MONTHLY_RETENTION_PRESETS,
  DEFAULT_BACKUP_RETENTION,
  DEFAULT_ARTIFACT_RETENTION,
  DEFAULT_HOURLY_COUNT,
  DEFAULT_MAX_BYTES,
  DEFAULT_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS,
  MAX_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS,
  MIN_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS,
} from "../types/instance.js";
import { feedbackDataSharingPreferenceSchema } from "./feedback.js";

function presetSchema<T extends readonly number[]>(presets: T, label: string) {
  return z.number().refine(
    (v): v is T[number] => (presets as readonly number[]).includes(v),
    { message: `${label} must be one of: ${presets.join(", ")}` },
  );
}

export const backupRetentionPolicySchema = z.object({
  dailyDays: presetSchema(DAILY_RETENTION_PRESETS, "dailyDays").default(DEFAULT_BACKUP_RETENTION.dailyDays),
  weeklyWeeks: presetSchema(WEEKLY_RETENTION_PRESETS, "weeklyWeeks").default(DEFAULT_BACKUP_RETENTION.weeklyWeeks),
  monthlyMonths: presetSchema(MONTHLY_RETENTION_PRESETS, "monthlyMonths").default(DEFAULT_BACKUP_RETENTION.monthlyMonths),
  hourlyCount: z.number().int().min(1).max(10_000).default(DEFAULT_HOURLY_COUNT),
  maxBytes: z.number().int().min(0).default(DEFAULT_MAX_BYTES),
});

export const artifactRetentionDirRuleSchema = z.object({
  path: z.string().min(1),
  kind: z.enum([
    "cache",
    "run_output",
    "debug",
    "rotating_pool",
    "log",
    "build_artifact",
    "deliverable_with_floor",
  ]),
  shape: z.enum(["subdir", "file"]),
  pattern: z.string().optional(),
  maxAgeDays: z.number().int().min(0).optional(),
  maxCount: z.number().int().min(0).optional(),
  maxBytes: z.number().int().min(0).optional(),
  pressureOnly: z.boolean().optional(),
  requireFile: z.string().optional(),
  excludeIfFile: z.string().optional(),
  requirePairedSiblings: z
    .object({
      dir: z.string().min(1),
      pattern: z.string().min(1),
      minCount: z.number().int().min(1),
    })
    .optional(),
});

export const artifactRetentionPolicySchema = z.object({
  enabled: z.boolean().default(DEFAULT_ARTIFACT_RETENTION.enabled),
  dirs: z.array(artifactRetentionDirRuleSchema).default([]),
  excludeAlways: z.array(z.string().min(1)).default([]),
  activeDirs: z.array(z.string().min(1)).default([]),
});

export const instanceGeneralSettingsSchema = z.object({
  censorUsernameInLogs: z.boolean().default(false),
  keyboardShortcuts: z.boolean().default(false),
  feedbackDataSharingPreference: feedbackDataSharingPreferenceSchema.default(
    DEFAULT_FEEDBACK_DATA_SHARING_PREFERENCE,
  ),
  backupRetention: backupRetentionPolicySchema.default(DEFAULT_BACKUP_RETENTION),
  artifactRetention: artifactRetentionPolicySchema.default(DEFAULT_ARTIFACT_RETENTION),
}).strict();

export const patchInstanceGeneralSettingsSchema = instanceGeneralSettingsSchema.partial();

export const instanceExperimentalSettingsSchema = z.object({
  enableEnvironments: z.boolean().default(false),
  enableIsolatedWorkspaces: z.boolean().default(false),
  autoRestartDevServerWhenIdle: z.boolean().default(false),
  enableIssueGraphLivenessAutoRecovery: z.boolean().default(false),
  issueGraphLivenessAutoRecoveryLookbackHours: z
    .number()
    .int()
    .min(MIN_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS)
    .max(MAX_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS)
    .default(DEFAULT_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS),
}).strict();

export const patchInstanceExperimentalSettingsSchema = instanceExperimentalSettingsSchema.partial();

export const issueGraphLivenessAutoRecoveryRequestSchema = z.object({
  lookbackHours: z
    .number()
    .int()
    .min(MIN_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS)
    .max(MAX_ISSUE_GRAPH_LIVENESS_AUTO_RECOVERY_LOOKBACK_HOURS)
    .optional(),
}).strict();

export type InstanceGeneralSettings = z.infer<typeof instanceGeneralSettingsSchema>;
export type PatchInstanceGeneralSettings = z.infer<typeof patchInstanceGeneralSettingsSchema>;
export type InstanceExperimentalSettings = z.infer<typeof instanceExperimentalSettingsSchema>;
export type PatchInstanceExperimentalSettings = z.infer<typeof patchInstanceExperimentalSettingsSchema>;
export type IssueGraphLivenessAutoRecoveryRequest = z.infer<
  typeof issueGraphLivenessAutoRecoveryRequestSchema
>;
