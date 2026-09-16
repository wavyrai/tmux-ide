# Digest pins are qualified in plans/development-instances/evidence/d09-preflight.json.
FROM oven/bun:1.4.2@sha256:9114c058aeae42162ee16dd5084b95fe9473970bb6bcb5b232ab1630f0546895 AS bun
FROM node:24-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS toolchain
ARG DEBIAN_SNAPSHOT=20260910T000000Z
RUN rm -f /etc/apt/sources.list.d/debian.sources && \
    printf 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/%s bookworm main\ndeb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/%s bookworm-security main\n' "$DEBIAN_SNAPSHOT" "$DEBIAN_SNAPSHOT" > /etc/apt/sources.list && \
    apt-get -o Acquire::Check-Valid-Until=false -o Acquire::http::Timeout=30 -o Acquire::Retries=1 update && \
    apt-get install -y --no-install-recommends build-essential autoconf automake pkg-config libevent-dev libncurses-dev libutf8proc-dev bison patchelf git ca-certificates python3 tini procps && \
    mkdir -p /opt/fixture && dpkg-query -W > /opt/fixture/debian-packages.txt && \
    rm -rf /var/lib/apt/lists/*
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN npm install --global --ignore-scripts pnpm@10.21.0 && \
    test "$(bun --version)" = 1.4.2 && test "$(pnpm --version)" = 10.21.0 && \
    mkdir -p /workspace /state /build /evidence /opt/native && chown -R node:node /workspace /state /build /evidence /opt/native
ENV HOME=/home/node PNPM_HOME=/home/node/.local/share/pnpm
WORKDIR /workspace
USER node
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bash"]

FROM toolchain AS native-tmux
COPY --chown=node:node native/tmux /build/source/native/tmux
COPY --chown=node:node scripts/build-bundled-tmux.mjs /build/source/scripts/build-bundled-tmux.mjs
COPY --chown=node:node scripts/lib/linux-tmux-bundle.mjs /build/source/scripts/lib/linux-tmux-bundle.mjs
COPY --chown=node:node packages/daemon/src/terminal/mirror/native-grid-capture.ts /build/source/packages/daemon/src/terminal/mirror/native-grid-capture.ts
RUN git init /build/tmux-source && \
    git -C /build/tmux-source remote add origin https://github.com/tmux/tmux.git && \
    git -C /build/tmux-source fetch --depth=1 origin e476c1230b958df0cb12977517d24b3dc931375b && \
    git -C /build/tmux-source checkout --detach FETCH_HEAD && \
    node /build/source/scripts/build-bundled-tmux.mjs --source /build/tmux-source --output /opt/native/tmux --jobs 2

FROM native-tmux AS source-development
USER root
RUN mkdir -p /pnpm/store /opt/source-snapshot && chown -R node:node /pnpm /opt/source-snapshot
USER node
COPY --chown=node:node . /opt/source-snapshot
WORKDIR /opt/source-snapshot
RUN test -f .development-container-source.json && test "$(node -p 'require("./package.json").packageManager')" = pnpm@10.21.0 && \
    test "$(cat .bun-version)" = 1.4.2 && \
    pnpm fetch --frozen-lockfile --ignore-scripts --store-dir /pnpm/store --network-concurrency=4
WORKDIR /workspace
CMD ["bash"]

# Build artifacts and fresh runtime dependencies separately from source node_modules.
FROM source-development AS packed-build
RUN node /opt/source-snapshot/docker/development/prepare-source.mjs /opt/source-snapshot /workspace/packed-source
WORKDIR /workspace/packed-source
RUN node scripts/build-cli.mjs && \
    bun scripts/build-tui.mjs --outfile /evidence/tmux-ide-tui && \
    /evidence/tmux-ide-tui __release-provenance > /evidence/tui-provenance.json && \
    npm pack --ignore-scripts --pack-destination /evidence --json > /evidence/pack.json && \
    node -e 'const fs=require("fs"),p=JSON.parse(fs.readFileSync("/evidence/pack.json"))[0];fs.renameSync("/evidence/"+p.filename,"/evidence/tmux-ide.tgz")' && \
    node docker/development/prepare-packed-lock.mjs package.json /evidence/tmux-ide.tgz docker/development/packed-package-lock.json /evidence/install
WORKDIR /evidence/install
RUN npm ci --ignore-scripts --no-audit --no-fund && \
    npm_config_build_from_source=true npm_config_nodedir=/usr/local npm_config_jobs=2 npm rebuild node-pty @parcel/watcher && \
    node node_modules/tmux-ide/bin/cli.js --version && \
    rm tmux-ide.tgz

# No source checkout, source node_modules, or Bun executable in the installed lane.
FROM node:24-bookworm-slim@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553 AS packed-install
ARG DEBIAN_SNAPSHOT=20260910T000000Z
RUN rm -f /etc/apt/sources.list.d/debian.sources && \
    printf 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/%s bookworm main\ndeb [check-valid-until=no] http://snapshot.debian.org/archive/debian-security/%s bookworm-security main\n' "$DEBIAN_SNAPSHOT" "$DEBIAN_SNAPSHOT" > /etc/apt/sources.list && \
    apt-get -o Acquire::Check-Valid-Until=false -o Acquire::http::Timeout=30 -o Acquire::Retries=1 update && \
    apt-get install -y --no-install-recommends git procps ca-certificates && \
    mkdir -p /opt/fixture && dpkg-query -W > /opt/fixture/runtime-debian-packages.txt && \
    rm -rf /var/lib/apt/lists/*
COPY --from=toolchain /usr/bin/tini /usr/bin/tini
COPY --from=toolchain /opt/fixture/debian-packages.txt /opt/fixture/build-debian-packages.txt
COPY --from=packed-build --chown=node:node /evidence/install /opt/installed
COPY --from=packed-build --chown=node:node /evidence/tmux-ide-tui /opt/fixture/tmux-ide-tui
COPY --from=packed-build /evidence/pack.json /opt/fixture/pack.json
COPY --from=packed-build /evidence/tui-provenance.json /opt/fixture/tui-provenance.json
COPY --from=packed-build /workspace/packed-source/.development-container-source.json /opt/fixture/source-provenance.json
COPY docker/development/packed-probe.mjs /opt/fixture/packed-probe.mjs
RUN ln -s "/opt/installed/node_modules/tmux-ide/packages/daemon/dist/native/tmux/linux-$(node -p process.arch)/tmux" /usr/local/bin/tmux && \
    mkdir -p /workspace /state /evidence && chown -R node:node /workspace /state /evidence
ENV HOME=/home/node PATH=/opt/installed/node_modules/.bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin TMUX_IDE_TUI_BIN=/opt/fixture/tmux-ide-tui
USER node
WORKDIR /workspace
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["bash"]
