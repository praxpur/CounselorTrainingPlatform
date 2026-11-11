"""Build bundled common glyphs and a server-hosted complete Noto SC font.

Requires fonttools and brotli. Original font/license URLs are pinned in
server/fonts/source.json; the original OTF can be downloaded from that URL.
"""
import base64
import hashlib
import io
import json
import shutil
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'server/.font-tools'))
from fontTools import subset
from fontTools.ttLib import TTFont


def rename(font, family):
    names = font['name']
    for record in names.names:
        if record.nameID in (1, 4, 6, 16, 17):
            value = 'Regular' if record.nameID == 17 else family
            if record.nameID == 6:
                value = family.replace(' ', '')
            record.string = value.encode(record.getEncoding(), errors='replace')


def build():
    source = ROOT / 'server/fonts/NotoSansCJKsc-Regular.otf'
    metadata = json.loads((ROOT / 'server/fonts/source.json').read_text(encoding='utf-8'))
    if not source.exists():
        with urllib.request.urlopen(metadata['font'], timeout=120) as response:
            source.write_bytes(response.read())
    if hashlib.sha256(source.read_bytes()).hexdigest() != metadata['sha256']:
        raise ValueError('Original font checksum does not match the pinned source')
    target = ROOT / 'assets/fonts'
    target.mkdir(parents=True, exist_ok=True)
    # Bundle UI text and common surnames; keep the main package small.
    chars = set(chr(code) for code in range(32, 127))
    chars.update('王李张刘陈杨黄赵吴周徐孙马朱胡郭何高林罗郑梁谢宋唐许邓韩冯曹彭曾肖田董袁潘于蒋蔡余杜叶程苏魏吕丁任沈姚卢姜崔钟谭陆汪范金石廖贾夏韦傅方白邹孟熊秦邱江尹薛闫段雷侯龙史陶黎贺顾毛郝龚邵万钱严覃武戴莫孔向汤')
    for folder in ['pages', 'components', 'utils']:
        for path in (ROOT / folder).rglob('*'):
            if path.suffix in ('.js', '.wxml', '.wxss', '.json'):
                chars.update(path.read_text(encoding='utf-8'))
    chars.update('，。；：？！、“”‘’（）【】《》—…·℃￥％　')
    font = TTFont(source)
    available = font.getBestCmap()
    chars = {char for char in chars if ord(char) in available}
    options = subset.Options()
    options.flavor = 'woff2'
    options.name_IDs = ['*']
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(unicodes=[ord(char) for char in chars])
    subsetter.subset(font)
    rename(font, 'Campus Noto SC')
    font.flavor = 'woff2'
    buffer = io.BytesIO()
    font.save(buffer)
    encoded = base64.b64encode(buffer.getvalue()).decode('ascii')
    (target / 'noto-sans-sc.wxss').write_text(
        '/* Derived from Noto Sans CJK SC under SIL OFL 1.1. See OFL.txt. */\n'
        '@font-face {\n  font-family: "Campus Noto SC";\n'
        '  src: url("data:font/woff2;base64,' + encoded + '") format("woff2");\n'
        '  font-style: normal;\n  font-weight: 400;\n  font-display: swap;\n}\n',
        encoding='utf-8',
    )
    (target / 'coverage.json').write_text(json.dumps(''.join(sorted(chars)), ensure_ascii=False) + '\n', encoding='utf-8')
    (target / 'coverage.js').write_text('module.exports = ' + json.dumps(''.join(sorted(chars)), ensure_ascii=False) + '\n', encoding='utf-8')
    shutil.copyfile(ROOT / 'server/fonts/OFL.txt', target / 'OFL.txt')
    full_path = ROOT / 'server/fonts/noto-sans-sc-full.woff2'
    if not full_path.exists():
        full = TTFont(source)
        rename(full, 'Campus Noto SC Full')
        full.flavor = 'woff2'
        full.save(full_path)
    print('Bundled glyphs:', len(chars))
    print('Bundled font WXSS bytes:', (target / 'noto-sans-sc.wxss').stat().st_size)
    print('Full server font bytes:', (ROOT / 'server/fonts/noto-sans-sc-full.woff2').stat().st_size)


if __name__ == '__main__':
    build()
