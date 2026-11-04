#!/usr/bin/env python3
"""Start the existing local aiscoo-admin and this checkout's private desktop."""
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import shlex
import stat
import subprocess
import sys
import tempfile
import time

HOME = Path.home()
ROOT = Path(__file__).resolve().parents[2]
STATE = HOME / ".local/share/xcode-local"
SPEC = HOME / ".config/xcode-local/start.json"
ORIGIN = "http://127.0.0.1:3001"
LABEL = "com.xwork.local-desktop"
# XCODE: 仅展示名读取共享 JSON；launchd、配置和状态目录保持兼容身份。
BRAND = json.loads((ROOT / "packages/shared/src/aiscoo-brand/brand.json").read_text())


def run(args, *, check=True, timeout=20, env=None):
    result = subprocess.run([str(arg) for arg in args], capture_output=True, text=True,
                            timeout=timeout, env=env, cwd=ROOT)
    if check and result.returncode:
        raise RuntimeError(f"命令失败：{Path(args[0]).name} {args[1]} (exit={result.returncode})；未重配已有实例")
    return result


@contextmanager
def startup_lock(path):
    fd = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid():
            raise RuntimeError("启动锁不是本用户的普通文件")
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        yield
    finally:
        os.close(fd)


def private_path(path, mode):
    info = path.lstat()
    if path.is_symlink() or info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) != mode:
        raise RuntimeError(f"私密路径权限/所有者不符：{path}")


def sha256(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def validate_native_files(backend):
    for key in ("binary", "config", "plist"):
        path = Path(backend[key])
        if path.is_symlink() or not path.is_file():
            raise RuntimeError(f"原生后端的{key}缺失；不会创建或替换")
        info = path.stat()
        if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o022:
            raise RuntimeError(f"原生后端的{key}所有者/权限不符")
        if sha256(path) != backend[key + "Sha256"]:
            raise RuntimeError(f"原生后端的{key}已变更；需要重新核验，不自动升级")
    private_path(Path(backend["config"]).parent, 0o700)
    private_path(Path(backend["config"]), 0o600)


def require_private_origin(origin):
    if origin != ORIGIN:
        raise RuntimeError("现有桌面的私有origin不匹配；未激活、接管或重新构建")
    return origin


def listener_pids(port):
    value = run(["/usr/sbin/lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-t"], check=False)
    if value.returncode not in (0, 1) or (value.returncode == 1 and value.stderr):
        raise RuntimeError(f"无法核对监听归属：{port}")
    return {int(pid) for pid in value.stdout.split()}


def process_args(pid):
    return shlex.split(run(["/bin/ps", "-p", str(pid), "-o", "command="]).stdout)


def process_executable(pid):
    output = run(["/usr/sbin/lsof", "-a", "-p", str(pid), "-d", "txt", "-Fn"], check=False).stdout
    paths = [Path(line[1:]) for line in output.splitlines() if line.startswith("n")]
    if not paths:
        status = run(["/bin/ps", "-p", str(pid), "-o", "stat="], check=False).stdout.strip()
        if not status or status.startswith("Z"):
            return None
        raise RuntimeError("无法核验进程可执行文件；未接管")
    return paths[0]


def job_snapshot(label):
    result = run(["/bin/launchctl", "print", f"gui/{os.getuid()}/{label}"], check=False)
    pid = re.search(r"^\s*pid = (\d+)\s*$", result.stdout, re.MULTILINE)
    return {"loaded": result.returncode == 0, "running": "state = running" in result.stdout,
            "pid": int(pid.group(1)) if pid else None}


def require_native_listener(port, backend):
    pids = listener_pids(port)
    for pid in pids:
        executable = process_executable(pid)
        if executable is None:
            return False
        if executable != Path(backend["binary"]) or job_snapshot(backend["label"])["pid"] != pid:
            raise RuntimeError(f"{port}不是已核对原生作业；不启动旧容器、不接管")
    return bool(pids)


def http_json(url):
    result = run(["/usr/bin/curl", "--noproxy", "*", "--silent", "--show-error", "--fail",
                  "--connect-timeout", "2", "--max-time", "5", "--max-filesize", "1048576", url],
                 check=False, timeout=7)
    try:
        return json.loads(result.stdout) if result.returncode == 0 else None
    except ValueError:
        return None


def has_ancestor(pid, ancestor):
    seen = set()
    while pid > 1 and pid not in seen:
        if pid == ancestor:
            return True
        seen.add(pid)
        result = run(["/bin/ps", "-p", str(pid), "-o", "ppid="], check=False)
        if result.returncode or not result.stdout.strip():
            return False
        pid = int(result.stdout.strip())
    return False


def job_attests_origin(pid):
    result = run(["/bin/launchctl", "print", f"gui/{os.getuid()}/{LABEL}"], check=False)
    parent = re.search(r"^\s*pid = (\d+)\s*$", result.stdout, re.MULTILINE)
    origin = re.search(r"^\s*AISCOO_ADMIN_BASE_URL => ([^\n]+)$", result.stdout, re.MULTILINE)
    return (result.returncode == 0 and parent is not None and origin is not None
            and origin.group(1).strip() == ORIGIN
            and f"working directory = {ROOT}\n" in result.stdout
            and has_ancestor(pid, int(parent.group(1))))


def desktop_pid():
    pids = listener_pids(9229)
    if len(pids) > 1:
        raise RuntimeError("9229有多个未知实例；未接管")
    for pid in pids:
        executable = process_executable(pid)
        if executable is None:
            return None
        if (not executable.is_relative_to(ROOT / ".zcode-runtime/desktop-dev")
                or executable.parts[-4:] != (f"{BRAND['developmentName']}.app", "Contents", "MacOS", "Electron")):
            raise RuntimeError(f"9229不是本仓库{BRAND['developmentName']}；不会启动第二个桌面")
        value = run(["/bin/ps", "eww", "-p", str(pid), "-o", "command="]).stdout
        found = re.search(r"(?:^|\s)AISCOO_ADMIN_BASE_URL=([^\s]*)", value)
        # Electron may rewrite argv/environment visible to ps; our launchd ancestry proves its launch environment.
        origin = found.group(1) if found else (ORIGIN if job_attests_origin(pid) else None)
        require_private_origin(origin)
        return pid
    return None


def check_vite_owner():
    pids = listener_pids(5174)
    for pid in pids:
        args = process_args(pid)
        cwd = run(["/usr/sbin/lsof", "-a", "-p", str(pid), "-d", "cwd", "-Fn"]).stdout
        directories = [line[1:] for line in cwd.splitlines() if line.startswith("n")]
        if str(ROOT / "packages/desktop") not in directories or not any(Path(arg).name in ("vite", "vite.js") for arg in args):
            raise RuntimeError("5174属于未知Vite实例；不会清out或重复启动")
    return bool(pids)


def window_ready():
    pid = desktop_pid()
    if pid is None:
        return False
    targets = http_json("http://127.0.0.1:9229/json/list")
    return isinstance(targets, list) and any(
        target.get("type") == "page" and any(target.get("url", "").startswith(origin)
        for origin in ("http://localhost:5174/", "http://127.0.0.1:5174/", "http://[::1]:5174/"))
        for target in targets)


def wait_for(check, name, seconds, *, alive=None):
    deadline = time.monotonic() + seconds
    while True:
        if check():
            print(f"[通过] {name}", flush=True)
            return
        if alive is not None and not alive():
            raise RuntimeError(f"{name}进程已退出；查看{STATE / 'desktop.log'}，不会等待600秒或重复构建")
        if time.monotonic() >= deadline:
            raise RuntimeError(f"{name}未就绪；查看{STATE}，不会自动再跑pre-dev")
        time.sleep(1)


def load_spec():
    private_path(SPEC.parent, 0o700)
    private_path(SPEC, 0o600)
    spec = json.loads(SPEC.read_text())
    for name in ("python", "node", "pnpm"):
        if not Path(spec[name]).is_absolute() or not os.access(spec[name], os.X_OK):
            raise RuntimeError(f"缺少已核对工具：{name}")
    if not os.access(spec["database"]["docker"], os.X_OK):
        raise RuntimeError("数据库依赖需要已安装的Docker；未安装替代服务")
    node_version = run([spec["node"], "--version"]).stdout.strip()
    if int(node_version.lstrip("v").split(".")[0]) < 24:
        raise RuntimeError("需要Node24+；未执行pre-dev")
    path = f'{Path(spec["node"]).parent}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
    environment = desktop_environment(spec, path)
    if run([spec["pnpm"], "--version"], env=environment).stdout.strip() != "10.33.2":
        raise RuntimeError("需要现有pnpm10.33.2；未安装或升级")
    validate_native_files(spec["backend"])
    job = plistlib.loads(Path(spec["backend"]["plist"]).read_bytes())
    if (job.get("Label") != spec["backend"]["label"] or job.get("WorkingDirectory") != spec["backend"]["cwd"]
            or job.get("ProgramArguments") != spec["backend"]["arguments"]):
        raise RuntimeError("原生后端托管规格不一致；不重配")
    provider = ROOT / "config/provider/zcode-builtin.json"
    if environment.get("ZCODE_BUILTIN_PROVIDER_CONFIG_FILE") != str(provider) or not provider.is_file():
        raise RuntimeError("缺少已核对的生产内置模型配置路径；未执行pre-dev")
    for required in (ROOT / "node_modules", ROOT / "scripts/mise-run.mjs", ROOT / "scripts/dev-desktop-env.mjs"):
        if not required.exists():
            raise RuntimeError("现有依赖或启动资源缺失；不自动install/bootstrap")
    for source in (ROOT / "packages/desktop/scripts/devElectronAppBundle.mjs", ROOT / "packages/desktop/src/host/index.ts"):
        if re.search(r"^(<<<<<<<|=======|>>>>>>>)", source.read_text(), re.MULTILINE):
            raise RuntimeError("源码存在合并冲突；为保护out拒绝启动")
    return spec, path


def desktop_environment(spec, path):
    # 修复原因：上游开发 Vite 默认注入含 FPS 的 React Scan；仅下游默认关闭，保留显式启用。
    react_scan = "1" if os.environ.get("ZCODE_REACT_SCAN") == "1" else "0"
    return {"ZCODE_REACT_SCAN": react_scan, **spec["desktopEnvironment"],
            "HOME": str(HOME), "PATH": path, "AISCOO_ADMIN_BASE_URL": ORIGIN}


def ensure_desktop_job(spec, path):
    target = f"gui/{os.getuid()}/{LABEL}"
    plist = HOME / "Library/LaunchAgents" / f"{LABEL}.plist"
    log = STATE / "desktop.log"
    fd = os.open(log, os.O_CREAT | os.O_WRONLY | os.O_APPEND | os.O_NOFOLLOW, 0o600)
    os.fchmod(fd, 0o600)
    os.close(fd)
    environment = desktop_environment(spec, path)
    value = {"Label": LABEL, "ProgramArguments": [spec["node"], "scripts/mise-run.mjs", "pnpm", "dev:desktop:prod"],
             "WorkingDirectory": str(ROOT), "EnvironmentVariables": environment,
             "RunAtLoad": False, "KeepAlive": False, "StandardOutPath": str(log), "StandardErrorPath": str(log)}
    if plist.exists() or plist.is_symlink():
        if plist.is_symlink() or plistlib.loads(plist.read_bytes()) != value:
            raise RuntimeError(f"既有桌面launchd配置不匹配：{plist}；不覆盖，请核对安装规格")
    else:
        plist.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=plist.parent, delete=False) as staging:
            staging.write(plistlib.dumps(value))
        os.replace(staging.name, plist)
    if run(["/bin/launchctl", "print", target], check=False).returncode:
        run(["/bin/launchctl", "bootstrap", f"gui/{os.getuid()}", plist])
    status = run(["/bin/launchctl", "print", target]).stdout
    if "state = running" not in status:
        run(["/bin/launchctl", "kickstart", target])


def desktop_action(pid, vite, managed):
    if pid is not None:
        return "activate"
    if managed:
        return "wait"
    if vite:
        raise RuntimeError("本仓库Vite仍运行但不属于本启动作业；为保护out拒绝再跑pre-dev")
    return "start"


def database_matches(actual, expected):
    return (all(actual.get(key) == expected.get(key) for key in ("image", "ports", "entrypoint", "command", "runtime"))
            and sorted(actual["mounts"], key=lambda mount: mount["Destination"])
            == sorted(expected["mounts"], key=lambda mount: mount["Destination"]))


def database_info(database):
    template = ('{"image":{{json .Image}},"ports":{{json .HostConfig.PortBindings}},'
                '"mounts":{{json .Mounts}},"entrypoint":{{json .Config.Entrypoint}},"command":{{json .Config.Cmd}},'
                '"runtime":{"privileged":{{json .HostConfig.Privileged}},"network":{{json .HostConfig.NetworkMode}},'
                '"capAdd":{{json .HostConfig.CapAdd}},"devices":{{json .HostConfig.Devices}}},'
                '"state":{{json .State}}}')
    value = json.loads(run([database["docker"], "inspect", "--format", template, database["name"]]).stdout)
    for mount in value["mounts"]:
        for key in ("Mode", "Propagation", "Driver", "Name"):
            mount.pop(key, None)
    return value


def ensure_database(database):
    docker = database["docker"]
    def available():
        try:
            return run([docker, "info", "--format", "{{.ServerVersion}}"], check=False, timeout=5).returncode == 0
        except subprocess.TimeoutExpired:
            return False
    if not available():
        run(["/usr/bin/open", "-a", "Docker"])
        wait_for(available, "数据库依赖的Docker Desktop", 120)
    info = database_info(database)
    if not database_matches(info, database["identity"]):
        raise RuntimeError("现有PostgreSQL的镜像/卷/端口/权限已变更；不创建替代数据库")
    if not info["state"]["Running"]:
        run([docker, "start", database["name"]])
    wait_for(lambda: run([docker, "exec", database["name"], "pg_isready", "-U", database["user"],
                          "-d", database["database"]], check=False).returncode == 0, "现有PostgreSQL15433", 180)


def start(spec, path):
    pid = desktop_pid()
    action = desktop_action(pid, check_vite_owner(), job_snapshot(LABEL)["running"])
    backend = spec["backend"]
    require_native_listener(3001, backend)
    ensure_database(spec["database"])
    if not require_native_listener(3001, backend):
        state = job_snapshot(backend["label"])
        if not state["loaded"]:
            run(["/bin/launchctl", "bootstrap", f"gui/{os.getuid()}", backend["plist"]])
        elif not state["running"]:
            run(["/bin/launchctl", "kickstart", f"gui/{os.getuid()}/{backend['label']}"])
    def backend_ready():
        value = http_json(ORIGIN + "/api/status")
        return require_native_listener(3001, backend) and isinstance(value, dict) and value.get("success") is True
    wait_for(backend_ready, "原生aiscoo-admin3001", 180)
    if action == "start":
        ensure_desktop_job(spec, path)
    if action != "activate":
        wait_for(lambda: job_snapshot(LABEL)["running"], "桌面启动进程", 5)
    wait_for(window_ready, f"{BRAND['productName']}真实桌面页面", 600, alive=lambda: job_snapshot(LABEL)["running"])
    pid = desktop_pid()
    executable = process_executable(pid) if pid is not None else None
    if executable is None:
        raise RuntimeError("桌面在激活前已退出；未重新拉起或重复构建")
    app = executable.parents[2]
    run(["/usr/bin/open", app])
    print("桌面已打开。登录/私有连接状态请查看原生状态卡；本次未执行登录或资金操作。", flush=True)


def main():
    os.umask(0o077)
    STATE.mkdir(parents=True, exist_ok=True, mode=0o700)
    try:
        private_path(STATE, 0o700)
        with startup_lock(STATE / "start.lock"):
            spec, path = load_spec()
            start(spec, path)
        print("关闭此启动窗口不停止桌面；退出桌面不会停止aiscoo-admin。", flush=True)
        return 0
    except BlockingIOError:
        print("另一启动检查/构建正在进行，未重复执行pre-dev。", flush=True)
        return 1
    except (OSError, RuntimeError, ValueError, KeyError, subprocess.TimeoutExpired):
        error = sys.exception()
        print(f"[失败] {error if isinstance(error, RuntimeError) else '规格/权限/工具检查失败'}", flush=True)
        print(f"日志：{STATE}。未停止已有服务。", flush=True)
        return 1


if __name__ == "__main__":
    sys.exit(main())
