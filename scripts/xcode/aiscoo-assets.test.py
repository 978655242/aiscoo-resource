#!/usr/bin/env python3
"""Regression checks for published Aiscoo resources and clean-source generation."""
import hashlib
import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET

from PIL import Image, ImageChops

ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts/xcode/generate-icons.py"
SOURCE = ROOT / "docs/brand/aiscoo"
SIZES = (16, 24, 32, 48, 64, 128, 256, 512, 1024)
SVG_NS = "{http://www.w3.org/2000/svg}"
# 原因：眼型升级覆盖全部品牌出口；桌面主题配置仍不能影响 Web／安装器，
# 已发布文件须与同版设计源一致，原字母和背景几何由 robot-motion.test.py 独立锁定。
NON_DESKTOP_OUTPUTS = (
    "packages/web/public/favicon.ico",
    "packages/web/public/apple-touch-icon.png",
    "packages/web/public/icon-192.png",
    "packages/web/public/icon-512.png",
    "packages/desktop/build/icon_installer.png",
    "packages/desktop/build/icon_installer.ico",
    "packages/desktop/build/icon_installer.icns",
    "packages/desktop/build/dmg_background.png",
    "packages/desktop/build/dmg_background@2x.png",
)


def hashes(directory):
    return {str(p.relative_to(directory)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in directory.rglob("*") if p.is_file()}


def white_glyph_bounds(image):
    bright = image.convert("L").point(lambda value: 255 if value > 240 else 0)
    return ImageChops.multiply(bright, image.convert("RGBA").getchannel("A")).getbbox()


class AiscooAssetTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temporary = tempfile.TemporaryDirectory(prefix="aiscoo-assets-")
        cls.output = Path(cls.temporary.name)
        cls.source_before = hashes(SOURCE)
        cls.generate()
        cls.first = hashes(cls.output)

    @classmethod
    def tearDownClass(cls):
        cls.temporary.cleanup()

    @classmethod
    def generate(cls, *extra):
        # 原因：旧脚本依赖 cwd 并覆盖已有底图；隔离 cwd 能让回归失败时也不污染仓库。
        result = subprocess.run(
            [sys.executable, "-B", str(SCRIPT), "--output-root", str(cls.output), *extra],
            cwd=cls.output, capture_output=True, text=True, timeout=30,
            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"},
        )
        if result.returncode:
            raise AssertionError(result.stderr or result.stdout)
        return result

    def test_repeated_generation_and_polluted_outputs_are_reproducible(self):
        self.generate()
        self.assertEqual(hashes(self.output), self.first)
        target = self.output / "packages/desktop/build/icon.png"
        target.write_bytes(b"previous runtime output must never become an input")
        check = subprocess.run(
            [sys.executable, "-B", str(SCRIPT), "--output-root", str(self.output), "--check"],
            cwd=self.output, capture_output=True, text=True, timeout=30,
        )
        self.assertEqual(check.returncode, 1, check.stdout + check.stderr)
        self.assertIn("packages/desktop/build/icon.png", check.stderr)
        self.assertEqual(target.read_bytes(), b"previous runtime output must never become an input")
        self.generate()
        self.assertEqual(hashes(self.output), self.first)
        self.assertEqual(hashes(SOURCE), self.source_before)
        self.generate("--check")

    def test_design_inputs_remain_immutable_during_publication(self):
        self.assertIn("source/ai.py", self.source_before)
        self.assertIn("app-icon/png/icon-light-1024.png", self.source_before)
        self.assertEqual(hashes(SOURCE), self.source_before)

    def test_production_assets_are_published_in_existing_packaging_paths(self):
        # 原因：逐项锁定 44 个实际发布路径与字节，
        # 防止新机器人只落在未消费的目录，或部分 PNG 仍保留旧版。
        expected = set(NON_DESKTOP_OUTPUTS)
        for directory in ("packages/desktop/build/icons", "public/logo/icons"):
            expected.update(f"{directory}/{size}x{size}.png" for size in SIZES)
        expected.update(f"packages/ui/src/aiscoo/brand/assets/{kind}-{theme}.svg"
                        for theme in ("light", "dark")
                        for kind in ("mark", "app", "startup", "wordmark", "wordmark-animated"))
        expected.update(("packages/desktop/build/icon.png", "packages/desktop/build/icon_windows.png",
                         "public/icon_512@2x.png", "packages/desktop/build/icon.ico",
                         "packages/desktop/build/icon.icns", "public/logo/icons/icon.ico",
                         "public/logo/icons/icon.icns"))
        self.assertEqual(len(self.first), 44)
        self.assertEqual(set(self.first), expected)
        for name in expected:
            with self.subTest(published=name):
                self.assertEqual((self.output / name).read_bytes(), (ROOT / name).read_bytes())
        for directory in ("packages/desktop/build/icons", "public/logo/icons"):
            for size in SIZES:
                with self.subTest(directory=directory, size=size):
                    path = self.output / directory / f"{size}x{size}.png"
                    with Image.open(path) as image:
                        self.assertEqual(image.size, (size, size))
                        self.assertEqual(image.mode, "RGBA")
                        self.assertEqual(image.getchannel("A").getextrema(), (0, 255))
                    self.assertEqual(path.read_bytes(), (self.output / "packages/desktop/build/icons"
                                                        / f"{size}x{size}.png").read_bytes())
        desktop_png = (self.output / "packages/desktop/build/icon.png").read_bytes()
        for name in ("packages/desktop/build/icon_windows.png", "public/icon_512@2x.png",
                     "packages/desktop/build/icons/1024x1024.png", "public/logo/icons/1024x1024.png"):
            self.assertEqual((self.output / name).read_bytes(), desktop_png, name)
        for extension in ("ico", "icns"):
            self.assertEqual((self.output / f"public/logo/icons/icon.{extension}").read_bytes(),
                             (self.output / f"packages/desktop/build/icon.{extension}").read_bytes())

    def test_desktop_mark_is_twenty_percent_larger_without_resizing_the_tile(self):
        manifest = json.loads((ROOT / "packages/shared/src/aiscoo-brand/brand.json").read_text())
        self.assertEqual(manifest["desktopIcon"], {"theme": "dark", "markScale": 1.2})
        with Image.open(self.output / "packages/desktop/build/icon.png") as published:
            image = published.convert("RGBA")
        with Image.open(SOURCE / "app-icon/png/icon-dark-1024.png") as source:
            original = source.convert("RGBA")
        self.assertEqual(image.size, original.size)
        self.assertEqual(image.getchannel("A").tobytes(), original.getchannel("A").tobytes())
        self.assertLess(max(image.getpixel((180, 512))[:3]), 60)
        # 原因：Dock 图案偏小；按真实前景边界校验放大和中心，避免只改分辨率或放大底板。
        before = white_glyph_bounds(original)
        after = white_glyph_bounds(image)
        for index in range(4):
            self.assertAlmostEqual(after[index], 512 + (before[index] - 512) * 1.2, delta=2)
        self.assertAlmostEqual(after[2] - after[0], (before[2] - before[0]) * 1.2, delta=2)
        self.assertAlmostEqual(after[3] - after[1], (before[3] - before[1]) * 1.2, delta=2)
        self.assertGreater(after[0], 100)
        self.assertGreater(after[1], 100)
        self.assertLess(after[2], 924)
        self.assertLess(after[3], 924)
        for size in SIZES:
            with Image.open(self.output / f"packages/desktop/build/icons/{size}x{size}.png") as scaled:
                expected = image.resize((size, size), Image.Resampling.LANCZOS)
                self.assertEqual(scaled.tobytes(), expected.tobytes(), size)
                if size in (16, 32):
                    self.assertIsNotNone(white_glyph_bounds(scaled), f"glyph missing at {size}px")

    def test_manifest_selects_desktop_art_without_changing_other_surfaces(self):
        # 在隔离源码树改变品牌事实，确认桌面主题和前景大小没有在生成脚本中另行写死。
        with tempfile.TemporaryDirectory(prefix="aiscoo-brand-variant-") as temporary:
            root = Path(temporary)
            script = root / "scripts/xcode/generate-icons.py"
            script.parent.mkdir(parents=True)
            script.write_bytes(SCRIPT.read_bytes())
            manifest_path = root / "packages/shared/src/aiscoo-brand/brand.json"
            manifest_path.parent.mkdir(parents=True)
            manifest = json.loads((ROOT / manifest_path.relative_to(root)).read_text())
            source = root / manifest["sourceDirectory"]
            source.parent.mkdir(parents=True)
            source.symlink_to(SOURCE, target_is_directory=True)
            (root / "node_modules").symlink_to(ROOT / "node_modules", target_is_directory=True)
            output = root / "output"
            for theme in ("light", "dark"):
                with self.subTest(theme=theme):
                    manifest["desktopIcon"] = {"theme": theme, "markScale": 1.0}
                    manifest_path.write_text(json.dumps(manifest))
                    result = subprocess.run(
                        [sys.executable, "-B", str(script), "--output-root", str(output)],
                        cwd=root, capture_output=True, text=True, timeout=30,
                    )
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertEqual((output / "packages/desktop/build/icon.png").read_bytes(),
                                     (SOURCE / f"app-icon/png/icon-{theme}-1024.png").read_bytes())
                    self.assertNotEqual((output / "packages/desktop/build/icon.png").read_bytes(),
                                        (self.output / "packages/desktop/build/icon.png").read_bytes())
                    for name in NON_DESKTOP_OUTPUTS:
                        self.assertEqual((output / name).read_bytes(),
                                         (self.output / name).read_bytes(), name)

    def test_ico_and_icns_payloads_cover_platform_sizes_and_use_desktop_pixels(self):
        for name in ("packages/desktop/build/icon.ico", "packages/desktop/build/icon_installer.ico",
                     "public/logo/icons/icon.ico", "packages/web/public/favicon.ico"):
            with Image.open(self.output / name) as image:
                self.assertEqual(image.ico.sizes(), {(s, s) for s in SIZES if s <= 256}, name)
                for size in image.ico.sizes():
                    frame = image.ico.getimage(size).convert("RGBA")
                    self.assertEqual(frame.size, size)
                    self.assertEqual(frame.getchannel("A").getextrema(), (0, 255))
                    if name in ("packages/desktop/build/icon.ico", "public/logo/icons/icon.ico"):
                        with Image.open(self.output / "packages/desktop/build/icons"
                                        / f"{size[0]}x{size[1]}.png") as published:
                            self.assertEqual(frame.tobytes(), published.tobytes(), (name, size))
        for name in ("packages/desktop/build/icon.icns", "public/logo/icons/icon.icns",
                     "packages/desktop/build/icon_installer.icns"):
            raw = (self.output / name).read_bytes()
            self.assertEqual(raw[:4], b"icns")
            self.assertEqual(struct.unpack(">I", raw[4:8])[0], len(raw))
            with Image.open(self.output / name) as image:
                image.load()
                self.assertEqual(image.size, (1024, 1024))
                self.assertIn((16, 16, 2), image.info["sizes"])
                self.assertIn((512, 512, 2), image.info["sizes"])
                if "installer" not in name:
                    self.assertIn((16, 16, 1), image.info["sizes"])
                    self.assertIn((32, 32, 1), image.info["sizes"])
                    for width, height, scale in image.info["sizes"]:
                        frame = image.icns.getimage((width, height, scale)).convert("RGBA")
                        pixels = (width * scale, height * scale)
                        self.assertEqual(frame.size, pixels)
                        with Image.open(self.output / "packages/desktop/build/icons"
                                        / f"{pixels[0]}x{pixels[1]}.png") as published:
                            self.assertEqual(frame.tobytes(), published.tobytes(), (name, pixels))

    def test_ui_svg_assets_retain_original_geometry_theme_and_reduced_motion(self):
        assets = self.output / "packages/ui/src/aiscoo/brand/assets"
        # 原因：资源只有 aiscoo/brand/assets 一份；退役的 xwork 路径不得再出现副本。
        self.assertFalse((self.output / "packages/ui/src/xwork/brand/assets").exists())
        self.assertFalse((ROOT / "packages/ui/src/xwork/brand/assets").exists())
        self.assertFalse((assets / "app-desktop.svg").exists())
        for theme in ("light", "dark"):
            mappings = {
                f"mark-{theme}.svg": f"mark/svg/ai-{theme}.svg",
                f"app-{theme}.svg": f"app-icon/png/icon-{theme}.svg",
                f"startup-{theme}.svg": f"splash/ai-animated-{theme}.svg",
            }
            for target, source in mappings.items():
                self.assertEqual((assets / target).read_bytes(), (SOURCE / source).read_bytes())
            for target, source in (
                (f"wordmark-{theme}.svg", f"logo/svg/aiscoo-{theme}.svg"),
                (f"wordmark-animated-{theme}.svg", f"logo-animated/aiscoo-animated-{theme}.svg"),
            ):
                produced = ET.fromstring((assets / target).read_text())
                expected = ET.fromstring((SOURCE / source).read_text())
                for child in list(expected):
                    if child.tag == SVG_NS + "rect":
                        expected.remove(child)
                self.assertEqual(ET.tostring(produced), ET.tostring(expected), target)
                self.assertFalse(any(child.tag == SVG_NS + "rect" for child in produced))
            for name in (f"startup-{theme}.svg", f"wordmark-animated-{theme}.svg"):
                text = (assets / name).read_text()
                self.assertIn("prefers-reduced-motion:reduce", text)
                self.assertIn("10.0s", text)
            for path in assets.glob(f"*-{theme}.svg"):
                tree = ET.fromstring(path.read_text())
                self.assertFalse(any(el.tag in (SVG_NS + "text", SVG_NS + "image", SVG_NS + "script")
                                     for el in tree.iter()), path.name)

    def test_web_and_installer_publish_the_current_design(self):
        for name in NON_DESKTOP_OUTPUTS:
            with self.subTest(name=name):
                self.assertEqual((self.output / name).read_bytes(), (ROOT / name).read_bytes())

    def test_mobile_and_installer_outputs_have_correct_canvas_and_theme(self):
        for name, size in (("apple-touch-icon.png", 180), ("icon-192.png", 192), ("icon-512.png", 512)):
            with Image.open(self.output / "packages/web/public" / name) as image:
                self.assertEqual(image.size, (size, size))
                self.assertEqual(image.convert("RGBA").getchannel("A").getextrema(),
                                 (255, 255) if size == 180 else (0, 255))
                self.assertGreater(min(image.getpixel((round(size * 0.18), size // 2))[:3]), 230)
                self.assertLess(max(image.getpixel((size // 2, size // 2))[:3]), 50)
        share_config = (ROOT / "packages/web-share/vite.config.ts").read_text()
        self.assertRegex(share_config, r'publicDir:\s*resolve\(REPO_ROOT, "packages/web/public"\)')
        self.assertFalse((self.output / "packages/web-share/public").exists())
        for name, size in (("dmg_background.png", (540, 380)),
                           ("dmg_background@2x.png", (1080, 760)),
                           ("icon_installer.png", (1024, 1024))):
            with Image.open(self.output / "packages/desktop/build" / name) as image:
                self.assertEqual(image.size, size)
                if name.startswith("dmg"):
                    self.assertEqual(image.convert("RGBA").getchannel("A").getextrema(), (255, 255))
        manifest = json.loads((ROOT / "packages/shared/src/aiscoo-brand/brand.json").read_text())
        self.assertEqual(manifest["productName"], "Aiscoo")
        self.assertEqual(manifest["wordmark"], "aiscoo")
        self.assertEqual(manifest["sourceDirectory"], "docs/brand/aiscoo")


if __name__ == "__main__":
    unittest.main()
