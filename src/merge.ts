export type ConflictContent = string;

/**
 * package.json 中需要并集合并的 key（对象类型，同 key 取 ours 优先）
 */
const MERGE_KEYS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
  "scripts",
  "bin",
  "exports",
  "overrides",
  "resolutions",
] as const;

/**
 * 合并两个 package.json
 * - MERGE_KEYS 中的字段：并集合并，同 key 时 ours 优先
 * - 其他字段：ours 优先（保留主分支版本）
 */
export function mergePackageJson(
  ours: ConflictContent,
  theirs: ConflictContent,
): ConflictContent | null {
  let oursObj: Record<string, unknown>;
  let theirsObj: Record<string, unknown>;
  try {
    oursObj = JSON.parse(ours) as Record<string, unknown>;
    theirsObj = JSON.parse(theirs) as Record<string, unknown>;
  } catch {
    return null;
  }

  const result = { ...oursObj };

  for (const key of MERGE_KEYS) {
    const oursVal = oursObj[key] as Record<string, string> | undefined;
    const theirsVal = theirsObj[key] as Record<string, string> | undefined;

    if (!oursVal && !theirsVal) continue;

    const merged: Record<string, string> = {};
    // theirs 先写入
    if (theirsVal) {
      for (const [k, v] of Object.entries(theirsVal)) {
        merged[k] = v;
      }
    }
    // ours 覆盖（ours 优先）
    if (oursVal) {
      for (const [k, v] of Object.entries(oursVal)) {
        merged[k] = v;
      }
    }

    result[key] = merged;
  }

  // theirs 中有但 ours 中没有的顶层 key 也保留（如新增的 "type" 等）
  for (const [key, val] of Object.entries(theirsObj)) {
    if (!(key in result)) {
      result[key] = val;
    }
  }

  return JSON.stringify(result, null, 2) + "\n";
}

/**
 * 合并两个 TS/JS import/export 文件
 * import 区：去重并集（规范化后比较）
 * body 区：ours 优先（同文件双方都改 → 保留主分支版本，避免重复函数/变量）
 */
export function mergeTsImports(
  ours: ConflictContent,
  theirs: ConflictContent,
): ConflictContent | null {
  const oursLines = ours.split("\n");
  const theirsLines = theirs.split("\n");

  // 分离 import 区和 body 区
  const oursImports: string[] = [];
  const oursBody: string[] = [];
  const theirsImports: string[] = [];

  let pastImports = false;
  for (const line of oursLines) {
    if (!pastImports && (line.startsWith("import ") || line.trim() === "")) {
      oursImports.push(line);
    } else {
      pastImports = true;
      oursBody.push(line);
    }
  }

  pastImports = false;
  for (const line of theirsLines) {
    if (!pastImports && (line.startsWith("import ") || line.trim() === "")) {
      theirsImports.push(line);
    } else {
      pastImports = true;
      // theirs body 丢弃 — 同文件冲突 ours 优先
    }
  }

  // 去重并集
  const seenImports = new Set<string>();
  const mergedImports: string[] = [];
  for (const imp of [...oursImports, ...theirsImports]) {
    const normalized = imp.trim();
    if (normalized && !seenImports.has(normalized)) {
      mergedImports.push(imp);
      seenImports.add(normalized);
    }
  }

  // 拼接：import 区 + 空行 + ours body
  const parts: string[] = [];
  if (mergedImports.length > 0) parts.push(mergedImports.join("\n"));
  const bodyTrimmed = oursBody.join("\n").trim();
  if (bodyTrimmed.length > 0) parts.push(bodyTrimmed);

  return parts.join("\n\n") + "\n";
}

/** 判断文件路径是否为 package.json */
function isPackageJson(filepath: string): boolean {
  return filepath === "package.json" || filepath.endsWith("/package.json");
}

/** 判断文件路径是否为 TS/JS import 文件 */
function isTsImportFile(filepath: string): boolean {
  return /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(filepath);
}

/** 深度合并两个对象（ours 优先） */
export function deepMerge(
  ours: Record<string, unknown>,
  theirs: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...theirs };
  for (const [key, val] of Object.entries(ours)) {
    if (
      val &&
      typeof val === "object" &&
      !Array.isArray(val) &&
      result[key] &&
      typeof result[key] === "object" &&
      !Array.isArray(result[key])
    ) {
      result[key] = deepMerge(
        val as Record<string, unknown>,
        result[key] as Record<string, unknown>,
      );
    } else {
      result[key] = val;
    }
  }
  return result;
}

function isLockFile(filepath: string): boolean {
  return /(package-lock\.json|bun\.lockb|yarn\.lock|pnpm-lock\.yaml)$/.test(filepath);
}

/**
 * 自动解决冲突文件
 * @returns 解决后的内容，或 null 表示无法自动解决
 */
export function autoResolveConflictFile(
  filepath: string,
  ours: ConflictContent,
  theirs: ConflictContent,
): ConflictContent | null {
  try {
    if (isPackageJson(filepath)) {
      return mergePackageJson(ours, theirs);
    }
    // lock 文件 → 直接取 theirs（重新生成比 merge 安全）
    if (/(package-lock\.json|bun\.lockb|yarn\.lock|pnpm-lock\.yaml)$/.test(filepath)) {
      return theirs;
    }
    if (isTsImportFile(filepath)) {
      return mergeTsImports(ours, theirs);
    }
    // 其他 JSON 配置文件 → deepMerge
    if (filepath.endsWith(".json")) {
      const oursObj = JSON.parse(ours) as Record<string, unknown>;
      const theirsObj = JSON.parse(theirs) as Record<string, unknown>;
      return JSON.stringify(deepMerge(oursObj, theirsObj), null, 2) + "\n";
    }
  } catch {
    return null;
  }
  return null;
}
