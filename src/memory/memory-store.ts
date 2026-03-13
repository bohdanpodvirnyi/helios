import { StmtCache } from "../store/database.js";

export interface MemoryNode {
  path: string;
  gist: string;
  content: string | null;
  isDir: boolean;
  createdAt: number;
  updatedAt: number;
}

export class MemoryStore {
  private sessionId: string;
  private stmts = new StmtCache();
  private stmt(sql: string) { return this.stmts.stmt(sql); }

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  setSession(sessionId: string): void {
    this.sessionId = sessionId;
  }

  /** List children of a directory path. */
  ls(dirPath = "/"): MemoryNode[] {
    const normalized = normalizeDirPath(validatePath(dirPath));
    const prefixLen = normalized.length;

    // Fetch all descendants, filter to direct children in JS (simple and correct)
    // Only fetches gist-level columns to keep it lightweight (no content)
    const rows = this.stmt(
        `SELECT path, gist, is_dir, created_at, updated_at
         FROM memory_nodes
         WHERE session_id = ? AND path LIKE ? AND path != ?`,
      )
      .all(this.sessionId, normalized + "%", normalized) as Record<string, unknown>[];

    return rows
      .filter((row) => {
        const rel = (row.path as string).slice(prefixLen);
        return !rel.includes("/") || (rel.endsWith("/") && !rel.slice(0, -1).includes("/"));
      })
      .map(rowToNode);
  }

  /** Recursively list all nodes under a path, returning paths + gists only. */
  tree(dirPath = "/"): Array<{ path: string; gist: string; isDir: boolean }> {
    const normalized = normalizeDirPath(validatePath(dirPath));

    const rows = this.stmt(
        `SELECT path, gist, is_dir
         FROM memory_nodes
         WHERE session_id = ? AND path LIKE ? AND path != ?
         ORDER BY path`,
      )
      .all(this.sessionId, normalized + "%", normalized) as Record<string, unknown>[];

    return rows.map((row) => ({
      path: row.path as string,
      gist: row.gist as string,
      isDir: (row.is_dir as number) === 1,
    }));
  }

  /** Read a node's full content. */
  read(path: string): MemoryNode | null {
    path = validatePath(path);
    const row = this.stmt(
        `SELECT path, gist, content, is_dir, created_at, updated_at
         FROM memory_nodes
         WHERE session_id = ? AND path = ?`,
      )
      .get(this.sessionId, path) as Record<string, unknown> | undefined;

    return row ? rowToNode(row) : null;
  }

  /** Write or update a node. Auto-creates parent directories. */
  write(path: string, gist: string, content?: string | null): void {
    path = validatePath(path);
    const now = Date.now();
    const isDir = content === undefined || content === null;

    // Auto-create parent directories
    this.ensureParents(path);

    this.stmt(
      `INSERT INTO memory_nodes (session_id, path, gist, content, is_dir, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, path) DO UPDATE SET
         gist = excluded.gist,
         content = excluded.content,
         is_dir = excluded.is_dir,
         updated_at = excluded.updated_at`,
    ).run(this.sessionId, path, gist, isDir ? null : content, isDir ? 1 : 0, now, now);
  }

  /** Remove a node and all children (if directory). */
  rm(path: string): number {
    path = validatePath(path);

    // Delete exact match + any children
    const result = this.stmt(
        `DELETE FROM memory_nodes
         WHERE session_id = ? AND (path = ? OR path LIKE ?)`,
      )
      .run(this.sessionId, path, path.endsWith("/") ? path + "%" : path + "/%");

    return result.changes;
  }

  /** Check if a path exists. */
  exists(path: string): boolean {
    path = validatePath(path);
    const row = this.stmt("SELECT 1 FROM memory_nodes WHERE session_id = ? AND path = ?")
      .get(this.sessionId, path);
    return !!row;
  }

  /** Count all nodes for this session. */
  count(): number {
    const row = this.stmt("SELECT COUNT(*) as c FROM memory_nodes WHERE session_id = ?")
      .get(this.sessionId) as { c: number };
    return row.c;
  }

  /** Build a formatted tree string (paths + gists) for checkpoint briefings. */
  formatTree(dirPath = "/"): string {
    const nodes = this.tree(dirPath);
    if (nodes.length === 0) return "(empty)";

    const lines: string[] = [];
    for (const node of nodes) {
      const parts = node.path.split("/").filter(Boolean);
      const depth = parts.length - 1;
      const indent = "  ".repeat(depth);
      const name = parts[parts.length - 1] + (node.isDir ? "/" : "");
      lines.push(`${indent}${name}: ${node.gist}`);
    }
    return lines.join("\n");
  }

  /** Clear all memory for this session. */
  clear(): void {
    this.stmt("DELETE FROM memory_nodes WHERE session_id = ?").run(this.sessionId);
  }

  private ensureParents(path: string): void {
    const parts = path.split("/").filter(Boolean);
    if (parts.length <= 1) return;
    const now = Date.now();
    const parentStmt = this.stmt(
      `INSERT OR IGNORE INTO memory_nodes (session_id, path, gist, content, is_dir, created_at, updated_at)
       VALUES (?, ?, ?, NULL, 1, ?, ?)`,
    );
    // For "/a/b/c", ensure "/a/" and "/a/b/" exist
    for (let i = 1; i < parts.length; i++) {
      const parentPath = "/" + parts.slice(0, i).join("/") + "/";
      parentStmt.run(this.sessionId, parentPath, parts[i - 1], now, now);
    }
  }
}

function validatePath(path: string): string {
  if (!path.startsWith("/")) path = "/" + path;
  // Collapse repeated slashes and resolve . and ..
  const parts = path.split("/").filter(Boolean);
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === "..") {
      resolved.pop();
    } else if (part !== ".") {
      resolved.push(part);
    }
  }
  return "/" + resolved.join("/") + (path.endsWith("/") && resolved.length > 0 ? "/" : "");
}

function normalizeDirPath(path: string): string {
  if (path === "/") return "/";
  return path.endsWith("/") ? path : path + "/";
}

function rowToNode(row: Record<string, unknown>): MemoryNode {
  return {
    path: row.path as string,
    gist: row.gist as string,
    content: row.content as string | null,
    isDir: (row.is_dir as number) === 1,
    createdAt: row.created_at as number,
    updatedAt: row.updated_at as number,
  };
}
