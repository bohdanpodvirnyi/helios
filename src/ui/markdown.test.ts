import { describe, it, expect, vi, beforeEach } from "vitest";

// We need to reset module cache between some tests to test caching behavior
let renderMarkdown: typeof import("./markdown.js")["renderMarkdown"];

beforeEach(async () => {
  // Re-import fresh for each test to avoid cross-test pollution
  // (except the caching tests which specifically test module-level state)
  const mod = await import("./markdown.js");
  renderMarkdown = mod.renderMarkdown;
});

describe("renderMarkdown", () => {
  it("returns empty string for empty input", () => {
    expect(renderMarkdown("")).toBe("");
  });

  it("returns empty string for undefined-ish falsy input", () => {
    // The function checks !input, so null/undefined coerced should also return ""
    expect(renderMarkdown(null as unknown as string)).toBe("");
    expect(renderMarkdown(undefined as unknown as string)).toBe("");
  });

  it("passes through plain text without markdown syntax", () => {
    const result = renderMarkdown("Hello world", 80);
    // Should contain the original text (possibly with minor whitespace changes)
    expect(result).toContain("Hello world");
    // Should NOT contain markdown-specific decorations like heading prefixes
    // Plain text should be mostly unchanged
  });

  it("styles headings with ANSI escape codes", () => {
    const result = renderMarkdown("# My Heading", 80);
    // firstHeading wraps text in \x1b[1;33m ... \x1b[0m
    expect(result).toContain("\x1b[1;33m");
    expect(result).toContain("\x1b[0m");
    expect(result).toContain("My Heading");
  });

  it("styles second-level headings", () => {
    const result = renderMarkdown("# First\n\n## Second", 80);
    // heading (non-first) wraps in \x1b[33m ... \x1b[0m
    expect(result).toContain("\x1b[33m");
    expect(result).toContain("Second");
  });

  it("styles bold text with ANSI codes", () => {
    const result = renderMarkdown("This is **bold** text", 80);
    // strong wraps in \x1b[1;37m ... \x1b[0m
    expect(result).toContain("\x1b[1;37m");
    expect(result).toContain("bold");
  });

  it("styles code blocks and preserves content", () => {
    const result = renderMarkdown("```\nconst x = 1;\n```", 80);
    // Code block content should be present in the output
    expect(result).toContain("const x = 1;");
    // The output should be non-trivially formatted (indented or styled)
    expect(result).not.toBe("const x = 1;");
  });

  it("styles inline code with background color", () => {
    const result = renderMarkdown("Use `foo()` here", 80);
    // codespan wraps in \x1b[33;48;5;236m ... \x1b[0m
    expect(result).toContain("\x1b[33;48;5;236m");
    expect(result).toContain("foo()");
  });

  it("formats list items with custom bullet", () => {
    const result = renderMarkdown("- item one\n- item two", 80);
    // listitem uses ▹ bullet
    expect(result).toContain("▹");
    expect(result).toContain("item one");
    expect(result).toContain("item two");
  });

  it("formats emphasis/italic with ANSI codes", () => {
    const result = renderMarkdown("This is *italic* text", 80);
    // em wraps in \x1b[3;33m ... \x1b[0m
    expect(result).toContain("\x1b[3;33m");
    expect(result).toContain("italic");
  });

  it("strips trailing newlines from output", () => {
    const result = renderMarkdown("Hello", 80);
    expect(result).not.toMatch(/\n+$/);
  });

  it("strips trailing newlines from multiline output", () => {
    const result = renderMarkdown("# Heading\n\nParagraph\n\nMore text", 80);
    expect(result).not.toMatch(/\n+$/);
  });

  it("uses cached Marked instance for same width", () => {
    // Render twice with same width — should not crash and should produce
    // consistent output (the caching is an internal optimization)
    const result1 = renderMarkdown("**test**", 80);
    const result2 = renderMarkdown("**test**", 80);
    expect(result1).toBe(result2);
  });

  it("produces potentially different instances for different widths", () => {
    // Different widths can produce different reflowed output
    const narrow = renderMarkdown("A paragraph that is long enough to be reflowed differently at different widths to verify width matters.", 40);
    const wide = renderMarkdown("A paragraph that is long enough to be reflowed differently at different widths to verify width matters.", 200);
    // Both should contain the text
    expect(narrow).toContain("paragraph");
    expect(wide).toContain("paragraph");
    // They can differ in reflow; at minimum both should be valid
  });

  it("handles very long input without crashing", () => {
    const longInput = "word ".repeat(10_000);
    expect(() => renderMarkdown(longInput, 80)).not.toThrow();
    const result = renderMarkdown(longInput, 80);
    expect(result.length).toBeGreaterThan(0);
  });

  it("handles deeply nested markdown without crashing", () => {
    const nested = "- " + "  - ".repeat(20) + "deep item";
    expect(() => renderMarkdown(nested, 80)).not.toThrow();
  });

  it("handles input with only newlines", () => {
    const result = renderMarkdown("\n\n\n", 80);
    // After stripping trailing newlines, may be empty or minimal
    expect(typeof result).toBe("string");
  });

  it("renders horizontal rules", () => {
    const result = renderMarkdown("---", 80);
    // hr uses ━ repeated 40 times
    expect(result).toContain("━".repeat(40));
  });

  it("renders blockquotes with border", () => {
    const result = renderMarkdown("> quoted text", 80);
    // blockquote uses ┃ prefix
    expect(result).toContain("┃");
    expect(result).toContain("quoted text");
  });

  it("renders links with href", () => {
    const result = renderMarkdown("[click here](https://example.com)", 80);
    expect(result).toContain("click here");
    expect(result).toContain("https://example.com");
  });

  it("defaults to process.stdout.columns or 80 when width not provided", () => {
    // Just verify it doesn't crash without a width argument
    expect(() => renderMarkdown("test")).not.toThrow();
    const result = renderMarkdown("test");
    expect(result).toContain("test");
  });
});
