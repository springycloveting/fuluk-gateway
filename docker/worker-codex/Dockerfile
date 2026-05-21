FROM node:22-bookworm

WORKDIR /workspace

# 国内 npm 镜像
RUN npm config set registry https://registry.npmmirror.com

# 安装 Codex CLI
RUN npm install -g @openai/codex

# 保持容器运行，由宿主机 tmux 通过 docker exec -it worker-codex codex 进入
CMD ["sleep", "infinity"]
