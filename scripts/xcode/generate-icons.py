#!/usr/bin/env python3
"""XCODE: publish Aiscoo runtime assets from immutable final design files.

Requires Python 3 + Pillow 12.1.0 and the frozen workspace's @napi-rs/canvas 0.1.100.
Run from any cwd. --check compares without writing; --output-root supports isolation.
"""
import argparse
from io import BytesIO
import json
import os
from pathlib import Path
import re
import struct
import subprocess
import sys
import xml.etree.ElementTree as ET

from PIL import Image, __version__ as pillow_version

ROOT = Path(__file__).resolve().parents[2]
SIZES = (16, 24, 32, 48, 64, 128, 256, 512, 1024)
PILLOW_VERSION = "12.1.0"
CANVAS_VERSION = "0.1.100"
UI_ASSETS = Path("packages/ui/src/aiscoo/brand/assets")
DESKTOP = Path("packages/desktop/build")
PUBLIC = Path("public/logo/icons")


def png(image):
    stream = BytesIO()
    image.save(stream, format="PNG", compress_level=9)
    return stream.getvalue()


def clean_image(data):
    with Image.open(BytesIO(data)) as image:
        # 原因：PNG 中的 EXIF/ICC 不应随派生图传播；像素、alpha 与源设计一致即可。
        return Image.frombytes("RGBA", image.size, image.convert("RGBA").tobytes())


def ico(image):
    frames = [image.resize((size, size), Image.Resampling.LANCZOS)
              for size in SIZES if size <= 256]
    stream = BytesIO()
    image.save(stream, format="ICO", sizes=[frame.size for frame in frames], append_images=frames)
    return stream.getvalue()


def icns(image, *, include_small_sizes=False):
    # 固定块序与 PNG 编码，避免 iconutil 的宿主差异；小尺寸含 16/32pt 的 @2x 资源。
    blocks = ((b"ic07", 128), (b"ic08", 256), (b"ic09", 512), (b"ic10", 1024),
              (b"ic11", 32), (b"ic12", 64), (b"ic13", 256), (b"ic14", 512))
    if include_small_sizes:
        # 桌面需真实 16/32px 资源；安装器沿用既有块序和字节，不随 Dock 反馈变化。
        blocks += ((b"icp4", 16), (b"icp5", 32), (b"icp6", 64))
    images = {size: png(image.resize((size, size), Image.Resampling.LANCZOS))
              for _, size in blocks}
    payload = b"".join(kind + struct.pack(">I", 8 + len(images[size])) + images[size]
                       for kind, size in blocks)
    return b"icns" + struct.pack(">I", len(payload) + 8) + payload


def transparent_wordmark(data):
    # 只去根画布实底：眼睛填色、字距、clipPath 和动态参数均保持原稿。
    text = data.decode("utf-8")
    text, count = re.subn(r'<rect width="[^\"]+" height="200" fill="#[0-9A-Fa-f]+"/>', "", text)
    if count != 1:
        raise ValueError("Final wordmark must contain exactly one background canvas")
    return text.encode("utf-8")


def placed_svg(data, x, y, width, height):
    text = data.decode("utf-8").strip()
    text = re.sub(r'\s+(?:width|height)="[^\"]*"', "", text, count=2)
    return text.replace("<svg ", f'<svg x="{x}" y="{y}" width="{width}" height="{height}" ', 1)


def installer_svg(mark):
    # 新建无品牌包装底板，不读取已绘入 X 的 runtime 产物，避免重复叠图。
    art = placed_svg(mark, 244, 355, 536, 536)
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
<defs>
<linearGradient id="pkg-top" x2="0" y2="1"><stop stop-color="#34373D"/><stop offset="1" stop-color="#181A1F"/></linearGradient>
<linearGradient id="pkg-front" x2="1" y2="1"><stop stop-color="#22252B"/><stop offset="1" stop-color="#0D0F12"/></linearGradient>
</defs>
<ellipse cx="512" cy="921" rx="390" ry="34" fill="#000000" opacity=".16"/>
<path d="M144 122Q150 110 170 110H854Q874 110 880 132L950 303H74Z" fill="url(#pkg-top)" stroke="#0D0F12" stroke-width="6"/>
<path d="M74 303H950L902 902Q900 932 870 932H154Q124 932 122 902Z" fill="url(#pkg-front)" stroke="#0D0F12" stroke-width="6"/>
<path d="M512 112V303M76 303H948" fill="none" stroke="#080A0D" stroke-width="10"/>
<path d="M150 133H482M535 133H858M144 325H881" fill="none" stroke="#FFFFFF" opacity=".08" stroke-width="3"/>
{art}</svg>'''


def dmg_svg(wordmark):
    art = placed_svg(wordmark, 150, 53, 240, 82.6)
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="540" height="380" viewBox="0 0 540 380">
<rect width="540" height="380" fill="#F4F5F7"/>
<g fill="none" stroke="#121317" opacity=".10" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">
<path d="M26 16L6 36L26 56M54 16L74 36L54 56M38 4L32 68"/>
<rect x="475" y="28" width="40" height="34" rx="6" transform="rotate(-24 495 45)"/>
<path d="M488 40L495 45L488 50M502 50H510"/>
<path d="M32 307L19 324L32 341M52 307L65 324L52 341"/>
<circle cx="504" cy="248" r="20"/><path d="M504 237V248L512 254"/>
<rect x="459" y="324" width="52" height="40" rx="8" transform="rotate(24 485 344)"/>
<path d="M469 339H493M469 350H485M480 321V328M496 321V328"/>
<path d="M135 26C116 26 116 48 130 50L132 59L140 50C157 44 152 26 135 26Z"/>
<circle cx="400" cy="30" r="11"/><path d="M400 41V51M127 356C115 331 138 321 151 330C164 337 158 349 167 356C177 365 171 379 158 380"/>
<path d="M398 330V364M382 347H415"/>
</g>
{art}
<path d="M220 212Q270 183 317 210M309 192L320 213L300 217" fill="none" stroke="#676A70" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"/>
</svg>'''


def rasterize(requests):
    # 使用锁文件已有的矢量渲染器；只有原稿图形，没有系统字体或网络输入。
    code = r'''
const { createCanvas, loadImage } = require("@napi-rs/canvas");
const version = require("@napi-rs/canvas/package.json").version;
if (version !== process.argv[1]) throw new Error(`Expected @napi-rs/canvas ${process.argv[1]}, got ${version}`);
(async () => {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  const output = [];
  for (const { svg, width, height } of input) {
    const image = await loadImage(Buffer.from(svg));
    const canvas = createCanvas(width, height);
    canvas.getContext("2d").drawImage(image, 0, 0, width, height);
    output.push(canvas.toBuffer("image/png").toString("base64"));
  }
  process.stdout.write(JSON.stringify(output));
})().catch((error) => { process.stderr.write(error.message + "\n"); process.exitCode = 1; });
'''
    result = subprocess.run(
        [os.environ.get("NODE_BINARY", "node"), "--input-type=commonjs", "-e", code, CANVAS_VERSION],
        cwd=ROOT, input=json.dumps(requests), text=True, capture_output=True, timeout=30,
    )
    if result.returncode:
        raise RuntimeError(result.stderr.strip() or "SVG renderer failed")
    import base64
    return [base64.b64decode(data) for data in json.loads(result.stdout)]


def desktop_icon(source, config):
    theme, scale = config["theme"], config["markScale"]
    if theme not in ("light", "dark"):
        raise ValueError("desktopIcon.theme must be light or dark")
    if isinstance(scale, bool) or not isinstance(scale, (int, float)) or not 0 < scale <= 1.2:
        raise ValueError("desktopIcon.markScale must be greater than 0 and at most 1.2")
    original = (source / f"app-icon/png/icon-{theme}-1024.png").read_bytes()
    if scale == 1:
        return original

    # 原因：Dock 内部图案偏小；只缩放原稿前景，底板的尺寸、圆角和渐变参数保持不变。
    tree = ET.fromstring((source / f"app-icon/png/icon-{theme}.svg").read_bytes())
    ET.register_namespace("", "http://www.w3.org/2000/svg")
    namespace = "{http://www.w3.org/2000/svg}"
    layers = tree.findall(namespace + "g")
    if len(layers) != 2 or "transform" not in layers[1].attrib:
        raise ValueError("Final app icon must contain a tile and a transformed mark")
    wrapper = ET.Element(namespace + "g", {
        "transform": f"translate(512 512) scale({scale}) translate(-512 -512)",
    })
    tree.remove(layers[1])
    wrapper.append(layers[1])
    tree.append(wrapper)
    rendered = clean_image(rasterize([{
        "svg": ET.tostring(tree, encoding="unicode"), "width": 1024, "height": 1024,
    }])[0])
    # 渲染器不支持原稿阴影滤镜；用原 PNG 作底，且只覆盖其完全不透明的底板像素。
    background = clean_image(original)
    opaque_tile = background.getchannel("A").point(lambda alpha: 255 if alpha == 255 else 0)
    background.paste(rendered, (0, 0), opaque_tile)
    return png(background)


def outputs():
    if pillow_version != PILLOW_VERSION:
        raise RuntimeError(f"Expected Pillow {PILLOW_VERSION}, got {pillow_version}")
    brand = json.loads((ROOT / "packages/shared/src/aiscoo-brand/brand.json").read_text())
    source = ROOT / brand["sourceDirectory"]
    result = {}
    for theme in ("light", "dark"):
        for target, original in (
            (f"mark-{theme}.svg", f"mark/svg/ai-{theme}.svg"),
            (f"app-{theme}.svg", f"app-icon/png/icon-{theme}.svg"),
            (f"startup-{theme}.svg", f"splash/ai-animated-{theme}.svg"),
        ):
            result[UI_ASSETS / target] = (source / original).read_bytes()
        for target, original in (
            (f"wordmark-{theme}.svg", f"logo/svg/aiscoo-{theme}.svg"),
            (f"wordmark-animated-{theme}.svg", f"logo-animated/aiscoo-animated-{theme}.svg"),
        ):
            result[UI_ASSETS / target] = transparent_wordmark((source / original).read_bytes())

    app_data = desktop_icon(source, brand["desktopIcon"])
    app = clean_image(app_data)
    for directory in (DESKTOP / "icons", PUBLIC):
        for size in SIZES:
            result[directory / f"{size}x{size}.png"] = (
                app_data if size == 1024 else png(app.resize((size, size), Image.Resampling.LANCZOS))
            )
    for path in (DESKTOP / "icon.png", DESKTOP / "icon_windows.png", Path("public/icon_512@2x.png")):
        result[path] = app_data
    # 设计包的 ICNS 是浅色；封装同一桌面派生图，避免容器主题或图形大小不一致。
    app_icns = icns(app, include_small_sizes=True)
    for path in (DESKTOP / "icon.icns", PUBLIC / "icon.icns"):
        result[path] = app_icns
    app_ico = ico(app)
    for path in (DESKTOP / "icon.ico", PUBLIC / "icon.ico"):
        result[path] = app_ico

    # Dock 的主题仅由桌面配置选择，Web/手机继续使用原有浅色设计。
    web_app = clean_image((source / "app-icon/png/icon-light-1024.png").read_bytes())
    mobile = Image.new("RGBA", (180, 180), brand["palette"]["lightBackground"])
    mobile.alpha_composite(web_app.resize((180, 180), Image.Resampling.LANCZOS))
    # Share 的 Vite publicDir 已指向 Web public，只有一个静态资源所有者。
    web_public = Path("packages/web/public")
    result[web_public / "favicon.ico"] = ico(web_app)
    result[web_public / "apple-touch-icon.png"] = png(mobile)
    for size in (192, 512):
        result[web_public / f"icon-{size}.png"] = png(web_app.resize((size, size), Image.Resampling.LANCZOS))

    package = installer_svg(result[UI_ASSETS / "mark-dark.svg"])
    background = dmg_svg(result[UI_ASSETS / "wordmark-light.svg"])
    raster = rasterize([
        {"svg": package, "width": 1024, "height": 1024},
        {"svg": background, "width": 540, "height": 380},
        {"svg": background, "width": 1080, "height": 760},
    ])
    installer = clean_image(raster[0])
    result[DESKTOP / "icon_installer.png"] = png(installer)
    result[DESKTOP / "icon_installer.ico"] = ico(installer)
    result[DESKTOP / "icon_installer.icns"] = icns(installer)
    result[DESKTOP / "dmg_background.png"] = png(clean_image(raster[1]))
    result[DESKTOP / "dmg_background@2x.png"] = png(clean_image(raster[2]))
    return brand, result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-root", type=Path, default=ROOT,
                        help="Destination repository root (defaults to this checkout)")
    parser.add_argument("--check", action="store_true", help="Compare generated bytes without writing")
    args = parser.parse_args()
    brand, generated = outputs()
    mismatched = []
    for relative, content in sorted(generated.items()):
        path = args.output_root / relative
        if args.check:
            if not path.is_file() or path.read_bytes() != content:
                mismatched.append(str(relative))
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
    if mismatched:
        sys.stderr.write("Brand assets differ or are missing:\n" + "\n".join(mismatched) + "\n")
        return 1
    print(f"{'Verified' if args.check else 'Generated'} {len(generated)} {brand['productName']} assets "
          f"from {brand['sourceDirectory']}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, ValueError, RuntimeError, subprocess.TimeoutExpired) as error:
        sys.stderr.write(f"Asset generation failed: {error}\n")
        sys.exit(1)
