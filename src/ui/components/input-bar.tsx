import { useState, useMemo, useRef, memo } from "react";
import { Box, Text, useInput } from "ink";
import { C, G } from "../theme.js";
import type { SlashCommand } from "../commands.js";

interface InputBarProps {
  onSubmit: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  commands?: SlashCommand[];
}

export const InputBar = memo(function InputBar({
  onSubmit,
  disabled = false,
  placeholder = "send a message...",
  commands: commandsProp,
}: InputBarProps) {
  const COMMANDS = commandsProp ?? [];
  const [value, setValue] = useState("");
  const valueRef = useRef("");
  const [cursorPos, setCursorPos] = useState(0);
  // Refs track the real-time value and cursor position across batched input
  // events. Without these, fast typing uses stale closure-captured values.
  const cursorRef = useRef(0);
  const moveCursor = (pos: number) => { cursorRef.current = pos; setCursorPos(pos); };
  const setVal = (v: string) => { valueRef.current = v; setValue(v); };
  const [history, setHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const [selectedIdx, setSelectedIdx] = useState(0);

  const isCommandMode = value.startsWith("/");
  const commandQuery = isCommandMode ? value.slice(1).split(" ")[0] : "";
  const hasArgs = isCommandMode && value.includes(" ");

  const filteredCommands = useMemo(() => {
    if (!isCommandMode || hasArgs) return [];
    if (commandQuery === "") return COMMANDS;
    return COMMANDS.filter((cmd) => cmd.name.startsWith(commandQuery));
  }, [isCommandMode, commandQuery, hasArgs]);

  const showMenu = isCommandMode && !hasArgs && filteredCommands.length > 0;

  useInput((input, key) => {
    if (disabled) return;

    const pos = cursorRef.current;

    if (key.return) {
      const trimmed = valueRef.current.trim();
      if (trimmed) {
        onSubmit(trimmed);
        setHistory((h) => [trimmed, ...h].slice(0, 50));
      }
      setVal("");
      moveCursor(0);
      setHistoryIdx(-1);
      setSelectedIdx(0);
      return;
    }

    if (key.tab && showMenu) {
      const cmd = filteredCommands[selectedIdx];
      if (cmd) {
        const completed = `/${cmd.name}${cmd.args ? " " : ""}`;
        setVal(completed);
        moveCursor(completed.length);
      }
      return;
    }

    if (key.backspace || key.delete) {
      if (pos > 0) {
        const v = valueRef.current;
        setVal(v.slice(0, pos - 1) + v.slice(pos));
        moveCursor(pos - 1);
      }
      setSelectedIdx(0);
      return;
    }

    // Left arrow
    if (key.leftArrow) {
      moveCursor(Math.max(0, pos - 1));
      return;
    }

    // Right arrow
    if (key.rightArrow) {
      moveCursor(Math.min(valueRef.current.length, pos + 1));
      return;
    }

    if (key.upArrow) {
      if (showMenu) {
        setSelectedIdx((prev) =>
          prev > 0 ? prev - 1 : filteredCommands.length - 1,
        );
      } else if (history.length > 0) {
        const newIdx = Math.min(historyIdx + 1, history.length - 1);
        setHistoryIdx(newIdx);
        setVal(history[newIdx]);
        moveCursor(history[newIdx].length);
      }
      return;
    }

    if (key.downArrow) {
      if (showMenu) {
        setSelectedIdx((prev) =>
          prev < filteredCommands.length - 1 ? prev + 1 : 0,
        );
      } else {
        if (historyIdx <= 0) {
          setHistoryIdx(-1);
          setVal("");
          moveCursor(0);
        } else {
          const newIdx = historyIdx - 1;
          setHistoryIdx(newIdx);
          setVal(history[newIdx]);
          moveCursor(history[newIdx].length);
        }
      }
      return;
    }

    // Home / Ctrl+A
    if (key.ctrl && input === "a") {
      moveCursor(0);
      return;
    }

    // End / Ctrl+E
    if (key.ctrl && input === "e") {
      moveCursor(valueRef.current.length);
      return;
    }

    // Ctrl+U — clear line
    if (key.ctrl && input === "u") {
      setVal("");
      moveCursor(0);
      return;
    }

    // Ctrl+W — delete word backward
    if (key.ctrl && input === "w") {
      const v = valueRef.current;
      const before = v.slice(0, pos);
      const after = v.slice(pos);
      const trimmed = before.replace(/\S+\s*$/, "");
      setVal(trimmed + after);
      moveCursor(trimmed.length);
      return;
    }

    if (input && !key.ctrl && !key.meta) {
      const v = valueRef.current;
      setVal(v.slice(0, pos) + input + v.slice(pos));
      moveCursor(pos + input.length);
      setHistoryIdx(-1);
      setSelectedIdx(0);
    }
  });

  return (
    <Box flexDirection="column">
      {/* Command autocomplete menu */}
      {showMenu && (
        <Box flexDirection="column" paddingX={1} paddingY={0}>
          {filteredCommands.map((cmd, i) => (
            <CommandItem
              key={cmd.name}
              command={cmd}
              selected={i === selectedIdx}
            />
          ))}
          <Text color={C.dim} dimColor>
            {"  "}↑↓ navigate{"  "}tab complete{"  "}enter run
          </Text>
        </Box>
      )}

      {/* Input line */}
      <Box paddingX={1}>
        <Text color={C.primary} bold>
          {G.active}{" "}
        </Text>
        {value ? (
          <CursorText text={value} cursorPos={cursorPos} />
        ) : (
          <Text color={C.dim} dimColor>
            {disabled ? "waiting..." : placeholder}
          </Text>
        )}
      </Box>
    </Box>
  );
});

function CursorText({ text, cursorPos }: { text: string; cursorPos: number }) {
  const before = text.slice(0, cursorPos);
  const cursor = text[cursorPos] ?? " ";
  const after = text.slice(cursorPos + 1);

  return (
    <Text>
      <Text color={C.text}>{before}</Text>
      <Text color="black" backgroundColor={C.primary}>{cursor}</Text>
      <Text color={C.text}>{after}</Text>
    </Text>
  );
}

function CommandItem({
  command,
  selected,
}: {
  command: SlashCommand;
  selected: boolean;
}) {
  const argStr = command.args ? ` ${command.args}` : "";
  return (
    <Box>
      <Text
        color={selected ? C.primary : C.dim}
        bold={selected}
      >
        {selected ? `${G.active} ` : "  "}
        /{command.name}
      </Text>
      {command.args && (
        <Text color={C.dim}>{argStr}</Text>
      )}
      <Text color={C.dim} dimColor>
        {"  "}{command.description}
      </Text>
    </Box>
  );
}
