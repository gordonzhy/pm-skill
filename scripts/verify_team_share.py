#!/usr/bin/env python3
"""在隔离的 Codex 目录中安装并验证项目经理 Skill。"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def run(command: list[str], *, env: dict[str, str], cwd: Path | None = None, timeout: int = 120) -> None:
    print("检查：" + " ".join(command), flush=True)
    subprocess.run(command, cwd=cwd, env=env, check=True, timeout=timeout)


def main() -> int:
    source = Path(__file__).resolve().parent.parent
    node = shutil.which("node")
    if node is None:
        print("缺少 node；请先安装 Node.js。", file=sys.stderr)
        return 2

    with tempfile.TemporaryDirectory(prefix="project-manager-team-check-") as temporary:
        codex_root = Path(temporary) / "codex-home"
        home = Path(temporary) / "home"
        home.mkdir(mode=0o700)
        env = {**os.environ, "HOME": str(home), "CODEX_HOME": str(codex_root)}
        env["PM_SERVER_BIN"] = str(Path(temporary) / "absent-pm-server")
        env.pop("CODEX_SESSION_RUNTIME_CSV", None)
        env.pop("PROJECT_MANAGER_CODEX_BIN", None)
        env.pop("DSH_HOME", None)
        env.pop("PROJECT_MANAGER_HOST_HOME", None)
        env.pop("PROJECT_MANAGER_NOTIFY_BIN", None)
        env.pop("PROJECT_MANAGER_NOTIFY_ARGS", None)
        env.pop("PROJECT_MANAGER_NOTIFY_DISABLED", None)
        run([sys.executable, str(source / "scripts" / "install_local.py"), "--codex-root", str(codex_root)], env=env)

        installed = codex_root / "skills" / "project-manager"
        if not (installed / "SKILL.md").is_file():
            raise RuntimeError("隔离安装后找不到 SKILL.md")
        node_tests = sorted(str(path) for path in (installed / "scripts").glob("*.test.mjs"))
        if not node_tests:
            raise RuntimeError("隔离安装后找不到 Node 测试")

        # Exhaustive real-process interruption tests may exceed fifteen minutes.
        run([node, "--test", *node_tests], cwd=installed, env=env, timeout=1800)
        run([sys.executable, "-m", "unittest", "discover", "-s", "scripts", "-p", "test_*.py"], cwd=installed, env=env)
        print("通过：隔离安装、已支持能力/未支持拒绝 Node 回归和 Python 检查；未修改用户级 Codex 配置。完整 D3 独立执行，本结果不作完整 D3 放行。")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        print(f"验证失败：{error}", file=sys.stderr)
        raise SystemExit(1)
