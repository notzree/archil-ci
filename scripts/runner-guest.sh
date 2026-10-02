#!/usr/bin/env bash
# Disable inherited tracing before handling the short-lived registration token.
set +x
set -euo pipefail

die() {
    printf 'runner-guest: %s\n' "$1" >&2
    exit 2
}

[[ $# == 1 ]] || die "usage: runner-guest.sh install|register|start"
phase=$1
case "$phase" in
    install|register|start) ;;
    *) die "phase must be install, register, or start" ;;
esac

safe_path() {
    local path=$1 component current=
    local -a components
    [[ "$path" =~ ^/[A-Za-z0-9_./-]+$ && "$path" != */ ]] || die "invalid directory"
    [[ "$path" != *//* && "$path" != */./* && "$path" != */../* &&
        "$path" != */. && "$path" != */.. ]] || die "directory must be canonical"
    IFS=/ read -r -a components <<< "$path"
    for component in "${components[@]}"; do
        [[ -n "$component" ]] || continue
        current="$current/$component"
        [[ ! -L "$current" ]] || die "directory must not contain symlinks"
        [[ ! -e "$current" || -d "$current" ]] || die "directory component is not a directory"
    done
}

# A single prefix keeps test installations wholly inside their temporary root.
guest_root=${ARCHIL_CI_GUEST_ROOT-/}
if [[ "$guest_root" != / ]]; then
    safe_path "$guest_root"
    [[ -d "$guest_root" && "$(cd -- "$guest_root" && pwd -P)" == "$guest_root" ]] ||
        die "guest root must be an existing canonical directory"
    case "$guest_root" in
        /opt|/opt/*|/workspace|/workspace/*|/etc|/etc/*|/usr|/usr/*|/home|/home/*)
            die "unsafe guest root" ;;
    esac
fi
prefix=${guest_root%/}
runner_dir="$prefix/opt/archil-actions-runner"
work_dir="$prefix/workspace/actions"
runner_home="$prefix/home/runner"
workspace=${ARCHIL_CI_WORKSPACE-"$work_dir/repository/repository"}
cache_root=${ARCHIL_CI_CACHE_ROOT-"$prefix/workspace/cache"}
for directory in "$runner_dir" "$work_dir" "$runner_home" "$workspace" "$cache_root"; do
    safe_path "$directory"
done
[[ "$workspace" == "$work_dir/"* ]] || die "workspace must be inside runner work directory"
[[ "$cache_root" == "$prefix/workspace/"* &&
    "$cache_root" != "$work_dir" && "$cache_root" != "$work_dir/"* &&
    "$work_dir" != "$cache_root/"* &&
    "$cache_root" != "$workspace" && "$cache_root" != "$workspace/"* &&
    "$workspace" != "$cache_root/"* ]] ||
    die "cache root must be under /workspace and outside checkout and runner work directory"

unregistered() {
    local state
    shopt -s nullglob
    for state in "$runner_dir/.runner" "$runner_dir"/.credentials*; do
        [[ ! -e "$state" && ! -L "$state" ]] || die "runner registration state already exists"
    done
}

if [[ "$phase" == install ]]; then
    [[ $(id -u) == 0 ]] || die "install requires root"
    [[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || die "install requires Linux x86-64"
    unregistered
    [[ -d "$workspace" ]] || die "workspace bootstrap must run before install"
    if [[ -d "$runner_dir" ]]; then
        shopt -s nullglob dotglob
        existing=("$runner_dir"/*)
        [[ ${#existing[@]} == 0 ]] || die "install requires an empty runner directory"
        shopt -u dotglob
    fi
    if command -v getent >/dev/null && getent passwd runner >/dev/null; then
        die "install requires a fresh dedicated runner user"
    fi
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y --no-install-recommends \
        ca-certificates curl git tar gzip passwd util-linux
    etc="$prefix/etc"
    mkdir -p -- "$etc"
    for file in "$etc/hosts" "$etc/nsswitch.conf"; do
        [[ ! -L "$file" ]] || die "guest hostname configuration must not be a symlink"
    done
    [[ -e "$etc/hosts" ]] || : > "$etc/hosts"
    if awk '
        { sub(/#.*/, ""); for (i=2; i<=NF; i++)
            if (tolower($i) == "localhost" && $1 != "127.0.0.1" && $1 != "::1") bad=1 }
        END { exit !bad }
    ' "$etc/hosts"; then
        die "localhost has a non-loopback hosts mapping"
    fi
    for address in 127.0.0.1 ::1; do
        if ! awk -v address="$address" '
            { sub(/#.*/, ""); if ($1 == address) for (i=2; i<=NF; i++)
                if (tolower($i) == "localhost") found=1 }
            END { exit !found }
        ' "$etc/hosts"; then
            printf '%s localhost\n' "$address" >> "$etc/hosts"
        fi
    done
    [[ -e "$etc/nsswitch.conf" ]] || : > "$etc/nsswitch.conf"
    if grep -q '^[[:space:]]*hosts:' "$etc/nsswitch.conf"; then
        grep -Eq '^[[:space:]]*hosts:[[:space:]]+files([[:space:]]|$)' "$etc/nsswitch.conf" ||
            die "guest NSS hosts policy must consult files first"
    else
        printf 'hosts: files dns\n' >> "$etc/nsswitch.conf"
    fi
    getent ahosts localhost >/dev/null || die "guest localhost lookup failed"
    downloads=$(mktemp -d "$(dirname -- "$workspace")/archil-runner.XXXXXXXX")
    trap 'rm -rf -- "$downloads"' EXIT
    asset=actions-runner-linux-x64-2.337.0.tar.gz
    curl --fail --silent --show-error --location --retry 3 \
        "https://github.com/actions/runner/releases/download/v2.337.0/$asset" \
        --output "$downloads/$asset"
    printf '%s  %s\n' \
        70920811a4f8ad4328818682bca5c6469c1c942fab52448868071d0063816613 \
        "$downloads/$asset" | sha256sum --check --status
    mkdir -p -- "$runner_dir"
    tar -xzf "$downloads/$asset" -C "$runner_dir"
    bash "$runner_dir/bin/installdependencies.sh"
    useradd --create-home --home-dir "$runner_home" --shell /bin/bash --user-group runner
    mkdir -p -- "$work_dir" "$cache_root"
    install -m 0755 -- "${BASH_SOURCE[0]}" "$runner_dir/runner-guest.sh"
    chown -R runner:runner -- "$runner_dir" "$work_dir" "$cache_root" "$runner_home"
    unregistered
    exit 0
fi

[[ $(id -u) != 0 && $(id -un) == runner ]] || die "register and start require the unprivileged runner user"
[[ "${HOME-}" == "$runner_home" ]] || die "HOME must be the runner home"
[[ -d "$runner_dir" && -x "$runner_dir/config.sh" && -x "$runner_dir/run.sh" ]] ||
    die "runner installation is missing"
unset RUNNER_ALLOW_RUNASROOT
cd -- "$runner_dir"
if [[ "$phase" == start ]]; then
    [[ -f .runner && -f .credentials ]] || die "runner is not registered"
    unset GH_RUNNER_REGISTRATION_TOKEN
    exec ./run.sh
fi

unregistered
repository=${GITHUB_REPOSITORY-}
name=${ARCHIL_CI_RUNNER_NAME-}
label=${ARCHIL_CI_RUNNER_LABEL-}
token=${GH_RUNNER_REGISTRATION_TOKEN-}
[[ "$repository" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,37}[A-Za-z0-9])?/[A-Za-z0-9_.-]{1,100}$ &&
    "${repository#*/}" != . && "${repository#*/}" != .. ]] || die "invalid repository"
[[ "$name" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$ ]] || die "invalid runner name"
[[ "$label" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$ ]] || die "invalid runner label"
[[ "$token" =~ ^[A-Za-z0-9_.-]+$ && ${#token} -le 512 ]] || die "invalid registration token"
# Pass the token only as config.sh's argument, not in subprocess environments.
unset GH_RUNNER_REGISTRATION_TOKEN
trap 'unset token GH_RUNNER_REGISTRATION_TOKEN' EXIT
status=0
./config.sh --unattended --url "https://github.com/$repository" --token "$token" \
    --name "$name" --labels "$label" --work "$work_dir" --ephemeral --disableupdate || status=$?
unset token
exit "$status"
