#!/bin/bash
set -e

echo "=========================================="
echo "🚀 Iniciando despliegue de Smability Lambda"
echo "=========================================="

echo "1️⃣ Actualizando código desde GitHub..."
git pull origin main

echo "2️⃣ Instalando dependencias limpias..."
npm install --production

echo "3️⃣ Empaquetando en function.zip..."
rm -f function.zip
zip -r function.zip . -x "*.git*" -x "deploy.sh" -x "README.md" -x ".gitignore"

echo "4️⃣ Actualizando función en AWS Lambda..."
aws lambda update-function-code \
    --function-name smabilitydatacollector \
    --zip-file fileb://function.zip \
    --no-cli-pager

echo "=========================================="
echo "✅ ¡Despliegue de Smability Collector exitoso!"
echo "=========================================="
