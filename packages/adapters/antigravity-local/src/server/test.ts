import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import {
  asNumber,
  asString,
  ensurePathInEnv,
  parseObject,
} from "@paperclipai/adapter-utils/server-utils";
import {
  describeAdapterExecutionTarget,
  ensureAdapterExecutionTargetCommandResolvable,
  ensureAdapterExecutionTargetDirectory,
  resolveAdapterExecutionTargetCwd,
  runAdapterExecutionTargetProcess,
} from "@paperclipai/adapter-utils/execution-target";
import { DEFAULT_ANTIGRAVITY_LOCAL_MODEL } from "../index.js";
import { parseAntigravityStream } from "./parse.js";

export interface AntigravityModelsProbe {
  models: string[];
}

function summarizeStatus(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentTestResult["status"] {
  if (checks.some((check) => check.level === "error")) return "fail";
  if (checks.some((check) => check.level === "warn")) return "warn";
  return "pass";
}

function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}

function summarizeProbeDetail(stdout: string, stderr: string, parsedError: string | null): string | null {
  const raw = parsedError?.trim() || firstNonEmptyLine(stderr) || firstNonEmptyLine(stdout);
  if (!raw) return null;
  const clean = raw.replace(/\s+/g, " ").trim();
  const max = 240;
  return clean.length > max ? `${clean.slice(0, max - 3)}...` : clean;
}

function normalizeEnv(input: unknown): Record<string, string> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return {};
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

const ANTIGRAVITY_AUTH_REQUIRED_RE =
  /(?:not\s+logged\s+in|login\s+required|authentication\s+required|unauthorized|invalid\s+credentials|IneligibleTierError|migrate\s+to\s+the\s+Antigravity)/i;

// `agy models` prints one model id per line.
export function parseAntigravityModelsOutput(stdout: string): AntigravityModelsProbe {
  const models = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && /^[a-z0-9][a-z0-9._-]*$/i.test(line));
  return { models: Array.from(new Set(models)) };
}

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const config = parseObject(ctx.config);
  const command = asString(config.command, "agy");
  const target = ctx.executionTarget ?? null;
  const targetIsRemote = target?.kind === "remote";
  const cwd = resolveAdapterExecutionTargetCwd(target, asString(config.cwd, ""), process.cwd());
  const targetLabel = targetIsRemote
    ? ctx.environmentName ?? describeAdapterExecutionTarget(target)
    : null;
  const runId = `antigravity-envtest-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  if (targetLabel) {
    checks.push({
      code: "antigravity_environment_target",
      level: "info",
      message: `Probing inside environment: ${targetLabel}`,
    });
  }

  try {
    await ensureAdapterExecutionTargetDirectory(runId, target, cwd, {
      cwd,
      env: {},
      createIfMissing: true,
    });
    checks.push({
      code: "antigravity_cwd_valid",
      level: "info",
      message: `Working directory is valid: ${cwd}`,
    });
  } catch (err) {
    checks.push({
      code: "antigravity_cwd_invalid",
      level: "error",
      message: err instanceof Error ? err.message : "Invalid working directory",
      detail: cwd,
    });
  }

  const env = normalizeEnv(config.env);
  const runtimeEnv = ensurePathInEnv({ ...process.env, ...env });

  try {
    await ensureAdapterExecutionTargetCommandResolvable(command, target, cwd, runtimeEnv);
    checks.push({
      code: "antigravity_command_resolvable",
      level: "info",
      message: `Command is executable: ${command}`,
    });
  } catch (err) {
    checks.push({
      code: "antigravity_command_unresolvable",
      level: "error",
      message: err instanceof Error ? err.message : "Command is not executable",
      detail: command,
    });
  }

  const canRunProbe =
    checks.every((check) => check.code !== "antigravity_cwd_invalid" && check.code !== "antigravity_command_unresolvable");

  const configuredModel = asString(config.model, DEFAULT_ANTIGRAVITY_LOCAL_MODEL).trim();

  if (canRunProbe) {
    const modelsProbe = await runAdapterExecutionTargetProcess(
      runId,
      target,
      command,
      ["models"],
      {
        cwd,
        env,
        timeoutSec: Math.max(1, asNumber(config.helloProbeTimeoutSec, 45)),
        graceSec: 5,
        onLog: async () => {},
      },
    );

    const probeOutput = `${modelsProbe.stdout}\n${modelsProbe.stderr}`;
    const parsedModels = parseAntigravityModelsOutput(modelsProbe.stdout);
    const authRequired = ANTIGRAVITY_AUTH_REQUIRED_RE.test(probeOutput);

    if (modelsProbe.timedOut) {
      checks.push({
        code: "antigravity_models_probe_timed_out",
        level: "warn",
        message: "`agy models` timed out.",
        hint: "Retry the probe. If this persists, run `agy models` manually from the target environment.",
      });
    } else if ((modelsProbe.exitCode ?? 1) !== 0 || authRequired) {
      checks.push({
        code: authRequired ? "antigravity_auth_required" : "antigravity_models_probe_failed",
        level: authRequired ? "warn" : "error",
        message: authRequired
          ? "Antigravity CLI is not authenticated."
          : "`agy models` failed.",
        detail: summarizeProbeDetail(modelsProbe.stdout, modelsProbe.stderr, null),
        hint: authRequired ? "Log in with the Antigravity CLI on the target host, then retry." : undefined,
      });
    } else {
      checks.push({
        code: "antigravity_models_probe_passed",
        level: "info",
        message: "`agy models` completed.",
      });
      if (parsedModels.models.length > 0) {
        checks.push({
          code: "antigravity_models_discovered",
          level: "info",
          message: `Discovered ${parsedModels.models.length} Antigravity model(s).`,
        });
      } else {
        checks.push({
          code: "antigravity_models_empty",
          level: "warn",
          message: "Antigravity returned no available models.",
          hint: "Run `agy models` manually and verify the account has access to a model.",
        });
      }
      if (configuredModel) {
        checks.push({
          code: parsedModels.models.includes(configuredModel)
            ? "antigravity_model_configured"
            : "antigravity_model_not_found",
          level: parsedModels.models.includes(configuredModel) ? "info" : "warn",
          message: parsedModels.models.includes(configuredModel)
            ? `Configured model: ${configuredModel}`
            : `Configured model "${configuredModel}" not found in available models.`,
          hint: parsedModels.models.includes(configuredModel)
            ? undefined
            : "Run `agy models` and choose an available model id.",
        });
      }
    }
  }

  if (canRunProbe) {
    const probeArgs = [
      "--output-format",
      "stream-json",
      "--dangerously-skip-permissions",
      "--print-timeout",
      "2m",
    ];
    if (configuredModel) {
      probeArgs.push("--model", configuredModel);
    }
    probeArgs.push("--print", "Respond with exactly hello.");

    const helloProbe = await runAdapterExecutionTargetProcess(
      runId,
      target,
      command,
      probeArgs,
      {
        cwd,
        env,
        timeoutSec: Math.max(1, asNumber(config.helloProbeTimeoutSec, 120)),
        graceSec: 5,
        onLog: async () => {},
      },
    );
    const parsed = parseAntigravityStream(helloProbe.stdout);
    const detail = summarizeProbeDetail(helloProbe.stdout, helloProbe.stderr, parsed.errorMessage);
    const authRequired = ANTIGRAVITY_AUTH_REQUIRED_RE.test(`${helloProbe.stdout}\n${helloProbe.stderr}`);

    if (helloProbe.timedOut) {
      checks.push({
        code: "antigravity_hello_probe_timed_out",
        level: "warn",
        message: "Antigravity hello probe timed out.",
        hint: "Retry the probe. If this persists, verify `agy --print` works manually.",
      });
    } else if ((helloProbe.exitCode ?? 1) !== 0 || (parsed.status && parsed.status !== "SUCCESS")) {
      checks.push({
        code: authRequired ? "antigravity_hello_probe_auth_required" : "antigravity_hello_probe_failed",
        level: authRequired ? "warn" : "error",
        message: authRequired
          ? "Antigravity CLI could not answer the hello probe because authentication is missing."
          : "Antigravity hello probe failed.",
        ...(detail ? { detail } : {}),
        hint: authRequired ? "Log in with the Antigravity CLI on the target host, then retry." : undefined,
      });
    } else if (/\bhello\b/i.test(parsed.summary)) {
      checks.push({
        code: "antigravity_hello_probe_passed",
        level: "info",
        message: "Antigravity hello probe succeeded.",
      });
    } else {
      checks.push({
        code: "antigravity_hello_probe_unexpected_output",
        level: "warn",
        message: "Antigravity hello probe succeeded but returned unexpected output.",
        ...(detail ? { detail } : {}),
      });
    }
  }

  return {
    adapterType: "antigravity_local",
    status: summarizeStatus(checks),
    checks,
    testedAt: new Date().toISOString(),
  };
}
