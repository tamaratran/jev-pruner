FROM jev-coreutils-causal-probe:local
RUN apk add --no-cache nodejs=22.23.2-r0 npm=11.6.4-r0 ripgrep=14.1.1-r0 \
    && npm install -g @openai/codex@0.152.1 \
    && ln -s /usr/bin/node /usr/local/bin/node
COPY dist /opt/jev-eval/dist
COPY evals/codex_checkpoint.mjs evals/codex-preview.mjs evals/codex_start.mjs evals/codex_gate.mjs evals/codex_command.mjs evals/codex_observer.mjs /opt/jev-eval/evals/
COPY evals/observer/evidence-isolation.mjs /opt/jev-eval/evals/observer/
RUN mkdir -p /opt/jev-eval/private /opt/jev-eval/evidence /opt/jev-eval/codex-home \
    && chmod 700 /opt/jev-eval/private /opt/jev-eval/evidence /opt/jev-eval/codex-home \
    && touch /opt/jev-eval/codex-home/config.toml
ENV CODEX_HOME=/opt/jev-eval/codex-home CFLAGS=-g0 PYTHONPATH=/pkg/:/root/ JEV_EVAL_ARM=control
WORKDIR /workdir
CMD ["tail", "-f", "/dev/null"]
