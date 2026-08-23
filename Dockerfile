FROM node:22-bookworm-slim AS base

# Install system dependencies needed for agent execution. musl-tools builds the
# Landlock launcher (the only usable Linux sandbox backend inside Docker:
# bubblewrap needs CLONE_NEWUSER, which Docker's default seccomp profile denies).
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    python3 \
    curl \
    ca-certificates \
    bash \
    procps \
    musl-tools \
    && rm -rf /var/lib/apt/lists/*

# Setup pnpm
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@11.7.0 --activate

WORKDIR /app

# Set Git commit hash for client build metadata (pass the building commit;
# "unknown" marks an unattributed build)
ARG DSH_CLIENT_COMMIT_HASH=unknown
ENV DSH_CLIENT_COMMIT_HASH=${DSH_CLIENT_COMMIT_HASH}

# Copy root workspace configurations and lockfiles
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsdown.config.ts ./
COPY tsconfig*.json ./
COPY patches ./patches

# Copy all source directories and configurations
COPY packages ./packages
COPY apps ./apps
COPY vendor ./vendor
COPY scripts ./scripts
COPY docs ./docs
COPY native ./native
COPY federation ./federation
COPY examples ./examples
COPY website ./website

# Install workspace dependencies and compile libraries and frontend
RUN pnpm install --frozen-lockfile
RUN pnpm run build
# Compile the landlock-run launcher for this build architecture so confined
# shell execution has an enforcing backend inside the container.
RUN cd native/landlock-run && pnpm build:native

# Default environment configuration
ENV NODE_ENV=production

EXPOSE 3080

CMD ["node", "apps/cli/lib/bin.js", "web"]
