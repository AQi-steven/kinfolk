#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
脱敏规则自检（sanitize.py 配套）

为什么需要它：脱敏规则全部以 Base64 存储，**改错一个字符会导致脱敏静默失效**，
真名直接泄露，而且不会有任何报错。所以规则表必须能独立验证。

用法：
    python3 test_sanitize.py           # 验证规则表
    python3 test_sanitize.py --scan    # 顺带扫描全仓库残留
"""
import base64
import importlib.util
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))


def load():
    spec = importlib.util.spec_from_file_location('san', os.path.join(ROOT, 'sanitize.py'))
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def main():
    scan = '--scan' in sys.argv
    m = load()

    # 🔴 自检脚本**绝不能自己写明文真值**（首版就是这么把真值带进仓库的，
    #   与 sanitize.py 犯的是同一个错误）。所有目标一律从 sanitize.py 的 Base64 规则读取。
    #   sanitize.py 中不可 Base64 化的目标（如裸 IP）也改为在那里统一导出。
    targets = list(m.SENSITIVE_VALUES)

    print('=' * 64)
    print('脱敏规则自检')
    print('=' * 64)

    # --- 1) Base64 还原必须与真值一致 ---
    print('\n[1] Base64 还原值一致性')
    ok = True
    encoded = {
        '父亲': m._REAL_FATHER, '母亲': m._REAL_MOTHER, '爷爷': m._REAL_GRANPA,
        '演示母名': m._REAL_DEMO_M, '儿子': m._REAL_SON, '示例名': m._SAMPLE_NAME,
        '手机1': m._REAL_PHONE_1, '手机2': m._REAL_PHONE_2,
    }
    for label, val in encoded.items():
        # 真值长度应为 3（中文）或 11（手机号），且非空
        good = bool(val) and len(val) in (3, 11)
        if not good:
            ok = False
        print(f'  {"PASS" if good else "FAIL"}  {label} 长度 {len(val)}')
    print()

    # --- 2) 端到端：所有目标必须被清除 ---
    print('[2] 端到端替换（所有敏感值必须被清除）')
    sample = ' '.join(targets)
    out = sample
    for pat, repl, desc in m.RULES:
        out = re.sub(pat, repl, out)
    leaks = [t for t in targets if t and t in out]
    if leaks:
        print(f'  FAIL  残留 {len(leaks)} 项: {leaks}')
        ok = False
    else:
        print(f'  PASS  {len(targets)} 项敏感值全部清除')
    print()

    # --- 3) 可选：扫描全仓库 ---
    if scan:
        print('[3] 全仓库残留扫描')
        files = subprocess.run(['git', 'ls-files'], capture_output=True,
                               text=True, cwd=ROOT).stdout.split('\n')
        found = 0
        for label, val in encoded.items():
            hits = []
            for f in files:
                if not f.strip():
                    continue
                try:
                    with open(os.path.join(ROOT, f), encoding='utf-8',
                              errors='ignore') as fh:
                        if val in fh.read():
                            hits.append(f)
                except OSError:
                    continue
            if hits:
                print(f'  FAIL  {label} 出现在: {hits[:3]}')
                found += 1
            else:
                print(f'  PASS  {label} 无残留')
        # 非 Base64 的目标直接扫（同样从单一数据源取，不写明文）
        for t in m.SENSITIVE_VALUES:
            hits = []
            for f in files:
                if not f.strip():
                    continue
                try:
                    with open(os.path.join(ROOT, f), encoding='utf-8',
                              errors='ignore') as fh:
                        if t in fh.read():
                            hits.append(f)
                except OSError:
                    continue
            if hits:
                print(f'  FAIL  {t} 出现在: {hits[:3]}')
                found += 1
        if found:
            ok = False
            print(f'\n  ⚠ 发现 {found} 项残留')
        else:
            print('\n  PASS  全仓库无残留')
        print()

    print('=' * 64)
    print('结论:', '规则表可用' if ok else '规则表有问题，必须修正')
    print('=' * 64)
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
