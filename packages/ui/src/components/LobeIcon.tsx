import { useEffect, useState } from "react";
import { cn } from "@/components/lib/utils.js";

// XCODE: 与 Aiscoo 管理端 getLobeIcon 同规则解析 @lobehub/icons 图标名（如 "Claude.Color"、"OpenAI"）：
// 取首段为图标 ID，第二段为 Color 且存在彩色资源时用彩色，否则用单色。资源来自同版本图标的静态 SVG。
// 相对路径：desktop/web/vitest 的 Vite root 不同，只有相对本文件的 glob 在各端一致；依赖由 node-linker=hoisted 提升到仓库根。
// 懒加载：全部 950 个图标内联会让主包增加约 1.5MB，这里只在用到时加载单个 SVG。
const ICON_LOADERS = import.meta.glob<string>(
  "../../../../node_modules/@lobehub/icons-static-svg/icons/*.svg",
  { import: "default", query: "?url" },
);
const ICON_LOADER_BY_FILE: Record<string, () => Promise<string>> = Object.fromEntries(
  Object.entries(ICON_LOADERS).map(([path, load]) => [
    path.slice(path.lastIndexOf("/") + 1, -4),
    load,
  ]),
);

/** 解析后端图标名；未知名称返回 null，由调用方回落默认图标。 */
export function resolveLobeIcon(
  iconName: string,
): { load: () => Promise<string>; mono: boolean } | null {
  const [base, variant] = iconName.trim().split(".");
  if (!base) return null;
  const id = base.toLowerCase();
  const color = variant === "Color" ? ICON_LOADER_BY_FILE[`${id}-color`] : undefined;
  if (color) return { load: color, mono: false };
  const mono = ICON_LOADER_BY_FILE[id];
  return mono ? { load: mono, mono: true } : null;
}

export function LobeIcon({ name, className }: { name: string; className?: string }) {
  const icon = resolveLobeIcon(name);
  const [loaded, setLoaded] = useState<{ name: string; url: string } | null>(null);
  useEffect(() => {
    let active = true;
    void icon?.load().then((url) => {
      if (active) setLoaded({ name, url });
    });
    return () => {
      active = false;
    };
    // icon 由 name 唯一决定。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);
  const url = loaded?.name === name ? loaded.url : null;
  // 加载前占位同尺寸，避免按钮宽度跳动。
  if (!icon || !url)
    return <span aria-hidden="true" className={cn("inline-block shrink-0", className)} />;
  // 单色 SVG 使用 currentColor；<img> 无法继承文字颜色，改用 mask 跟随主题前景色。
  return icon.mono ? (
    <span
      aria-hidden="true"
      className={cn("inline-block shrink-0 bg-current", className)}
      style={{
        maskImage: `url("${url}")`,
        maskSize: "contain",
        maskRepeat: "no-repeat",
        maskPosition: "center",
      }}
    />
  ) : (
    <img src={url} alt="" aria-hidden="true" className={cn("shrink-0 object-contain", className)} />
  );
}
