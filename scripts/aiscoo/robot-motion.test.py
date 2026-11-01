#!/usr/bin/env python3
"""Regression boundaries for the shared ai / aiscoo robot expression redesign."""
import hashlib
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[2]
# 原因：校验实际被 UI 与打包消费的资源目录，不另建副本。
ASSETS = ROOT / "packages/ui/src/aiscoo/brand/assets"
NS = "{http://www.w3.org/2000/svg}"
# 原因：只允许优化机器人；固定其外部的字母、画布、底板、遮挡和布局。
SURROUNDING_GEOMETRY = {
    "mark-light.svg": "108656a495f37b8406c149673beef701a626bab2ff37522be37d8949e2e06d45",
    "mark-dark.svg": "06b95e9318c3fa46200f110314c373b3ec39cc6f1f97380ac782d4526f469e8b",
    "app-light.svg": "8e4494da0ecb3f2e95ff172f1ff617186a30f2ed0426a4f3061618e856436dd1",
    "app-dark.svg": "faa7ce06d49930e4aead0a0af0e3c4b73634e510fa13cc46bb9ac7f853604d7b",
    "startup-light.svg": "e54f755ebcf71385979b822b6571c8f448507c1e8a75bf6c1cf6d9aa6dd29aaf",
    "startup-dark.svg": "f80d953a851ddc5877dc83dffb5c9462325b0369fa6b88fcddfb145a19bf52fa",
    "wordmark-light.svg": "6056e030fd14868294261e5fdfc344bb67892ef3b15dadeca708b66b9e784732",
    "wordmark-dark.svg": "efed916f2f8c9f7d6692d3b12f085903e66d145a20b5173d5d8e3b80d2eb3037",
    "wordmark-animated-light.svg": "896a8f66d29c0385b58baab81c10c9f039d647daab865f01acf88e74edb5621e",
    "wordmark-animated-dark.svg": "02c17a413ae141db23c12a0b26631867cd9e07fe09d1929c88c30e3b27a058b7",
}


def keyframes(css, name):
    match = re.search(r"@keyframes " + name + r"\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}", css)
    if match is None:
        raise AssertionError(f"Missing {name} keyframes")
    return re.sub(r"\s+", "", match.group(0))


def timed_frames(css, name):
    """Compare seconds, so a longer cycle cannot silently slow an existing action."""
    duration = float(re.search(r"animation:peek ([\d.]+)s", css).group(1))
    body = keyframes(css, name).split("{", 1)[1][:-1]
    return sorted((round(float(percent) * duration / 100, 6), values)
                  for offsets, values in re.findall(r"([^{}]+)\{([^{}]*)\}", body)
                  for percent in offsets.replace("%", "").split(","))


class RobotMotionTests(unittest.TestCase):
    def test_robot_surroundings_are_unchanged(self):
        for name, expected in SURROUNDING_GEOMETRY.items():
            with self.subTest(asset=name):
                tree = ET.fromstring((ASSETS / name).read_text())
                for parent in tree.iter():
                    for child in list(parent):
                        if child.tag == NS + "style" or child.get("class") == "head":
                            parent.remove(child)
                self.assertEqual(hashlib.sha256(ET.tostring(tree)).hexdigest(), expected)

    def test_every_variant_shares_capsule_eyes_and_static_tucked_pose(self):
        for name in SURROUNDING_GEOMETRY:
            with self.subTest(asset=name):
                tree = ET.fromstring((ASSETS / name).read_text())
                head = next(el for el in tree.iter() if el.get("class") == "head")
                self.assertEqual(head.get("transform"), "translate(21 0)")
                face = head.find(".//" + NS + "circle")
                self.assertEqual({k: face.get(k) for k in ("cx", "cy", "r")},
                                 {"cx": "44", "cy": "58", "r": "30.5"})
                eyes = [el for el in head.iter() if el.get("class") == "eye"]
                self.assertEqual(len(eyes), 2)
                self.assertEqual([eye.tag for eye in eyes], [NS + "rect"] * 2)
                for eye in eyes:
                    self.assertEqual(float(eye.get("width")), 7.4)
                    self.assertEqual(float(eye.get("height")), 17.2)
                    self.assertEqual(float(eye.get("rx")), 3.7)
                self.assertAlmostEqual(float(eyes[1].get("x")) - float(eyes[0].get("x")), 18)
                smile = next(el for el in head.iter() if el.get("class") == "smile")
                self.assertEqual(smile.get("opacity"), "0")
                self.assertEqual(smile.get("fill"), eyes[0].get("fill"))
                self.assertIsNone(smile.get("stroke"))
                paths = smile.findall(".//" + NS + "path")
                self.assertEqual(len(paths), 2)
                for path in paths:
                    self.assertTrue(path.get("d").endswith("Z"))
                    self.assertIn("C", path.get("d"))
                bounce = next(el for el in head.iter() if el.get("class") == "bounce")
                self.assertIn(face, list(bounce.iter()))
                self.assertIn(smile, list(bounce.iter()))
                self.assertIsNone(bounce.get("transform"))

    def test_shared_timeline_retains_peek_hop_and_reduced_motion(self):
        expected_peek = [(0, "transform:translateX(21px)"), (.288, "transform:translateX(21px)"),
                         (.768, "transform:translateX(-2px)"), (.96, "transform:translateX(0)"),
                         (6.032, "transform:translateX(0)"), (6.224, "transform:translateX(-3px)"),
                         (6.608, "transform:translateX(21px)"), (10, "transform:translateX(21px)")]
        expected_hop = [(0, "transform:translateY(0)scale(1)"), (2.592, "transform:translateY(0)scale(1)"),
                        (2.736, "transform:translateY(0)scale(1.15,.82)"),
                        (2.976, "transform:translateY(-14px)scale(.92,1.1)"),
                        (3.216, "transform:translateY(0)scale(1.12,.86)"),
                        (3.36, "transform:translateY(0)scale(1)"), (10, "transform:translateY(0)scale(1)")]
        styles = []
        for name in ("startup-light.svg", "startup-dark.svg",
                     "wordmark-animated-light.svg", "wordmark-animated-dark.svg"):
            with self.subTest(asset=name):
                css = ET.fromstring((ASSETS / name).read_text()).find(NS + "style").text
                styles.append(css)
                self.assertEqual(timed_frames(css, "peek"), expected_peek)
                self.assertEqual(timed_frames(css, "hop"), expected_hop)
                self.assertIn("animation:peek 10.0s cubic-bezier(.34,1.56,.64,1) infinite", css)
                bounce = dict(timed_frames(css, "bounce"))
                self.assertIn("scale(1.035,.94)", bounce[3.52])
                self.assertIn("translateY(-8.2px)", bounce[3.82])
                self.assertIn("scale(1.03,.95)", bounce[4.10])
                self.assertIn("translateY(-2.1px)", bounce[4.27])
                self.assertIn("scale(1)", bounce[4.50])
                self.assertIn(".bounce,", css.split("@media (prefers-reduced-motion:reduce)")[1])
                # 原因：交叉淡变会同时画出两套眼睛；两层只在同一时刻离散切换。
                opened = dict(timed_frames(css, "open-eyes"))
                smiled = dict(timed_frames(css, "smile"))
                self.assertEqual(opened.keys(), smiled.keys())
                for time in opened:
                    self.assertEqual(int(opened[time][-1]) + int(smiled[time][-1]), 1)
                self.assertIn("animation:open-eyes 10.0s steps(1,end)", css)
                self.assertIn("animation:smile 10.0s steps(1,end)", css)
                self.assertIn("@media (prefers-reduced-motion:reduce)", css)
                self.assertIn(".smile{opacity:0}", css)
                self.assertIn(".eye-open{opacity:1}", css)
                self.assertIn("height:3.6px", keyframes(css, "blink"))
                self.assertIn("opacity:1", keyframes(css, "smile"))
        self.assertTrue(all(style == styles[0] for style in styles))

    def test_legacy_generators_cannot_publish_an_old_robot_or_cycle(self):
        # 原因：旧实验脚本可单独执行，不能在正式品牌升级后重新产出椭圆眼或旧周期。
        source = ROOT / "docs/brand/aiscoo"
        expected_css = ET.fromstring((source / "splash/ai-animated-light.svg").read_text()).find(NS + "style").text
        with tempfile.TemporaryDirectory(prefix="aiscoo-legacy-brand-") as temporary:
            package = Path(temporary) / "brand"
            shutil.copytree(source, package, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
            scripts = package / "source"
            for name in ("build.py", "q3d.py", "anim.py", "ai.py", "oo_preview.py"):
                result = subprocess.run([sys.executable, "-B", str(scripts / name)],
                                        cwd=temporary, capture_output=True, text=True, timeout=30)
                self.assertEqual(result.returncode, 0, name + result.stdout + result.stderr)
            assets = list(scripts.glob("*.svg"))
            self.assertGreaterEqual(len(assets), 25)
            for asset in assets:
                with self.subTest(legacy_asset=asset.name):
                    tree = ET.fromstring(asset.read_text())
                    head = next(el for el in tree.iter() if el.get("class") == "head")
                    self.assertEqual(head.get("transform"), "translate(21 0)")
                    eyes = [el for el in head.iter() if el.get("class") == "eye"]
                    self.assertEqual(len(eyes), 2)
                    for eye in eyes:
                        self.assertEqual(eye.tag, NS + "rect")
                        self.assertEqual((eye.get("width"), eye.get("height")), ("7.4", "17.2"))
                    self.assertIsNotNone(next((el for el in head.iter() if el.get("class") == "smile"), None))
                    for style in tree.iter(NS + "style"):
                        self.assertEqual(style.text, expected_css)
            self.assertEqual((scripts / "oo-preview.html").read_bytes(), (package / "preview.html").read_bytes())
            self.assertNotIn("oo 眼睛方案", (scripts / "oo-preview.html").read_text())

    def test_design_archive_is_an_exact_mirror_of_the_canonical_package(self):
        # 原因：工具归档曾独立保留旧 SVG 和二进制；完整文件集合与字节都须来自正式包。
        def files(directory):
            return {str(path.relative_to(directory)): hashlib.sha256(path.read_bytes()).hexdigest()
                    for path in directory.rglob("*")
                    if path.is_file() and "__pycache__" not in path.parts
                    and path.suffix != ".pyc" and path.name != ".DS_Store"}
        self.assertEqual(files(ROOT / ".skill-archive/logo-creator/Aiscoo-Logo-Final"),
                         files(ROOT / "docs/brand/aiscoo"))


if __name__ == "__main__":
    unittest.main()
