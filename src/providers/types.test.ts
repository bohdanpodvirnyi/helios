import { describe, it, expect } from "vitest";
import { ToolParameterSchema, CHECKPOINT_ACK } from "./types.js";

describe("ToolParameterSchema", () => {
  it("accepts valid schema with properties and required", () => {
    const result = ToolParameterSchema.safeParse({
      type: "object",
      properties: {
        name: { type: "string" },
        age: { type: "number" },
      },
      required: ["name"],
    });
    expect(result.success).toBe(true);
  });

  it("accepts schema without required (it is optional)", () => {
    const result = ToolParameterSchema.safeParse({
      type: "object",
      properties: {
        command: { type: "string" },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects schema without type: "object"', () => {
    const result = ToolParameterSchema.safeParse({
      type: "array",
      properties: {},
    });
    expect(result.success).toBe(false);
  });

  it("rejects schema without properties", () => {
    const result = ToolParameterSchema.safeParse({
      type: "object",
    });
    expect(result.success).toBe(false);
  });

  it("rejects schema with no type at all", () => {
    const result = ToolParameterSchema.safeParse({
      properties: { a: { type: "string" } },
    });
    expect(result.success).toBe(false);
  });

  it("accepts schema with various property types", () => {
    const result = ToolParameterSchema.safeParse({
      type: "object",
      properties: {
        str: { type: "string", description: "a string" },
        num: { type: "number", minimum: 0 },
        bool: { type: "boolean" },
        arr: { type: "array", items: { type: "string" } },
        nested: { type: "object", properties: { x: { type: "number" } } },
      },
      required: ["str", "num"],
    });
    expect(result.success).toBe(true);
  });

  it("accepts empty properties object", () => {
    const result = ToolParameterSchema.safeParse({
      type: "object",
      properties: {},
    });
    expect(result.success).toBe(true);
  });

  it("accepts empty required array", () => {
    const result = ToolParameterSchema.safeParse({
      type: "object",
      properties: { a: { type: "string" } },
      required: [],
    });
    expect(result.success).toBe(true);
  });

  it("rejects required with non-string elements", () => {
    const result = ToolParameterSchema.safeParse({
      type: "object",
      properties: { a: { type: "string" } },
      required: [123],
    });
    expect(result.success).toBe(false);
  });

  it("parsed value matches the input", () => {
    const input = {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "file path" },
      },
      required: ["path"],
    };
    const result = ToolParameterSchema.parse(input);
    expect(result.type).toBe("object");
    expect(result.properties).toEqual(input.properties);
    expect(result.required).toEqual(["path"]);
  });
});

describe("CHECKPOINT_ACK", () => {
  it("is a non-empty string", () => {
    expect(typeof CHECKPOINT_ACK).toBe("string");
    expect(CHECKPOINT_ACK.length).toBeGreaterThan(0);
  });

  it('contains "memory" (references the memory tree)', () => {
    expect(CHECKPOINT_ACK.toLowerCase()).toContain("memory");
  });

  it('contains "continue" (signals continuation)', () => {
    expect(CHECKPOINT_ACK.toLowerCase()).toContain("continue");
  });

  it("contains the word 'Understood'", () => {
    expect(CHECKPOINT_ACK).toMatch(/Understood/);
  });

  it("is a single sentence or short paragraph (no line breaks)", () => {
    expect(CHECKPOINT_ACK).not.toContain("\n");
  });
});
