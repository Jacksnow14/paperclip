import type {
  MemoryProviderDescriptor,
  MemoryProviderCaptureInput,
  MemoryProviderCaptureOutput,
  MemoryProviderForgetInput,
  MemoryProviderForgetOutput,
  MemoryProviderQueryInput,
  MemoryProviderQueryOutput,
  PaperclipPluginManifestV1,
} from "@paperclipai/shared";
import type { PluginWorkerManager } from "./plugin-worker-manager.js";

export interface RegisteredPluginMemoryProvider {
  pluginId: string;
  pluginKey: string;
  descriptor: MemoryProviderDescriptor;
}

export interface PluginMemoryProviderDispatcher {
  listProviders(): MemoryProviderDescriptor[];
  getProvider(providerKey: string): RegisteredPluginMemoryProvider | null;
  registerPluginProviders(pluginId: string, pluginKey: string, manifest: PaperclipPluginManifestV1): void;
  unregisterPluginProviders(pluginId: string): void;
  providerCount(pluginId?: string): number;
  query(providerKey: string, input: MemoryProviderQueryInput): Promise<MemoryProviderQueryOutput>;
  capture(providerKey: string, input: MemoryProviderCaptureInput): Promise<MemoryProviderCaptureOutput>;
  forget(providerKey: string, input: MemoryProviderForgetInput): Promise<MemoryProviderForgetOutput>;
}

let defaultPluginMemoryProviderDispatcher: PluginMemoryProviderDispatcher | null = null;

export function setDefaultPluginMemoryProviderDispatcher(
  dispatcher: PluginMemoryProviderDispatcher | null,
) {
  defaultPluginMemoryProviderDispatcher = dispatcher;
}

export function getDefaultPluginMemoryProviderDispatcher() {
  return defaultPluginMemoryProviderDispatcher;
}

export function createPluginMemoryProviderDispatcher(
  workerManager: PluginWorkerManager,
): PluginMemoryProviderDispatcher {
  const providers = new Map<string, RegisteredPluginMemoryProvider>();

  return {
    listProviders() {
      return [...providers.values()]
        .map((entry) => entry.descriptor)
        .sort((a, b) => a.displayName.localeCompare(b.displayName));
    },

    getProvider(providerKey: string) {
      return providers.get(providerKey) ?? null;
    },

    registerPluginProviders(pluginId: string, pluginKey: string, manifest: PaperclipPluginManifestV1) {
      for (const [key, entry] of providers.entries()) {
        if (entry.pluginId === pluginId) {
          providers.delete(key);
        }
      }

      for (const provider of manifest.memoryProviders ?? []) {
        const existing = providers.get(provider.key);
        if (existing && existing.pluginId !== pluginId) {
          throw new Error(
            `Memory provider key "${provider.key}" is already registered by plugin "${existing.pluginKey}"`,
          );
        }

        providers.set(provider.key, {
          pluginId,
          pluginKey,
          descriptor: {
            key: provider.key,
            displayName: provider.displayName,
            description: provider.description ?? null,
            kind: "plugin",
            pluginId,
            capabilities: {
              browse: provider.capabilities?.browse ?? false,
              correction: provider.capabilities?.correction ?? false,
              asyncIngestion: provider.capabilities?.asyncIngestion ?? false,
              providerManagedExtraction: provider.capabilities?.providerManagedExtraction ?? false,
            },
            configSchema: provider.configSchema ?? null,
            configMetadata: provider.configMetadata ?? null,
          },
        });
      }
    },

    unregisterPluginProviders(pluginId: string) {
      for (const [key, entry] of providers.entries()) {
        if (entry.pluginId === pluginId) {
          providers.delete(key);
        }
      }
    },

    providerCount(pluginId?: string) {
      if (!pluginId) return providers.size;
      return [...providers.values()].filter((entry) => entry.pluginId === pluginId).length;
    },

    async query(providerKey: string, input: MemoryProviderQueryInput) {
      const registration = providers.get(providerKey);
      if (!registration) {
        throw new Error(`Plugin memory provider not found: ${providerKey}`);
      }
      return workerManager.call(registration.pluginId, "invokeMemoryProvider", {
        providerKey,
        action: "query",
        input,
      }) as Promise<MemoryProviderQueryOutput>;
    },

    async capture(providerKey: string, input: MemoryProviderCaptureInput) {
      const registration = providers.get(providerKey);
      if (!registration) {
        throw new Error(`Plugin memory provider not found: ${providerKey}`);
      }
      return workerManager.call(registration.pluginId, "invokeMemoryProvider", {
        providerKey,
        action: "capture",
        input,
      }) as Promise<MemoryProviderCaptureOutput>;
    },

    async forget(providerKey: string, input: MemoryProviderForgetInput) {
      const registration = providers.get(providerKey);
      if (!registration) {
        throw new Error(`Plugin memory provider not found: ${providerKey}`);
      }
      return workerManager.call(registration.pluginId, "invokeMemoryProvider", {
        providerKey,
        action: "forget",
        input,
      }) as Promise<MemoryProviderForgetOutput>;
    },
  };
}
