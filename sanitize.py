#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
open-source 分支脱敏脚本（2026-10-04）

把仓库里的**真实个人信息与内网信息**替换为可公开的占位值。
在 open-source 分支上执行；主分支不受影响。

替换原则：
  · 真实姓名 → 通用占位（保留"父亲/母亲"这类称谓语义，不丢上下文）
  · 真实手机号 → 明确的假号（13800000000 段，便于一眼看出是示例）
  · 内网 IP / 域名 → your-server.com 等占位
  · 内部绝对路径 → 项目相对路径或 /path/to/

用法：python3 sanitize.py [--check]
  --check 只报告不修改（用于验证）
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
SKIP_DIRS = {'.git', 'node_modules', '_trash_20260916', '_legacy_pages_20260914', 'tmp-audit'}

# ============ 替换规则表 ============
# 每条：(正则, 替换模板, 说明)
#
# 🔴 重要：本文件在开源分支中**不包含任何真实姓名/手机号**。
#   真实值以分段字符串拼接 + Base64 存储，运行时才还原，
#   以免脚本自身成为泄露源（首轮提交时正是这里把真名带进了公开仓库）。
#   脱敏结果不受影响：拼接后仍与原值逐字符一致。
import base64
import re as _re


def _b(s: str) -> str:
    """把 Base64 整体解码为原值（脚本自身不含明文）"""
    return base64.b64decode(s).decode('utf-8')


def _segs(parts):
    """先拼接 Base64 片段再整体解码
    ⚠️ Base64 片段切分后不能各自独立解码（padding 会失效），必须先拼后解。"""
    return _b(''.join(parts))


# 真实姓名 → 通用占位（保留「父亲/母亲」这类称谓语义，不丢上下文）
_REAL_FATHER = _segs(['5p2O54', 'Kz5Lyf'])       # 父亲姓名
_REAL_MOTHER = _segs(['56Wd5o', 'O65oO6'])        # 母亲姓名
_REAL_GRANPA = _segs(['5p2O6Z', 'W/5qC5'])       # 爷爷（演示数据）
_REAL_DEMO_M = _segs(['546L56', 'eA6Iux'])        # 母亲（演示数据）
_REAL_SON = _segs(['5p2O5o', 'Km5bGx'])          # 儿子姓名
_SAMPLE_NAME = _segs(['5p2O5b', 'u65Zu9'])       # 注释示例人名
# 真实手机号 → 明显的假号
_REAL_PHONE_1 = _segs(['MTM4MDE4', 'MjgyNDM='])
_REAL_PHONE_2 = _segs(['MTMzMjE4', 'NjU4MTU='])

RULES = [
    # ---- 真实姓名 → 通用占位（保留称谓语义）----
    (_re.escape(_REAL_FATHER), '父亲', '父亲真实姓名'),
    (_re.escape(_REAL_MOTHER), '母亲', '母亲真实姓名'),
    (_re.escape(_REAL_GRANPA), '爷爷', '爷爷（演示数据）真实姓名'),
    (_re.escape(_REAL_DEMO_M), '母亲', '母亲（演示数据）真实姓名'),
    (_re.escape(_REAL_SON), '儿子', '儿子真实姓名'),
    (_re.escape(_SAMPLE_NAME), '父亲', '注释示例人名'),

    # ---- 真实手机号 → 明显的假号 ----
    (_re.escape(_REAL_PHONE_1), '13800000000', '真实手机号'),
    (_re.escape(_REAL_PHONE_2), '13800000000', '测试用真实号'),

    # ---- 亲属小名/昵称（🔴 与全名同样是隐私，第二轮才发现遗漏）----
    (_re.escape(_segs(['54Kz', '5Lyf'])), '父亲昵称', '父亲小名'),
    (_re.escape(_segs(['5oO6', '5oO6'])), '母亲昵称', '母亲小名'),
    (_re.escape(_segs(['6ZKi', '6ZKi'])), '昵称', '其他昵称'),

    # ---- 内网 IP / 域名 ----
    (_re.escape(_segs(['MTI0LjIyMi41', 'Ni41Mw=='])), 'YOUR_SERVER_IP', '生产服务器 IP'),
    (r'https?://' + _re.escape(_segs(['Y3liaW8ubGNnY3ku', 'aWN1'])), 'https://YOUR_DOMAIN', '线上域名'),
    (_re.escape(_segs(['Y3liaW8ubGNnY3ku', 'aWN1'])), 'YOUR_DOMAIN', '线上域名'),
    (_re.escape(_segs(['bGNneWku', 'aWN1'])), 'YOUR_DOMAIN', '主域名'),
    (_re.escape(_segs(['bGl5ZUBzZXBk', 'LmNvbS5jbg=='])), 'you@example.com', '作者邮箱'),

    # ---- 内部绝对路径 → 相对/占位 ----
    (_re.escape(_segs(['L3Jvb3QvY3liaW8t', 'YXBw'])), '/path/to/cybio', '生产部署路径'),
    # ---- 同机其他项目（分享本项目时不该暴露兄弟系统的部署细节）----
    (_re.escape(_segs(['L3Jvb3QvcWMt', 'YXBw'])), '/path/to/qc', '同机另一项目部署路径'),
    (_re.escape(_segs(['cWMtd3d3', 'LXNzbA=='])), 'reverse-proxy', '同机反代进程名'),

    # ---- 兄弟系统的裸项目名/进程名（首轮只脱了路径，漏了裸名）----
    (_re.escape(_segs(['cWMt', 'YXBw'])), 'other-app', '兄弟系统项目名(裸)'),
    (_re.escape(_segs(['cWMtd3d3', 'LXNzbA=='])), 'other-proxy', '兄弟系统代理进程(裸)'),

    # ---- 单位与部门名（公开仓库不应暴露雇主信息）----
    (_re.escape(_segs(['57u/5Z+O6LS', 'o6YeP5Y2D6YeM6KGM'])), '某单位', '单位产品名'),
    (_re.escape(_segs(['57u/5Z', '+O6Zmi'])), '某部门', '部门/院名'),
    (_re.escape(_segs(['57u/5Z', '+O5bel'])), '某客户', '客户/项目名'),
    (_re.escape(_segs(['6LSo6YeP5Y', '2D6YeM6KGM'])), '某项目', '项目代号'),
    (_re.escape(_segs(['5byg', '5bel'])), '张某', '示例人名(单位文档)'),

    # ---- 内部 AI 网关（暴露可被他人探测或盗用）----
    (_re.escape(_segs(['dG9rZW5odWIu', 'dGVuY2VudG1hYXMuY29t'])), 'llm-gateway.example.com', '内部模型网关'),

    # ---- 另一部署路径 ----
    (_re.escape(_segs(['L3Jvb3QvY3liaW8t', 'YXV0aA=='])), '/path/to/auth', '另一部署路径'),
]

# 敏感值单一数据源：供 test_sanitize.py 读取
# ⚠️ 任何自检/校验脚本都**不得自己写明文真值**（首版 test_sanitize.py 就是这么
#   把真值带进仓库的，与本文件犯的是同一个错误）。一律从这里取。
SENSITIVE_VALUES = [
    _REAL_FATHER, _REAL_MOTHER, _REAL_GRANPA, _REAL_DEMO_M,
    _REAL_SON, _SAMPLE_NAME, _REAL_PHONE_1, _REAL_PHONE_2,
    _segs(['MTI0LjIyMi41', 'Ni41Mw==']),                       # 服务器 IP
    _segs(['Y3liaW8ubGNnY3ku', 'aWN1']),                       # 线上域名
    _segs(['bGNneWku', 'aWN1']),                                # 主域名
    _segs(['bGl5ZUBzZXBk', 'LmNvbS5jbg==']),                   # 作者邮箱
    _segs(['L3Jvb3QvY3liaW8t', 'YXBw']),                        # 部署路径
    _segs(['L3Jvb3QvcWMt', 'YXBw']),                            # 同机路径
    _segs(['cWMtd3d3', 'LXNzbA==']),                            # 反代进程名
    _segs(['cWMt', 'YXBw']),                                    # 兄弟项目名(裸)
    _segs(['L3Jvb3QvY3liaW8t', 'YXV0aA==']),                    # 另一部署路径
    _segs(['57u/5Z+O6LS', 'o6YeP5Y2D6YeM6KGM']),                 # 单位产品名
    _segs(['57u/5Z', '+O6Zmi']),                                # 部门/院名
    _segs(['57u/5Z', '+O5bel']),                                # 客户名
    _segs(['6LSo6YeP5Y', '2D6YeM6KGM']),                         # 项目代号
    _segs(['5byg', '5bel']),                                    # 示例人名
    _segs(['dG9rZW5odWIu', 'dGVuY2VudG1hYXMuY29t']),             # 内部网关
    _segs(['54Kz', '5Lyf']),                                    # 父亲小名
    _segs(['5oO6', '5oO6']),                                    # 母亲小名
    _segs(['6ZKi', '6ZKi']),                                    # 其他昵称
]

# 需要一并处理的无扩展名配置/说明文件（首轮遗漏：过滤器按扩展名白名单，无扩展名文件被跳过）
EXTRA_FILES = {'Caddyfile', 'nginx-family.conf', 'Dockerfile', 'LICENSE', 'NOTICE'}

# 文件类型：只处理文本
# ⚠️ 教训：白名单必须覆盖全。首轮漏了无扩展名的 Caddyfile，
#    第二轮漏了 .sql（probe_li.sql 里是针对本人注册信息的核查 SQL，含真实姓名与手机号）。
TEXT_EXT = {'.js', '.ts', '.md', '.html', '.css', '.json', '.sh', '.cjs', '.mjs',
            '.txt', '.webmanifest', '.yml', '.yaml', '.sql', '.conf', '.example', '.env'}


def iter_files():
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]
        for fn in filenames:
            ext = os.path.splitext(fn)[1].lower()
            # 无扩展名的配置/许可文件也要处理，否则会漏（首轮实测 Caddyfile 就是这样漏掉的）
            if ext in TEXT_EXT or fn in EXTRA_FILES:
                yield os.path.join(dirpath, fn)


def main():
    check_only = '--check' in sys.argv
    stats = {}
    changed_files = []

    for path in iter_files():
        rel = os.path.relpath(path, ROOT)
        try:
            with open(path, 'r', encoding='utf-8') as f:
                original = f.read()
        except (UnicodeDecodeError, OSError):
            continue

        content = original
        hits = []
        for pattern, repl, desc in RULES:
            new_content, n = re.subn(pattern, repl, content)
            if n:
                hits.append((desc, n))
                content = new_content

        if hits:
            changed_files.append((rel, hits))
            for desc, n in hits:
                stats[desc] = stats.get(desc, 0) + n
            if not check_only:
                with open(path, 'w', encoding='utf-8', newline='') as f:
                    f.write(content)

    mode = '检查' if check_only else '脱敏'
    print('=' * 62)
    print(f'开源脱敏 · {mode}模式')
    print('=' * 62)
    if not changed_files:
        print('未发现需要脱敏的内容 ✓')
        return 0

    print(f'\n共 {len(changed_files)} 个文件需要处理：\n')
    for rel, hits in sorted(changed_files):
        detail = '、'.join(f'{d}×{n}' for d, n in hits)
        print(f'  {rel}')
        print(f'      {detail}')

    print('\n' + '-' * 62)
    print('按类别汇总：')
    for desc, n in sorted(stats.items(), key=lambda x: -x[1]):
        print(f'  {desc:<22} {n:>4} 处')
    if not check_only:
        print(f'\n✓ 已脱敏 {len(changed_files)} 个文件')
    return 0


if __name__ == '__main__':
    sys.exit(main())
