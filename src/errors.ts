export class LoomerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class DirtyWorktreeError extends LoomerError {}

export class BranchConflictError extends LoomerError {}

export class InvalidNameError extends LoomerError {}

export class AgentNotFoundError extends LoomerError {}

export class MergeError extends LoomerError {
  conflictFiles?: string[];

  constructor(message: string, conflictFiles?: string[]) {
    super(message);
    this.conflictFiles = conflictFiles;
  }
}

export class PlanFormatError extends LoomerError {}

export class DAGValidationError extends LoomerError {}

export class PlanNotFoundError extends LoomerError {}

export class PlanAlreadyActiveError extends LoomerError {}
