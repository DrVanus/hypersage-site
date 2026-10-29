#!/usr/bin/env python3
"""Catch GemBurrow's offscreen-image WebKit paint leak and verify mobile handoff.

Requires Playwright and Pillow from the configured Studio QA environment.
Run with --expected-game-sha from the reviewed canonical payload manifest.
"""
import argparse
from functools import partial
import hashlib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import threading
from PIL import Image
from playwright.sync_api import sync_playwright

class Quiet(SimpleHTTPRequestHandler):
    def log_message(self,*args): pass
    def do_GET(self):
        if self.path.split("?")[0] == "/favicon.ico":
            self.send_response(204); self.end_headers()
        else: super().do_GET()

def main():
    ap=argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--expected-game-sha",required=True)
    ap.add_argument("--output",required=True)
    a=ap.parse_args()
    root=Path(__file__).resolve().parents[1]
    out=Path(a.output).resolve();out.mkdir(parents=True,exist_ok=True)
    original_html=hashlib.sha256((root/"gemburrow/index.html").read_bytes()).hexdigest()
    expected=a.expected_game_sha
    assert hashlib.sha256((root/"gemburrow/play/game.js").read_bytes()).hexdigest()==expected
    server=ThreadingHTTPServer(("127.0.0.1",0),partial(Quiet,directory=str(root)))
    threading.Thread(target=server.serve_forever,daemon=True).start()
    base=f"http://127.0.0.1:{server.server_port}"
    proof={"scope":"Desktop browser mobile emulation and desktop rendering; not physical-device proof",
           "html_sha256":original_html,"release_game_sha256":expected,"cases":[]}
    failures=[]
    try:
        with sync_playwright() as pw:
            for engine in ("chromium","webkit"):
                browser=getattr(pw,engine).launch()
                for width in (320,390,1280):
                    mobile=width<800;dpr=2 if mobile else 1
                    c=browser.new_context(viewport={"width":width,"height":844 if mobile else 900},
                                         device_scale_factor=dpr,is_mobile=mobile,has_touch=mobile,reduced_motion="reduce")
                    page=c.new_page();page.set_default_timeout(12000)
                    case={"engine":engine,"width":width,"is_mobile":mobile,"dpr":dpr,
                          "page_errors":[],"console_errors":[],"phases":[],"passed":False}
                    proof["cases"].append(case)
                    page.on("pageerror",lambda e:case["page_errors"].append(str(e)))
                    page.on("console",lambda m:case["console_errors"].append(m.text) if m.type=="error" else None)
                    try:
                        page.goto(base+"/gemburrow/",wait_until="networkidle")
                        for phase in ("fresh","after-scroll"):
                            if phase=="after-scroll":
                                for y in range(0,page.evaluate("document.documentElement.scrollHeight"),600):
                                    page.evaluate("y=>scrollTo(0,y)",y);page.wait_for_timeout(40)
                                page.wait_for_function("Array.from(document.images).every(x=>x.complete&&x.naturalWidth>0)")
                                page.evaluate("scrollTo(0,0)")
                            page.wait_for_timeout(450)
                            assert page.evaluate("document.documentElement.scrollWidth<=innerWidth")
                            rect=page.locator("nav.site").bounding_box()
                            path=out/f"{engine}-{width}-{phase}.png";page.screenshot(path=str(path))
                            # This blank margin was filled by a 98%-black leaked filter
                            # surface. Measure rendered pixels, not the CSS declaration.
                            image=Image.open(path).convert("RGB")
                            top=round((rect["y"]+rect["height"]+1)*dpr)
                            region=image.crop((0,top,84*dpr,top+30*dpr))
                            pixels=list(region.getdata())
                            ratio=sum(max(x)<3 for x in pixels)/len(pixels)
                            case["phases"].append({"phase":phase,"black_ratio":ratio,"screenshot":str(path)})
                            assert ratio<.05,("opaque paint leak below header",engine,width,phase,ratio)
                        page.locator("#dragon").screenshot(path=str(out/f"{engine}-{width}-dragon.png"))
                        if mobile:
                            page.evaluate("scrollTo(0,0)");page.wait_for_timeout(200)
                            page.locator(".mobile-menu summary").tap()
                            assert page.locator(".mobile-menu").get_attribute("open") is not None
                            page.locator(".mobile-links a[href='play/']").tap()
                        else:
                            page.get_by_role("link",name="Play Gemburrow free").first.click()
                        page.wait_for_selector('[data-control-id="career"]')
                        assert page.url.endswith("/gemburrow/play/")
                        assert hashlib.sha256(page.request.get(base+"/gemburrow/play/game.js").body()).hexdigest()==expected
                        assert not case["page_errors"] and not case["console_errors"],case
                        case["passed"]=True
                        print(f"PASS {engine} {width}: fresh/scroll pixels and Play handoff",flush=True)
                    except Exception as e:
                        case["failure"]=str(e);failures.append(str(e))
                        page.screenshot(path=str(out/f"{engine}-{width}-FAILURE.png"))
                        print(f"FAIL {engine} {width}: {e}",flush=True)
                    finally:
                        c.close();(out/"proof.json").write_text(json.dumps(proof,indent=2)+"\n")
                browser.close()
    finally:
        server.shutdown()
    assert hashlib.sha256((root/"gemburrow/index.html").read_bytes()).hexdigest()==original_html,"HTML changed during test"
    proof["passed"]=not failures
    (out/"proof.json").write_text(json.dumps(proof,indent=2)+"\n")
    if failures:raise SystemExit("\n".join(failures))
if __name__=="__main__":main()
