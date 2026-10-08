# Query: Lightpanda headless browser for testing a three.js WebGL game (WebGL, screenshots, CDP, startup/memory)

Lightpanda is good for fast, low-memory automation where you care about DOM, JavaScript execution, network activity, and general scraping or agent workflows—not for visual or GPU-backed browser testing.[12][13]
65|
66|## What it supports
67|- It exposes CDP and WebDriver BiDi, and Playwright/Puppeteer can connect over CDP.[11][15]
68|- It is designed for JavaScript execution without graphical rendering.[12]
69|- It includes automation-oriented CDP domains such as `Page`, `Runtime`, `DOM`, `Network`, `Input`, `Fetch`, `CSS`, `Accessibility`, and `Emulation`.[14]
70|
71|## What it does not support well for a three.js game
72|- **WebGL / WebGL2 / GPU rendering:** available snippets strongly indicate Lightpanda has no graphical rendering engine, and canvas/WebGL are not rendered in the normal pixel sense.[1][4][12]
73|- **Canvas 2D rendering:** it may expose the APIs, but not with real pixel output useful for visual validation.[4]
74|- **Screenshots:** `page.screenshot()` is not a good fit because Lightpanda does not produce real pixel data; screenshot-style workflows are explicitly called out as unsupported or placeholder-like.[1][2][4][5]
75|- **requestAnimationFrame timing:** there is no evidence it provides browser-grade frame rendering/timing semantics suitable for animation/game loops; for a WebGL game, this is a practical limitation implied by the lack of rendering.[1][4][12]
76|- **Chrome DevTools Protocol features used by Playwright:** basic CDP connection works, but visual/test features are limited. The available sources say Playwright can connect over CDP, while screenshot-dependent and rendering-dependent paths do not work properly.[1][2][15]
77|
78|## Specific Playwright APIs you asked about
79|- `page.screenshot`: **No, not meaningfully supported** for real visual capture.[1][2][4]
80|- `Profiler`: **Unclear from the available information**; CDP is supported, but no source here confirms full profiler functionality.
81|- `Tracing`: **Unclear**; not confirmed by the gathered sources.
82|- `Emulation.setCPUThrottlingRate`: **Possibly exposed via CDP Emulation**, but no source here confirms this exact method works end-to-end.[14]
83|- `Input.dispatchTouchEvent`: **Likely partly exposed through the Input domain**, but no source here confirms touch-event fidelity or mobile emulation parity.[14]
84|
85|## Performance vs headless Chrome
86|- Published benchmarks cited in the results show roughly **11x faster** execution on a representative workload, with **much lower memory use** than headless Chrome.[10][13]
87|- One cited benchmark says Lightpanda handled 100 pages in **2.3 s and 24 MB peak memory**, versus Chrome headless at **25.2 s and 207 MB**.[3][6][7]
88|- Another cited summary reports startup in **under 100 ms**, while Chrome headless takes **3–5 s** to initialize.[3][7]
89|- Lightpanda is therefore well suited to high-throughput crawling, serverless automation, and AI-agent browsing where rendering is unnecessary.[1][12][13][14]
90|
91|## Bottom line for a three.js WebGL game
92|- **Not a suitable browser for testing or playing a three.js WebGL game.**
93|- It may be useful for verifying DOM-driven game menus, API calls, or non-visual logic.
94|- It is not a substitute for Chrome/Chromium when you need WebGL, canvas pixels, animation timing, screenshots, or GPU-backed rendering.[1][2][4][5][12]
95|
96|If needed, a practical test matrix for a three.js game can be outlined next, splitting what to run in Lightpanda vs Chromium.
97|
98|[1] Lightpanda: A Headless Browser for AI Agents and Automation with ... (https://qaskills.sh/blog/lightpanda-headless-browser-automation-guide)
99|[2] lilting.ch › en › articlesLightpanda, a Zig headless browser, is fast because it does not... (https://lilting.ch/en/articles/lightpanda-zig-headless-browser-ai-scraping)
100|[3] Lightpanda: 11x Faster Headless Browser for AI Automation | byteiota (https://byteiota.com/lightpanda-11x-faster-headless-browser-for-ai-automation/)
101|[4] A Headless Browser Without a Rendering Engine, Built for ... (https://journal.hexmos.com/a-browser-without-a-rendering-engine-built-for-agents/amp/)
102|[5] How to use Lightpanda in 2026 - Roundproxies (https://roundproxies.com/blog/lightpanda/)
103|[6] Lightpanda: Open-Source Headless Browser for AI Agents - LinkedIn (https://www.linkedin.com/posts/amit-rawat-3530566_github-lightpanda-iobrowser-lightpanda-activity-7439269321316483072-Cp50)
104|[7] Lightpanda is too fast. Why use Chrome for AI agent ... (https://note.com/hacklog_stealth/n/ncd21fda17961?hl=en)
105|[8] Lightpanda Browser Is Trending Because Chromium’s Headless Advantage Has a Cost (https://www.remio.ai/post/lightpanda-browser-is-trending-because-chromiums-headless-advantage-has-a-cost)
106|[9] github.com · Swival · swivalswival/docs.md/web-browsing.md at master · Swival/swival (https://github.com/Swival/swival/blob/master/docs.md/web-browsing.md)
107|[10] GitHub - PragmaAI/lightpanda-browser: Lightpanda: the ... (https://github.com/PragmaAI/lightpanda-browser)
108|[11] Lightpanda: the headless browser designed for AI and automation (https://github.com/lightpanda-io/browser)
109|[12] Lightpanda | The headless browser (https://lightpanda.io/)
110|[13] Why build a new browser? From intuition to reality - Blog - Lightpanda (https://lightpanda.io/blog/posts/why-build-a-new-browser)
111|[14] Lightpanda: the Headless Browser for AI Agents - Apidog (https://apidog.com/blog/lightpanda/)
112|[15] CDP - Documentation (https://lightpanda.io/docs/cloud-offer/tools/cdp)

[Some lines truncated to 768 chars]