export class LoomerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LoomerError";
  }
}

export class DirtyWorktreeError extends LoomerError {
  constructor(message: string) {
    super(message);
    this.name = "DirtyWorktreeError";
  }
}

export class BranchConflictError extends LoomerError {
  constructor(message: string) {
    super(message);
    this.name = "BranchConflictError";
  }
}

export class InvalidNameError extends LoomerError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidNameError";
  }
}

export class AgentNotFoundError extends LoomerError {
  constructor(message: string) {
    super(message);
    this.name = "AgentNotFoundError";
  }
}

export class MergeError extends LoomerError {
  conflictFiles?: string[];

  constructor(message: string, conflictFiles?: string[]) {
    super(message);
    this.name = "MergeError";
    this.conflictFiles = conflictFiles;
  }
}

export class PlanFormatError extends LoomerError {
  constructor(message: string) {
    super(message);
    this.name = "PlanFormatError";
  }
}

export class DAGValidationError extends LoomerError {
  constructor(message: string) {
    super(message);
    this.name = "DAGValidationError";
  }
}

export class PlanNotFoundError extends LoomerError {
  constructor(message: string) {
    super(message);
    this.name = "PlanNotFoundError";
  }
}

export class PlanAlreadyActiveError extends LoomerError {
  constructor(message: string) {
    super(message);
    this.name = "PlanAlreadyActiveError";
  }
}
