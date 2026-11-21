/** Served inside the remote desktop, so the clock and input prove that real framebuffer updates arrive. */
export const DESKTOP_DEMO = `<!doctype html>
<html lang="en"><meta charset="utf-8"><title>open-sb desktop demo</title>
<style>
*{box-sizing:border-box}body{margin:0;padding:48px;background:#101418;color:#eef4f6;font:18px system-ui,sans-serif}
main{max-width:780px;margin:auto}small{color:#82c8b4;letter-spacing:2px}h1{font-size:38px;margin:20px 0 12px}p{color:#aab9c0;line-height:1.6}
#clock{font:64px monospace;font-variant-numeric:tabular-nums;margin:28px 0}.track{height:5px;background:#25363b;border-radius:5px;overflow:hidden}
#progress{height:100%;background:#82c8b4}button,input{font:inherit;border:1px solid #49646b;border-radius:8px;padding:14px 18px}
button{background:#82c8b4;color:#101418;cursor:pointer}input{display:block;margin:24px 0 10px;width:100%;background:#1d282e;color:#fff}
#echo{min-height:29px;color:#82c8b4}footer{font:14px monospace;color:#aab9c0;margin-top:30px}
</style><main><small>OPEN-SB / LIVE DESKTOP</small><h1>This is running in your sandbox.</h1>
<p>The clock is rendered by the remote browser. Enable control in the viewer to click and type here.</p>
<div id="clock"></div><div class="track"><div id="progress"></div></div>
<p><button id="count">Clicks: 0</button></p><input id="input" aria-label="Desktop input" placeholder="Type here to test keyboard input" autocomplete="off">
<div id="echo"></div><footer>Connected through VNC · close the session to clean up</footer></main>
<script>
const clock=document.getElementById('clock'),bar=document.getElementById('progress');
function tick(){const d=new Date();clock.textContent=d.toISOString().slice(11,19)+' UTC';bar.style.width=(d.getSeconds()/60*100)+'%'}
tick();setInterval(tick,250);let clicks=0;document.getElementById('count').onclick=e=>e.target.textContent='Clicks: '+(++clicks);
document.getElementById('input').oninput=e=>document.getElementById('echo').textContent=e.target.value;
</script></html>`;
