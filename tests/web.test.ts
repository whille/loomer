import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import express from "express";
import { createApp } from "../src/web.js";
import { createStubApp } from "../src/stubs/app.js";
import { createDefaultConfig } from "../src/stubs/config.js";
import type { StubApp } from "../src/stubs/app.js";
import type { LoomerConfig } from "../src/types/web.js";
import {
  AgentNotFoundError,
  MergeError,
  PlanAlreadyActiveError,
  DirtyWorktreeError,
} from "../src/errors.js";

describe("createApp", () => {
  let stubApp: StubApp;
  let config: LoomerConfig;
  let app: express.Express;

  beforeEach(() => {
    stubApp = createStubApp();
    config = createDefaultConfig();
    app = createApp(config, stubApp, { pollIntervalMs: 50, keepaliveIntervalMs: 200 });
  });

  describe("factory function", () => {
    it("returns an Express app", () => {
      const result = createApp(config, stubApp);
      expect(result).toBeDefined();
      expect(typeof result.listen).toBe("function");
    });

    it("works with no arguments", () => {
      const result = createApp();
      expect(result).toBeDefined();
    });
  });

  describe("GET / (dashboard)", () => {
    it("returns 200 and HTML", async () => {
      const res = await request(app).get("/");
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/text\/html/);
    });

    it("contains agent table container", async () => {
      const res = await request(app).get("/");
      expect(res.text).toContain('id="agent-table"');
      expect(res.text).toContain('id="agent-tbody"');
    });

    it("contains SSE indicator", async () => {
      const res = await request(app).get("/");
      expect(res.text).toContain('id="sse-dot"');
    });

    it("contains start agent form", async () => {
      const res = await request(app).get("/");
      expect(res.text).toContain('id="start-form"');
      expect(res.text).toContain('id="input-name"');
      expect(res.text).toContain('id="input-prompt"');
    });

    it("contains log and diff modals", async () => {
      const res = await request(app).get("/");
      expect(res.text).toContain('id="log-modal"');
      expect(res.text).toContain('id="diff-modal"');
    });

    it("contains DAG panel", async () => {
      const res = await request(app).get("/");
      expect(res.text).toContain('id="dag-panel"');
    });

    it("loads app.js", async () => {
      const res = await request(app).get("/");
      expect(res.text).toContain('src="/app.js"');
    });
  });

  describe("GET /api/status", () => {
    it("returns empty array when no agents", async () => {
      const res = await request(app).get("/api/status");
      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });

    it("returns agents excluding archived by default", async () => {
      stubApp.agents.set("active-agent", {
        name: "active-agent",
        status: "RUNNING",
        archived: false,
      });
      stubApp.agents.set("archived-agent", {
        name: "archived-agent",
        status: "DONE",
        archived: true,
      });

      const res = await request(app).get("/api/status");
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].name).toBe("active-agent");
    });

    it("includes archived agents with ?archived=true", async () => {
      stubApp.agents.set("active-agent", {
        name: "active-agent",
        status: "RUNNING",
        archived: false,
      });
      stubApp.agents.set("archived-agent", {
        name: "archived-agent",
        status: "DONE",
        archived: true,
      });

      const res = await request(app).get("/api/status?archived=true");
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(2);
    });

    it("explicitly excludes archived with ?archived=false", async () => {
      stubApp.agents.set("archived-agent", {
        name: "archived-agent",
        status: "DONE",
        archived: true,
      });

      const res = await request(app).get("/api/status?archived=false");
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(0);
    });
  });

  describe("POST /api/start", () => {
    it("returns {ok: true} on success", async () => {
      const res = await request(app)
        .post("/api/start")
        .send({ name: "test-agent", prompt: "do something" });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });

    it("returns 400 if name is missing", async () => {
      const res = await request(app)
        .post("/api/start")
        .send({ prompt: "do something" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    it("returns 400 if prompt is missing", async () => {
      const res = await request(app)
        .post("/api/start")
        .send({ name: "test-agent" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBeDefined();
    });

    it("returns InvalidNameError for invalid name", async () => {
      const res = await request(app)
        .post("/api/start")
        .send({ name: "bad name!", prompt: "test" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("InvalidNameError");
    });

    it("returns InvalidNameError for path traversal in name", async () => {
      const res = await request(app)
        .post("/api/start")
        .send({ name: "../../etc", prompt: "test" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("InvalidNameError");
    });

    it("propagates DirtyWorktreeError as 400", async () => {
      stubApp.start = () => {
        throw new DirtyWorktreeError("worktree is dirty");
      };

      const res = await request(app)
        .post("/api/start")
        .send({ name: "test-agent", prompt: "test" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("DirtyWorktreeError");
    });
  });

  describe("GET /api/log/:name", () => {
    it("returns log text", async () => {
      stubApp.agents.set("test-agent", {
        name: "test-agent",
        status: "RUNNING",
      });

      const res = await request(app).get("/api/log/test-agent");
      expect(res.status).toBe(200);
      expect(res.body.log).toBeDefined();
      expect(typeof res.body.log).toBe("string");
    });

    it("passes lines query param", async () => {
      stubApp.agents.set("test-agent", {
        name: "test-agent",
        status: "RUNNING",
      });

      const res = await request(app).get("/api/log/test-agent?lines=20");
      expect(res.status).toBe(200);
      expect(res.body.log).toContain("20");
    });

    it("returns 400 for missing agent", async () => {
      const res = await request(app).get("/api/log/nonexistent");
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("AgentNotFoundError");
    });
  });

  describe("GET /api/diff/:name", () => {
    it("returns diff text", async () => {
      stubApp.agents.set("test-agent", {
        name: "test-agent",
        status: "DONE",
      });

      const res = await request(app).get("/api/diff/test-agent");
      expect(res.status).toBe(200);
      expect(res.body.diff).toBeDefined();
      expect(typeof res.body.diff).toBe("string");
    });

    it("passes mode query param", async () => {
      stubApp.agents.set("test-agent", {
        name: "test-agent",
        status: "DONE",
      });

      const res = await request(app).get("/api/diff/test-agent?mode=full");
      expect(res.status).toBe(200);
      expect(res.body.diff).toContain("full");
    });

    it("returns 400 for missing agent", async () => {
      const res = await request(app).get("/api/diff/nonexistent");
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("AgentNotFoundError");
    });
  });

  describe("GET /api/status — risk_assessment", () => {
    it("includes risk_assessment for REVIEW agents", async () => {
      stubApp.agents.set("review-agent", {
        name: "review-agent",
        status: "REVIEW",
        archived: false,
        risk_assessment: {
          level: "HIGH",
          signals: [
            { name: "file_count", level: "HIGH", detail: "7 files changed (threshold: 5)" },
            { name: "line_count", level: "LOW", detail: "150 lines changed (threshold: 200)" },
            { name: "new_files", level: "HIGH", detail: "new files added" },
            { name: "public_modules", level: "LOW", detail: "no public module changes" },
            { name: "conflict", level: "LOW", detail: "no conflict" },
            { name: "test", level: "HIGH", detail: "no test files modified" },
          ],
        },
      });

      const res = await request(app).get("/api/status");
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
      expect(res.body[0].risk_assessment).toBeDefined();
      expect(res.body[0].risk_assessment.level).toBe("HIGH");
      expect(res.body[0].risk_assessment.signals).toHaveLength(6);
    });

    it("returns null risk_assessment for non-REVIEW agents", async () => {
      stubApp.agents.set("running-agent", {
        name: "running-agent",
        status: "RUNNING",
        archived: false,
      });

      const res = await request(app).get("/api/status");
      expect(res.status).toBe(200);
      expect(res.body[0].risk_assessment).toBeUndefined();
    });
  });

  describe("POST /api/done/:name", () => {
    it("returns {ok: true} on success", async () => {
      stubApp.agents.set("test-agent", {
        name: "test-agent",
        status: "DONE",
      });

      const res = await request(app).post("/api/done/test-agent");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });

    it("returns 400 for missing agent", async () => {
      const res = await request(app).post("/api/done/nonexistent");
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("AgentNotFoundError");
    });

    it("propagates MergeError with conflictFiles", async () => {
      stubApp.agents.set("test-agent", {
        name: "test-agent",
        status: "DONE",
      });
      const origDone = stubApp.done.bind(stubApp);
      stubApp.done = () => {
        throw new MergeError("merge conflict", ["a.ts", "b.ts"]);
      };

      const res = await request(app).post("/api/done/test-agent");
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("MergeError");
      expect(res.body.conflictFiles).toEqual(["a.ts", "b.ts"]);
    });
  });

  describe("POST /api/kill/:name", () => {
    it("returns {ok: true} on success", async () => {
      stubApp.agents.set("test-agent", {
        name: "test-agent",
        status: "RUNNING",
      });

      const res = await request(app).post("/api/kill/test-agent");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });

    it("passes clean=1 as clean=true", async () => {
      stubApp.agents.set("test-agent", {
        name: "test-agent",
        status: "RUNNING",
      });

      const res = await request(app).post("/api/kill/test-agent?clean=1");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });

    it("defaults clean to false", async () => {
      stubApp.agents.set("test-agent", {
        name: "test-agent",
        status: "RUNNING",
      });

      const res = await request(app).post("/api/kill/test-agent");
      expect(res.status).toBe(200);
    });
  });

  describe("POST /api/retry/:name", () => {
    it("returns {ok: true} on success", async () => {
      stubApp.agents.set("test-agent", {
        name: "test-agent",
        status: "CRASHED",
      });

      const res = await request(app).post("/api/retry/test-agent");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });

    it("returns 400 for missing agent", async () => {
      const res = await request(app).post("/api/retry/nonexistent");
      expect(res.status).toBe(400);
    });
  });

  describe("POST /api/accept/:name", () => {
    it("returns {ok: true} on success", async () => {
      stubApp.agents.set("test-agent", {
        name: "test-agent",
        status: "REVIEW",
      });

      const res = await request(app).post("/api/accept/test-agent");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });

    it("returns 400 for missing agent", async () => {
      const res = await request(app).post("/api/accept/nonexistent");
      expect(res.status).toBe(400);
    });
  });

  describe("POST /api/reject/:name", () => {
    it("returns {ok: true} on success", async () => {
      stubApp.agents.set("test-agent", {
        name: "test-agent",
        status: "REVIEW",
      });

      const res = await request(app).post("/api/reject/test-agent");
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true });
    });

    it("returns 400 for missing agent", async () => {
      const res = await request(app).post("/api/reject/nonexistent");
      expect(res.status).toBe(400);
    });
  });

  describe("POST /api/plan/run", () => {
    it("returns plan result with path", async () => {
      const res = await request(app)
        .post("/api/plan/run")
        .send({ path: "/tmp/plan.md" });

      expect(res.status).toBe(200);
      expect(res.body.name).toBeDefined();
      expect(res.body.taskCount).toBeDefined();
    });

    it("returns plan result with prdPath", async () => {
      const res = await request(app)
        .post("/api/plan/run")
        .send({ prdPath: "/tmp/prd.json" });

      expect(res.status).toBe(200);
      expect(res.body.name).toBeDefined();
    });

    it("returns 400 when neither path nor prdPath provided", async () => {
      const res = await request(app)
        .post("/api/plan/run")
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("ValidationError");
    });

    it("returns 400 on PlanAlreadyActiveError", async () => {
      stubApp.planData.progress = {
        plan: "existing",
        total: 1,
        done: 0,
        running: 1,
        pending: 0,
        crashed: 0,
        conflicted: 0,
        stale: 0,
        review: 0,
      };

      const res = await request(app)
        .post("/api/plan/run")
        .send({ path: "/tmp/new-plan.md" });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe("PlanAlreadyActiveError");
    });
  });

  describe("GET /api/plan/status", () => {
    it("returns null when no plan is active", async () => {
      const res = await request(app).get("/api/plan/status");
      expect(res.status).toBe(200);
      expect(res.body).toBeNull();
    });

    it("returns progress when plan is active", async () => {
      stubApp.planData.progress = {
        plan: "test-plan",
        total: 3,
        done: 1,
        running: 1,
        pending: 1,
        crashed: 0,
        conflicted: 0,
        stale: 0,
        review: 0,
      };

      const res = await request(app).get("/api/plan/status");
      expect(res.status).toBe(200);
      expect(res.body.plan).toBe("test-plan");
      expect(res.body.total).toBe(3);
    });
  });

  describe("GET /api/plan/dag", () => {
    it("returns null when no plan is active", async () => {
      const res = await request(app).get("/api/plan/dag");
      expect(res.status).toBe(200);
      expect(res.body).toBeNull();
    });

    it("returns nodes and edges when plan is active", async () => {
      stubApp.planData.dag = {
        nodes: [
          { id: "TS-001", status: "DONE" },
          { id: "TS-002", status: "RUNNING" },
        ],
        edges: [{ from: "TS-001", to: "TS-002" }],
      };

      const res = await request(app).get("/api/plan/dag");
      expect(res.status).toBe(200);
      expect(res.body.nodes).toHaveLength(2);
      expect(res.body.edges).toHaveLength(1);
    });
  });

  describe("GET /api/events (SSE)", () => {
    it("sets correct SSE headers", async () => {
      const server = app.listen(0);
      const port = (server.address() as { port: number }).port;

      try {
        const controller = new AbortController();
        const res = await fetch(`http://localhost:${port}/api/events`, {
          signal: controller.signal,
        });

        expect(res.headers.get("content-type")).toBe("text/event-stream");
        expect(res.headers.get("cache-control")).toBe("no-cache");

        controller.abort();
      } finally {
        server.close();
      }
    });

    it("sends initial status event on first poll", async () => {
      stubApp.agents.set("agent-1", { name: "agent-1", status: "RUNNING" });

      const server = app.listen(0);
      const port = (server.address() as { port: number }).port;

      try {
        const controller = new AbortController();
        const res = await fetch(`http://localhost:${port}/api/events`, {
          signal: controller.signal,
        });

        const reader = res.body!.getReader();
        const chunks: string[] = [];
        const timeout = setTimeout(() => controller.abort(), 500);

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(new TextDecoder().decode(value));
          if (chunks.join("").includes("agent-1")) break;
        }

        clearTimeout(timeout);
        controller.abort();

        const allData = chunks.join("");
        expect(allData).toContain("event: status");
        expect(allData).toContain("agent-1");
      } finally {
        server.close();
      }
    });

    it("sends keepalive heartbeat", async () => {
      const server = app.listen(0);
      const port = (server.address() as { port: number }).port;

      try {
        const controller = new AbortController();
        const res = await fetch(`http://localhost:${port}/api/events`, {
          signal: controller.signal,
        });

        const reader = res.body!.getReader();
        const chunks: string[] = [];
        const timeout = setTimeout(() => controller.abort(), 500);

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(new TextDecoder().decode(value));
          if (chunks.join("").includes("keepalive")) break;
        }

        clearTimeout(timeout);
        controller.abort();

        const allData = chunks.join("");
        expect(allData).toContain(": keepalive");
      } finally {
        server.close();
      }
    });
  });

  describe("static assets", () => {
    it("serves style.css", async () => {
      const res = await request(app).get("/style.css");
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/css/);
    });

    it("serves app.js", async () => {
      const res = await request(app).get("/app.js");
      expect(res.status).toBe(200);
      expect(res.headers["content-type"]).toMatch(/javascript/);
    });
  });

  describe("error handling", () => {
    it("LoomerError subclass returns 400 JSON", async () => {
      const res = await request(app).get("/api/log/nonexistent");
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("AgentNotFoundError");
      expect(res.body.message).toBeDefined();
    });

    it("non-LoomerError returns 500 with generic message", async () => {
      stubApp.status = () => {
        throw new Error("unexpected crash with /secret/path");
      };

      const res = await request(app).get("/api/status");
      expect(res.status).toBe(500);
      expect(res.body.error).toBe("InternalError");
      expect(res.body.message).toBe("An internal error occurred");
      expect(res.body.message).not.toContain("/secret/path");
    });

    it("returns 503 when loomerApp is not initialized", async () => {
      const noApp = createApp(config);
      const res = await request(noApp).get("/api/status");
      expect(res.status).toBe(503);
      expect(res.body.error).toBe("ServiceUnavailable");
    });
  });
});
