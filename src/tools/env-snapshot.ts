import type { ToolDefinition } from "../providers/types.js";
import type { RemoteExecutor } from "../remote/executor.js";
import type { MemoryStore } from "../memory/memory-store.js";
import { formatError, shellQuote } from "../ui/format.js";

interface Snapshot {
  name: string;
  machineId: string;
  capturedAt: string;
  os: string | null;
  cpu: string | null;
  memory: string | null;
  disk: string | null;
  gpu: string | null;
  cudaVersion: string | null;
  toolchains: Record<string, string>;
  gitHash: string | null;
  gitDiff: string | null;
  packages: string[] | null;
}

export function createEnvSnapshotTool(
  executor: RemoteExecutor,
  memoryStore: MemoryStore,
): ToolDefinition {
  return {
    name: "env_snapshot",
    description:
      "Capture a full environment snapshot on a machine for reproducibility. Records OS, CPU, memory, disk, GPU, available toolchains (languages, compilers, runtimes), git hash, and installed packages. Stores the snapshot in memory at /snapshots/<name>.",
    parameters: {
      type: "object",
      properties: {
        machine_id: {
          type: "string",
          description: "Machine to snapshot",
        },
        name: {
          type: "string",
          description:
            'Name for this snapshot (e.g. "baseline", "exp-03-start")',
        },
        repo_path: {
          type: "string",
          description: "Git repo path to capture commit hash from",
        },
        venv_path: {
          type: "string",
          description:
            "Path to Python venv/conda env for pip freeze (optional, for Python projects)",
        },
      },
      required: ["machine_id", "name"],
    },
    execute: async (args) => {
      const machineId = args.machine_id as string;
      const name = args.name as string;
      const repoPath = args.repo_path as string | undefined;
      const venvPath = args.venv_path as string | undefined;

      try {
        const safeExec = async (cmd: string): Promise<string | null> => {
          try {
            const result = await executor.exec(machineId, cmd);
            const output = result.stdout.trim();
            return result.exitCode === 0 && output ? output : null;
          } catch {
            return null;
          }
        };

        // Build CPU info command — try macOS sysctl first, fall back to Linux lscpu
        const cpuCmd = `sysctl -n machdep.cpu.brand_string 2>/dev/null || lscpu 2>/dev/null | head -20`;

        // Build git command
        const gitCmd = repoPath
          ? `cd ${shellQuote(repoPath)} && git rev-parse HEAD 2>/dev/null && git diff --stat 2>/dev/null`
          : null;

        // Build pip freeze command (optional, for Python projects)
        const pipCmd = venvPath
          ? `${shellQuote(venvPath)}/bin/pip freeze 2>/dev/null`
          : `pip3 freeze 2>/dev/null || pip freeze 2>/dev/null`;

        // Run all commands in parallel — system info + toolchain detection
        const [
          osOut,
          cpuOut,
          memOut,
          diskOut,
          gpuOut,
          cudaOut,
          nodeOut,
          pythonOut,
          swiftOut,
          goOut,
          rustOut,
          javaOut,
          xcodeOut,
          pipOut,
          gitOut,
        ] = await Promise.all([
          safeExec(`uname -a`),
          safeExec(cpuCmd),
          safeExec(`free -h 2>/dev/null || vm_stat 2>/dev/null`),
          safeExec(`df -h / 2>/dev/null`),
          safeExec(`nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader 2>/dev/null`),
          safeExec(`nvcc --version 2>/dev/null`),
          safeExec(`node --version 2>/dev/null`),
          safeExec(`python3 --version 2>/dev/null || python --version 2>/dev/null`),
          safeExec(`swift --version 2>/dev/null | head -1`),
          safeExec(`go version 2>/dev/null`),
          safeExec(`rustc --version 2>/dev/null`),
          safeExec(`java --version 2>/dev/null | head -1`),
          safeExec(`xcodebuild -version 2>/dev/null | head -1`),
          safeExec(pipCmd),
          gitCmd ? safeExec(gitCmd) : Promise.resolve(null),
        ]);

        // Build toolchains map
        const toolchains: Record<string, string> = {};
        if (nodeOut) toolchains.node = nodeOut.replace(/^v/, "");
        if (pythonOut) toolchains.python = pythonOut.replace(/^Python\s+/i, "");
        if (swiftOut) {
          const m = swiftOut.match(/Swift version\s+([\d.]+)/i);
          toolchains.swift = m ? m[1] : swiftOut;
        }
        if (goOut) {
          const m = goOut.match(/go([\d.]+)/);
          toolchains.go = m ? m[1] : goOut;
        }
        if (rustOut) {
          const m = rustOut.match(/rustc\s+([\d.]+)/);
          toolchains.rust = m ? m[1] : rustOut;
        }
        if (javaOut) {
          const m = javaOut.match(/([\d.]+)/);
          toolchains.java = m ? m[1] : javaOut;
        }
        if (xcodeOut) {
          const m = xcodeOut.match(/Xcode\s+([\d.]+)/);
          toolchains.xcode = m ? m[1] : xcodeOut;
        }

        // Parse packages (pip for Python projects)
        const packages = pipOut
          ? pipOut.split("\n").filter((l) => l.includes("==") || l.includes("@"))
          : null;

        // Parse CUDA version from nvcc output
        let cudaVersion: string | null = null;
        if (cudaOut) {
          const match = cudaOut.match(/release\s+([\d.]+)/);
          cudaVersion = match ? match[1] : cudaOut.split("\n").pop()?.trim() ?? null;
        }

        // Parse git hash and diff stat
        let gitHash: string | null = null;
        let gitDiff: string | null = null;
        if (gitOut) {
          const lines = gitOut.split("\n");
          gitHash = lines[0]?.trim() ?? null;
          if (lines.length > 1) {
            gitDiff = lines.slice(1).join("\n").trim() || null;
          }
        }

        // Build structured snapshot
        const snapshot: Snapshot = {
          name,
          machineId,
          capturedAt: new Date().toISOString(),
          os: osOut,
          cpu: cpuOut,
          memory: memOut,
          disk: diskOut,
          gpu: gpuOut ?? "no GPU",
          cudaVersion,
          toolchains,
          gitHash,
          gitDiff,
          packages,
        };

        // Format as readable text block
        const content = formatSnapshot(snapshot);

        // Build one-line gist summary
        const tcNames = Object.entries(snapshot.toolchains)
          .map(([k, v]) => `${k} ${v}`)
          .join(", ");
        const gpuStr =
          snapshot.gpu && snapshot.gpu !== "no GPU"
            ? snapshot.gpu.split(",")[0]?.trim()
            : "no GPU";
        const gist = `${machineId}: ${tcNames || "no toolchains"}, ${gpuStr}`;

        // Store in memory
        const memoryPath = `/snapshots/${name}`;
        memoryStore.write(memoryPath, gist, content);

        return JSON.stringify({
          summary: gist,
          memory_path: memoryPath,
          snapshot,
        });
      } catch (err) {
        return JSON.stringify({
          error: formatError(err),
          machine_id: machineId,
          name,
        });
      }
    },
  };
}

function formatSnapshot(s: Snapshot): string {
  const lines: string[] = [
    `# Environment Snapshot: ${s.name}`,
    `Machine: ${s.machineId}`,
    `Captured: ${s.capturedAt}`,
    "",
    `## OS`,
    s.os ?? "unavailable",
    "",
    `## CPU`,
    s.cpu ?? "unavailable",
    "",
    `## Memory`,
    s.memory ?? "unavailable",
    "",
    `## Disk`,
    s.disk ?? "unavailable",
    "",
    `## GPU`,
    s.gpu ?? "no GPU",
  ];

  if (s.cudaVersion) {
    lines.push("", `## CUDA`, s.cudaVersion);
  }

  // Toolchains
  const tcEntries = Object.entries(s.toolchains);
  if (tcEntries.length > 0) {
    lines.push("", `## Toolchains`);
    for (const [name, version] of tcEntries) {
      lines.push(`${name}: ${version}`);
    }
  } else {
    lines.push("", `## Toolchains`, "none detected");
  }

  if (s.gitHash) {
    lines.push("", `## Git`, `Commit: ${s.gitHash}`);
    if (s.gitDiff) {
      lines.push(`Uncommitted changes:`, s.gitDiff);
    }
  }

  if (s.packages && s.packages.length > 0) {
    lines.push("", `## Packages (${s.packages.length})`, ...s.packages);
  }

  return lines.join("\n");
}
