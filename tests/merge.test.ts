import { describe, it, expect } from "vitest";
import {
  mergePackageJson,
  mergeTsSource,
  deepMerge,
  autoResolveConflictFile,
  type ConflictContent,
} from "../src/merge.js";

// === package.json 合并 ===

describe("mergePackageJson", () => {
  it("合并 dependencies 并集", () => {
    const ours: ConflictContent = JSON.stringify({
      dependencies: { express: "^4.0.0", ejs: "^3.0.0" },
      devDependencies: { vitest: "^2.0.0" },
    });
    const theirs: ConflictContent = JSON.stringify({
      dependencies: { express: "^4.0.0", "better-sqlite3": "^11.0.0" },
      devDependencies: { vitest: "^2.0.0", supertest: "^7.0.0" },
    });
    const result = JSON.parse(mergePackageJson(ours, theirs));
    expect(result.dependencies).toEqual({
      express: "^4.0.0",
      ejs: "^3.0.0",
      "better-sqlite3": "^11.0.0",
    });
    expect(result.devDependencies).toEqual({
      vitest: "^2.0.0",
      supertest: "^7.0.0",
    });
  });

  it("同 key 冲突时 ours 优先", () => {
    const ours = JSON.stringify({ dependencies: { pkg: "^1.0.0" } });
    const theirs = JSON.stringify({ dependencies: { pkg: "^2.0.0" } });
    const result = JSON.parse(mergePackageJson(ours, theirs));
    expect(result.dependencies.pkg).toBe("^1.0.0");
  });

  it("缺少 deps 字段不报错", () => {
    const ours = JSON.stringify({ name: "ours" });
    const theirs = JSON.stringify({ dependencies: { foo: "^1.0.0" } });
    const result = JSON.parse(mergePackageJson(ours, theirs));
    expect(result.dependencies).toEqual({ foo: "^1.0.0" });
    expect(result.name).toBe("ours");
  });
});

// === TypeScript 源码拼接 ===

describe("mergeTsSource", () => {
  it("import 区 ours 前 theirs 后", () => {
    const ours = `import { foo } from "./foo";\n\nexport const a = 1;`;
    const theirs = `import { bar } from "./bar";\n\nexport const b = 2;`;
    const result = mergeTsSource(ours, theirs);
    // ours import 在前
    expect(result.indexOf("import { foo }")).toBeLessThan(result.indexOf("import { bar }"));
  });

  it("export 区 ours 前 theirs 后", () => {
    const ours = `export const a = 1;`;
    const theirs = `export const b = 2;`;
    const result = mergeTsSource(ours, theirs);
    expect(result).toContain("export const a = 1;");
    expect(result).toContain("export const b = 2;");
    expect(result.indexOf("export const a")).toBeLessThan(result.indexOf("export const b"));
  });

  it("去重相同 import", () => {
    const ours = `import { foo } from "./foo";`;
    const theirs = `import { foo } from "./foo";`;
    const result = mergeTsSource(ours, theirs);
    // 只出现一次
    expect(result.match(/import \{ foo \}/g)?.length).toBe(1);
  });

  it("空 ours 时只返回 theirs", () => {
    const result = mergeTsSource("", "export const b = 2;");
    expect(result.trim()).toBe("export const b = 2;");
  });
});

// === Deep Merge ===

describe("deepMerge", () => {
  it("递归合并嵌套对象", () => {
    const ours = { a: { x: 1, y: 2 }, b: 3 };
    const theirs = { a: { x: 1, z: 4 }, c: 5 };
    const result = deepMerge(ours, theirs);
    expect(result).toEqual({ a: { x: 1, y: 2, z: 4 }, b: 3, c: 5 });
  });

  it("同 key 冲突时 ours 优先", () => {
    const ours = { key: "ours-value" };
    const theirs = { key: "theirs-value" };
    const result = deepMerge(ours, theirs);
    expect(result.key).toBe("ours-value");
  });

  it("theirs 新增 key 合并进来", () => {
    const ours = { existing: 1 };
    const theirs = { newKey: 2 };
    const result = deepMerge(ours, theirs);
    expect(result).toEqual({ existing: 1, newKey: 2 });
  });
});

// === autoResolveConflictFile ===

describe("autoResolveConflictFile", () => {
  it("package.json 文件使用并集合并", () => {
    const ours = JSON.stringify({ dependencies: { a: "^1" } });
    const theirs = JSON.stringify({ dependencies: { b: "^2" } });
    const result = autoResolveConflictFile("package.json", ours, theirs);
    const parsed = JSON.parse(result);
    expect(parsed.dependencies).toEqual({ a: "^1", b: "^2" });
  });

  it("src/*.ts 文件使用拼接合并", () => {
    const ours = "export const a = 1;";
    const theirs = "export const b = 2;";
    const result = autoResolveConflictFile("src/app.ts", ours, theirs);
    expect(result).toContain("export const a = 1;");
    expect(result).toContain("export const b = 2;");
  });

  it("config 文件使用 deep merge", () => {
    const ours = JSON.stringify({ server: { port: 3000, host: "localhost" } });
    const theirs = JSON.stringify({ server: { port: 3000, debug: true }, log: { level: "info" } });
    const result = autoResolveConflictFile("tsconfig.json", ours, theirs);
    const parsed = JSON.parse(result);
    expect(parsed.server.port).toBe(3000);
    expect(parsed.server.debug).toBe(true);
    expect(parsed.log.level).toBe("info");
  });

  it("config 文件名包含 config", () => {
    const ours = JSON.stringify({ a: 1 });
    const theirs = JSON.stringify({ b: 2 });
    const result = autoResolveConflictFile("app.config.json", ours, theirs);
    const parsed = JSON.parse(result);
    expect(parsed).toEqual({ a: 1, b: 2 });
  });

  it("不识别的文件类型返回 null", () => {
    const result = autoResolveConflictFile("README.md", "ours content", "theirs content");
    expect(result).toBeNull();
  });
});
