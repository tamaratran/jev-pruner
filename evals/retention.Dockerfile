ARG BASE_IMAGE=jev-claude-smoke:2.1.274
FROM ${BASE_IMAGE}
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pytest \
    && rm -rf /var/lib/apt/lists/*
