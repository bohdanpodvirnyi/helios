import { describe, it, expect } from "vitest";
import { StickyManager } from "./stickies.js";

describe("StickyManager", () => {
  it("starts empty", () => {
    const mgr = new StickyManager();
    expect(mgr.count()).toBe(0);
    expect(mgr.list()).toEqual([]);
  });

  it("adds notes with sequential numbers", () => {
    const mgr = new StickyManager();
    const n1 = mgr.add("first");
    const n2 = mgr.add("second");
    expect(n1.num).toBe(1);
    expect(n2.num).toBe(2);
    expect(mgr.count()).toBe(2);
  });

  it("removes notes by number", () => {
    const mgr = new StickyManager();
    mgr.add("a");
    mgr.add("b");
    expect(mgr.remove(1)).toBe(true);
    expect(mgr.count()).toBe(1);
    expect(mgr.list()[0].text).toBe("b");
  });

  it("returns false when removing non-existent note", () => {
    const mgr = new StickyManager();
    expect(mgr.remove(999)).toBe(false);
  });

  it("formats notes for model injection", () => {
    const mgr = new StickyManager();
    mgr.add("remember this");
    const formatted = mgr.formatForModel();
    expect(formatted).toContain("STICKY NOTES");
    expect(formatted).toContain("[1] remember this");
  });

  it("returns null when no notes", () => {
    const mgr = new StickyManager();
    expect(mgr.formatForModel()).toBeNull();
  });

  it("lists are copies (not internal array)", () => {
    const mgr = new StickyManager();
    mgr.add("test");
    const list = mgr.list();
    list.pop();
    expect(mgr.count()).toBe(1); // original not affected
  });

  it("enforces max 20 notes", () => {
    const mgr = new StickyManager();
    for (let i = 0; i < 20; i++) {
      mgr.add(`note ${i}`);
    }
    expect(mgr.count()).toBe(20);
    expect(() => mgr.add("one too many")).toThrow("Maximum of 20");
  });

  it("sets createdAt timestamp", () => {
    const mgr = new StickyManager();
    const before = Date.now();
    const note = mgr.add("test");
    expect(note.createdAt).toBeGreaterThanOrEqual(before);
    expect(note.createdAt).toBeLessThanOrEqual(Date.now());
  });
});
