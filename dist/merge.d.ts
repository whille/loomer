export type ConflictContent = string;
/**
 * 合并两个 package.json 的依赖并集
 * 同 key 冲突时 ours 优先（保留主分支版本）
 */
export declare function mergePackageJson(ours: ConflictContent, theirs: ConflictContent): ConflictContent;
/**
 * 合并 TypeScript 源码：import 区 + export 区 + 类定义拼接
 * ours 在前，theirs 在后，重复 import 去重
 */
export declare function mergeTsSource(ours: ConflictContent, theirs: ConflictContent): ConflictContent;
/**
 * 深合并对象：ours 为基准，叠 theirs 新增 key
 * 同 key 冲突时 ours 优先
 */
export declare function deepMerge(ours: Record<string, unknown>, theirs: Record<string, unknown>): Record<string, unknown>;
/**
 * 按文件类型分派自动解决策略
 * 返回 null 表示无法自动解决
 */
export declare function autoResolveConflictFile(filepath: string, ours: ConflictContent, theirs: ConflictContent): ConflictContent | null;
//# sourceMappingURL=merge.d.ts.map