#!/bin/bash

# VPS隧道管理面板 - Agent客户端安装脚本
# 此脚本用于在VPS上安装Agent客户端

set -e

echo "=== 安装VPS Agent客户端 ==="

# 检查Node.js
if ! command -v node &> /dev/null; then
    echo "错误: 未找到Node.js，请先安装Node.js"
    exit 1
fi

# 下载Agent客户端文件
echo "下载Agent客户端..."
curl -fsSL https://raw.githubusercontent.com/wenxin-99/vps-agent-client/main/agent.js -o /opt/vps-agent/agent.js
curl -fsSL https://raw.githubusercontent.com/wenxin-99/vps-agent-client/main/package.json -o /opt/vps-agent/package.json

chmod +x /opt/vps-agent/agent.js

# 安装依赖
echo "安装依赖..."
cd /opt/vps-agent
npm install --production --silent

echo "=== Agent客户端安装完成 ==="
