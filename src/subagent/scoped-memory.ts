import { MemoryStore, type MemoryNode } from "../memory/memory-store.js";

/**
 * Memory wrapper for subagents. Writes are scoped under /subagents/{id}/
 * in the parent's memory. Reads check own scope first, then fall through
 * to the parent for read-only access to the broader context.
 *
 * Follows the same override pattern as GlobalMemoryRouter.
 */
export class ScopedMemoryStore extends MemoryStore {
  private parent: MemoryStore;
  private prefix: string; // e.g. "/subagents/abc123"

  constructor(parent: MemoryStore, subagentId: string) {
    // Use a dummy session ID — all actual DB ops go through `parent`
    super(`__scoped_${subagentId}__`);
    this.parent = parent;
    this.prefix = `/subagents/${subagentId}`;
  }

  private toScoped(path: string): string {
    if (path.startsWith(this.prefix)) return path;
    return this.prefix + (path.startsWith("/") ? path : "/" + path);
  }

  private isOwn(path: string): boolean {
    return path.startsWith(this.prefix + "/") || path === this.prefix || path === this.prefix + "/";
  }

  // ─── Writes always go to scoped prefix in parent ──────

  override write(path: string, gist: string, content?: string | null): void {
    this.parent.write(this.toScoped(path), gist, content);
  }

  // ─── Reads: own scope first, then parent (read-only) ──

  override read(path: string): MemoryNode | null {
    // Already a fully-qualified own path
    if (this.isOwn(path)) {
      return this.parent.read(path);
    }
    // Check scoped version first
    const scoped = this.toScoped(path);
    const own = this.parent.read(scoped);
    if (own) return { ...own, path };
    // Fall through to parent
    return this.parent.read(path);
  }

  override exists(path: string): boolean {
    if (this.isOwn(path)) return this.parent.exists(path);
    return this.parent.exists(this.toScoped(path)) || this.parent.exists(path);
  }

  // ─── Listing: merge own children + parent children ──

  override ls(dirPath = "/"): MemoryNode[] {
    if (dirPath === "/") {
      // At root: show own scoped children (remapped to /) + parent root (read-only)
      const ownNodes = this.parent.ls(this.prefix + "/").map((n) => ({
        ...n,
        path: n.path.slice(this.prefix.length),
      }));
      const parentNodes = this.parent.ls("/");
      // Merge: own nodes shadow parent nodes with same name
      const ownPaths = new Set(ownNodes.map((n) => n.path));
      const merged = [...ownNodes];
      for (const pn of parentNodes) {
        if (!ownPaths.has(pn.path)) merged.push(pn);
      }
      return merged;
    }

    if (this.isOwn(dirPath)) {
      return this.parent.ls(dirPath);
    }

    // Check scoped version first
    const scopedDir = this.toScoped(dirPath);
    const ownChildren = this.parent.ls(scopedDir);
    if (ownChildren.length > 0) {
      return ownChildren.map((n) => ({
        ...n,
        path: n.path.slice(this.prefix.length),
      }));
    }
    // Fall through to parent
    return this.parent.ls(dirPath);
  }

  override tree(dirPath = "/"): Array<{ path: string; gist: string; isDir: boolean }> {
    if (dirPath === "/") {
      const ownTree = this.parent.tree(this.prefix + "/").map((n) => ({
        ...n,
        path: n.path.slice(this.prefix.length),
      }));
      const parentTree = this.parent.tree("/");
      const ownPaths = new Set(ownTree.map((n) => n.path));
      const merged = [...ownTree];
      for (const pn of parentTree) {
        if (!ownPaths.has(pn.path)) merged.push(pn);
      }
      return merged.sort((a, b) => a.path.localeCompare(b.path));
    }

    if (this.isOwn(dirPath)) {
      return this.parent.tree(dirPath);
    }

    const scopedDir = this.toScoped(dirPath);
    const ownTree = this.parent.tree(scopedDir);
    if (ownTree.length > 0) {
      return ownTree.map((n) => ({
        ...n,
        path: n.path.slice(this.prefix.length),
      }));
    }
    return this.parent.tree(dirPath);
  }

  // ─── Deletes: only from own scope ──

  override rm(path: string): number {
    return this.parent.rm(this.toScoped(path));
  }

  override clear(): void {
    this.parent.rm(this.prefix + "/");
  }

  override count(): number {
    // Count own scoped nodes (approximation: use parent tree)
    return this.parent.tree(this.prefix + "/").length;
  }
}
