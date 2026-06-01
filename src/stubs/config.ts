import type { LoomerConfig } from "../types/web.js";

const defaults: LoomerConfig = {
  baseBranch: "",
  claudePath: "claude",
  claudeArgs: [],
  defaultPort: 3000,
  defaultTimeoutMinutes: 30,
  maxConcurrent: 5,
  stateDir: "~/.loomer",
  mergeStrategy: "auto",
  createPr: false,
  autoMergeRules: {
    maxFiles: 5,
    maxLines: 200,
    conflict: "review",
    testFail: "review",
  },
};

export function createDefaultConfig(
  overrides?: Partial<LoomerConfig>,
): LoomerConfig {
  return { ...defaults, ...overrides };
}
