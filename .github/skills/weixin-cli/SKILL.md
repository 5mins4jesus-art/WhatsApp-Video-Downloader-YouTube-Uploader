---
name: weixin-cli
description: 'WeChat personal account CLI tool (weixin-claw-cli). Use for: sending/receiving WeChat messages from terminal, file transfers, interactive chat, QR code login, monitoring incoming messages, clipboard sharing to WeChat. Keywords: wechat, weixin, 微信, messaging, chat, CLI, terminal, personal account'
user-invocable: true
argument-hint: 'command or task (e.g. login, send, chat, listen)'
---

# WeChat CLI (weixin-claw-cli)

Interact with a personal WeChat account directly from the terminal using `weixin-claw-cli`.

## When to Use

- Send or receive WeChat messages from the terminal
- Transfer files, images, or videos via WeChat
- Monitor incoming WeChat messages in real-time
- Interactive two-way WeChat chat from CLI
- Send clipboard content to WeChat
- Automate WeChat messaging workflows

## Prerequisites

- Node.js >= 18
- Package installed globally: `npm install -g weixin-claw-cli`
- Binary: `weixin` (located at `~/.npm-global/bin/weixin`)
- Session data stored in `~/.weixin/`

## Security Notes

- **No backdoors found** in v0.1.4 (audited 2026-04-26): all API calls go only to official WeChat domains (`ilinkai.weixin.qq.com`, `novac2c.cdn.weixin.qq.com`)
- Auth tokens stored in `~/.weixin/accounts/` with `chmod 600`
- **Platform risk**: Using unofficial bot APIs may violate WeChat ToS — avoid spamming or excessive automation
- Single maintainer project — re-audit after updates

## Commands

| Command | Description |
|---------|-------------|
| `weixin login` | Scan QR code to authenticate with WeChat |
| `weixin accounts` | List logged-in accounts |
| `weixin send <user_id> <message>` | Send a text message |
| `weixin sendfile <file> [--to <id>] [--caption <text>]` | Send a file/image/video |
| `weixin listen` | Monitor all incoming messages (Ctrl+C to stop) |
| `weixin chat [user_id]` | Interactive two-way chat mode |
| `weixin` | (no args) Send clipboard content to bound WeChat |
| `weixin help` | Show help |

## Procedures

### Login for the First Time

1. Run `weixin login`
2. A QR code appears in the terminal
3. Open WeChat on phone → scan the QR code → confirm
4. Session is saved in `~/.weixin/` for future use

### Send a Text Message

```bash
weixin send "user123@im.wechat" "Hello from terminal!"
```

### Send a File

```bash
# Send image to yourself
weixin sendfile photo.jpg

# Send file to a specific user
weixin sendfile report.pdf --to "user@im.wechat"

# Send video with caption
weixin sendfile demo.mp4 --caption "Check this out"
```

Supported file types:
- **Image**: jpg, png, gif, webp, bmp
- **Video**: mp4, mov, webm, avi
- **File**: pdf, doc, xls, zip, and more

### Monitor Incoming Messages

```bash
weixin listen
```

- Prints all incoming messages in real-time
- Media files auto-downloaded to `./downloads/`
- Press Ctrl+C to stop

### Interactive Chat

```bash
# Auto-detect chat target from first incoming message
weixin chat

# Chat with a specific user
weixin chat "user123@im.wechat"
```

Chat mode controls:
- Type message + Enter to send
- `/target <id>` — switch chat target
- `/quit` — exit chat mode

### Send Clipboard Content

```bash
# Copy something, then:
weixin
```

Sends current clipboard content to your bound WeChat account. Requires `xclip` on Linux or `pbpaste` on macOS.

## Troubleshooting

| Issue | Solution |
|-------|----------|
| QR code not displaying | Open the printed URL in a browser to scan instead |
| "未找到已登录账号" | Run `weixin login` first |
| Clipboard read fails (Linux) | Install xclip: `sudo apt install xclip` |
| Token expired | Run `weixin login` again to re-authenticate |
| Account restricted | WeChat may flag unofficial bot usage — reduce automation frequency |

## API Endpoints (for reference)

The CLI communicates with WeChat's iLink Bot API:

| Endpoint | Purpose |
|----------|---------|
| `GET /ilink/bot/get_bot_qrcode` | Fetch login QR code |
| `GET /ilink/bot/get_qrcode_status` | Poll QR scan status |
| `POST /ilink/bot/getupdates` | Long-poll for incoming messages |
| `POST /ilink/bot/sendmessage` | Send a text or media message |
| `POST /ilink/bot/getuploadurl` | Get CDN upload URL for files |
| CDN `POST /upload` | Upload encrypted file to WeChat CDN |
| CDN `GET /download` | Download encrypted file from WeChat CDN |

Base URL: `https://ilinkai.weixin.qq.com`
CDN URL: `https://novac2c.cdn.weixin.qq.com/c2c`
