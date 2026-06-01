export declare class LoomerError extends Error {
    constructor(message: string);
}
export declare class DirtyWorktreeError extends LoomerError {
}
export declare class BranchConflictError extends LoomerError {
}
export declare class InvalidNameError extends LoomerError {
}
export declare class AgentNotFoundError extends LoomerError {
}
export declare class MergeError extends LoomerError {
    conflictFiles?: string[];
    constructor(message: string, conflictFiles?: string[]);
}
export declare class PlanFormatError extends LoomerError {
}
export declare class DAGValidationError extends LoomerError {
}
export declare class PlanNotFoundError extends LoomerError {
}
export declare class PlanAlreadyActiveError extends LoomerError {
}
//# sourceMappingURL=errors.d.ts.map