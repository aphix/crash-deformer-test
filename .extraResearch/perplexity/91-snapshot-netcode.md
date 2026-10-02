For browser physics netcode, **snapshot interpolation** is usually the practical choice for host-authoritative movement and world state, while **deterministic lockstep** only works well when all clients can simulate identically and input delay is acceptable; **state synchronization** sits between them by sending authoritative state updates instead of full visual snapshots.[2][3]

## Concrete numbers and rules of thumb

- **Interpolation buffer delay:** at 10 snapshots/sec, the minimum interpolation delay is **100 ms**, with **~150 ms** a more practical floor to absorb jitter.[1][2]
- **Buffer depth:** this is often described as holding **2–3 snapshots** so the renderer can interpolate between the current and next snapshot while staying safely behind real time.[3]
- **Snapshot sequence numbers:** a **16-bit sequence number** is used in the packet header in Gaffer’s example.[3]
- **Position quantization:** Gaffer’s snapshot compression examples focus on sending only the data that changed and using compact encodings; for browser games, common practice is to quantize positions to a fixed grid such as **1/512 m** or **millimeter-level precision** depending on game scale, but that exact number is a design choice rather than a single universal Gaffer rule.[1]
- **Quaternion compression:** a common approach is **smallest-three** quaternion compression, where the largest component is omitted and the other three are stored plus index/sign bits; the exact bit budget depends on quality target, but this is the standard compact orientation encoding pattern referenced by the broader snapshot-compression approach.[1][3]
- **Delta compression:** encode each snapshot **relative to the last acknowledged snapshot** so the receiver can reconstruct changes from a known baseline; Gaffer’s snapshot compression article explicitly describes sending snapshot *N* encoded relative to snapshot *M* and only transmitting changed elements.[1]
- **Per-object bandwidth:** bandwidth depends heavily on object count and quantization, but the main win comes from sending only changed state; Gaffer’s example reduces bandwidth by transmitting only changed cubes instead of the full 901-cube state every frame.[1]

## Reliable/unreliable delivery over WebRTC data channels

- For game-state updates that can drop, use **`ordered: false`** and **`maxRetransmits: 0`** for UDP-like semantics.[7]
- WebRTC data channels can send **binary `ArrayBuffer`** payloads.[7]
- A **16 KiB** chunk size is a conservative cross-browser ceiling, while some stacks advertise support up to roughly **256 KiB** for a single message; larger than the negotiated maximum may fail or throw depending on browser behavior.[5][8]
- If you need the actual negotiated ceiling, check **`pc.sctp.maxMessageSize`** after the connection is established.[5]

## Delta encoding on an unreliable channel

- Use a **baseline/ack scheme**: sender tags each delta snapshot with the baseline sequence it was encoded against, and the receiver only applies it if that baseline is known.[1]
- If the baseline is missing, the receiver should discard the delta and wait for a newer full or self-contained snapshot.[1]
- This is the standard way to make delta compression work over unreliable delivery without stalling on lost packets.[1]

## Same-origin tab testing

- **BroadcastChannel** is the browser-native option for same-origin tabs, windows, frames, and workers.[9][12]
- It is scoped to the **same origin** and broadcasts messages to all listeners on that channel except the sender.[12]

## Practical recommendation

- **Best default for browser action games:** host-authoritative **snapshot interpolation + delta-compressed unreliable snapshots**.
- **Use lockstep only** if the simulation is strictly deterministic and you can tolerate input delay.
- **Send compact binary snapshots** over unordered/unreliable data channels, quantize aggressively, and keep a **~100–150 ms interpolation buffer**.[1][3][7]

If useful, a concrete packet layout for a browser game can be sketched next, including bit fields for position, quaternion, velocity, and acked-baseline IDs.

[1] Snapshot Compression | Gaffer On Games (https://gafferongames.com/post/snapshot_compression/)
[2] Networked Physics (https://gafferongames.com/categories/networked-physics/)
[3] Snapshot Interpolation | Gaffer On Games (https://www.gafferongames.com/post/snapshot_interpolation/)
[4] Physics | Gaffer On Games (https://gafferongames.com/tags/physics/)
[5] WebRTC Data Channels (RTCDataChannel) (https://webrtc.smnandre.dev/messaging/data-channels)
[6] blog.openreplay.com · browser-tab-syncBrowser Tab Synchronization with BroadcastChannel (https://blog.openreplay.com/browser-tab-sync-broadcastchannel/)
[7] Send data between browsers with WebRTC data channels | Articles (https://web.dev/articles/webrtc-datachannels)
[8] RTCDataChannel Complete Guide: File Transfer, Game Sync ... (https://webrtc.link/en/articles/rtcdatachannel-usage-and-message-size-limits/)
[9] BroadcastChannel API - A message bus for the web | Blog (https://developer.chrome.com/blog/broadcastchannel)
[10] WebRTC: Real-Time Communication in Browsers (https://w3c.github.io/webrtc-pc/)
[11] BroadcastChannel for Cross-Boundary Communication (https://stevekinney.com/courses/enterprise-ui/broadcast-channel)
[12] BroadcastChannel - Web APIs | MDN (https://developer.mozilla.org/en-US/docs/Web/API/BroadcastChannel)
[13] Class RTCDataChannel | WebRTC | 3.0.0 - Unity - Manual (https://docs.unity3d.com/Packages/com.unity.webrtc@3.0/api/Unity.WebRTC.RTCDataChannel.html)
[14] JavaScript Cross-Window Communication - W3docs (https://www.w3docs.com/learn-javascript/cross-window-communication)
[15] Stop using the localStorage hack to sync browser tabs ... (https://dev.to/parsajiravand/stop-using-the-localstorage-hack-to-sync-browser-tabs-broadcastchannel-does-it-natively-4an9)
