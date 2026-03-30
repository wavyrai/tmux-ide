# Third-Party Notices

## VibeTunnel

Several components in this project are derived from or based on VibeTunnel.

- **Source:** https://github.com/amantus-ai/vibetunnel
- **Copyright:** amantus-ai
- **License:** MIT

### Derived Components

| Path | Description |
|------|-------------|
| `src/lib/auth/auth-service.ts` | JWT + SSH challenge-response authentication |
| `src/lib/ws-v3/` | WebSocket v3 binary protocol and hub |
| `src/lib/tunnels/tailscale.ts` | Tailscale Serve tunnel service |
| `src/lib/tunnels/ngrok.ts` | ngrok tunnel service |
| `src/lib/tunnels/cloudflare.ts` | Cloudflare Quick Tunnel service |
| `src/lib/hq/client.ts` | HQ multi-machine registration client |
| `src/lib/hq/registry.ts` | HQ remote machine registry |
| `src/lib/hq/mdns.ts` | mDNS/Bonjour service advertisement |
| `src/lib/ipc/socket-protocol.ts` | Unix socket IPC protocol |
| `src/lib/log.ts` | Logger (VibeTunnel-compatible shim) |
| `src/lib/cast/recorder.ts` | asciicast v2 session recorder |
| `app/` | macOS app scaffold (entire directory) |

### MIT License

```
MIT License

Copyright (c) amantus-ai

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
