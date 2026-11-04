#!/usr/bin/env python3
"""Startup boundary checks use isolated files, real processes and real sockets."""
import hashlib
import importlib.util
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

SOURCE = Path(__file__).with_name("start-local.py")


def load_launcher():
    if not SOURCE.exists():
        return None
    spec = importlib.util.spec_from_file_location("local_xcode", SOURCE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class StartupTests(unittest.TestCase):
    def test_concurrent_clicks_share_one_lock(self):
        launcher = load_launcher()
        self.assertIsNotNone(launcher, "desktop one-click launcher is missing")
        with tempfile.TemporaryDirectory() as directory:
            lock = Path(directory) / "start.lock"
            code = (
                "import importlib.util,sys; "
                "s=importlib.util.spec_from_file_location('launcher',sys.argv[1]); "
                "m=importlib.util.module_from_spec(s); s.loader.exec_module(m); "
                "\nwith m.startup_lock(sys.argv[2]):\n print('locked',flush=True); input()\n"
            )
            child = subprocess.Popen([sys.executable, "-c", code, str(SOURCE), str(lock)],
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
            try:
                self.assertEqual(child.stdout.readline().strip(), "locked")
                with self.assertRaises(BlockingIOError):
                    with launcher.startup_lock(lock):
                        self.fail("second click entered pre-dev")
            finally:
                child.communicate("\n", timeout=5)
            with launcher.startup_lock(lock):
                self.assertTrue(lock.is_file())

    def test_foreign_backend_is_not_adopted(self):
        launcher = load_launcher()
        self.assertTrue(hasattr(launcher, "require_native_listener"), "native listener ownership check is missing")
        self.assertIsNotNone(launcher, "desktop one-click launcher is missing")
        server = ThreadingHTTPServer(("127.0.0.1", 0), BaseHTTPRequestHandler)
        try:
            with self.assertRaises(RuntimeError):
                launcher.require_native_listener(server.server_port, {"binary": "/not/our/aiscoo-admin", "label": "not-our-job"})
        finally:
            server.server_close()

    def test_missing_or_tampered_native_backend_is_refused(self):
        launcher = load_launcher()
        self.assertTrue(hasattr(launcher, "validate_native_files"), "native backend validation is missing")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binary, config, plist = root / "binary", root / ".env", root / "service.plist"
            config.write_text("PORT=3001\n")
            config.chmod(0o600)
            plist.write_text("approved service metadata")
            backend = {"binary": str(binary), "binarySha256": "0" * 64, "config": str(config),
                       "configSha256": hashlib.sha256(config.read_bytes()).hexdigest(),
                       "plist": str(plist), "plistSha256": hashlib.sha256(plist.read_bytes()).hexdigest()}
            with self.assertRaises(RuntimeError):
                launcher.validate_native_files(backend)
            binary.write_bytes(b"approved binary")
            backend["binarySha256"] = hashlib.sha256(binary.read_bytes()).hexdigest()
            binary.write_bytes(b"tampered binary")
            with self.assertRaises(RuntimeError):
                launcher.validate_native_files(backend)
            self.assertEqual(config.read_text(), "PORT=3001\n")

    def test_desktop_environment_injects_admin_origin(self):
        launcher = load_launcher()
        configured = {"AISCOO_ADMIN_BASE_URL": "https://other.example", "KEEP": "unchanged"}
        with mock.patch.dict(os.environ, {}, clear=True):
            environment = launcher.desktop_environment({"desktopEnvironment": configured}, "/mock/bin")
        self.assertEqual(environment, {**configured, "HOME": str(launcher.HOME),
                                      "PATH": "/mock/bin", "AISCOO_ADMIN_BASE_URL": launcher.ORIGIN,
                                      "ZCODE_REACT_SCAN": "0"})
        self.assertNotIn("NEW_API_BASE_URL", environment)
        self.assertEqual(configured["AISCOO_ADMIN_BASE_URL"], "https://other.example")
        self.assertNotIn("ZCODE_REACT_SCAN", configured)

    def test_react_scan_defaults_off_and_honors_explicit_configuration(self):
        launcher = load_launcher()
        for inherited, configured, expected in ((None, None, "0"), ("1", None, "1"),
                                                 ("0", None, "0"), ("other", None, "0"),
                                                 ("1", "0", "0"), ("0", "1", "1")):
            environment = {} if inherited is None else {"ZCODE_REACT_SCAN": inherited}
            settings = {} if configured is None else {"ZCODE_REACT_SCAN": configured}
            original = settings.copy()
            with self.subTest(inherited=inherited, configured=configured), \
                    mock.patch.dict(os.environ, environment, clear=True):
                result = launcher.desktop_environment({"desktopEnvironment": settings}, "/mock/bin")
                self.assertEqual(result["ZCODE_REACT_SCAN"], expected)
                self.assertEqual(settings, original)

    def test_job_attests_only_admin_origin(self):
        launcher = load_launcher()
        for key, origin, accepted in (("AISCOO_ADMIN_BASE_URL", launcher.ORIGIN, True),
                                      ("NEW_API_BASE_URL", launcher.ORIGIN, False),
                                      ("AISCOO_ADMIN_BASE_URL", "https://other.example", False),
                                      ("AISCOO_ADMIN_BASE_URL", "", False)):
            output = f"pid = 123\nworking directory = {launcher.ROOT}\n{key} => {origin}\n"
            result = subprocess.CompletedProcess([], 0, stdout=output)
            with self.subTest(key=key, origin=origin), \
                    mock.patch.object(launcher, "run", return_value=result) as run, \
                    mock.patch.object(launcher, "has_ancestor", return_value=True) as ancestor:
                self.assertEqual(launcher.job_attests_origin(456), accepted)
                run.assert_called_once_with(["/bin/launchctl", "print",
                                            f"gui/{os.getuid()}/{launcher.LABEL}"], check=False)
                if accepted:
                    ancestor.assert_called_once_with(456, 123)
                else:
                    ancestor.assert_not_called()

    def test_mismatched_origin_is_not_success(self):
        launcher = load_launcher()
        self.assertIsNotNone(launcher, "desktop one-click launcher is missing")
        for origin in (None, "", "https://www.z.ai", "http://127.0.0.1:3001/api"):
            with self.subTest(origin=origin), self.assertRaises(RuntimeError):
                launcher.require_private_origin(origin)
        self.assertEqual(launcher.require_private_origin("http://127.0.0.1:3001"),
                         "http://127.0.0.1:3001")

    def test_partial_manual_dev_is_refused_but_managed_startup_is_reused(self):
        launcher = load_launcher()
        self.assertTrue(hasattr(launcher, "desktop_action"), "partial desktop startup guard is missing")
        with self.assertRaises(RuntimeError):
            launcher.desktop_action(None, True, False)
        self.assertEqual(launcher.desktop_action(None, True, True), "wait")
        self.assertEqual(launcher.desktop_action(None, False, False), "start")
        self.assertEqual(launcher.desktop_action(123, True, True), "activate")

    def test_only_descendants_of_our_launch_job_are_attested(self):
        launcher = load_launcher()
        self.assertTrue(hasattr(launcher, "has_ancestor"), "launch environment attestation is missing")
        child = subprocess.Popen([sys.executable, "-c", "input()"], stdin=subprocess.PIPE, text=True)
        try:
            self.assertTrue(launcher.has_ancestor(child.pid, os.getpid()))
            self.assertFalse(launcher.has_ancestor(os.getpid(), child.pid))
        finally:
            child.communicate("\n", timeout=5)

    def test_failed_build_does_not_wait_for_window_deadline(self):
        code = (
            "import importlib.util,sys; "
            "s=importlib.util.spec_from_file_location('launcher',sys.argv[1]); "
            "m=importlib.util.module_from_spec(s); s.loader.exec_module(m); "
            "\ntry:\n m.wait_for(lambda: False,'build',30,alive=lambda: False)\n"
            "except RuntimeError:\n sys.exit(0)\n"
            "else:\n sys.exit(1)\n"
        )
        try:
            result = subprocess.run([sys.executable, "-c", code, str(SOURCE)], capture_output=True, timeout=3)
        except subprocess.TimeoutExpired:
            self.fail("failed build waited for the window deadline")
        self.assertEqual(result.returncode, 0, result.stderr.decode())

    def test_other_database_volume_or_public_binding_is_not_adopted(self):
        launcher = load_launcher()
        self.assertTrue(hasattr(launcher, "database_matches"), "database dependency ownership check is missing")
        wanted = {"image": "trusted", "ports": {"5432/tcp": [{"HostIp": "127.0.0.1", "HostPort": "15433"}]},
                  "entrypoint": ["docker-entrypoint.sh"], "command": ["postgres"], "runtime": {"privileged": False},
                  "mounts": [{"Type": "volume", "Source": "/volumes/original", "Destination": "/var/lib/postgresql/data", "RW": True}]}
        self.assertTrue(launcher.database_matches({**wanted, "state": {"Running": True}}, wanted))
        other = {**wanted, "mounts": [{**wanted["mounts"][0], "Source": "/volumes/empty"}]}
        self.assertFalse(launcher.database_matches(other, wanted))
        self.assertFalse(launcher.database_matches({**wanted, "ports": {}}, wanted))

    def test_exited_process_is_not_claimed_or_treated_as_an_inspection_failure(self):
        launcher = load_launcher()
        child = subprocess.Popen([sys.executable, "-c", "pass"])
        child.wait(timeout=3)
        try:
            executable = launcher.process_executable(child.pid)
        except RuntimeError:
            self.fail("a disappearing startup process aborted readiness instead of remaining unclaimed")
        self.assertIsNone(executable)


if __name__ == "__main__":
    unittest.main()
