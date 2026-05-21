FROM node:22-bookworm

WORKDIR /workspace

# 国内 npm 镜像
RUN npm config set registry https://registry.npmmirror.com

# 安装 OpenCode CLI
RUN npm install -g opencode-ai

# 保持容器运行，由宿主机 tmux 通过 docker exec -it worker-opencode opencode 进入
CMD ["sleep", "infinity"]
