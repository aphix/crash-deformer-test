For this game, Vercel can host WebSockets, but only as function-bound connections: each socket is pinned to one function instance, closes when that function hits its duration limit, and cannot be used as durable shared in-memory state across instances[1][2][3]. On Vercel Pro/Enterprise, the practical ceiling is 300s by default and 800s maximum, with a 1,800s beta extension for supported runtimes; Hobby is capped at 300s[2][4].

## 1) Vercel Functions as the socket host
- WebSocket connections are supported on Vercel Functions with Fluid compute, but the connection lasts only until the function’s max duration expires[1][4].
- A single socket is pinned to one function instance, so any per-instance memory is only local to that one process and cannot be relied on as shared state across reconnects or other invocations[1][3].
- For a real-time multiplayer game, this means Vercel is usable for a prototype relay or room coordinator, but not as a durable authoritative game server unless you accept reconnects and externalize state[1][2][3].

## 2) WebRTC DataChannels with Vercel-backed signaling
- The signaling path can be done with polling or short-lived requests through a Vercel function backed by Postgres, Neon, or Upstash KV; the signaling channel itself does not need long-lived server sockets.
- The hard part is NAT traversal: many connections succeed with STUN-only in favorable networks, but symmetric NATs, restrictive corporate networks, and some mobile carriers often require TURN for reliable connectivity.
- For production reliability, plan on TURN for a meaningful fraction of sessions; for a browser game with 2–16 players, a no-TURN design is usually only acceptable for a prototype or a trusted-network demo.
- TURN options mentioned in practice include Cloudflare Calls TURN, Twilio TURN, and metered.ca TURN; these are used to relay media/data when direct peer-to-peer paths fail[10].
- Cloudflare’s Calls API explicitly includes TURN key management, indicating TURN is a first-class offering in that platform[10].

## 3) Hosted realtime services
| Service | What it gives you | Constraints / notes |
|---|---|---|
| PartyKit / Cloudflare Durable Objects | Closest fit for authoritative-room state and WebSocket fanout | Better for “one room = one object” logic than Vercel; DOs are designed for per-room state, while WebSocket hibernation reduces idle resource use. |
| Ably | Managed pub/sub with strong realtime delivery | Good global delivery and reconnection handling; typically easier than self-hosting. |
| Pusher Channels | Simple pub/sub and presence | Good developer experience; usually not ideal if you need binary game snapshots or very high tick rates. |
| Liveblocks | Collaboration-first realtime stack | Great for sync/presence patterns, less game-server-like than PartyKit/DOs. |
| Supabase Realtime broadcast | Convenient if you already use Supabase/Postgres | Useful for lightweight broadcast and presence, but not the strongest fit for high-rate game ticks. |

From the Vercel-side sources, the key constraint is that Vercel WebSockets are still function-limited and reconnect-oriented, so external realtime platforms are the cleaner option when you need persistent room state and lower operational friction[1][2][3][4]. For the services you listed, the main practical differentiators are binary payload support, per-message or per-connection quotas, and whether the service is optimized for game-style authoritative rooms versus collaboration or chat.

## 4) PeerJS cloud broker
- PeerJS is easiest when you want a lightweight WebRTC signaling broker and rapid prototyping.
- It is not the game transport itself; it only helps peers find each other and exchange connection metadata.
- For browser games, the broker approach is fine for a demo, but once you need reliable matchmaking, reconnects, NAT fallback, and room lifecycle management, a dedicated realtime service or TURN-backed WebRTC stack is more robust.

## Best choice for a prototype
- **Easiest locally:** PeerJS for signaling, with host-authoritative logic in one browser tab.
- **Easiest on Vercel:** Vercel Functions for signaling plus an external realtime service, or Vercel Functions + WebRTC with TURN if you want to stay close to P2P[1][2][4].
- **Best overall prototype balance:** PartyKit / Cloudflare Durable Objects if the goal is a browser-hosted authoritative room with simple state fanout; it maps much better to “one room, one stateful actor” than Vercel’s duration-limited functions.

If the goal is “works fast with the least infrastructure,” the shortest path is:
- Signaling on Vercel
- Game state in a single host browser
- TURN available for fallback
- Migrate later to PartyKit or Durable Objects if the prototype proves out

[1] https://vercel.com/docs/functions/websockets  
[2] https://vercel.com/docs/functions/limitations  
[3] https://vercel.com/kb/guide/publish-and-subscribe-to-realtime-data-on-vercel  
[4] https://vercel.com/kb/guide/do-vercel-serverless-functions-support-websocket-connections  
[10] https://developers.cloudflare.com/api/resources/calls/

[1] WebSockets - Vercel (https://vercel.com/docs/functions/websockets)
[2] Vercel Functions Limits (https://vercel.com/docs/functions/limitations)
[3] Publish and subscribe to realtime data on Vercel (https://vercel.com/kb/guide/publish-and-subscribe-to-realtime-data-on-vercel)
[4] Do Vercel Serverless Functions support WebSocket ... (https://vercel.com/kb/guide/do-vercel-serverless-functions-support-websocket-connections)
[5] WebSockets with Next.js: SSR, App Router, and Vercel (https://websocket.org/guides/frameworks/nextjs/)
[6] Backends on Vercel (https://vercel.com/docs/frameworks/backend)
[7] Best Tech Stack for WebRTC App Development (https://sheerbit.com/best-tech-stack-for-webrtc-app-development/)
[8] Configuring Maximum Duration for Vercel Functions (https://vercel.com/docs/functions/configuring-functions/duration)
[9] WebSockets on Vercel: native support, limits, and your options (https://ably.com/vercel/websockets-on-vercel)
[10] Calls (https://developers.cloudflare.com/api/resources/calls/)
[11] Build a real-time chat app with WebSockets on Vercel (https://vercel.com/kb/guide/real-time-chat-websockets)
[12] What is the best backend for a Next.js app deployed on Vercel? - Neon (https://neon.com/faqs/best-backend-nextjs-app-vercel)
[13] Configuring Functions (https://vercel.com/docs/functions/configuring-functions)
[14] Is Vercel's Advice To Use A... (https://ably.com/vercel/vercel-websockets-vs-ably)
[15] WebSocket support is now in Public Beta (https://vercel.com/changelog/websocket-support-is-now-in-public-beta)
