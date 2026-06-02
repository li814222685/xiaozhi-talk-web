#!/bin/bash
set -e

SERVER="192.168.112.133"
USER="root"
TARGET_DIR="/opt/avator"

echo "📦 Building project..."
npm run build

echo "📂 Creating target directory on server..."
ssh "$USER@$SERVER" "mkdir -p $TARGET_DIR"

echo "📤 Deploying to $USER@$SERVER:$TARGET_DIR ..."
scp -r dist/* "$USER@$SERVER:$TARGET_DIR/"

echo "🔄 Restarting nginx..."
ssh "$USER@$SERVER" "systemctl restart nginx || nginx -s reload"

echo "✅ Deploy complete!"
