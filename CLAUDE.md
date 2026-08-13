# CLAUDE.md - Guardrails for AI Coding Sessions

## CRITICAL: Process Management Safety

### NEVER run blanket process kill commands
On Windows, these kill ALL Node.js processes on the machine:
- taskkill //F //IM node.exe
- taskkill /F /IM node.exe
- taskkill /F /IM electron.exe

These crash other Claude Code sessions, MCP servers, Electron apps, and dev tools.

### ALWAYS use targeted process management instead



Or use npm scripts:


### The safe-process script:
1. Finds PIDs by port number using netstat -ano
2. Verifies the process is actually OpenMausBot via /api/health
3. Kills only that specific PID with taskkill /F /PID <pid>
4. NEVER kills by image name (node.exe, electron.exe, etc.)

## Project Overview
OpenMausBot is an Electron + React + TypeScript chat app for multiple AI bots.
Each bot runs on a provider driver (Ollama, Claude, Codex, Grok, Gemini, Box).
The harness server runs on port 8799.

## Multi-Ollama Setup
Three Ollama instances:
1. ollamaLocal - http://127.0.0.1:11434 (no API key)
2. ollamaWorkstation - http://192.168.68.70:11434 (no API key)
3. ollamaCloud - https://api.ollama.com (requires API key)

Config: ~/.openmausbot/config.json

## Build Commands
- pnpm typecheck - TypeScript check
- pnpm test - Run vitest tests
- pnpm build - Full build (frontend + server)
- pnpm build:server - Build server only
- pnpm package:win - Build Windows installer
