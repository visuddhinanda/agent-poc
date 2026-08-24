# WikiPali MCP server —— 多阶段构建
#
# 构建前请把 package-lock.json 纳入版本管理（当前 .gitignore 忽略了它），
# 否则 `npm ci` 无法复现依赖。命令：
#   docker build -t wikipali-mcp .

# ---- 构建阶段：需要 devDependencies（typescript 等） ----
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- 运行阶段：只装生产依赖，跑编译产物 ----
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# 无状态：server 不读任何凭据文件；凭据由客户端经 HTTP 头提供
ENV PORT=3000 \
    MCP_HOST=0.0.0.0
#    WIKIPALI_API_URL=https://next.wikipali.org/api
#    MCP_ALLOWED_HOSTS=mcp.example.com,localhost

EXPOSE 3000
CMD ["node", "dist/index.js"]
