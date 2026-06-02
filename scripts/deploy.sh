#!/bin/bash

SERVER="192.168.112.133"
USER="root"
TARGET_DIR="/opt/avator/dist"

echo "📦 1/4 Building project..."
npm run build
echo ""

echo "📂 2/4 Creating target directory on server..."
ssh "$USER@$SERVER" "mkdir -p $TARGET_DIR"
echo ""

echo "📤 3/4 Deploying to $USER@$SERVER:$TARGET_DIR ..."
scp -r dist/* "$USER@$SERVER:$TARGET_DIR/"
echo ""

echo "🔄 4/4 Reloading nginx (Docker container: avatar-web)..."
ssh "$USER@$SERVER" "docker exec avatar-web nginx -s reload"
echo ""

echo "✅ Deploy complete!"
echo ""
echo "🔍 Verifying remote $TARGET_DIR ..."
ssh "$USER@$SERVER" "ls -lh $TARGET_DIR/index.html $TARGET_DIR/assets/index-*.js 2>&1 | tail -5"
echo ""
echo "💡 浏览器如果还是旧内容，请强制刷新: Cmd+Shift+R"
