# Installed into .venv by scripts/setup-python.sh only on Macs where
# platform.mac_ver() returns an empty version. pip and packaging parse that
# version to pick wheels and crash on "" — this fills it in from the system.
import platform
import subprocess

_original_mac_ver = platform.mac_ver


def _system_version() -> str:
    for cmd in (["/usr/bin/sw_vers", "-productVersion"], ["/usr/sbin/sysctl", "-n", "kern.osproductversion"]):
        try:
            v = subprocess.run(cmd, capture_output=True, text=True, timeout=5).stdout.strip()
        except Exception:  # noqa: BLE001
            continue
        if v and v.split(".")[0].isdigit():
            return v
    return "11.0"  # oldest version with arm64 wheels; still installs everything we need


def mac_ver(release="", versioninfo=("", "", ""), machine=""):
    r = _original_mac_ver(release, versioninfo, machine)
    if r[0]:
        return r
    return (_system_version(), r[1], r[2] or platform.machine())


platform.mac_ver = mac_ver
