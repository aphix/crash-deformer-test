/**
 * Full-viewport loading cover, server-rendered in the first HTML with its CSS inlined so it paints before the
 * app stylesheet or any JS arrives (no flash of unstyled markup). Only transform/opacity animate.
 * `dismissBootLoader()` fades it out once the engine is ready (or 20 s after the app mounts, or on a boot error). The
 * CSS `boot-timeout` animation is the backstop for a JS bundle that never loads: it hides the cover after 45 s.
 */
import { BOOT_LOADER_ID as ID } from "@/lib/boot-loader";

const TITLE = "Crush Stream";

const css = `
html{background:#09090b}
#${ID}{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;overflow:hidden;
background:radial-gradient(ellipse at 50% 55%,#1c1210 0,#09090b 65%);color:#fafafa;
transition:opacity .45s ease-out;animation:boot-timeout .4s linear 45s forwards}
#${ID}.boot-done{opacity:0;pointer-events:none}
#${ID} .bl-lines{position:absolute;inset:0 -200px;opacity:.6;will-change:transform;
background:repeating-linear-gradient(90deg,transparent 0 120px,rgba(255,120,60,.18) 120px 123px,transparent 123px 170px,rgba(255,255,255,.1) 170px 171px,transparent 171px 200px);
animation:bl-sweep .6s linear infinite}
#${ID} .bl-title{position:relative;margin:0;font:italic 700 clamp(44px,12vw,132px)/1 "Barlow Condensed","Arial Narrow",Impact,system-ui,sans-serif;
letter-spacing:.02em;text-transform:uppercase;will-change:transform;animation:bl-crumple 1.8s cubic-bezier(.5,0,.2,1) infinite}
#${ID} .bl-title::before,#${ID} .bl-title::after{content:attr(data-t);position:absolute;inset:0;will-change:transform}
#${ID} .bl-title::before{color:#ff5a2a;clip-path:inset(0 0 58% 0);mix-blend-mode:screen;animation:bl-tear-a .9s steps(2,end) infinite}
#${ID} .bl-title::after{color:#2ad0ff;clip-path:inset(54% 0 0 0);mix-blend-mode:screen;animation:bl-tear-b 1.1s steps(2,end) infinite}
#${ID} .bl-bar{position:absolute;left:50%;top:calc(50% + clamp(34px,8vw,90px));width:min(52vw,360px);height:3px;margin-left:calc(min(52vw,360px) / -2);overflow:hidden;background:rgba(255,255,255,.1)}
#${ID} .bl-bar::after{content:"";position:absolute;inset:0;background:#ff5a2a;transform-origin:0 50%;will-change:transform;animation:bl-load 1.2s ease-in-out infinite}
@keyframes bl-sweep{to{transform:translateX(-200px)}}
@keyframes bl-crumple{0%,55%,100%{transform:scale(1,1) skewX(-6deg)}
70%{transform:scale(.9,1.04) skewX(-14deg)}
78%{transform:scale(1.04,.94) skewX(4deg)}
88%{transform:scale(.98,1.01) skewX(-8deg)}}
@keyframes bl-tear-a{0%{transform:translateX(0)}50%{transform:translateX(-.06em)}100%{transform:translateX(.04em)}}
@keyframes bl-tear-b{0%{transform:translateX(0)}50%{transform:translateX(.07em)}100%{transform:translateX(-.03em)}}
@keyframes bl-load{0%{transform:translateX(-100%) scaleX(.4)}60%{transform:translateX(30%) scaleX(.7)}100%{transform:translateX(100%) scaleX(.4)}}
@keyframes boot-timeout{to{opacity:0;visibility:hidden}}
@media (prefers-reduced-motion:reduce){
#${ID} .bl-lines,#${ID} .bl-title,#${ID} .bl-title::before,#${ID} .bl-title::after,#${ID} .bl-bar::after{animation:none}
#${ID} .bl-title{transform:skewX(-6deg)}
#${ID} .bl-title::before,#${ID} .bl-title::after{display:none}
#${ID} .bl-bar::after{transform:scaleX(.5)}}
`;

export function BootLoaderStyle() {
  return <style dangerouslySetInnerHTML={{ __html: css }} />;
}

export function BootLoader() {
  return (
    <div id={ID} role="status" aria-label="Loading">
      <div className="bl-lines" />
      <div className="bl-title" data-t={TITLE}>
        {TITLE}
      </div>
      <div className="bl-bar" />
    </div>
  );
}
