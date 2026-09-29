FROM ubuntu@sha256:496754492fb28b4d3049432f2ca787449331e23fb14f0dd3fffea86bf5a93eb4
ENV DEBIAN_FRONTEND=noninteractive LC_ALL=C TZ=UTC
# Mutable package resolution is preparation-only. Final image ID, exact dpkg
# manifest and tool/library hashes are retained before any later admission.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl xz-utils unzip python3 git procps binutils libc-bin build-essential autoconf automake pkg-config libevent-dev libncurses-dev libutf8proc-dev bison patchelf && rm -rf /var/lib/apt/lists/*
RUN curl --fail --location --max-time 180 https://nodejs.org/dist/v26.8.2/node-v26.8.2-linux-x64.tar.xz -o /tmp/node.tar.xz && echo '40e1d3225c1c9ae9a2671c98ecb9857e4d5555026394f348645676798840d5c5  /tmp/node.tar.xz' | sha256sum -c - && mkdir -p /opt/node26 && tar -xJf /tmp/node.tar.xz -C /opt/node26 --strip-components=1 && rm /tmp/node.tar.xz
RUN curl --fail --location --max-time 180 https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-linux-x64.zip -o /tmp/bun.zip && echo '36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913  /tmp/bun.zip' | sha256sum -c - && unzip -q /tmp/bun.zip -d /tmp && mkdir /pinned && mv /tmp/bun-linux-x64/bun /pinned/bun && rm -rf /tmp/bun.zip /tmp/bun-linux-x64
RUN curl --fail --location --max-time 180 https://registry.npmjs.org/pnpm/-/pnpm-10.21.0.tgz -o /tmp/pnpm.tgz && python3 -c "import hashlib,base64;assert base64.b64encode(hashlib.sha512(open('/tmp/pnpm.tgz','rb').read()).digest()).decode()=='2jM3Jn5AD909R5psaAeaxtsB2MpPZ1cgg+cid1p5Z4inqZVmE3SeAA+sINQktZT3p5Gl9OLhNYHF75R/JpaKQA=='" && mkdir /pinned/pnpm && tar -xzf /tmp/pnpm.tgz -C /pinned/pnpm --strip-components=1 && ln -s /pinned/pnpm/bin/pnpm.cjs /pinned/pnpm.cjs && rm /tmp/pnpm.tgz
ENV PATH=/opt/node26/bin:/pinned:/usr/bin:/bin
RUN node --version && bun --version && node /pinned/pnpm.cjs --version && dpkg-query -W -f='${Package}\t${Version}\t${Architecture}\n' > /pinned/dpkg-packages.txt
