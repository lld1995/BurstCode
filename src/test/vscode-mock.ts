/**
 * Minimal vscode API stub for unit tests running outside the Extension Host.
 * Only stubs out the surfaces used by web.ts.
 */

interface MockConfig {
  [key: string]: unknown;
}

const _configs: Record<string, MockConfig> = {};

export function __setConfig(section: string, values: MockConfig): void {
  _configs[section] = values;
}

export function __clearAll(): void {
  for (const k of Object.keys(_configs)) delete _configs[k];
}

const workspace = {
  getConfiguration(section: string) {
    const cfg = _configs[section] ?? {};
    return {
      get<T>(key: string): T | undefined {
        return cfg[key] as T | undefined;
      },
    };
  },
};

export { workspace };
