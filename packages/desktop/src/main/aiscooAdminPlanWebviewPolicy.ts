import { randomUUID } from "node:crypto";

export interface NativePlanWebviewOwner {
  origin: string;
  ownerGeneration: number;
}

// XCODE: Main admits a short URL only for the owner reported by the trusted Host.
export class AiscooAdminPlanWebviewPolicy {
  private owner: NativePlanWebviewOwner | null = null;
  private handoff: { url: string; ownerGeneration: number } | null = null;
  private readonly views = new Map<
    string,
    { url: string; owner: NativePlanWebviewOwner; attached: boolean }
  >();

  setOwner(owner: NativePlanWebviewOwner | null): string[] {
    if (
      this.owner?.origin === owner?.origin &&
      this.owner?.ownerGeneration === owner?.ownerGeneration
    )
      return [];
    const partitions = [...this.views.keys()];
    this.views.clear();
    this.handoff = null;
    this.owner = owner;
    return partitions;
  }

  authorize(request: { url: string; ownerGeneration: number }): boolean {
    const owner = this.owner;
    if (!owner || request.ownerGeneration !== owner.ownerGeneration) return false;
    const url = this.parse(request.url, owner.origin);
    if (!url || url.searchParams.size !== 1 || !url.searchParams.get("handoff")) return false;
    this.handoff = { url: url.href, ownerGeneration: request.ownerGeneration };
    return true;
  }

  prepare(request: { url: string; ownerGeneration: number }): { partition: string } {
    const owner = this.owner;
    if (!owner || request.ownerGeneration !== owner.ownerGeneration)
      throw new Error("XCODE_STALE_WEB_HANDOFF");
    const url = this.parse(request.url, owner.origin);
    if (!url || url.searchParams.size !== 1 || !url.searchParams.get("handoff"))
      throw new Error("XCODE_INVALID_WEB_HANDOFF");
    if (this.handoff?.url !== url.href || this.handoff.ownerGeneration !== request.ownerGeneration)
      throw new Error("XCODE_STALE_WEB_HANDOFF");
    this.handoff = null;
    const partition = `xcode-native-plan:${owner.ownerGeneration}:${randomUUID()}`;
    this.views.set(partition, { url: url.href, owner, attached: false });
    return { partition };
  }

  canAttach(partition: string, url: string): boolean {
    const view = this.views.get(partition);
    return Boolean(view && !view.attached && this.isCurrent(view.owner) && url === view.url);
  }

  claim(partition: string, url: string): boolean {
    if (!this.canAttach(partition, url)) return false;
    this.views.get(partition)!.attached = true;
    return true;
  }

  canNavigate(partition: string, value: string): boolean {
    const view = this.views.get(partition);
    if (!view || !this.isCurrent(view.owner)) return false;
    const url = this.parse(value, view.owner.origin);
    return Boolean(url && (url.search === "" || url.href === view.url));
  }

  canRequest(partition: string, value: string, isMainFrame: boolean): boolean {
    const view = this.views.get(partition);
    if (!view?.attached || !this.isCurrent(view.owner)) return false;
    if (isMainFrame) return this.canNavigate(partition, value);
    try {
      const url = new URL(value);
      if (url.origin !== view.owner.origin || url.username || url.password) return false;
      const path = decodeURIComponent(url.pathname);
      // XCODE: 同源 fetch/子 frame 也不能用别人的交接码覆盖当前 owner 的只读 Cookie。
      if (path === "/xcode/plans" || path.startsWith("/xcode/plans/"))
        return this.canNavigate(partition, value);
      // XCODE: Only the exact bootstrap root script joins same-origin viewer/API and build assets.
      if (url.hash) return false;
      if (path === "/xcode-plan-display.js") return url.pathname === path && url.search === "";
      return (
        path === "/api/xcode/v1/web/view" ||
        path.startsWith("/assets/") ||
        path.startsWith("/fonts/") ||
        path.startsWith("/static/js/") ||
        path.startsWith("/static/css/") ||
        path.startsWith("/static/font/") ||
        path.startsWith("/static/image/") ||
        path.startsWith("/static/svg/") ||
        path === "/favicon.ico"
      );
    } catch {
      return false;
    }
  }

  close(partition: string): boolean {
    return this.views.delete(partition);
  }

  private isCurrent(owner: NativePlanWebviewOwner): boolean {
    return (
      this.owner?.origin === owner.origin && this.owner?.ownerGeneration === owner.ownerGeneration
    );
  }

  private parse(value: string, origin: string): URL | null {
    try {
      const url = new URL(value);
      if (
        url.origin !== origin ||
        url.username ||
        url.password ||
        url.hash ||
        url.pathname !== "/xcode/plans"
      )
        return null;
      return url;
    } catch {
      return null;
    }
  }
}
