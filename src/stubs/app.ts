import type {
  LoomerAppLike,
  AgentInfo,
  PlanProgress,
  DagData,
  PlanResult,
} from "../types/web.js";
import {
  AgentNotFoundError,
  InvalidNameError,
  PlanAlreadyActiveError,
} from "../errors.js";

export interface StubApp extends LoomerAppLike {
  agents: Map<string, AgentInfo>;
  planData: {
    progress: PlanProgress | null;
    dag: DagData | null;
  };
  reset(): void;
}

export function createStubApp(): StubApp {
  const agents = new Map<string, AgentInfo>();
  const planData: StubApp["planData"] = { progress: null, dag: null };

  function getOrThrow(name: string): AgentInfo {
    const agent = agents.get(name);
    if (!agent) throw new AgentNotFoundError(`Agent '${name}' not found`);
    return agent;
  }

  function validateName(name: string): void {
    if (!/^[a-zA-Z0-9_-]+$/.test(name) || name.length > 64) {
      throw new InvalidNameError(
        `Invalid agent name: '${name}' (must match [a-zA-Z0-9_-]+, max 64 chars)`,
      );
    }
  }

  const stub: StubApp = {
    agents,
    planData,

    reset() {
      agents.clear();
      planData.progress = null;
      planData.dag = null;
    },

    start(name: string, prompt: string): void {
      validateName(name);
      if (agents.has(name)) {
        throw new InvalidNameError(`Agent '${name}' already exists`);
      }
      agents.set(name, {
        name,
        status: "PENDING",
        prompt,
        archived: false,
      });
    },

    done(name: string): void {
      getOrThrow(name);
      agents.set(name, { ...getOrThrow(name), status: "ACCEPTED" });
    },

    accept(name: string): void {
      const agent = getOrThrow(name);
      if (agent.status !== "REVIEW") {
        throw new AgentNotFoundError(
          `Agent '${name}' is not in REVIEW state`,
        );
      }
      agents.set(name, { ...agent, status: "ACCEPTED" });
    },

    reject(name: string): void {
      const agent = getOrThrow(name);
      if (agent.status !== "REVIEW") {
        throw new AgentNotFoundError(
          `Agent '${name}' is not in REVIEW state`,
        );
      }
      agents.set(name, { ...agent, status: "REJECTED" });
    },

    kill(name: string, clean?: boolean): void {
      getOrThrow(name);
      const agent = agents.get(name)!;
      agents.set(name, { ...agent, status: "DONE" });
      if (clean) agents.delete(name);
    },

    retry(name: string): void {
      const agent = getOrThrow(name);
      agents.set(name, { ...agent, status: "RUNNING" });
    },

    status(): AgentInfo[] {
      return Array.from(agents.values());
    },

    log(name: string, lines?: number): string {
      getOrThrow(name);
      return `log output for ${name} (last ${lines ?? 50} lines)`;
    },

    diff(name: string, mode?: string): string {
      getOrThrow(name);
      return `diff output for ${name} (mode=${mode ?? "stat"})`;
    },

    runPlan(path?: string, prdPath?: string): PlanResult {
      if (planData.progress) {
        throw new PlanAlreadyActiveError("A plan is already active");
      }
      planData.progress = {
        plan: path ?? prdPath ?? "test-plan",
        total: 2,
        done: 0,
        running: 1,
        pending: 1,
        crashed: 0,
        conflicted: 0,
        stale: 0,
        review: 0,
      };
      planData.dag = {
        nodes: [
          { id: "TS-001", status: "RUNNING" },
          { id: "TS-002", status: "PENDING" },
        ],
        edges: [{ from: "TS-001", to: "TS-002" }],
      };
      return {
        name: path ?? prdPath ?? "test-plan",
        taskCount: 2,
      };
    },

    planStatus(): PlanProgress | null {
      return planData.progress;
    },

    planDag(): DagData | null {
      return planData.dag;
    },
  };

  return stub;
}
