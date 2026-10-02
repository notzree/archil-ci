"""Offline production-script tests: python3 tests/test_runner_guest.py."""

import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts/runner-guest.sh"
SHA256 = "70920811a4f8ad4328818682bca5c6469c1c942fab52448868071d0063816613"
ASSET = "actions-runner-linux-x64-2.337.0.tar.gz"
PACKAGES = ["ca-certificates", "curl", "git", "tar", "gzip", "passwd", "util-linux"]


class NativeGuestTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.work = self.root / "workspace/actions"
        self.workspace = self.work / "repository/repository"
        self.workspace.mkdir(parents=True)
        self.cache = self.root / "workspace/cache"
        self.source = self.workspace / SCRIPT.name
        shutil.copyfile(SCRIPT, self.source)
        self.runner = self.root / "opt/archil-actions-runner"
        self.home = self.root / "home/runner"
        self.bin = self.root / "mock-bin"
        self.bin.mkdir()
        self.log = self.root / "commands.jsonl"
        self.env = {
            "PATH": f"{self.bin}:{os.defpath}",
            "HOME": str(self.home),
            "TMPDIR": str(self.root),
            "ARCHIL_CI_GUEST_ROOT": str(self.root),
            "ARCHIL_CI_WORKSPACE": str(self.workspace),
            "ARCHIL_CI_CACHE_ROOT": str(self.cache),
            "GITHUB_REPOSITORY": "example/project",
            "ARCHIL_CI_RUNNER_NAME": "archil-ci-123",
            "ARCHIL_CI_RUNNER_LABEL": "archil-ci-123",
            "GH_RUNNER_REGISTRATION_TOKEN": "SHORT_LIVED_TOKEN123",
            "RUNNER_ALLOW_RUNASROOT": "1",
            "MOCK_ROOT": str(self.root),
            "MOCK_LOG": str(self.log),
            "MOCK_BIN": str(self.bin),
            "MOCK_UID": "0",
        }
        mock = f"""#!{sys.executable}
import json, os, pathlib, shutil, sys
name = pathlib.Path(sys.argv[0]).name
args = sys.argv[1:]
stdin = sys.stdin.read() if name == "sha256sum" else None
with open(os.environ["MOCK_LOG"], "a") as log:
    log.write(json.dumps({{"command": name, "args": args, "stdin": stdin,
                          "cwd": os.getcwd(),
                          "debconf": os.environ.get("DEBIAN_FRONTEND"),
                          "token_env": os.environ.get("GH_RUNNER_REGISTRATION_TOKEN"),
                          "root_override": os.environ.get("RUNNER_ALLOW_RUNASROOT")}}) + "\\n")
if (name == os.environ.get("MOCK_FAIL") or
        (name == "apt-get" and "apt-get:" + args[0] == os.environ.get("MOCK_FAIL"))):
    sys.exit(31)

def safe(value):
    path = pathlib.Path(value).resolve()
    path.relative_to(pathlib.Path(os.environ["MOCK_ROOT"]).resolve())
    return path

packages = safe(pathlib.Path(os.environ["MOCK_ROOT"]) / "installed-packages")
if name in ("curl", "tar", "useradd", "runuser", "git", "gzip"):
    if not packages.exists():
        sys.exit(97)

if name == "id":
    print(os.environ.get("MOCK_UID", "0") if args == ["-u"] else os.environ.get("MOCK_USER", "runner"))
elif name == "uname":
    print(os.environ.get("MOCK_OS", "Linux") if args == ["-s"] else os.environ.get("MOCK_ARCH", "x86_64"))
elif name == "getent":
    if args == ["ahosts", "localhost"]:
        print("127.0.0.1 STREAM localhost")
    else:
        sys.exit(0 if os.environ.get("MOCK_EXISTING_USER") else 2)
elif name == "apt-get":
    if args[0] == "install":
        packages.write_text(json.dumps(args[3:]))
elif name == "curl":
    safe(args[args.index("--output") + 1]).write_bytes(b"mock runner archive")
elif name == "tar":
    output = safe(args[args.index("-C") + 1])
    (output / "bin").mkdir()
    for relative, tool in (("bin/installdependencies.sh", "dependencies"),
                           ("config.sh", "config"), ("run.sh", "run")):
        target = output / relative
        target.write_text('#!/usr/bin/env bash\\nexec "$MOCK_BIN/' + tool + '" "$@"\\n')
        target.chmod(0o755)
elif name == "useradd":
    safe(args[args.index("--home-dir") + 1]).mkdir(parents=True)
elif name == "install":
    destination = safe(args[-1])
    shutil.copyfile(args[-2], destination)
    destination.chmod(0o755)
elif name == "chown":
    for value in args[3:]:
        safe(value)
elif name == "config":
    safe(pathlib.Path.cwd() / ".runner").write_text("registered")
    safe(pathlib.Path.cwd() / ".credentials").write_text("mock credentials")
elif name in ("sha256sum", "dependencies", "run", "runuser", "git", "gzip"):
    pass
else:
    sys.exit(98)
"""
        for name in (
            "id", "uname", "getent", "curl", "tar", "useradd", "install",
            "chown", "sha256sum", "dependencies", "config", "run", "runuser", "apt-get",
            "git", "gzip",
        ):
            target = self.bin / name
            target.write_text(mock)
            target.chmod(0o755)

    def invoke(self, *args, installed=False, **env):
        script = self.runner / SCRIPT.name if installed else self.source
        return subprocess.run(
            [shutil.which("bash"), str(script), *args],
            env={**self.env, **env}, capture_output=True, text=True,
        )

    def calls(self):
        if not self.log.exists():
            return []
        return [json.loads(line) for line in self.log.read_text().splitlines()]

    def install(self):
        result = self.invoke("install")
        self.assertEqual(result.returncode, 0, result.stderr)
        return self.calls()

    def clear_log(self):
        self.log.unlink(missing_ok=True)

    def test_install_pins_verifies_then_extracts_and_creates_unprivileged_user(self):
        calls = self.install()
        self.assertEqual([c["command"] for c in calls], [
            "id", "uname", "uname", "getent", "apt-get", "apt-get", "getent", "curl", "sha256sum",
            "tar", "dependencies", "useradd", "install", "chown",
        ])
        download = calls[7]
        self.assertEqual(download["args"][:-1], [
            "--fail", "--silent", "--show-error", "--location", "--retry", "3",
            f"https://github.com/actions/runner/releases/download/v2.337.0/{ASSET}",
            "--output",
        ])
        archive = download["args"][-1]
        self.assertEqual(calls[8]["args"], ["--check", "--status"])
        self.assertEqual(calls[8]["stdin"], f"{SHA256}  {archive}\n")
        self.assertEqual(calls[9]["args"], ["-xzf", archive, "-C", str(self.runner)])
        self.assertFalse(Path(archive).exists())
        self.assertEqual(calls[11]["args"], [
            "--create-home", "--home-dir", str(self.home),
            "--shell", "/bin/bash", "--user-group", "runner",
        ])
        self.assertEqual(calls[12]["args"], [
            "-m", "0755", "--", str(self.source), str(self.runner / SCRIPT.name),
        ])
        self.assertEqual(calls[13]["args"], [
            "-R", "runner:runner", "--", str(self.runner), str(self.work),
            str(self.cache), str(self.home),
        ])
        self.assertEqual((self.runner / SCRIPT.name).read_bytes(), SCRIPT.read_bytes())
        self.assertEqual((self.runner / SCRIPT.name).stat().st_mode & 0o777, 0o755)
        self.assertTrue(self.cache.is_dir())
        self.assertNotIn(self.work, self.cache.parents)
        self.assertFalse((self.runner / ".runner").exists())
        self.assertFalse((self.runner / ".credentials").exists())

    def test_default_workspace_cache_with_no_consumer_dependencies(self):
        del self.env["ARCHIL_CI_WORKSPACE"]
        del self.env["ARCHIL_CI_CACHE_ROOT"]
        self.assertFalse((self.root / "installed-packages").exists())
        result = self.invoke("install")
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.calls()
        apt = [c for c in calls if c["command"] == "apt-get"]
        self.assertEqual([c["args"] for c in apt], [
            ["update"],
            ["install", "-y", "--no-install-recommends", *PACKAGES],
        ])
        self.assertTrue(all(c["debconf"] == "noninteractive" for c in apt))
        self.assertEqual(json.loads((self.root / "installed-packages").read_text()), PACKAGES)
        order = [c["command"] for c in calls]
        self.assertLess(order.index("apt-get"), order.index("curl"))
        self.assertLess(order.index("apt-get"), order.index("useradd"))
        self.assertTrue(self.cache.is_dir())

    def test_custom_workspace_and_cache(self):
        workspace = self.work / "other-project/other-project"
        workspace.mkdir(parents=True)
        cache = self.root / "workspace/shared-cache"
        self.env.update(ARCHIL_CI_WORKSPACE=str(workspace), ARCHIL_CI_CACHE_ROOT=str(cache))
        calls = self.install()
        self.assertTrue(cache.is_dir())
        self.assertEqual(calls[-1]["args"][-2], str(cache))

    def test_localhost_setup_preserves_custom_hosts_and_nss_entries(self):
        etc = self.root / "etc"
        etc.mkdir()
        (etc / "hosts").write_text("10.0.0.7 internal-service\n")
        (etc / "nsswitch.conf").write_text("passwd: files\nhosts: files dns\n")
        self.install()
        self.assertEqual((etc / "hosts").read_text(),
                         "10.0.0.7 internal-service\n127.0.0.1 localhost\n::1 localhost\n")
        self.assertEqual((etc / "nsswitch.conf").read_text(), "passwd: files\nhosts: files dns\n")

    def test_existing_loopback_entries_are_not_duplicated(self):
        etc = self.root / "etc"
        etc.mkdir()
        original = "127.0.0.1 localhost custom-alias\n::1 localhost ip6-localhost\n"
        (etc / "hosts").write_text(original)
        (etc / "nsswitch.conf").write_text("hosts: files dns\n")
        self.install()
        self.assertEqual((etc / "hosts").read_text(), original)

    def test_unsafe_localhost_or_nss_configuration_fails_before_download(self):
        for hosts, nss in [
            ("10.0.0.7 localhost\n", "hosts: files dns\n"),
            ("127.0.0.1 localhost\n", "hosts: dns files\n"),
        ]:
            with self.subTest(hosts=hosts, nss=nss):
                etc = self.root / "etc"
                etc.mkdir(exist_ok=True)
                (etc / "hosts").write_text(hosts)
                (etc / "nsswitch.conf").write_text(nss)
                self.clear_log()
                result = self.invoke("install")
                self.assertEqual(result.returncode, 2, result.stderr)
                self.assertFalse(any(call["command"] == "curl" for call in self.calls()))

    def test_installed_register_and_start_survive_checkout_cleanup(self):
        self.install()
        cached = self.cache / "persistent"
        cached.write_text("cached data")
        shutil.rmtree(self.workspace)
        self.assertFalse(self.source.exists())
        self.assertEqual(cached.read_text(), "cached data")
        self.assertTrue(os.access(self.runner / SCRIPT.name, os.X_OK))
        self.clear_log()
        result = self.invoke("register", installed=True, MOCK_UID="1001")
        self.assertEqual(result.returncode, 0, result.stderr)
        config = self.calls()[-1]
        self.assertEqual(config["command"], "config")
        self.assertEqual(config["args"], [
            "--unattended", "--url", "https://github.com/example/project",
            "--token", "SHORT_LIVED_TOKEN123", "--name", "archil-ci-123",
            "--labels", "archil-ci-123", "--work", str(self.work),
            "--ephemeral", "--disableupdate",
        ])
        self.assertEqual(config["cwd"], str(self.runner))
        self.assertIsNone(config["token_env"])
        self.assertIsNone(config["root_override"])
        self.assertNotIn("SHORT_LIVED_TOKEN123", result.stdout + result.stderr)
        self.clear_log()
        result = self.invoke("start", installed=True, MOCK_UID="1001")
        self.assertEqual(result.returncode, 0, result.stderr)
        run = self.calls()[-1]
        self.assertEqual(run["command"], "run")
        self.assertEqual(run["args"], [])
        self.assertIsNone(run["token_env"])
        self.assertIsNone(run["root_override"])
        self.assertEqual(cached.read_text(), "cached data")

    def test_bad_phases_have_no_side_effects(self):
        for args in ((), ("invalid",), ("install", "extra")):
            with self.subTest(args=args):
                self.assertEqual(self.invoke(*args).returncode, 2)
                self.assertEqual(self.calls(), [])

    def test_invalid_paths_have_no_side_effects(self):
        for env in (
            {"ARCHIL_CI_GUEST_ROOT": ""},
            {"ARCHIL_CI_GUEST_ROOT": "/etc"},
            {"ARCHIL_CI_GUEST_ROOT": str(self.root / "missing")},
            {"ARCHIL_CI_WORKSPACE": "/"},
            {"ARCHIL_CI_WORKSPACE": "/workspace/actions/repository/repository"},
            {"ARCHIL_CI_WORKSPACE": str(self.work)},
            {"ARCHIL_CI_WORKSPACE": str(self.work / "repository/../escape")},
            {"ARCHIL_CI_WORKSPACE": f"{self.work}/repository/./project"},
            {"ARCHIL_CI_WORKSPACE": f"{self.work}//project"},
            {"ARCHIL_CI_WORKSPACE": str(self.workspace) + "/"},
            {"ARCHIL_CI_WORKSPACE": str(self.workspace) + "\n"},
            {"ARCHIL_CI_CACHE_ROOT": ""},
            {"ARCHIL_CI_CACHE_ROOT": "/workspace/cache"},
            {"ARCHIL_CI_CACHE_ROOT": str(self.root)},
            {"ARCHIL_CI_CACHE_ROOT": str(self.root / "workspace")},
            {"ARCHIL_CI_CACHE_ROOT": str(self.work)},
            {"ARCHIL_CI_CACHE_ROOT": str(self.work / "sibling-cache")},
            {"ARCHIL_CI_CACHE_ROOT": str(self.workspace)},
            {"ARCHIL_CI_CACHE_ROOT": str(self.workspace / "cache")},
            {"ARCHIL_CI_CACHE_ROOT": str(self.workspace.parent)},
            {"ARCHIL_CI_CACHE_ROOT": str(self.root / "workspace/../escape")},
            {"ARCHIL_CI_CACHE_ROOT": f"{self.root}/workspace/./cache"},
            {"ARCHIL_CI_CACHE_ROOT": str(self.root / "workspace/cache/..")},
            {"ARCHIL_CI_CACHE_ROOT": f"{self.cache}/."},
            {"ARCHIL_CI_CACHE_ROOT": f"{self.root}/workspace//cache"},
            {"ARCHIL_CI_CACHE_ROOT": str(self.cache) + "/"},
            {"ARCHIL_CI_CACHE_ROOT": str(self.cache) + "\n"},
            {"ARCHIL_CI_CACHE_ROOT": str(self.root / "outside-workspace")},
        ):
            with self.subTest(env=env):
                self.assertEqual(self.invoke("install", **env).returncode, 2)
                self.assertEqual(self.calls(), [])
                self.assertFalse(self.runner.exists())
                self.assertFalse(self.cache.exists())
                self.assertFalse(self.home.exists())
        (self.root / "opt").symlink_to(self.workspace, target_is_directory=True)
        self.assertEqual(self.invoke("install").returncode, 2)
        self.assertEqual(self.calls(), [])

    def test_cache_symlinks_and_nondirectory_components_are_rejected(self):
        for dangling in (False, True):
            with self.subTest(dangling=dangling):
                self.cache.symlink_to(
                    self.root / ("missing" if dangling else "mock-bin"),
                    target_is_directory=True,
                )
                for path in (self.cache, self.cache / "child"):
                    self.assertEqual(self.invoke("install", ARCHIL_CI_CACHE_ROOT=str(path)).returncode, 2)
                    self.assertEqual(self.calls(), [])
                self.cache.unlink()
        self.cache.touch()
        self.assertEqual(self.invoke("install").returncode, 2)
        self.assertEqual(self.calls(), [])
        self.assertFalse(self.runner.exists())

    def test_workspace_symlink_is_rejected(self):
        link = self.work / "linked"
        link.symlink_to(self.workspace, target_is_directory=True)
        self.assertEqual(self.invoke("install", ARCHIL_CI_WORKSPACE=str(link / "project")).returncode, 2)
        self.assertEqual(self.calls(), [])

    def test_install_rejects_non_root_and_wrong_platform(self):
        for env in (
            {"MOCK_UID": "1001"}, {"MOCK_OS": "Darwin"}, {"MOCK_ARCH": "aarch64"},
        ):
            with self.subTest(env=env):
                self.clear_log()
                self.assertEqual(self.invoke("install", **env).returncode, 2)
                self.assertTrue(all(c["command"] in ("id", "uname") for c in self.calls()))

    def test_install_rejects_missing_workspace_before_package_install(self):
        result = self.invoke("install", ARCHIL_CI_WORKSPACE=str(self.work / "missing"))
        self.assertEqual(result.returncode, 2)
        self.assertTrue(all(c["command"] in ("id", "uname") for c in self.calls()))
        self.assertFalse(self.runner.exists())
        self.assertFalse((self.root / "installed-packages").exists())

    def test_register_and_start_reject_root_and_other_users(self):
        for phase in ("register", "start"):
            for env in ({"MOCK_UID": "0"}, {"MOCK_UID": "1001", "MOCK_USER": "other"}):
                with self.subTest(phase=phase, env=env):
                    self.clear_log()
                    self.assertEqual(self.invoke(phase, **env).returncode, 2)
                    self.assertTrue(all(c["command"] == "id" for c in self.calls()))

    def test_install_rejects_existing_user_and_nonempty_directory(self):
        result = self.invoke("install", MOCK_EXISTING_USER="1")
        self.assertEqual(result.returncode, 2)
        self.assertEqual([c["command"] for c in self.calls()], ["id", "uname", "uname", "getent"])
        self.runner.mkdir(parents=True)
        (self.runner / "existing").touch()
        self.clear_log()
        self.assertEqual(self.invoke("install").returncode, 2)
        self.assertEqual([c["command"] for c in self.calls()], ["id", "uname", "uname"])

    def test_credential_guard_precedes_install_or_register_mutations(self):
        self.install()
        for state in (".runner", ".credentials", ".credentials_rsaparams", ".credentials_extra"):
            for phase in ("install", "register"):
                for symlink in (False, True):
                    with self.subTest(state=state, phase=phase, symlink=symlink):
                        target = self.runner / state
                        if symlink:
                            target.symlink_to(self.runner / "missing")
                        else:
                            target.touch()
                        self.clear_log()
                        result = self.invoke(phase, MOCK_UID="0" if phase == "install" else "1001")
                        self.assertEqual(result.returncode, 2)
                        self.assertTrue(all(c["command"] in ("id", "uname") for c in self.calls()))
                        target.unlink()

    def test_invalid_registration_inputs_do_not_call_config(self):
        self.install()
        for key, values in {
            "GITHUB_REPOSITORY": ("", "owner", "https://github.com/a/b", "-owner/repo", "a/..", "a/b/c"),
            "ARCHIL_CI_RUNNER_NAME": ("", "--bad", "a b", "x" * 65, "x;echo"),
            "ARCHIL_CI_RUNNER_LABEL": ("", "a,b", "-bad", "x/y", "x" * 65),
            "GH_RUNNER_REGISTRATION_TOKEN": ("", "a b", "x\n", "x\r", "a/b", "x;echo", "x" * 513),
            "HOME": ("", "/root"),
        }.items():
            for value in values:
                with self.subTest(key=key, value=value):
                    self.clear_log()
                    result = self.invoke("register", MOCK_UID="1001", **{key: value})
                    self.assertEqual(result.returncode, 2)
                    self.assertNotIn("config", [c["command"] for c in self.calls()])
                    self.assertNotIn("SHORT_LIVED_TOKEN123", result.stdout + result.stderr)

    def test_opaque_visible_registration_tokens_are_passed_without_logging(self):
        self.install()
        for token in ("opaque.Token_1-with-dashes", "--opaque", ".token", "x" * 512):
            with self.subTest(token=token):
                self.clear_log()
                result = self.invoke("register", MOCK_UID="1001", GH_RUNNER_REGISTRATION_TOKEN=token)
                self.assertEqual(result.returncode, 0, result.stderr)
                config = self.calls()[-1]
                self.assertEqual(config["args"][config["args"].index("--token") + 1], token)
                self.assertIsNone(config["token_env"])
                self.assertNotIn(token, result.stdout + result.stderr)
                (self.runner / ".runner").unlink()
                (self.runner / ".credentials").unlink()

    def test_package_failures_precede_download_and_guest_mutations(self):
        for index, step in enumerate(("update", "install")):
            with self.subTest(step=step):
                self.clear_log()
                result = self.invoke("install", MOCK_FAIL=f"apt-get:{step}")
                self.assertEqual(result.returncode, 31, result.stderr)
                calls = self.calls()
                self.assertEqual([c["command"] for c in calls],
                                 ["id", "uname", "uname", "getent"] + ["apt-get"] * (index + 1))
                self.assertEqual(calls[-1]["args"][0], step)
                self.assertFalse((self.root / "installed-packages").exists())
                self.assertFalse(self.runner.exists())
                self.assertFalse(self.home.exists())
                self.assertFalse(self.cache.exists())
                self.assertEqual(list(self.workspace.parent.glob("archil-runner.*")), [])

    def test_download_checksum_and_install_failures_stop_immediately(self):
        order = ["curl", "sha256sum", "tar", "dependencies", "useradd", "install", "chown"]
        for index, command in enumerate(order):
            with self.subTest(command=command):
                shutil.rmtree(self.runner, ignore_errors=True)
                shutil.rmtree(self.home, ignore_errors=True)
                self.clear_log()
                result = self.invoke("install", MOCK_FAIL=command)
                self.assertEqual(result.returncode, 31, result.stderr)
                calls = [c["command"] for c in self.calls()]
                self.assertEqual(calls[-1], command)
                for later in order[index + 1:]:
                    self.assertNotIn(later, calls)
                self.assertEqual(list(self.workspace.parent.glob("archil-runner.*")), [])
                if command in ("curl", "sha256sum"):
                    self.assertFalse(self.runner.exists())

    def test_start_requires_registration_and_propagates_run_failure(self):
        self.install()
        self.clear_log()
        self.assertEqual(self.invoke("start", MOCK_UID="1001").returncode, 2)
        self.assertNotIn("run", [c["command"] for c in self.calls()])
        result = self.invoke("register", MOCK_UID="1001", MOCK_FAIL="config")
        self.assertEqual(result.returncode, 31)
        self.assertFalse((self.runner / ".runner").exists())
        self.assertEqual(self.invoke("register", MOCK_UID="1001").returncode, 0)
        self.assertEqual(self.invoke("start", MOCK_UID="1001", MOCK_FAIL="run").returncode, 31)


if __name__ == "__main__":
    unittest.main()
