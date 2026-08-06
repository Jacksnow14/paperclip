import type { UIAdapterModule } from "../types";
import { createAntigravityStdoutParser, parseAntigravityStdoutLine } from "@paperclipai/adapter-antigravity-local/ui";
import { buildAntigravityLocalConfig } from "@paperclipai/adapter-antigravity-local/ui";
import { AntigravityLocalConfigFields } from "./config-fields";

export const antigravityLocalUIAdapter: UIAdapterModule = {
  type: "antigravity_local",
  label: "Antigravity (local)",
  parseStdoutLine: parseAntigravityStdoutLine,
  createStdoutParser: createAntigravityStdoutParser,
  ConfigFields: AntigravityLocalConfigFields,
  buildAdapterConfig: buildAntigravityLocalConfig,
};
