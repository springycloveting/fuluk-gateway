FROM node:22-bookworm

WORKDIR /workspace

# 国内 npm 镜像
RUN npm config set registry https://registry.npmmirror.com

# 安装 Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# 保持容器运行，由宿主机 tmux 通过 docker exec -it worker-claude claude 进入
CMD ["sleep", "infinity"]
