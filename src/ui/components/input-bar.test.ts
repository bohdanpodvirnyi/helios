import { describe, it, expect } from "vitest";

/**
 * Pure-logic tests for InputBar keyboard handling.
 *
 * Since the component is an Ink/React component that uses useInput,
 * we replicate the key logic as pure functions and test them directly.
 */

// ─── Cursor Movement Logic ──────────────────────────────

function cursorRight(cursorPos: number, valueLen: number): number {
  return Math.min(cursorPos + 1, valueLen);
}

function cursorLeft(cursorPos: number): number {
  return Math.max(cursorPos - 1, 0);
}

function cursorHome(): number {
  return 0;
}

function cursorEnd(valueLen: number): number {
  return valueLen;
}

// ─── Text Editing Logic ─────────────────────────────────

function insertChar(value: string, cursorPos: number, char: string): { value: string; cursor: number } {
  return {
    value: value.slice(0, cursorPos) + char + value.slice(cursorPos),
    cursor: cursorPos + char.length,
  };
}

function backspace(value: string, cursorPos: number): { value: string; cursor: number } {
  if (cursorPos <= 0) return { value, cursor: cursorPos };
  return {
    value: value.slice(0, cursorPos - 1) + value.slice(cursorPos),
    cursor: cursorPos - 1,
  };
}

function deleteChar(value: string, cursorPos: number): { value: string; cursor: number } {
  // The component actually treats delete the same as backspace (see line 72-79)
  if (cursorPos <= 0) return { value, cursor: cursorPos };
  return {
    value: value.slice(0, cursorPos - 1) + value.slice(cursorPos),
    cursor: cursorPos - 1,
  };
}

function clearLine(): { value: string; cursor: number } {
  return { value: "", cursor: 0 };
}

function deleteWordBackward(value: string, cursorPos: number): { value: string; cursor: number } {
  const before = value.slice(0, cursorPos);
  const after = value.slice(cursorPos);
  const trimmed = before.replace(/\S+\s*$/, "");
  return { value: trimmed + after, cursor: trimmed.length };
}

// ─── History Navigation Logic ───────────────────────────

const HISTORY_MAX = 50;

function historyUp(
  history: string[],
  historyIdx: number,
): { historyIdx: number; value: string; cursor: number } | null {
  if (history.length === 0) return null;
  const newIdx = Math.min(historyIdx + 1, history.length - 1);
  return {
    historyIdx: newIdx,
    value: history[newIdx],
    cursor: history[newIdx].length,
  };
}

function historyDown(
  history: string[],
  historyIdx: number,
): { historyIdx: number; value: string; cursor: number } {
  if (historyIdx <= 0) {
    return { historyIdx: -1, value: "", cursor: 0 };
  }
  const newIdx = historyIdx - 1;
  return {
    historyIdx: newIdx,
    value: history[newIdx],
    cursor: history[newIdx].length,
  };
}

function addToHistory(history: string[], entry: string): string[] {
  return [entry, ...history].slice(0, HISTORY_MAX);
}

// ─── Command Autocomplete Logic ─────────────────────────

interface SlashCommand {
  name: string;
  args?: string;
  description: string;
}

function filterCommands(commands: SlashCommand[], value: string): SlashCommand[] {
  if (!value.startsWith("/")) return [];
  if (value.includes(" ")) return [];
  const query = value.slice(1).split(" ")[0];
  if (query === "") return commands;
  return commands.filter((cmd) => cmd.name.startsWith(query));
}

function tabComplete(
  commands: SlashCommand[],
  selectedIdx: number,
): { value: string; cursor: number } | null {
  const cmd = commands[selectedIdx];
  if (!cmd) return null;
  const completed = `/${cmd.name}${cmd.args ? " " : ""}`;
  return { value: completed, cursor: completed.length };
}

function menuSelectionUp(selectedIdx: number, listLength: number): number {
  return selectedIdx > 0 ? selectedIdx - 1 : listLength - 1;
}

function menuSelectionDown(selectedIdx: number, listLength: number): number {
  return selectedIdx < listLength - 1 ? selectedIdx + 1 : 0;
}

// ─── Tests ──────────────────────────────────────────────

describe("InputBar — cursor movement", () => {
  it("right arrow moves cursor forward by 1", () => {
    expect(cursorRight(0, 5)).toBe(1);
    expect(cursorRight(3, 5)).toBe(4);
  });

  it("right arrow clamps at value length", () => {
    expect(cursorRight(5, 5)).toBe(5);
    expect(cursorRight(10, 5)).toBe(5);
  });

  it("left arrow moves cursor back by 1", () => {
    expect(cursorLeft(5)).toBe(4);
    expect(cursorLeft(1)).toBe(0);
  });

  it("left arrow clamps at 0", () => {
    expect(cursorLeft(0)).toBe(0);
  });

  it("Ctrl+A (Home) moves cursor to 0", () => {
    expect(cursorHome()).toBe(0);
  });

  it("Ctrl+E (End) moves cursor to value length", () => {
    expect(cursorEnd(10)).toBe(10);
    expect(cursorEnd(0)).toBe(0);
  });

  it("cursor stays at 0 for empty value", () => {
    expect(cursorRight(0, 0)).toBe(0);
    expect(cursorLeft(0)).toBe(0);
    expect(cursorEnd(0)).toBe(0);
  });
});

describe("InputBar — text insertion", () => {
  it("inserts character at cursor position", () => {
    const result = insertChar("hllo", 1, "e");
    expect(result.value).toBe("hello");
    expect(result.cursor).toBe(2);
  });

  it("inserts at beginning of string", () => {
    const result = insertChar("ello", 0, "h");
    expect(result.value).toBe("hello");
    expect(result.cursor).toBe(1);
  });

  it("appends at end of string", () => {
    const result = insertChar("hell", 4, "o");
    expect(result.value).toBe("hello");
    expect(result.cursor).toBe(5);
  });

  it("inserts into empty string", () => {
    const result = insertChar("", 0, "a");
    expect(result.value).toBe("a");
    expect(result.cursor).toBe(1);
  });

  it("inserts multi-char input (paste)", () => {
    const result = insertChar("hd", 1, "ello worl");
    expect(result.value).toBe("hello world");
    expect(result.cursor).toBe(10);
  });
});

describe("InputBar — backspace and delete", () => {
  it("backspace removes character before cursor", () => {
    const result = backspace("hello", 3);
    expect(result.value).toBe("helo");
    expect(result.cursor).toBe(2);
  });

  it("backspace at position 0 does nothing", () => {
    const result = backspace("hello", 0);
    expect(result.value).toBe("hello");
    expect(result.cursor).toBe(0);
  });

  it("backspace at end removes last character", () => {
    const result = backspace("hello", 5);
    expect(result.value).toBe("hell");
    expect(result.cursor).toBe(4);
  });

  it("backspace on single character yields empty string", () => {
    const result = backspace("x", 1);
    expect(result.value).toBe("");
    expect(result.cursor).toBe(0);
  });

  it("delete key (treated as backspace in component) removes char before cursor", () => {
    const result = deleteChar("hello", 3);
    expect(result.value).toBe("helo");
    expect(result.cursor).toBe(2);
  });

  it("delete at position 0 does nothing", () => {
    const result = deleteChar("hello", 0);
    expect(result.value).toBe("hello");
    expect(result.cursor).toBe(0);
  });
});

describe("InputBar — Ctrl+U (clear line)", () => {
  it("clears value and resets cursor", () => {
    const result = clearLine();
    expect(result.value).toBe("");
    expect(result.cursor).toBe(0);
  });
});

describe("InputBar — Ctrl+W (delete word backward)", () => {
  it("deletes last word", () => {
    const result = deleteWordBackward("hello world", 11);
    expect(result.value).toBe("hello ");
    expect(result.cursor).toBe(6);
  });

  it("deletes word and trailing spaces", () => {
    const result = deleteWordBackward("hello   world   ", 16);
    expect(result.value).toBe("hello   ");
    expect(result.cursor).toBe(8);
  });

  it("deletes first word when cursor at end of single word", () => {
    const result = deleteWordBackward("hello", 5);
    expect(result.value).toBe("");
    expect(result.cursor).toBe(0);
  });

  it("does nothing on empty string", () => {
    const result = deleteWordBackward("", 0);
    expect(result.value).toBe("");
    expect(result.cursor).toBe(0);
  });

  it("deletes word from middle of string", () => {
    const result = deleteWordBackward("foo bar baz", 7);
    // cursor at 7 = "foo bar", before = "foo bar", after = " baz"
    // regex removes "bar" -> "foo " + " baz" = "foo  baz"
    expect(result.value).toBe("foo  baz");
    expect(result.cursor).toBe(4);
  });

  it("handles slash commands", () => {
    const result = deleteWordBackward("/switch claude", 14);
    expect(result.value).toBe("/switch ");
    expect(result.cursor).toBe(8);
  });
});

describe("InputBar — history navigation", () => {
  const history = ["third", "second", "first"];

  it("up arrow moves to first history entry from fresh state", () => {
    const result = historyUp(history, -1);
    expect(result).not.toBeNull();
    expect(result!.historyIdx).toBe(0);
    expect(result!.value).toBe("third");
    expect(result!.cursor).toBe(5);
  });

  it("up arrow moves through history", () => {
    const result = historyUp(history, 0);
    expect(result!.historyIdx).toBe(1);
    expect(result!.value).toBe("second");
  });

  it("up arrow clamps at end of history", () => {
    const result = historyUp(history, 2);
    expect(result!.historyIdx).toBe(2);
    expect(result!.value).toBe("first");
  });

  it("up arrow returns null for empty history", () => {
    expect(historyUp([], -1)).toBeNull();
  });

  it("down arrow returns to draft from first entry", () => {
    const result = historyDown(history, 0);
    expect(result.historyIdx).toBe(-1);
    expect(result.value).toBe("");
    expect(result.cursor).toBe(0);
  });

  it("down arrow moves forward in history", () => {
    const result = historyDown(history, 2);
    expect(result.historyIdx).toBe(1);
    expect(result.value).toBe("second");
  });

  it("down arrow from draft stays at draft", () => {
    const result = historyDown(history, -1);
    expect(result.historyIdx).toBe(-1);
    expect(result.value).toBe("");
  });

  it("cursor is placed at end of history entry", () => {
    const result = historyUp(history, -1);
    expect(result!.cursor).toBe(result!.value.length);
  });
});

describe("InputBar — history storage", () => {
  it("adds entry to front of history", () => {
    const result = addToHistory(["old"], "new");
    expect(result).toEqual(["new", "old"]);
  });

  it("limits history to HISTORY_MAX (50) entries", () => {
    const history = Array.from({ length: 50 }, (_, i) => `entry${i}`);
    const result = addToHistory(history, "newest");
    expect(result.length).toBe(50);
    expect(result[0]).toBe("newest");
    expect(result[49]).toBe("entry48");
  });

  it("does not exceed 50 entries when already at max", () => {
    const history = Array.from({ length: 55 }, (_, i) => `entry${i}`);
    const result = addToHistory(history, "newest");
    expect(result.length).toBe(50);
  });

  it("works with empty history", () => {
    const result = addToHistory([], "first");
    expect(result).toEqual(["first"]);
  });
});

describe("InputBar — command autocomplete filtering", () => {
  const commands: SlashCommand[] = [
    { name: "help", description: "Show help" },
    { name: "history", description: "Show history" },
    { name: "hub", args: "<action>", description: "Hub" },
    { name: "quit", description: "Exit" },
    { name: "status", description: "Status" },
  ];

  it("returns all commands for bare slash", () => {
    const result = filterCommands(commands, "/");
    expect(result).toEqual(commands);
  });

  it("filters by prefix", () => {
    const result = filterCommands(commands, "/h");
    expect(result).toEqual([
      { name: "help", description: "Show help" },
      { name: "history", description: "Show history" },
      { name: "hub", args: "<action>", description: "Hub" },
    ]);
  });

  it("returns empty for no matches", () => {
    const result = filterCommands(commands, "/xyz");
    expect(result).toEqual([]);
  });

  it("returns empty for non-command input", () => {
    const result = filterCommands(commands, "hello");
    expect(result).toEqual([]);
  });

  it("returns empty when command has args (space present)", () => {
    const result = filterCommands(commands, "/help arg");
    expect(result).toEqual([]);
  });

  it("filters exact match", () => {
    const result = filterCommands(commands, "/quit");
    expect(result).toEqual([{ name: "quit", description: "Exit" }]);
  });

  it("returns empty for empty string", () => {
    const result = filterCommands(commands, "");
    expect(result).toEqual([]);
  });
});

describe("InputBar — tab completion", () => {
  const commands: SlashCommand[] = [
    { name: "help", description: "Show help" },
    { name: "hub", args: "<action>", description: "Hub" },
  ];

  it("completes selected command", () => {
    const result = tabComplete(commands, 0);
    expect(result).not.toBeNull();
    expect(result!.value).toBe("/help");
    expect(result!.cursor).toBe(5);
  });

  it("appends space for commands with args", () => {
    const result = tabComplete(commands, 1);
    expect(result!.value).toBe("/hub ");
    expect(result!.cursor).toBe(5);
  });

  it("returns null for invalid index", () => {
    expect(tabComplete(commands, 5)).toBeNull();
    expect(tabComplete([], 0)).toBeNull();
  });
});

describe("InputBar — menu selection wrapping", () => {
  it("up wraps from 0 to end", () => {
    expect(menuSelectionUp(0, 5)).toBe(4);
  });

  it("up decrements normally", () => {
    expect(menuSelectionUp(3, 5)).toBe(2);
  });

  it("down wraps from end to 0", () => {
    expect(menuSelectionDown(4, 5)).toBe(0);
  });

  it("down increments normally", () => {
    expect(menuSelectionDown(1, 5)).toBe(2);
  });

  it("single item: up stays at 0", () => {
    expect(menuSelectionUp(0, 1)).toBe(0);
  });

  it("single item: down stays at 0", () => {
    expect(menuSelectionDown(0, 1)).toBe(0);
  });
});
