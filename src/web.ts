import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LoomerConfig, LoomerAppLike } from "./types/web.js";
import { LoomerError, MergeError } from "./errors.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VALID_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

export interface SseOptions {
  pollIntervalMs?: number;
  keepaliveIntervalMs?: number;
}

const SSE_DEFAULTS: Required<SseOptions> = {
  pollIntervalMs: 2000,
  keepaliveIntervalMs: 15000,
};

function validateNameParam(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  const name = req.params.name as string;
  if (!VALID_NAME.test(name)) {
    res
      .status(400)
      .json({ error: "InvalidNameError", message: `Invalid agent name: '${name}'` });
    return;
  }
  next();
}

function requireApp(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction,
): void {
  // loomerApp 通过闭包访问，见 createApp
  const app = (req as unknown as { _loomerApp?: LoomerAppLike })._loomerApp;
  if (!app) {
    res
      .status(503)
      .json({ error: "ServiceUnavailable", message: "Loomer backend not initialized" });
    return;
  }
  next();
}

function getApp(loomerApp: LoomerAppLike | undefined): LoomerAppLike {
  if (!loomerApp) throw new Error("LoomerApp not initialized");
  return loomerApp;
}

export function createApp(
  config?: LoomerConfig,
  loomerApp?: LoomerAppLike,
  sseOptions?: SseOptions,
): express.Express {
  const app = express();
  const sse = { ...SSE_DEFAULTS, ...sseOptions };

  // 中间件
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(express.static(path.join(__dirname, "..", "public")));

  // EJS 视图引擎
  app.set("view engine", "ejs");
  app.set("views", path.join(__dirname, "..", "views"));

  // 注入 loomerApp 到 req 供中间件使用
  app.use((req, _res, next) => {
    (req as unknown as { _loomerApp?: LoomerAppLike })._loomerApp = loomerApp;
    next();
  });

  // /api 路由要求 loomerApp 存在
  app.use("/api", requireApp);

  // 仪表盘
  app.get("/", (_req, res) => {
    res.render("index", {});
  });

  // --- REST API ---

  // GET /api/status
  app.get("/api/status", (req, res, next) => {
    try {
      const agents = getApp(loomerApp).status();
      const archived = req.query.archived === "true";
      const filtered = archived
        ? agents
        : agents.filter((a) => a.archived !== true);
      res.json(filtered);
    } catch (err) {
      next(err);
    }
  });

  // POST /api/start
  app.post("/api/start", (req, res, next) => {
    try {
      const { name, prompt } = req.body ?? {};
      if (!name || !prompt) {
        return res
          .status(400)
          .json({ error: "ValidationError", message: "name and prompt are required" });
      }
      if (!VALID_NAME.test(name)) {
        return res
          .status(400)
          .json({ error: "InvalidNameError", message: `Invalid agent name: '${name}'` });
      }
      getApp(loomerApp).start(name, prompt);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/log/:name
  app.get("/api/log/:name", validateNameParam, (req, res, next) => {
    try {
      const name = req.params.name as string;
      const log = getApp(loomerApp).log(name);
      res.json({ log });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/log/:name/stream — SSE incremental log stream
  const MAX_SSE_CLIENTS = 20;
  const activeSseIntervals = new Set<ReturnType<typeof setInterval>>();

  app.get("/api/log/:name/stream", validateNameParam, (req, res) => {
    if (activeSseIntervals.size >= MAX_SSE_CLIENTS) {
      res.status(429).json({ error: "TooManySSEConnections" });
      return;
    }
    const name = req.params.name as string;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    let lastLen = 0;
    const interval = setInterval(() => {
      try {
        const fullLog = getApp(loomerApp).log(name);
        if (fullLog && fullLog.length > lastLen) {
          const newChunk = fullLog.slice(lastLen);
          lastLen = fullLog.length;
          res.write(`data: ${JSON.stringify({ text: newChunk })}\n\n`);
        }
        // Check if agent is done
        const agent = getApp(loomerApp).status().find((a: { name: string; status: string }) => a.name === name);
        if (agent && !["RUNNING", "PENDING"].includes(agent.status)) {
          res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
          clearInterval(interval);
          activeSseIntervals.delete(interval);
          res.end();
        }
      } catch {
        clearInterval(interval);
        activeSseIntervals.delete(interval);
        res.end();
      }
    }, 2000);

    activeSseIntervals.add(interval);
    req.on("close", () => {
      clearInterval(interval);
      activeSseIntervals.delete(interval);
    });
  });

  // GET /api/diff/:name
  app.get("/api/diff/:name", validateNameParam, (req, res, next) => {
    try {
      const name = req.params.name as string;
      const mode = (req.query.mode as string) || "stat";
      const diff = getApp(loomerApp).diff(name, mode);
      res.json({ diff });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/done/:name
  app.post("/api/done/:name", validateNameParam, (req, res, next) => {
    try {
      getApp(loomerApp).done(req.params.name as string);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/kill/:name
  app.post("/api/kill/:name", validateNameParam, (req, res, next) => {
    try {
      const clean = req.query.clean === "1";
      getApp(loomerApp).kill(req.params.name as string, clean);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/retry/:name
  app.post("/api/retry/:name", validateNameParam, (req, res, next) => {
    try {
      getApp(loomerApp).retry(req.params.name as string);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/accept/:name
  app.post("/api/accept/:name", validateNameParam, (req, res, next) => {
    try {
      getApp(loomerApp).accept(req.params.name as string);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/reject/:name
  app.post("/api/reject/:name", validateNameParam, (req, res, next) => {
    try {
      getApp(loomerApp).reject(req.params.name as string);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  // --- Plan ---

  // POST /api/plan/run
  app.post("/api/plan/run", (req, res, next) => {
    try {
      const { path: planPath, prdPath } = req.body ?? {};
      if (!planPath && !prdPath) {
        return res
          .status(400)
          .json({ error: "ValidationError", message: "path or prdPath is required" });
      }
      const result = getApp(loomerApp).runPlan(planPath, prdPath);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/plan/status
  app.get("/api/plan/status", (_req, res, next) => {
    try {
      const progress = getApp(loomerApp).planStatus();
      res.json(progress);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/plan/dag
  app.get("/api/plan/dag", (_req, res, next) => {
    try {
      const dag = getApp(loomerApp).planDag();
      res.json(dag);
    } catch (err) {
      next(err);
    }
  });

  // --- Web lifecycle (附属管控) ---

  app.post("/api/web/stop", (_req, res) => {
    loomerApp?.stopServer();
    res.json({ ok: true, message: "Web dashboard stopped." });
  });

  app.post("/api/web/start", (req, res) => {
    const port = req.body?.port ? Number(req.body.port) : undefined;
    const server = loomerApp?.startServer(port);
    if (server) {
      res.json({ ok: true, port: loomerApp?.getServerPort() });
    } else {
      res.status(400).json({ error: "WebError", message: "Failed to start web dashboard (port in use?)" });
    }
  });

  app.post("/api/shutdown", (_req, res) => {
    res.json({ ok: true, message: "Shutting down..." });
    // 延迟让响应发出
    setTimeout(() => {
      loomerApp?.shutdown();
      process.exit(0);
    }, 100);
  });

  // --- SSE ---

  app.get("/api/events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const lastStatus: Record<string, string> = {};

    const pollInterval = setInterval(() => {
      if (!loomerApp) return;
      if (res.writableEnded) {
        clearInterval(pollInterval);
        clearInterval(keepaliveInterval);
        return;
      }
      const agents = loomerApp.status();
      const current: Record<string, string> = {};
      for (const a of agents) {
        current[a.name] = a.status ?? "UNKNOWN";
      }

      // 只推变化
      const changed: Record<string, string> = {};
      for (const [k, v] of Object.entries(current)) {
        if (lastStatus[k] !== v) changed[k] = v;
      }
      Object.assign(lastStatus, current);

      if (Object.keys(changed).length > 0) {
        try {
          res.write(`event: status\ndata: ${JSON.stringify(changed)}\n\n`);
        } catch {
          clearInterval(pollInterval);
          clearInterval(keepaliveInterval);
        }
      }
    }, sse.pollIntervalMs);

    const keepaliveInterval = setInterval(() => {
      if (res.writableEnded) {
        clearInterval(pollInterval);
        clearInterval(keepaliveInterval);
        return;
      }
      try {
        res.write(": keepalive\n\n");
      } catch {
        clearInterval(pollInterval);
        clearInterval(keepaliveInterval);
      }
    }, sse.keepaliveIntervalMs);

    req.on("close", () => {
      clearInterval(pollInterval);
      clearInterval(keepaliveInterval);
    });
  });

  // --- 错误处理 ---

  app.use(
    (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      if (err instanceof LoomerError) {
        const payload: Record<string, unknown> = {
          error: err.constructor.name,
          message: err.message,
        };
        if (err instanceof MergeError && err.conflictFiles) {
          payload.conflictFiles = err.conflictFiles;
        }
        res.status(400).json(payload);
      } else {
        console.error("Unhandled error:", err);
        res.status(500).json({ error: "InternalError", message: "An internal error occurred" });
      }
    },
  );

  return app;
}
