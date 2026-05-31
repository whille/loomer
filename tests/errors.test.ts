import { describe, it, expect } from "vitest";
import {
  LoomerError,
  DirtyWorktreeError,
  BranchConflictError,
  InvalidNameError,
  AgentNotFoundError,
  MergeError,
  PlanFormatError,
  DAGValidationError,
  PlanNotFoundError,
  PlanAlreadyActiveError,
} from "../src/errors.js";

describe("LoomerError hierarchy", () => {
  it("LoomerError extends Error", () => {
    const err = new LoomerError("test");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(LoomerError);
    expect(err.message).toBe("test");
    expect(err.name).toBe("LoomerError");
  });

  it("DirtyWorktreeError extends LoomerError", () => {
    const err = new DirtyWorktreeError("dirty");
    expect(err).toBeInstanceOf(LoomerError);
    expect(err.name).toBe("DirtyWorktreeError");
  });

  it("BranchConflictError extends LoomerError", () => {
    const err = new BranchConflictError("conflict");
    expect(err).toBeInstanceOf(LoomerError);
    expect(err.name).toBe("BranchConflictError");
  });

  it("InvalidNameError extends LoomerError", () => {
    const err = new InvalidNameError("bad name");
    expect(err).toBeInstanceOf(LoomerError);
    expect(err.name).toBe("InvalidNameError");
  });

  it("AgentNotFoundError extends LoomerError", () => {
    const err = new AgentNotFoundError("not found");
    expect(err).toBeInstanceOf(LoomerError);
    expect(err.name).toBe("AgentNotFoundError");
  });

  it("MergeError extends LoomerError with optional conflictFiles", () => {
    const err = new MergeError("merge failed");
    expect(err).toBeInstanceOf(LoomerError);
    expect(err.name).toBe("MergeError");
    expect(err.conflictFiles).toBeUndefined();

    const withFiles = new MergeError("conflict", ["a.ts", "b.ts"]);
    expect(withFiles.conflictFiles).toEqual(["a.ts", "b.ts"]);
  });

  it("PlanFormatError extends LoomerError", () => {
    const err = new PlanFormatError("bad format");
    expect(err).toBeInstanceOf(LoomerError);
    expect(err.name).toBe("PlanFormatError");
  });

  it("DAGValidationError extends LoomerError", () => {
    const err = new DAGValidationError("cycle");
    expect(err).toBeInstanceOf(LoomerError);
    expect(err.name).toBe("DAGValidationError");
  });

  it("PlanNotFoundError extends LoomerError", () => {
    const err = new PlanNotFoundError("no plan");
    expect(err).toBeInstanceOf(LoomerError);
    expect(err.name).toBe("PlanNotFoundError");
  });

  it("PlanAlreadyActiveError extends LoomerError", () => {
    const err = new PlanAlreadyActiveError("active");
    expect(err).toBeInstanceOf(LoomerError);
    expect(err.name).toBe("PlanAlreadyActiveError");
  });
});
