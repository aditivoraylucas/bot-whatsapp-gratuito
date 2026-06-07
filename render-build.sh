#!/bin/bash
# Instala dependências Node.js
npm install

# Instala Python e Whisper para transcrição de áudio
pip install openai-whisper
apt-get install -y ffmpeg 2>/dev/null || true
