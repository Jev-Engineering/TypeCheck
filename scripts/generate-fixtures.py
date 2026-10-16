"""Original synthetic matching fixtures; Pillow required, not a bot dependency."""
from pathlib import Path
from PIL import Image, ImageDraw
import json
root=Path(__file__).resolve().parents[1]/'fixtures'
root.mkdir(exist_ok=True)
ref=Image.new('RGB',(640,640),'white');d=ImageDraw.Draw(ref)
d.rectangle((70,70,570,570),fill=(43,64,96));d.ellipse((110,110,390,390),fill=(196,110,70));d.polygon([(320,200),(530,510),(190,510)],fill=(125,194,166));d.rectangle((90,530,280,550),fill=(245,222,140))
ref.save(root/'reference.png');ref.save(root/'exact.png');ref.resize((360,360)).save(root/'resized.png');ref.save(root/'recompressed.jpg',quality=30)
ref.crop((30,30,610,610)).save(root/'cropped.png')
wm=ref.copy();ImageDraw.Draw(wm).text((415,575),'TEST WATERMARK',fill=(0,0,0));wm.save(root/'watermarked.png')
border=Image.new('RGB',(680,680),(100,100,100));border.paste(ref,(20,20));border.save(root/'border.png')
partial=Image.new('RGB',(1100,750),(201,206,215));partial.paste(ref.resize((460,460)),(480,130));partial.save(root/'composition.png')
for n in range(1,25):
    other=Image.new('RGB',(640,640),(240,240,240));o=ImageDraw.Draw(other)
    o.rectangle((70+n*3,70,530,560),fill=(43+(n*5)%90,64,96));o.ellipse((120,140+n*3,360,400+n),fill=(196,110,70));o.polygon([(400,80+n*5),(550,450),(240,500)],fill=(125,194,166));o.rectangle((110,505,320,520),fill=(60+n,70,110))
    other.save(root/f'distinct-{n:02}.png')
u=Image.new('RGB',(640,640),'white');d=ImageDraw.Draw(u)
for y in range(0,640,40):
    for x in range(0,640,40):d.rectangle((x,y,x+38,y+38),fill=(20,120,160) if (x+y)//40%2 else (225,215,95))
u.save(root/'unrelated.png')
cases=[]
def case(name,sample,mode,expected):cases.append(dict(id=name,reference='reference.png',sample=sample,mode=mode,expected=expected,threshold=.99))
case('exact-copy','exact.png','exact',True)
for f in ['resized.png','recompressed.jpg','cropped.png','watermarked.png','border.png']:case(f,f,'transformed',True)
case('embedded-reference','composition.png','partial',True)
for n in range(1,25):case(f'similar-but-distinct-{n:02}',f'distinct-{n:02}.png','transformed',False)
case('unrelated','unrelated.png','transformed',False)
(root/'manifest.json').write_text(json.dumps(cases,indent=2)+'\n')
print(f'{len(cases)} synthetic labeled cases generated. No Jev accuracy measured.')
