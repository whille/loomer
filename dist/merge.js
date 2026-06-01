/**
 * 合并两个 package.json 的依赖并集
 * 同 key 冲突时 ours 优先（保留主分支版本）
 */
export function mergePackageJson(ours, theirs) {
    const oursObj = JSON.parse(ours);
    const theirsObj = JSON.parse(theirs);
    const result = { ...oursObj };
    // 合并 dependencies 并集（ours 优先）
    const oursDeps = (oursObj.dependencies ?? {});
    const theirsDeps = (theirsObj.dependencies ?? {});
    result.dependencies = { ...theirsDeps, ...oursDeps };
    // 合并 devDependencies 并集（ours 优先）
    const oursDevDeps = (oursObj.devDependencies ?? {});
    const theirsDevDeps = (theirsObj.devDependencies ?? {});
    result.devDependencies = { ...theirsDevDeps, ...oursDevDeps };
    return JSON.stringify(result, null, 2);
}
/**
 * 合并 TypeScript 源码：import 区 + export 区 + 类定义拼接
 * ours 在前，theirs 在后，重复 import 去重
 */
export function mergeTsSource(ours, theirs) {
    if (!ours.trim())
        return theirs;
    if (!theirs.trim())
        return ours;
    const oursLines = ours.split("\n");
    const theirsLines = theirs.split("\n");
    // 分离 import 区和非 import 区
    const oursImports = oursLines.filter((l) => l.trim().startsWith("import "));
    const oursBody = oursLines.filter((l) => !l.trim().startsWith("import "));
    const theirsImports = theirsLines.filter((l) => l.trim().startsWith("import "));
    const theirsBody = theirsLines.filter((l) => !l.trim().startsWith("import "));
    // 去重 import（ours 优先）
    const seenImports = new Set();
    const mergedImports = [];
    for (const imp of oursImports) {
        const normalized = imp.trim();
        if (!seenImports.has(normalized)) {
            mergedImports.push(imp);
            seenImports.add(normalized);
        }
    }
    for (const imp of theirsImports) {
        const normalized = imp.trim();
        if (!seenImports.has(normalized)) {
            mergedImports.push(imp);
            seenImports.add(normalized);
        }
    }
    // 拼接：import 区 + 空行 + ours body + 空行 + theirs body
    const parts = [];
    if (mergedImports.length > 0)
        parts.push(mergedImports.join("\n"));
    if (oursBody.filter((l) => l.trim()).length > 0)
        parts.push(oursBody.join("\n").trim());
    if (theirsBody.filter((l) => l.trim()).length > 0)
        parts.push(theirsBody.join("\n").trim());
    return parts.join("\n\n");
}
/**
 * 深合并对象：ours 为基准，叠 theirs 新增 key
 * 同 key 冲突时 ours 优先
 */
export function deepMerge(ours, theirs) {
    const result = { ...ours };
    for (const [key, value] of Object.entries(theirs)) {
        if (!(key in result)) {
            result[key] = value;
        }
        else if (typeof result[key] === "object" &&
            result[key] !== null &&
            !Array.isArray(result[key]) &&
            typeof value === "object" &&
            value !== null &&
            !Array.isArray(value)) {
            result[key] = deepMerge(result[key], value);
        }
        // 同 key 且非嵌套对象 → ours 优先，不覆盖
    }
    return result;
}
/** 判断是否为 package.json 文件 */
function isPackageJson(filepath) {
    return filepath === "package.json" || filepath.endsWith("/package.json");
}
/** 判断是否为 src/*.ts 源码文件 */
function isTsSource(filepath) {
    return /\.(ts|tsx)$/.test(filepath) && /(?:^|\/)src\//.test(filepath);
}
/** 判断是否为配置文件 */
function isConfigFile(filepath) {
    const filename = filepath.split("/").pop() ?? "";
    return (filename.includes("config") ||
        filename === "tsconfig.json" ||
        filename.endsWith(".config.json") ||
        filename.endsWith(".rc.json"));
}
/**
 * 按文件类型分派自动解决策略
 * 返回 null 表示无法自动解决
 */
export function autoResolveConflictFile(filepath, ours, theirs) {
    try {
        if (isPackageJson(filepath)) {
            return mergePackageJson(ours, theirs);
        }
        if (isTsSource(filepath)) {
            return mergeTsSource(ours, theirs);
        }
        if (isConfigFile(filepath)) {
            const oursObj = JSON.parse(ours);
            const theirsObj = JSON.parse(theirs);
            return JSON.stringify(deepMerge(oursObj, theirsObj), null, 2);
        }
    }
    catch {
        // 解析失败 → 无法自动解决
        return null;
    }
    return null;
}
//# sourceMappingURL=merge.js.map