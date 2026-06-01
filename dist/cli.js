#!/usr/bin/env node
import path from "node:path";
import { Command } from "commander";
import { CliError, LoomerClient, formatPlanStatus, formatStatusTable, } from "./cli-client.js";
import { LoomerConfig } from "./config.js";
function handleCliError(err) {
    if (err instanceof CliError) {
        if (err.statusCode === -1 && !err.serverError) {
            console.error("Loomer server is not running.");
            console.error("Start it first: loomer plan run --prd <path>");
        }
        else {
            console.error(`Error: ${err.message}`);
        }
        process.exit(1);
    }
    console.error("Unexpected error:", err);
    process.exit(1);
}
export function createProgram(clientFactory) {
    const program = new Command();
    program
        .name("loomer")
        .description("Multi-agent orchestration CLI")
        .version("0.1.0");
    const makeClient = (config) => clientFactory ? clientFactory(config) : new LoomerClient(config);
    const loadConfig = () => LoomerConfig.load(".loomer.json");
    // --- Agent lifecycle ---
    program
        .command("start")
        .argument("<name>", "Agent name")
        .requiredOption("--prompt <text>", "Prompt text")
        .action(async (name, opts) => {
        const client = makeClient(loadConfig());
        try {
            await client.start(name, opts.prompt);
            console.log(`Agent "${name}" started.`);
        }
        catch (err) {
            handleCliError(err);
        }
    });
    program
        .command("done")
        .argument("<name>", "Agent name")
        .action(async (name) => {
        const client = makeClient(loadConfig());
        try {
            await client.done(name);
            console.log(`Agent "${name}" done.`);
        }
        catch (err) {
            handleCliError(err);
        }
    });
    program
        .command("kill")
        .argument("<name>", "Agent name")
        .option("--clean", "Remove agent data after kill")
        .action(async (name, opts) => {
        const client = makeClient(loadConfig());
        try {
            await client.kill(name, opts.clean);
            console.log(`Agent "${name}" killed.`);
        }
        catch (err) {
            handleCliError(err);
        }
    });
    program
        .command("retry")
        .argument("<name>", "Agent name")
        .action(async (name) => {
        const client = makeClient(loadConfig());
        try {
            await client.retry(name);
            console.log(`Agent "${name}" retried.`);
        }
        catch (err) {
            handleCliError(err);
        }
    });
    program
        .command("accept")
        .argument("<name>", "Agent name")
        .action(async (name) => {
        const client = makeClient(loadConfig());
        try {
            await client.accept(name);
            console.log(`Agent "${name}" accepted.`);
        }
        catch (err) {
            handleCliError(err);
        }
    });
    program
        .command("reject")
        .argument("<name>", "Agent name")
        .action(async (name) => {
        const client = makeClient(loadConfig());
        try {
            await client.reject(name);
            console.log(`Agent "${name}" rejected.`);
        }
        catch (err) {
            handleCliError(err);
        }
    });
    // --- Web lifecycle (附属管控) ---
    program
        .command("web-start")
        .option("--port <number>", "Port for web dashboard", parseInt)
        .action(async (opts) => {
        const client = makeClient(loadConfig());
        try {
            const port = opts.port ?? loadConfig().defaultPort;
            await client.post(`/api/web/start`, { port });
        }
        catch (err) {
            handleCliError(err);
        }
    });
    program
        .command("web-stop")
        .action(async () => {
        const client = makeClient(loadConfig());
        try {
            await client.post(`/api/web/stop`);
        }
        catch (err) {
            handleCliError(err);
        }
    });
    program
        .command("shutdown")
        .action(async () => {
        const client = makeClient(loadConfig());
        try {
            await client.post(`/api/shutdown`);
        }
        catch (err) {
            handleCliError(err);
        }
    });
    // --- Queries ---
    program
        .command("log")
        .argument("<name>", "Agent name")
        .action(async (name) => {
        const client = makeClient(loadConfig());
        try {
            const text = await client.log(name);
            console.log(text);
        }
        catch (err) {
            handleCliError(err);
        }
    });
    program
        .command("status")
        .option("--all", "Include archived agents")
        .action(async (opts) => {
        const client = makeClient(loadConfig());
        try {
            const agents = await client.status(opts.all);
            console.log(formatStatusTable(agents));
        }
        catch (err) {
            handleCliError(err);
        }
    });
    // --- Plan ---
    const plan = program.command("plan");
    plan
        .command("run")
        .requiredOption("--prd <path>", "Path to PRD JSON file")
        .option("--port <number>", "Web server port", parseInt)
        .action(async (opts) => {
        const config = loadConfig();
        const prdPath = path.resolve(opts.prd);
        try {
            const { LoomerApp } = await import("./app.js");
            // 从 prd.json 路径推导目标仓库目录（prd.json 的父目录）
            const repoPath = path.dirname(path.dirname(prdPath));
            const loomerApp = LoomerApp.create(config, repoPath);
            const result = loomerApp.runPlan(undefined, prdPath, opts.port);
            console.log(`Plan "${result.name}" started with ${result.taskCount} tasks.`);
            // 优雅关闭
            const shutdown = () => {
                console.log("\nShutting down...");
                loomerApp.shutdown();
                process.exit(0);
            };
            process.on("SIGINT", shutdown);
            process.on("SIGTERM", shutdown);
        }
        catch (err) {
            if (err instanceof Error &&
                (err.message.includes("Cannot find module") ||
                    err.message.includes("MODULE_NOT_FOUND"))) {
                console.error("LoomerApp is not available. Ensure app.ts is compiled.");
                process.exit(1);
            }
            throw err;
        }
    });
    plan.command("status").action(async () => {
        const client = makeClient(loadConfig());
        try {
            const progress = await client.planStatus();
            console.log(formatPlanStatus(progress));
        }
        catch (err) {
            handleCliError(err);
        }
    });
    return program;
}
// 入口（仅在直接执行时运行，被 import 时不触发 parse）
if (process.argv[1]?.endsWith("cli.ts") ||
    process.argv[1]?.endsWith("cli.js")) {
    createProgram().parse();
}
//# sourceMappingURL=cli.js.map