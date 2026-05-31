import { describe, it, expect } from "vitest"
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
} from "../src/errors.js"

describe("errors", () => {
  it("LoomerError 是 Error 子类", () => {
    const err = new LoomerError("test")
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(LoomerError)
    expect(err.message).toBe("test")
    expect(err.name).toBe("LoomerError")
  })

  it("DirtyWorktreeError 继承 LoomerError", () => {
    const err = new DirtyWorktreeError("dirty")
    expect(err).toBeInstanceOf(LoomerError)
    expect(err).toBeInstanceOf(DirtyWorktreeError)
    expect(err.name).toBe("DirtyWorktreeError")
  })

  it("BranchConflictError 继承 LoomerError", () => {
    const err = new BranchConflictError("conflict")
    expect(err).toBeInstanceOf(LoomerError)
    expect(err.name).toBe("BranchConflictError")
  })

  it("InvalidNameError 继承 LoomerError", () => {
    const err = new InvalidNameError("bad name")
    expect(err).toBeInstanceOf(LoomerError)
    expect(err.name).toBe("InvalidNameError")
  })

  it("AgentNotFoundError 继承 LoomerError", () => {
    const err = new AgentNotFoundError("not found")
    expect(err).toBeInstanceOf(LoomerError)
    expect(err.name).toBe("AgentNotFoundError")
  })

  it("MergeError 继承 LoomerError，可选 conflictFiles", () => {
    const err = new MergeError("merge failed")
    expect(err).toBeInstanceOf(LoomerError)
    expect(err.name).toBe("MergeError")
    expect(err.conflictFiles).toBeUndefined()
  })

  it("MergeError 可携带 conflictFiles", () => {
    const err = new MergeError("conflict", ["a.ts", "b.ts"])
    expect(err.conflictFiles).toEqual(["a.ts", "b.ts"])
  })

  it("PlanFormatError 继承 LoomerError", () => {
    const err = new PlanFormatError("bad format")
    expect(err).toBeInstanceOf(LoomerError)
    expect(err.name).toBe("PlanFormatError")
  })

  it("DAGValidationError 继承 LoomerError", () => {
    const err = new DAGValidationError("cycle")
    expect(err).toBeInstanceOf(LoomerError)
    expect(err.name).toBe("DAGValidationError")
  })

  it("PlanNotFoundError 继承 LoomerError", () => {
    const err = new PlanNotFoundError("no plan")
    expect(err).toBeInstanceOf(LoomerError)
    expect(err.name).toBe("PlanNotFoundError")
  })

  it("PlanAlreadyActiveError 继承 LoomerError", () => {
    const err = new PlanAlreadyActiveError("active")
    expect(err).toBeInstanceOf(LoomerError)
    expect(err.name).toBe("PlanAlreadyActiveError")
  })
})
