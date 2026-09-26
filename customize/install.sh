#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# rsdk-webui customize hook for profile "E25 (GitHub Actions)" (gh-e25-01)
#
# Executed by bdebstrap as a `customize-hook` *inside the build container*,
# with $1 = path to the freshly built rootfs.
#
# It is inserted into the upstream rootfs.jsonnet right after `+ cleanup()`,
# so it runs before upstream's own trailing hooks (fingerprint, update-initramfs,
# u-boot-update).
#
# Generated file - edit the profile in the web UI, not this file.
# ---------------------------------------------------------------------------
set -euo pipefail

ROOTFS="${1:?usage: install.sh <rootfs-path>}"
BUNDLE="${RSDK_BUNDLE:-/rsdk-bundle}"
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_SUSPEND=1

step() { printf '\n\033[1;36m=== [rsdk-webui] %s\033[0m\n' "$*"; }

# apt operating on the target rootfs, using mmdebstrap's apt config when present
apt_root() {
  if [[ -n "${MMDEBSTRAP_APT_CONFIG:-}" ]]; then
    APT_CONFIG="$MMDEBSTRAP_APT_CONFIG" apt-get -oDPkg::Chroot-Directory="$ROOTFS" "$@"
  else
    chroot "$ROOTFS" env DEBIAN_FRONTEND=noninteractive apt-get "$@"
  fi
}

in_root() { chroot "$ROOTFS" "$@"; }

# enable a systemd unit offline, without needing a running systemd
enable_unit() {
  local unit="${1:-}" target="" dir
  for dir in usr/lib/systemd/system lib/systemd/system; do
    if [[ -e "$ROOTFS/$dir/$unit" ]]; then
      target="/$dir/$unit"
      break
    fi
  done
  if [[ -z "$target" ]]; then
    printf 'warn: systemd unit %s not found in rootfs\n' "$unit" >&2
    return 1
  fi
  install -d -m 0755 "$ROOTFS/etc/systemd/system/multi-user.target.wants"
  ln -sf "$target" "$ROOTFS/etc/systemd/system/multi-user.target.wants/$unit"
}

step "apt-get update"
apt_root update
step "安装 3 个附加软件包"
apt_root install -y --no-install-recommends htop htop nano
apt_root clean

step "写入 1 个覆盖文件"
install -D -m 0644 "$BUNDLE/customize/blobs/overlay-00-motd" "$ROOTFS/etc/motd"

step "设置主机名: e25-lab (通过 jsonnet hostname 字段)"
sed -i -e "/^127\.0\.1\.1[[:space:]]/d" "$ROOTFS/etc/hosts"
printf '127.0.1.1\t%s\n' e25-lab >> "$ROOTFS/etc/hosts"

step "设置时区: Asia/Shanghai"
ln -sf /usr/share/zoneinfo/Asia/Shanghai "$ROOTFS/etc/localtime"
printf '%s\n' Asia/Shanghai > "$ROOTFS/etc/timezone"
step "设置区域: zh_CN.UTF-8"
install -d -m 0755 "$ROOTFS/etc/default"
sed -i -E "s|^#[[:space:]]*(zh_CN\.UTF-8[[:space:]]+UTF-8)|\1|" "$ROOTFS/etc/locale.gen"
grep -qE "^zh_CN\.UTF-8" "$ROOTFS/etc/locale.gen" || printf '%s\n' 'zh_CN.UTF-8 UTF-8' >> "$ROOTFS/etc/locale.gen"
printf 'LANG=%s\n' zh_CN.UTF-8 > "$ROOTFS/etc/default/locale"
in_root locale-gen
install -D -m 0644 "$BUNDLE/customize/blobs/keyboard" "$ROOTFS/etc/default/keyboard"

step "创建用户: radxa"
if in_root id -u radxa >/dev/null 2>&1; then
  in_root usermod -s /bin/bash radxa
else
  in_root useradd -m -s /bin/bash -U radxa
fi
in_root usermod -aG sudo radxa
in_root passwd -d radxa || true
install -D -m 0440 "$BUNDLE/customize/blobs/sudoers-radxa" "$ROOTFS/etc/sudoers.d/90-rsdk-webui-radxa"
install -d -m 0700 "$ROOTFS/home/radxa/.ssh"
install -D -m 0600 "$BUNDLE/customize/blobs/authorized_keys-radxa" "$ROOTFS/home/radxa/.ssh/authorized_keys"
in_root chown -R radxa:radxa /home/radxa/.ssh

step "配置 SSH"
install -D -m 0644 "$BUNDLE/customize/blobs/sshd_config.d.conf" "$ROOTFS/etc/ssh/sshd_config.d/90-rsdk-webui.conf"
if [[ -e "$ROOTFS/usr/sbin/sshd" ]]; then enable_unit ssh.service || true; else echo "warn: sshd not installed" >&2; fi

step "启用 systemd 服务"
enable_unit avahi-daemon.service || true

step "customization finished"
