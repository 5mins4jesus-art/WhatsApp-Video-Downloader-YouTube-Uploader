#!/bin/bash
# ============================================================
# WhatsApp Video Downloader + YouTube Uploader
# Setup & Prerequisites Check
# ============================================================

set -e

WORKSPACE="$HOME/workspace"
mkdir -p "$WORKSPACE"
cd "$WORKSPACE"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "========================================"
echo "Setup & Prerequisites Check"
echo "========================================"
echo ""

ERRORS=0
WARNINGS=0

# Check Node.js
echo -n "[CHECK] Node.js... "
if command -v node &>/dev/null; then
  NODE_VER=$(node --version)
  echo -e "${GREEN}OK${NC} ($NODE_VER)"
else
  echo -e "${RED}MISSING${NC}"
  echo "  Install: sudo apt install nodejs"
  ERRORS=$((ERRORS + 1))
fi

# Check npm
echo -n "[CHECK] npm... "
if command -v npm &>/dev/null; then
  NPM_VER=$(npm --version)
  echo -e "${GREEN}OK${NC} ($NPM_VER)"
else
  echo -e "${RED}MISSING${NC}"
  echo "  Install: sudo apt install npm"
  ERRORS=$((ERRORS + 1))
fi

# Check Python3
echo -n "[CHECK] Python3... "
if command -v python3 &>/dev/null; then
  PY_VER=$(python3 --version 2>&1)
  echo -e "${GREEN}OK${NC} ($PY_VER)"
else
  echo -e "${RED}MISSING${NC}"
  echo "  Install: sudo apt install python3 python3-venv"
  ERRORS=$((ERRORS + 1))
fi

# Check npm packages
echo -n "[CHECK] Node.js packages... "
if [ -d "$WORKSPACE/node_modules" ]; then
  echo -e "${GREEN}OK${NC}"
else
  echo -e "${YELLOW}NOT INSTALLED${NC}"
  echo "  Run: cd $WORKSPACE && npm install"
  WARNINGS=$((WARNINGS + 1))
fi

# Check Python venv
echo -n "[CHECK] Python venv... "
if [ -f "$WORKSPACE/.venv/bin/python" ]; then
  YUP_VER=$($WORKSPACE/.venv/bin/python -m youtube_up --help 2>&1 | head -1 || echo "unknown")
  echo -e "${GREEN}OK${NC} (youtube-up available)"
else
  echo -e "${YELLOW}NOT INSTALLED${NC}"
  echo "  Run: python3 -m venv $WORKSPACE/.venv && $WORKSPACE/.venv/bin/pip install youtube-up"
  WARNINGS=$((WARNINGS + 1))
fi

# Check WhatsApp auth
echo -n "[CHECK] WhatsApp authentication... "
AUTH_DIR="$HOME/.local/share/mudslide"
if [ -f "$AUTH_DIR/creds.json" ]; then
  echo -e "${GREEN}OK${NC} (credentials found)"
else
  echo -e "${RED}NOT LOGGED IN${NC}"
  echo "  Run: node $WORKSPACE/whatsapp_login.mjs"
  echo "  Then scan the QR code with your phone"
  ERRORS=$((ERRORS + 1))
fi

# Check scripts
echo -n "[CHECK] download_and_upload.mjs... "
if node --check "$WORKSPACE/download_and_upload.mjs" 2>/dev/null; then
  echo -e "${GREEN}OK${NC}"
else
  echo -e "${RED}SYNTAX ERROR${NC}"
  ERRORS=$((ERRORS + 1))
fi

echo -n "[CHECK] whatsapp_login.mjs... "
if node --check "$WORKSPACE/whatsapp_login.mjs" 2>/dev/null; then
  echo -e "${GREEN}OK${NC}"
else
  echo -e "${RED}SYNTAX ERROR${NC}"
  ERRORS=$((ERRORS + 1))
fi

echo -n "[CHECK] run_pipeline.sh... "
if bash -n "$WORKSPACE/run_pipeline.sh" 2>/dev/null; then
  echo -e "${GREEN}OK${NC}"
else
  echo -e "${RED}SYNTAX ERROR${NC}"
  ERRORS=$((ERRORS + 1))
fi

echo ""
echo "========================================"
if [ $ERRORS -eq 0 ] && [ $WARNINGS -eq 0 ]; then
  echo -e "${GREEN}All checks passed! Ready to run.${NC}"
  echo ""
  echo "Quick start:"
  echo "  Dry run:    node download_and_upload.mjs --dry-run"
  echo "  Full run:   node download_and_upload.mjs"
  echo "  Background: ./run_pipeline.sh"
elif [ $ERRORS -eq 0 ]; then
  echo -e "${YELLOW}Warnings: $WARNINGS (pipeline may run with limited features)${NC}"
else
  echo -e "${RED}Errors: $ERRORS, Warnings: $WARNINGS${NC}"
  echo "Fix the errors above before running the pipeline."
fi
echo "========================================"
