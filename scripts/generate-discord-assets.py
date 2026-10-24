"""Discord portal art in the TypeSafe paper/ink theme; Playwright + Pillow required, not bot dependencies.

Renders HTML/SVG with the self-hosted OFL fonts in activity/fonts/ (inlined as data URIs, no network) and writes
flat RGB PNGs to docs/assets/discord/. Halftone dots and grain are computed here, so output is reproducible.
Set CHROMIUM_EXECUTABLE to use a specific Chromium; otherwise Playwright's preinstalled build is used.
"""
import base64, io, math, os
from pathlib import Path
from playwright.sync_api import sync_playwright
from PIL import Image

root=Path(__file__).resolve().parents[1]
fonts=root/'activity'/'fonts'
out=root/'docs'/'assets'/'discord'
INK,PAPER,PINK,PANEL,SHADE='#1E1E1E','#FEFEFE','#F386A1','#DEDEDE','#C4C4C4'

def font(family,file,weight):
    data=base64.b64encode((fonts/file).read_bytes()).decode()
    return f'@font-face{{font-family:"{family}";font-weight:{weight};src:url(data:font/woff2;base64,{data}) format("woff2")}}'

FONTS=''.join([font('Schibsted Grotesk','schibsted-grotesk-500.woff2',500),font('VT323','vt323-400.woff2',400),font('JetBrains Mono','jetbrains-mono-400.woff2',400)])

def halftone(w,h,pitch,clear):
    """Ink dot field on a 45-degree grid: dots grow toward the edges and vanish inside the clear ellipse (rx, ry)."""
    rx,ry=clear;dots=[]
    for j in range(-1,int(h/pitch*2)+2):
        for i in range(-1,int(w/pitch)+2):
            x=i*pitch+(pitch/2 if j%2 else 0);y=j*pitch/2
            d=math.hypot((x-w/2)/rx,(y-h/2)/ry)
            t=min(1,max(0,(d-1)/0.9))
            r=pitch*0.36*t**1.15
            if r>=0.6:dots.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="{r:.2f}"/>')
    return f'<svg class="layer" xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}"><g fill="{INK}">{"".join(dots)}</g></svg>'

def grain(w,h,opacity):
    return (f'<svg class="layer" xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}"><filter id="g"><feTurbulence type="fractalNoise" baseFrequency=".9" numOctaves="2" seed="7" stitchTiles="stitch"/>'
            f'<feColorMatrix values="0 0 0 0 .118 0 0 0 0 .118 0 0 0 0 .118 0 0 0 {opacity} 0"/></filter><rect width="100%" height="100%" filter="url(#g)"/></svg>')

def tile(size,border):
    # Brand mark: pink square, ink border, ink VT323 "J" (same as .brand-mark in activity/style.css).
    return f'<div class="tile" style="width:{size}px;height:{size}px;border-width:{border}px;font-size:{size*0.98:.0f}px"><span>J</span></div>'

def window(title,body,bar,border,pad,column=False):
    ctrl=round(bar*0.5)
    return (f'<div class="win" style="border-width:{border}px">'
            f'<div class="bar" style="height:{bar}px;font-size:{bar*0.78:.0f}px;padding:0 {bar*0.4:.0f}px"><span>{title}</span>'
            f'<i style="width:{ctrl}px;height:{ctrl}px;border-width:{max(2,border*0.75):.0f}px"></i></div>'
            f'<div class="body" style="padding:{pad}px;flex-direction:{"column" if column else "row"}">{body}</div></div>')

def page(w,h,content,background):
    return f'''<!doctype html><html><head><meta charset="utf-8"><style>{FONTS}
*{{box-sizing:border-box;margin:0}}
html,body{{width:{w}px;height:{h}px;overflow:hidden;background:{background}}}
.stage{{position:relative;width:{w}px;height:{h}px;display:grid;place-items:center}}
.layer{{position:absolute;inset:0;display:block}}
.win{{position:relative;border:solid {INK};background:{PANEL}}}
.bar{{display:flex;align-items:center;justify-content:space-between;background:{INK};color:{PAPER};font-family:"VT323";line-height:1;letter-spacing:.02em}}
.bar i{{display:block;border:solid {PAPER}}}
.body{{display:flex;align-items:center}}
.tile{{flex-shrink:0;display:grid;place-items:center;background:{PINK};border:solid {INK};color:{INK};font-family:"VT323";line-height:1}}
.tile span{{display:block;transform:translate(-2%,-3%)}}
.copy{{color:{INK}}}
.name{{font-family:"Schibsted Grotesk";font-weight:500;line-height:.9;letter-spacing:-.02em;white-space:nowrap}}
.mono{{font-family:"JetBrains Mono";text-transform:uppercase;letter-spacing:.08em}}
.stack{{position:relative;display:flex;flex-direction:column;align-items:flex-start}}
.chip{{background:{PAPER};color:{INK};border:solid {INK};font-family:"JetBrains Mono";text-transform:uppercase;letter-spacing:.08em;line-height:1}}
</style></head><body><div class="stage">{content}</div></body></html>'''

def cover(w,h,*,title,tile_size,name_size,mono_size,bar,border,pad,gap,headline,clear,pitch,grain_opacity,chip=None,stacked=False):
    lines=''.join(f'<div>{line}</div>' for line in headline)
    mono=f'<div class="mono" style="font-size:{mono_size}px;margin-top:{gap*0.8:.0f}px">Image moderation for Discord</div>' if mono_size else ''
    side='top' if stacked else 'left'
    body=f'{tile(tile_size,border)}<div class="copy" style="margin-{side}:{gap}px"><div class="name" style="font-size:{name_size}px">{lines}</div>{mono}</div>'
    extra=''
    if chip:
        extra=f'<div class="chip" style="font-size:{chip}px;padding:{chip*0.6:.0f}px {chip*0.8:.0f}px;border-width:{border}px;margin-bottom:{chip}px">Discord Activity</div>'
    return page(w,h,halftone(w,h,pitch,clear)+grain(w,h,grain_opacity)+f'<div class="stack">{extra}{window(title,body,bar,border,pad,stacked)}</div>',PINK)

def icon(w):
    return page(w,w,tile(round(w*0.56),round(w*0.012)),INK)

ASSETS={
    # Rich Presence large image: shown near 120px wide and may be centre-cropped to a square, so the window
    # stacks inside the middle 576x576.
    'typecheck-rich-presence-cover.png':(1024,576,lambda:cover(1024,576,title='TypeCheck 1.0',tile_size=200,name_size=92,mono_size=0,bar=50,border=6,pad=36,gap=30,headline=['TypeCheck'],clear=(300,270),pitch=30,grain_opacity=.06,stacked=True)),
    'typecheck-activity-cover.png':(1920,1080,lambda:cover(1920,1080,title='TypeCheck 1.0',tile_size=270,name_size=116,mono_size=32,bar=72,border=6,pad=72,gap=64,headline=['Match an image.','Apply your policy.'],clear=(820,430),pitch=34,grain_opacity=.06,chip=26)),
    # Profile banner: Discord crops the edges and overlaps the avatar at the lower left, so content stays central.
    'typecheck-bot-banner.png':(1360,480,lambda:cover(1360,480,title='TypeCheck 1.0',tile_size=160,name_size=96,mono_size=22,bar=46,border=5,pad=36,gap=36,headline=['TypeCheck'],clear=(470,200),pitch=26,grain_opacity=.06)),
    # App icon: Discord masks it to a circle, so the tile stays inside the inscribed circle with margin.
    'typecheck-icon.png':(1024,1024,lambda:icon(1024)),
    'typecheck_logo.png':(1024,1024,lambda:icon(1024)),
}

def main():
    with sync_playwright() as p:
        exe=os.environ.get('CHROMIUM_EXECUTABLE')
        browser=p.chromium.launch(**({'executable_path':exe} if exe else {}),headless=True,args=['--no-sandbox','--font-render-hinting=none'])
        for name,(w,h,build) in ASSETS.items():
            tab=browser.new_page(viewport={'width':w,'height':h},device_scale_factor=1)
            tab.set_content(build());tab.evaluate('document.fonts.ready')
            image=Image.open(io.BytesIO(tab.screenshot(type='png'))).convert('RGB')
            assert image.size==(w,h),(name,image.size)
            image.save(out/name,optimize=True);tab.close()
            print(f'{name} {w}x{h} {(out/name).stat().st_size} bytes')
        browser.close()

if __name__=='__main__':
    main()
