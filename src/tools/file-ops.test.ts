import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  createReadFileTool,
  createWriteFileTool,
  createPatchFileTool,
} from "./file-ops.js";

// ---------------------------------------------------------------------------
// Mock ConnectionPool
// ---------------------------------------------------------------------------

type ExecHandler = (
  machineId: string,
  command: string,
  opts?: any,
) => { stdout: string; stderr: string; exitCode: number };

function mockPool(handler?: ExecHandler) {
  return {
    exec: vi.fn(
      async (machineId: string, command: string, opts?: any) => {
        if (handler) return handler(machineId, command, opts);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
    ),
  } as any;
}

function parse(json: string): any {
  return JSON.parse(json);
}

// ---------------------------------------------------------------------------
// read_file
// ---------------------------------------------------------------------------

describe("read_file", () => {
  it("reads text file with offset and limit", async () => {
    const pool = mockPool((_, cmd) => {
      // Combined command: sed + delimiter + wc -l in one SSH call
      if (cmd.includes("sed") && cmd.includes("HELIOS_LINECOUNT")) {
        return { stdout: "line1\nline2\n---HELIOS_LINECOUNT---\n10\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const tool = createReadFileTool(pool);

    const result = parse(await tool.execute({ machine_id: "local", path: "/tmp/test.py", offset: 1, limit: 5 }));
    expect(result.content).toBe("line1\nline2\n");
    expect(result.lines.total).toBe(10);
  });

  it("defaults to offset 1, limit 200", async () => {
    const pool = mockPool((_, cmd) => {
      if (cmd.includes("sed")) {
        // Verify the command uses sed -n '1,200p'
        expect(cmd).toContain("1,200p");
        return { stdout: "content\n---HELIOS_LINECOUNT---\n50\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const tool = createReadFileTool(pool);

    await tool.execute({ machine_id: "local", path: "/tmp/test.py" });
  });

  it("returns total line count", async () => {
    const pool = mockPool((_, cmd) => {
      if (cmd.includes("sed")) {
        return { stdout: "data\n---HELIOS_LINECOUNT---\n42\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const tool = createReadFileTool(pool);

    const result = parse(await tool.execute({ machine_id: "local", path: "/tmp/test.py" }));
    expect(result.lines.total).toBe(42);
  });

  it("reads image file as base64 multimodal", async () => {
    const pool = mockPool((_, cmd) => {
      if (cmd.includes("wc -c")) return { stdout: "1024\n", stderr: "", exitCode: 0 };
      if (cmd.includes("base64")) return { stdout: "AQID\n", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const tool = createReadFileTool(pool);

    const result = parse(await tool.execute({ machine_id: "local", path: "/tmp/img.png" }));
    expect(result.__multimodal).toBe(true);
    expect(result.attachments).toHaveLength(1);
    expect(result.attachments[0].mediaType).toBe("image/png");
    expect(result.attachments[0].data).toBe("AQID");
  });

  it("reads PDF file as base64 multimodal", async () => {
    const pool = mockPool((_, cmd) => {
      if (cmd.includes("wc -c")) return { stdout: "2048\n", stderr: "", exitCode: 0 };
      if (cmd.includes("base64")) return { stdout: "PDFDATA\n", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const tool = createReadFileTool(pool);

    const result = parse(await tool.execute({ machine_id: "local", path: "/tmp/doc.pdf" }));
    expect(result.__multimodal).toBe(true);
    expect(result.attachments[0].mediaType).toBe("application/pdf");
    expect(result.text).toContain("PDF");
  });

  it("rejects oversized binary files (>10MB)", async () => {
    const pool = mockPool((_, cmd) => {
      if (cmd.includes("wc -c")) return { stdout: "15000000\n", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const tool = createReadFileTool(pool);

    const result = parse(await tool.execute({ machine_id: "local", path: "/tmp/big.png" }));
    expect(result.error).toBeDefined();
    expect(result.error).toContain("too large");
  });

  it("handles file not found error", async () => {
    const pool = mockPool((_, cmd) => {
      if (cmd.includes("sed")) return { stdout: "", stderr: "No such file or directory", exitCode: 1 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const tool = createReadFileTool(pool);

    const result = parse(await tool.execute({ machine_id: "local", path: "/tmp/nope.py" }));
    expect(result.error).toBeDefined();
    expect(result.error).toContain("No such file");
  });

  it("handles empty file", async () => {
    const pool = mockPool((_, cmd) => {
      if (cmd.includes("sed")) return { stdout: "", stderr: "", exitCode: 0 };
      if (cmd.includes("wc")) return { stdout: "0\n", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const tool = createReadFileTool(pool);

    const result = parse(await tool.execute({ machine_id: "local", path: "/tmp/empty.py" }));
    expect(result.content).toBe("");
    expect(result.lines.total).toBe(0);
  });

  it("returns proper MIME types for .png", async () => {
    const pool = mockPool((_, cmd) => {
      if (cmd.includes("wc -c")) return { stdout: "100\n", stderr: "", exitCode: 0 };
      if (cmd.includes("base64")) return { stdout: "AA==\n", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const tool = createReadFileTool(pool);

    const result = parse(await tool.execute({ machine_id: "local", path: "/tmp/test.png" }));
    expect(result.attachments[0].mediaType).toBe("image/png");
  });

  it("returns proper MIME types for .jpg", async () => {
    const pool = mockPool((_, cmd) => {
      if (cmd.includes("wc -c")) return { stdout: "100\n", stderr: "", exitCode: 0 };
      if (cmd.includes("base64")) return { stdout: "AA==\n", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const tool = createReadFileTool(pool);

    const result = parse(await tool.execute({ machine_id: "local", path: "/tmp/photo.jpg" }));
    expect(result.attachments[0].mediaType).toBe("image/jpeg");
  });

  it("returns proper MIME types for .jpeg", async () => {
    const pool = mockPool((_, cmd) => {
      if (cmd.includes("wc -c")) return { stdout: "100\n", stderr: "", exitCode: 0 };
      if (cmd.includes("base64")) return { stdout: "AA==\n", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const tool = createReadFileTool(pool);

    const result = parse(await tool.execute({ machine_id: "local", path: "/tmp/photo.jpeg" }));
    expect(result.attachments[0].mediaType).toBe("image/jpeg");
  });

  it("returns proper MIME types for .gif", async () => {
    const pool = mockPool((_, cmd) => {
      if (cmd.includes("wc -c")) return { stdout: "100\n", stderr: "", exitCode: 0 };
      if (cmd.includes("base64")) return { stdout: "AA==\n", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const tool = createReadFileTool(pool);

    const result = parse(await tool.execute({ machine_id: "local", path: "/tmp/anim.gif" }));
    expect(result.attachments[0].mediaType).toBe("image/gif");
  });

  it("returns proper MIME types for .webp", async () => {
    const pool = mockPool((_, cmd) => {
      if (cmd.includes("wc -c")) return { stdout: "100\n", stderr: "", exitCode: 0 };
      if (cmd.includes("base64")) return { stdout: "AA==\n", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const tool = createReadFileTool(pool);

    const result = parse(await tool.execute({ machine_id: "local", path: "/tmp/pic.webp" }));
    expect(result.attachments[0].mediaType).toBe("image/webp");
  });

  it("validates safe offset (Math.max(1, ...))", async () => {
    const pool = mockPool((_, cmd) => {
      if (cmd.includes("sed")) {
        // With offset=0, safeOffset should be 1
        expect(cmd).toContain("'1,");
        return { stdout: "data\n", stderr: "", exitCode: 0 };
      }
      if (cmd.includes("wc")) return { stdout: "10\n", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const tool = createReadFileTool(pool);

    await tool.execute({ machine_id: "local", path: "/tmp/test.py", offset: 0, limit: 5 });
  });

  it("returns correct multimodal JSON structure", async () => {
    const pool = mockPool((_, cmd) => {
      if (cmd.includes("wc -c")) return { stdout: "5000\n", stderr: "", exitCode: 0 };
      if (cmd.includes("base64")) return { stdout: "abc123\n", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const tool = createReadFileTool(pool);

    const result = parse(await tool.execute({ machine_id: "local", path: "/tmp/img.png" }));
    expect(result).toHaveProperty("__multimodal", true);
    expect(result).toHaveProperty("text");
    expect(result).toHaveProperty("attachments");
    expect(result.text).toContain("Image");
    expect(result.text).toContain("img.png");
    expect(result.text).toContain("KB");
  });

  it("handles empty binary file", async () => {
    const pool = mockPool((_, cmd) => {
      if (cmd.includes("wc -c")) return { stdout: "0\n", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const tool = createReadFileTool(pool);

    const result = parse(await tool.execute({ machine_id: "local", path: "/tmp/empty.png" }));
    expect(result.error).toBeDefined();
  });

  it("handles binary file not found", async () => {
    const pool = mockPool((_, cmd) => {
      if (cmd.includes("wc -c")) return { stdout: "", stderr: "No such file", exitCode: 1 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const tool = createReadFileTool(pool);

    const result = parse(await tool.execute({ machine_id: "local", path: "/tmp/missing.png" }));
    expect(result.error).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// write_file
// ---------------------------------------------------------------------------

describe("write_file", () => {
  it("writes content to file", async () => {
    const pool = mockPool((_, cmd) => {
      if (cmd.includes("wc")) return { stdout: "5\n", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const tool = createWriteFileTool(pool);

    const result = parse(await tool.execute({
      machine_id: "local",
      path: "/tmp/out.py",
      content: "print('hello')\n",
    }));
    expect(result.written).toBe("/tmp/out.py");
  });

  it("creates parent directory", async () => {
    const commands: string[] = [];
    const pool = mockPool((_, cmd) => {
      commands.push(cmd);
      if (cmd.includes("wc")) return { stdout: "1\n", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const tool = createWriteFileTool(pool);

    await tool.execute({
      machine_id: "local",
      path: "/tmp/new/dir/file.py",
      content: "x = 1\n",
    });
    expect(commands.some((c) => c.includes("mkdir -p"))).toBe(true);
  });

  it("uses heredoc for safe content", async () => {
    const commands: string[] = [];
    const pool = mockPool((_, cmd) => {
      commands.push(cmd);
      if (cmd.includes("wc")) return { stdout: "3\n", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const tool = createWriteFileTool(pool);

    await tool.execute({
      machine_id: "local",
      path: "/tmp/out.py",
      content: "line1\nline2\n",
    });
    expect(commands.some((c) => c.includes("_HELIOS_EOF_"))).toBe(true);
  });

  it("supports append mode", async () => {
    const commands: string[] = [];
    const pool = mockPool((_, cmd) => {
      commands.push(cmd);
      if (cmd.includes("wc")) return { stdout: "10\n", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const tool = createWriteFileTool(pool);

    await tool.execute({
      machine_id: "local",
      path: "/tmp/log.txt",
      content: "new line\n",
      append: true,
    });
    expect(commands.some((c) => c.includes(">>"))).toBe(true);
  });

  it("returns line count", async () => {
    const pool = mockPool((_, cmd) => {
      if (cmd.includes("wc")) return { stdout: "15\n", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const tool = createWriteFileTool(pool);

    const result = parse(await tool.execute({
      machine_id: "local",
      path: "/tmp/out.py",
      content: "content\n",
    }));
    expect(result.lines).toBe(15);
  });

  it("handles write error", async () => {
    const pool = mockPool((_, cmd) => {
      if (cmd.includes("cat")) return { stdout: "", stderr: "Permission denied", exitCode: 1 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const tool = createWriteFileTool(pool);

    const result = parse(await tool.execute({
      machine_id: "local",
      path: "/root/nope.py",
      content: "x = 1\n",
    }));
    expect(result.error).toBeDefined();
    expect(result.error).toContain("Permission denied");
  });

  it("strips trailing newline to avoid doubling", async () => {
    const commands: string[] = [];
    const pool = mockPool((_, cmd) => {
      commands.push(cmd);
      if (cmd.includes("wc")) return { stdout: "3\n", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const tool = createWriteFileTool(pool);

    await tool.execute({
      machine_id: "local",
      path: "/tmp/out.py",
      content: "line1\nline2\n",
    });
    // The heredoc body should strip the trailing newline
    const catCmd = commands.find((c) => c.includes("_HELIOS_EOF_"));
    expect(catCmd).toBeDefined();
    // Body should be "line1\nline2" not "line1\nline2\n"
    const bodyMatch = catCmd!.match(/<<'_HELIOS_EOF_[^']*'\n([\s\S]*)\n_HELIOS_EOF_/);
    expect(bodyMatch).not.toBeNull();
    expect(bodyMatch![1]).toBe("line1\nline2");
  });

  it("uses overwrite mode by default", async () => {
    const commands: string[] = [];
    const pool = mockPool((_, cmd) => {
      commands.push(cmd);
      if (cmd.includes("wc")) return { stdout: "1\n", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const tool = createWriteFileTool(pool);

    await tool.execute({
      machine_id: "local",
      path: "/tmp/out.py",
      content: "x",
    });
    const catCmd = commands.find((c) => c.includes("_HELIOS_EOF_"));
    // Should use ">" not ">>"
    expect(catCmd).toContain("> ");
    expect(catCmd).not.toContain(">>");
  });

  it("handles content without trailing newline", async () => {
    const commands: string[] = [];
    const pool = mockPool((_, cmd) => {
      commands.push(cmd);
      if (cmd.includes("wc")) return { stdout: "1\n", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const tool = createWriteFileTool(pool);

    await tool.execute({
      machine_id: "local",
      path: "/tmp/out.py",
      content: "no newline at end",
    });
    // Should not strip anything since there's no trailing newline
    const catCmd = commands.find((c) => c.includes("_HELIOS_EOF_"));
    expect(catCmd).toContain("no newline at end");
  });

  it("does not mkdir when path has no parent", async () => {
    const commands: string[] = [];
    const pool = mockPool((_, cmd) => {
      commands.push(cmd);
      if (cmd.includes("wc")) return { stdout: "1\n", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const tool = createWriteFileTool(pool);

    await tool.execute({
      machine_id: "local",
      path: "/file.py",
      content: "x",
    });
    // dir would be "" for "/file.py" -> no mkdir
    // The mkdir command should not be called since dir is empty
    expect(commands.filter((c) => c.includes("mkdir")).length).toBe(0);
  });

  it("passes machine_id to pool.exec", async () => {
    const pool = mockPool((_, cmd) => {
      if (cmd.includes("wc")) return { stdout: "1\n", stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const tool = createWriteFileTool(pool);

    await tool.execute({
      machine_id: "gpu-1",
      path: "/tmp/out.py",
      content: "x",
    });
    expect(pool.exec).toHaveBeenCalledWith("gpu-1", expect.any(String));
  });
});

// ---------------------------------------------------------------------------
// patch_file
// ---------------------------------------------------------------------------

describe("patch_file", () => {
  it("replaces matching string", async () => {
    let writtenContent = "";
    const pool = mockPool((_, cmd) => {
      if (cmd.includes("cat") && !cmd.includes("<<")) {
        return { stdout: "hello world\n", stderr: "", exitCode: 0 };
      }
      if (cmd.includes("<<")) {
        // Capture the written content from the heredoc
        const match = cmd.match(/<<'[^']+'\n([\s\S]*)\n[^\n]+$/);
        if (match) writtenContent = match[1];
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const tool = createPatchFileTool(pool);

    const result = parse(await tool.execute({
      machine_id: "local",
      path: "/tmp/test.py",
      old_string: "hello",
      new_string: "goodbye",
    }));
    expect(result.patched).toBe("/tmp/test.py");
    expect(writtenContent).toContain("goodbye");
    expect(writtenContent).not.toContain("hello");
  });

  it("rejects when old_string not found", async () => {
    const pool = mockPool((_, cmd) => {
      if (cmd.includes("cat") && !cmd.includes("<<")) {
        return { stdout: "totally different content\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const tool = createPatchFileTool(pool);

    const result = parse(await tool.execute({
      machine_id: "local",
      path: "/tmp/test.py",
      old_string: "nonexistent string",
      new_string: "replacement",
    }));
    expect(result.error).toBeDefined();
    expect(result.error).toContain("not found");
  });

  it("rejects when old_string found multiple times", async () => {
    const pool = mockPool((_, cmd) => {
      if (cmd.includes("cat") && !cmd.includes("<<")) {
        return { stdout: "hello hello hello\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const tool = createPatchFileTool(pool);

    const result = parse(await tool.execute({
      machine_id: "local",
      path: "/tmp/test.py",
      old_string: "hello",
      new_string: "goodbye",
    }));
    expect(result.error).toBeDefined();
    expect(result.error).toContain("3 times");
    expect(result.error).toContain("unique");
  });

  it("reads file first, then writes back", async () => {
    const callOrder: string[] = [];
    const pool = mockPool((_, cmd) => {
      if (cmd.includes("cat") && !cmd.includes("<<")) {
        callOrder.push("read");
        return { stdout: "original content\n", stderr: "", exitCode: 0 };
      }
      if (cmd.includes("<<")) {
        callOrder.push("write");
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const tool = createPatchFileTool(pool);

    await tool.execute({
      machine_id: "local",
      path: "/tmp/test.py",
      old_string: "original",
      new_string: "updated",
    });
    expect(callOrder).toEqual(["read", "write"]);
  });

  it("handles special characters in old_string", async () => {
    const pool = mockPool((_, cmd) => {
      if (cmd.includes("cat") && !cmd.includes("<<")) {
        return { stdout: "x = {'key': \"value\"}\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const tool = createPatchFileTool(pool);

    const result = parse(await tool.execute({
      machine_id: "local",
      path: "/tmp/test.py",
      old_string: "{'key': \"value\"}",
      new_string: "{'key': \"new_value\"}",
    }));
    expect(result.patched).toBe("/tmp/test.py");
  });

  it("returns patched filename", async () => {
    const pool = mockPool((_, cmd) => {
      if (cmd.includes("cat") && !cmd.includes("<<")) {
        return { stdout: "abc def\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const tool = createPatchFileTool(pool);

    const result = parse(await tool.execute({
      machine_id: "local",
      path: "/home/user/script.py",
      old_string: "abc",
      new_string: "xyz",
    }));
    expect(result.patched).toBe("/home/user/script.py");
  });

  it("handles read error", async () => {
    const pool = mockPool((_, cmd) => {
      if (cmd.includes("cat") && !cmd.includes("<<")) {
        return { stdout: "", stderr: "Permission denied", exitCode: 1 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const tool = createPatchFileTool(pool);

    const result = parse(await tool.execute({
      machine_id: "local",
      path: "/tmp/test.py",
      old_string: "x",
      new_string: "y",
    }));
    expect(result.error).toBeDefined();
    expect(result.error).toContain("Permission denied");
  });

  it("handles write error", async () => {
    const pool = mockPool((_, cmd) => {
      if (cmd.includes("cat") && !cmd.includes("<<")) {
        return { stdout: "find me\n", stderr: "", exitCode: 0 };
      }
      if (cmd.includes("<<")) {
        return { stdout: "", stderr: "Disk full", exitCode: 1 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const tool = createPatchFileTool(pool);

    const result = parse(await tool.execute({
      machine_id: "local",
      path: "/tmp/test.py",
      old_string: "find me",
      new_string: "replace me",
    }));
    expect(result.error).toBeDefined();
    expect(result.error).toContain("Disk full");
  });

  it("handles multiline patches", async () => {
    const pool = mockPool((_, cmd) => {
      if (cmd.includes("cat") && !cmd.includes("<<")) {
        return {
          stdout: "def hello():\n    return 'world'\n",
          stderr: "",
          exitCode: 0,
        };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const tool = createPatchFileTool(pool);

    const result = parse(await tool.execute({
      machine_id: "local",
      path: "/tmp/test.py",
      old_string: "def hello():\n    return 'world'",
      new_string: "def hello():\n    return 'universe'",
    }));
    expect(result.patched).toBe("/tmp/test.py");
  });

  it("uses heredoc for writing patched content", async () => {
    const commands: string[] = [];
    const pool = mockPool((_, cmd) => {
      commands.push(cmd);
      if (cmd.includes("cat") && !cmd.includes("<<")) {
        return { stdout: "old text here\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const tool = createPatchFileTool(pool);

    await tool.execute({
      machine_id: "local",
      path: "/tmp/test.py",
      old_string: "old text",
      new_string: "new text",
    });
    expect(commands.some((c) => c.includes("_HELIOS_EOF_"))).toBe(true);
  });

  it("passes machine_id correctly", async () => {
    const pool = mockPool((_, cmd) => {
      if (cmd.includes("cat") && !cmd.includes("<<")) {
        return { stdout: "content\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const tool = createPatchFileTool(pool);

    await tool.execute({
      machine_id: "gpu-2",
      path: "/tmp/test.py",
      old_string: "content",
      new_string: "updated",
    });
    // All calls should use "gpu-2"
    for (const call of pool.exec.mock.calls) {
      expect(call[0]).toBe("gpu-2");
    }
  });

  it("strips trailing newline from patched content before writing", async () => {
    const commands: string[] = [];
    const pool = mockPool((_, cmd) => {
      commands.push(cmd);
      if (cmd.includes("cat") && !cmd.includes("<<")) {
        return { stdout: "alpha beta\n", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const tool = createPatchFileTool(pool);

    await tool.execute({
      machine_id: "local",
      path: "/tmp/test.py",
      old_string: "alpha",
      new_string: "gamma",
    });

    const writeCmd = commands.find((c) => c.includes("_HELIOS_EOF_"));
    expect(writeCmd).toBeDefined();
    // The body should be "gamma beta" (trailing newline stripped)
    const bodyMatch = writeCmd!.match(/<<'_HELIOS_EOF_[^']*'\n([\s\S]*)\n_HELIOS_EOF_/);
    expect(bodyMatch).not.toBeNull();
    expect(bodyMatch![1]).toBe("gamma beta");
  });
});
