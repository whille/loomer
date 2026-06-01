import { AgentNotFoundError, InvalidNameError, PlanAlreadyActiveError, } from "../errors.js";
const SAMPLE_RISK_ASSESSMENT = {
    level: "HIGH",
    signals: [
        { name: "file_count", level: "HIGH", detail: "7 files changed (threshold: 5)" },
        { name: "line_count", level: "LOW", detail: "150 lines changed (threshold: 200)" },
        { name: "new_files", level: "HIGH", detail: "new files added" },
        { name: "public_modules", level: "LOW", detail: "no public module changes" },
        { name: "conflict", level: "LOW", detail: "no conflict" },
        { name: "test", level: "HIGH", detail: "no test files modified" },
    ],
};
export function createStubApp() {
    const agents = new Map();
    const planData = { progress: null, dag: null };
    function getOrThrow(name) {
        const agent = agents.get(name);
        if (!agent)
            throw new AgentNotFoundError(`Agent '${name}' not found`);
        return agent;
    }
    function validateName(name) {
        if (!/^[a-zA-Z0-9_-]+$/.test(name) || name.length > 64) {
            throw new InvalidNameError(`Invalid agent name: '${name}' (must match [a-zA-Z0-9_-]+, max 64 chars)`);
        }
    }
    const stub = {
        agents,
        planData,
        reset() {
            agents.clear();
            planData.progress = null;
            planData.dag = null;
        },
        start(name, prompt) {
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
        done(name) {
            getOrThrow(name);
            agents.set(name, { ...getOrThrow(name), status: "ACCEPTED" });
        },
        accept(name) {
            const agent = getOrThrow(name);
            if (agent.status !== "REVIEW") {
                throw new AgentNotFoundError(`Agent '${name}' is not in REVIEW state`);
            }
            agents.set(name, { ...agent, status: "ACCEPTED" });
        },
        reject(name) {
            const agent = getOrThrow(name);
            if (agent.status !== "REVIEW") {
                throw new AgentNotFoundError(`Agent '${name}' is not in REVIEW state`);
            }
            agents.set(name, { ...agent, status: "REJECTED" });
        },
        kill(name, clean) {
            getOrThrow(name);
            const agent = agents.get(name);
            agents.set(name, { ...agent, status: "DONE" });
            if (clean)
                agents.delete(name);
        },
        retry(name) {
            const agent = getOrThrow(name);
            agents.set(name, { ...agent, status: "RUNNING" });
        },
        status() {
            return Array.from(agents.values());
        },
        log(name) {
            getOrThrow(name);
            return `log output for ${name}`;
        },
        diff(name, mode) {
            getOrThrow(name);
            return `diff output for ${name} (mode=${mode ?? "stat"})`;
        },
        runPlan(path, prdPath) {
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
        planStatus() {
            return planData.progress;
        },
        planDag() {
            return planData.dag;
        },
        startServer(_port) {
            return null;
        },
        stopServer() { },
        getServerPort() {
            return null;
        },
        shutdown() { },
        getTaskStatus(id) {
            return agents.get(id)?.status;
        },
    };
    return stub;
}
//# sourceMappingURL=app.js.map