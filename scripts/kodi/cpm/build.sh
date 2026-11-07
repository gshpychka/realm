#!/usr/bin/env bash
# Builds the CPM CoreELEC update tar for the kodi box, on an x86_64 Linux host
# with Docker (reaper):
#   scripts/kodi/cpm/build.sh [workdir] > build.log 2>&1
# The tar lands in <workdir>/target. Deployment: scripts/kodi/runbook.md.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
WORK=${1:-$HOME/build/cpm-coreelec}
REPO=https://github.com/cpm-code/CoreELEC.git
COMMIT=976e9a652fc2c8a5cebf47a71ba7ab4ec0e625a1
IMAGE=coreelec-cpm
BUILD_ENV=(-e PROJECT=Amlogic-ce -e DEVICE=Amlogic-ng -e ARCH=aarch64 -e SUBDEVICE=Ugoos_AM6B)
# Sources fetched from a location of our choosing, each checked against its
# package's PKG_SHA256. Debian dropped this fakeroot release from its pool and
# no CoreELEC or LibreELEC mirror carries it; the snapshot archive keeps every
# published file. ftp.denx.de times out, and LibreELEC's mirror files U-Boot
# 2016.03 under u-boot, a directory the build's mirror lookup skips.
SOURCE_OVERRIDES="fakeroot=https://snapshot.debian.org/file/1a721c2b4093a4e83dc091dc41a028f19340c1b3
u-boot-tools=https://sources.libreelec.tv/mirror/u-boot/u-boot-2016.03.tar.bz2"

if [ ! -d "$WORK" ]; then
  git init -q "$WORK"
  git -C "$WORK" fetch -q --depth 1 "$REPO" "$COMMIT"
  git -C "$WORK" checkout -q FETCH_HEAD
  fresh=1
fi

docker build -q --pull -t "$IMAGE-base" "$WORK/tools/docker/noble" >/dev/null
# The tree's checkdeps requires wget, which its noble image lacks.
docker build -q -t "$IMAGE" - >/dev/null <<EOF
FROM $IMAGE-base
USER root
RUN apt-get update && apt-get install -y --no-install-recommends wget ca-certificates && rm -rf /var/lib/apt/lists/*
USER docker
EOF

# The build refuses to run as root, so the tree belongs to the image's build
# user.
if [ "${fresh:-0}" = 1 ]; then
  uid=$(docker run --rm "$IMAGE" id -u)
  docker run --rm --log-driver none -u 0 -v "$WORK":/build "$IMAGE" chown -R "$uid:$uid" /build
fi

# A build stopped mid-package leaves truncated objects behind: run
# scripts/clean <package> in the container for each package that was building
# before running this again.
# CoreELEC's build scripts read unset variables, so the container shell runs
# without -u.
exec docker run --rm --log-driver none --name cpm-build \
  -v "$WORK":/build -v "$HERE/patches":/patches:ro -w /build "${BUILD_ENV[@]}" \
  -e SOURCE_OVERRIDES="$SOURCE_OVERRIDES" "$IMAGE" bash -ec '
    # Ours are the local-*.patch files. A changed set changes the package
    # hash, so the build re-unpacks and re-patches that package.
    for target in kodi:projects/Amlogic-ce/packages/mediacenter/kodi/patches \
                  linux:projects/Amlogic-ce/devices/Amlogic-ng/patches/linux; do
      dir=${target#*:}
      rm -f "$dir"/local-*.patch
      cp /patches/"${target%%:*}"/local-*.patch "$dir"/
    done

    for override in $SOURCE_OVERRIDES; do
      (
        name=${override%%=*}
        . config/options "$name"
        package="$SOURCES/$name/$PKG_SOURCE_NAME"
        if [ ! -f "$package.sha256" ]; then
          mkdir -p "$SOURCES/$name"
          curl -fsSL -o "$package" "${override#*=}"
          echo "$PKG_SHA256  $package" | sha256sum -c --quiet
          echo "$PKG_SHA256" > "$package.sha256"
          echo "$PKG_URL" > "$package.url"
        fi
      )
    done

    make release
  '
