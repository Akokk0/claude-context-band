# -*- coding: utf-8 -*-
# Context Band 的 LOGO:纯色 squircle 底、粗圆线、实心主体,小克站在那条带上。
# 用法:python3 scripts/logo.py,重新生成 docs/images/logo.svg。
# 小克的样子照 Claude Code 自带的像素图:宽扁的方身子、两只竖着的小眼睛、两侧各一截小胳膊、底下四条小短腿。
# 这里是照着那个样子重新画的圆角版,不是把像素图搬过来。
import math, os, re

CANVAS, BODY, RADIUS = 1024, 824, 185.4
STROKE = 28
CORAL = '#EC7A4F'
FG, BG = '{fg}', '{bg}'


def polar(r, deg, cx, cy):
    a = math.radians(deg)
    return cx + r * math.cos(a), cy + r * math.sin(a)


def line(d, width=STROKE, color=FG):
    return f'<path d="{d}" fill="none" stroke="{color}" stroke-width="{width}" stroke-linecap="round" stroke-linejoin="round"/>'


def rays(cx, cy, r0, r1, angles, width=24):
    return line(' '.join('M{:.1f},{:.1f} L{:.1f},{:.1f}'.format(*polar(r0, a, cx, cy), *polar(r1, a, cx, cy)) for a in angles), width)


def box(x, y, w, h, rx, fill=FG):
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill}"/>'


def clawd(left, top, U, foot=None):
    """小克,比例照桌面应用里那只量的(主人给的截图,一格约 5.75 像素):
    身子 8 格宽 6 格高;眼睛 1 格见方,离两边和头顶各 1 格;胳膊 2 格见方,从头顶往下第 2 格起;
    腿 1 格宽 2 格高,在第 0、2、5、7 格。left / top 是身子的左上角,U 是一格多大。

    整只是一条轮廓,不是几块方块叠起来的:只有朝外的角是圆的(头顶两个、胳膊外侧四个),
    身子和腿、身子和胳膊相接的地方是直的 —— 原先各画各的圆角,圆角碰圆角就露出缺口(主人放大看出来的)。
    foot 是腿画到哪儿:给了就一直画到那儿(伸进带子的线里,脚底不留圆角),没给就是 2 格高。
    """
    right, r, a = left + 8 * U, 16, 10
    ax0, ax1 = left - 2 * U, right + 2 * U
    ay0, ay1 = top + 2 * U, top + 4 * U
    hip = top + 6 * U
    sole = foot if foot is not None else hip + 2 * U
    d = [f'M{left + r},{top}', f'H{right - r}', f'A{r},{r} 0 0 1 {right},{top + r}', f'V{ay0}']
    d += [f'H{ax1 - a}', f'A{a},{a} 0 0 1 {ax1},{ay0 + a}', f'V{ay1 - a}', f'A{a},{a} 0 0 1 {ax1 - a},{ay1}', f'H{right}']
    # 底边从右往左:第 7、5、2、0 格是腿,腿之间的空当回到胯的高度。
    d += [f'V{sole}', f'H{left + 7 * U}', f'V{hip}', f'H{left + 6 * U}', f'V{sole}', f'H{left + 5 * U}', f'V{hip}']
    d += [f'H{left + 3 * U}', f'V{sole}', f'H{left + 2 * U}', f'V{hip}', f'H{left + U}', f'V{sole}', f'H{left}', f'V{ay1}']
    d += [f'H{ax0 + a}', f'A{a},{a} 0 0 1 {ax0},{ay1 - a}', f'V{ay0 + a}', f'A{a},{a} 0 0 1 {ax0 + a},{ay0}', f'H{left}', f'V{top + r}', f'A{r},{r} 0 0 1 {left + r},{top}', 'Z']
    body = f'<path d="{" ".join(d)}" fill="{FG}"/>'
    eyes = box(left + U, top + U, U, U, 5, BG) + box(right - 2 * U, top + U, U, U, 5, BG)
    return body + eyes


def band(y, h=110):
    """那条带:粗线的胶囊,里面一段实心的进度。y 是胶囊的上沿(线的中心)。"""
    inner = h - STROKE - 32
    return (
        f'<rect x="236" y="{y}" width="552" height="{h}" rx="{h / 2}" fill="{BG}" stroke="{FG}" stroke-width="{STROKE}"/>'
        + box(236 + 14 + 16, y + (h - inner) / 2, 290, inner, inner / 2)
    )


def glyph_peek():
    """小克站在带子上。就是桌面应用里它站在输入框上的样子:四条小短腿踩着那条带,带里一段实心的进度。"""
    U = 38
    top = 291
    left = 512 - 4 * U
    edge = top + 8 * U + 14
    # 三道小光离得开一点:线粗 24,里头那一端相邻两道的间距要比 24 大得多,不然挤成一团(主人说的)。
    shine = rays(left + 8 * U + 14, top + 4, 60, 96, (-78, -39, 0))
    # 腿一直画到带子那条线的中心:带子后画,线把脚底盖住,脚和带子之间不留缝。
    return clawd(left, top, U, foot=edge) + band(edge) + shine


def icon(glyph, bg=CORAL, fg='#fff', uid='i'):
    """整张图标:投影、squircle、图形。尺寸照 BN 的出图脚本。"""
    inset = (CANVAS - BODY) / 2
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {CANVAS} {CANVAS}">'
        f'<defs><filter id="sh-{uid}" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="10" stdDeviation="16" flood-color="#000" flood-opacity="0.25"/></filter></defs>'
        f'<rect x="{inset}" y="{inset}" width="{BODY}" height="{BODY}" rx="{RADIUS}" fill="{bg}" filter="url(#sh-{uid})"/>'
        f'{glyph().replace(FG, fg).replace(BG, bg)}</svg>'
    )


def inner(svg):
    return svg[svg.index('>') + 1 : -len('</svg>')]


def export():
    """进仓的那一份:一行一个元素,带标题。"""
    svg = icon(glyph_peek, uid='logo').replace('sh-logo', 'shadow')
    svg = svg.replace('viewBox="0 0 1024 1024">', 'viewBox="0 0 1024 1024" role="img" aria-labelledby="title"><title id="title">Context Band</title>', 1)
    out, depth = [], 0
    for ln in re.sub(r'>\s*<', '>\n<', svg).split('\n'):
        if ln.startswith('</'):
            depth -= 1
        out.append('  ' * depth + ln)
        if re.match(r'<(svg|defs|filter|g)\b', ln) and not ln.endswith('/>') and '</' not in ln:
            depth += 1
    return '\n'.join(out) + '\n'


if __name__ == '__main__':
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    open(os.path.join(root, 'docs', 'images', 'logo.svg'), 'w', encoding='utf-8').write(export())
    print('wrote docs/images/logo.svg')
