#!/usr/bin/env python3
"""飞书推送（共享层）：创建飞书文档 + 发送卡片消息到群聊。

所有推广渠道（snipe / reddit-snipe / promote）+ 自动编排器共用本脚本。
用法：
    python3 push_feishu.py --report-file /tmp/report.md --title "🎯 ..."
    echo "markdown" | python3 push_feishu.py --stdin
    python3 push_feishu.py --report-file batch.md --title "⏳ 即将发布" --card-only

环境变量（从项目 .env 自动加载）：
    FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_CHAT_ID

posture 用法约定（编排器负责组织 markdown 与标题，本脚本只负责投递）：
    batch  -> --title "⏳ 即将自动发布 N 条 · {veto_window}h 内回复 ABORT 取消" --card-only
    auto   -> --title "📣 已自动发布 N 条" --card-only
    报告   -> --report-file（默认走文档 + 卡片，权限不足自动降级为卡片）
"""

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime
from pathlib import Path

try:
    import requests
except ImportError:
    print("ERROR: 需要 requests 库。运行: pip3 install requests", file=sys.stderr)
    sys.exit(1)

FEISHU_BASE = "https://open.feishu.cn/open-apis"


def _load_env():
    """从项目根目录的 .env 文件加载环境变量（向上查找）。"""
    for parent in [Path(__file__).resolve().parent] + list(Path(__file__).resolve().parents):
        env_file = parent / ".env"
        if env_file.exists():
            with open(env_file) as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    key, _, value = line.partition("=")
                    key = key.strip()
                    if key:
                        os.environ[key] = value.strip()
            break


_token_cache = {"token": "", "expires_at": 0.0}


def _get_tenant_token(app_id: str, app_secret: str) -> str:
    now = time.time()
    if _token_cache["token"] and now < _token_cache["expires_at"]:
        return _token_cache["token"]
    resp = requests.post(
        f"{FEISHU_BASE}/auth/v3/tenant_access_token/internal",
        json={"app_id": app_id, "app_secret": app_secret}, timeout=10,
    )
    resp.raise_for_status()
    data = resp.json()
    if data.get("code") != 0:
        raise RuntimeError(f"飞书 token 获取失败: {data}")
    token = data["tenant_access_token"]
    _token_cache["token"] = token
    _token_cache["expires_at"] = now + data.get("expire", 7200) - 100
    return token


def _headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


# ── Markdown → 飞书 Blocks ────────────────────────────────────

def _parse_inline(text: str) -> list:
    elements = []
    pattern = re.compile(r"\*\*(.+?)\*\*|\[([^\]]+)\]\(([^)]+)\)")
    last = 0
    for m in pattern.finditer(text):
        if m.start() > last:
            plain = text[last:m.start()]
            if plain:
                elements.append({"text_run": {"content": plain, "text_element_style": {}}})
        if m.group(1) is not None:
            elements.append({"text_run": {"content": m.group(1), "text_element_style": {"bold": True}}})
        else:
            elements.append({"text_run": {"content": m.group(2),
                                          "text_element_style": {"link": {"url": m.group(3)}}}})
        last = m.end()
    if last < len(text):
        tail = text[last:]
        if tail:
            elements.append({"text_run": {"content": tail, "text_element_style": {}}})
    if not elements:
        elements.append({"text_run": {"content": text, "text_element_style": {}}})
    return elements


def _make_text_block(block_type: int, key: str, elements: list) -> dict:
    return {"block_type": block_type, key: {"elements": elements}}


def md_to_feishu_blocks(md: str) -> list:
    blocks = []
    lines = md.split("\n")
    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()
        if not stripped:
            i += 1
            continue
        if re.match(r"^-{3,}\s*$", stripped):
            blocks.append({"block_type": 22, "divider": {}}); i += 1; continue
        heading_match = re.match(r"^(#{1,3})\s+(.+)$", stripped)
        if heading_match:
            level = len(heading_match.group(1))
            type_map = {1: (3, "heading1"), 2: (4, "heading2"), 3: (5, "heading3")}
            bt, key = type_map[level]
            blocks.append(_make_text_block(bt, key, _parse_inline(heading_match.group(2))))
            i += 1; continue
        if stripped.startswith("> "):
            blocks.append(_make_text_block(2, "text", [
                {"text_run": {"content": "💬 " + stripped[2:], "text_element_style": {"italic": True}}}]))
            i += 1; continue
        bullet_match = re.match(r"^[-*]\s+(.+)$", stripped)
        if bullet_match:
            blocks.append(_make_text_block(12, "bullet", _parse_inline(bullet_match.group(1))))
            i += 1; continue
        ordered_match = re.match(r"^\d+[.)]\s+(.+)$", stripped)
        if ordered_match:
            blocks.append(_make_text_block(13, "ordered", _parse_inline(ordered_match.group(1))))
            i += 1; continue
        para_lines = [stripped]; i += 1
        while i < len(lines):
            next_stripped = lines[i].strip()
            if not next_stripped:
                break
            if re.match(r"^(#{1,3}\s|[-*]\s|\d+[.)]\s|-{3,}|>)", next_stripped):
                break
            para_lines.append(next_stripped); i += 1
        blocks.append(_make_text_block(2, "text", _parse_inline("\n".join(para_lines))))
    return blocks


# ── 飞书 API ────────────────────────────────────

def _create_document(token: str, title: str) -> tuple:
    resp = requests.post(f"{FEISHU_BASE}/docx/v1/documents",
                         headers=_headers(token), json={"title": title}, timeout=15)
    if not resp.ok:
        raise RuntimeError(f"创建文档失败 HTTP {resp.status_code}: {resp.text}")
    data = resp.json()
    if data.get("code") != 0:
        raise RuntimeError(f"创建文档失败: {data}")
    doc_id = data["data"]["document"]["document_id"]
    return doc_id, f"https://feishu.cn/docx/{doc_id}"


def _write_blocks(token: str, doc_id: str, blocks: list) -> None:
    for start in range(0, len(blocks), 50):
        batch = blocks[start:start + 50]
        resp = requests.post(
            f"{FEISHU_BASE}/docx/v1/documents/{doc_id}/blocks/{doc_id}/children?document_revision_id=-1",
            headers=_headers(token),
            json={"children": batch, "index": 0 if start == 0 else -1}, timeout=30)
        resp.raise_for_status()
        if resp.json().get("code") != 0:
            raise RuntimeError(f"写入 block 失败: {resp.json()}")


def _send_card_message(token, receive_id, title, summary, doc_url="", template="blue"):
    elements = [{"tag": "div", "text": {"tag": "lark_md", "content": summary}}]
    if doc_url:
        elements.append({"tag": "hr"})
        elements.append({"tag": "action", "actions": [
            {"tag": "button", "text": {"tag": "plain_text", "content": "打开文档"},
             "type": "primary", "url": doc_url}]})
    card = {"config": {"wide_screen_mode": True},
            "header": {"title": {"tag": "plain_text", "content": title}, "template": template},
            "elements": elements}
    resp = requests.post(
        f"{FEISHU_BASE}/im/v1/messages?receive_id_type=chat_id", headers=_headers(token),
        json={"receive_id": receive_id, "msg_type": "interactive", "content": json.dumps(card)},
        timeout=15)
    data = resp.json()
    if not resp.ok or data.get("code") != 0:
        raise RuntimeError(f"发送消息失败 HTTP {resp.status_code}: {data}")


def _md_to_lark_md(report_md: str, max_len: int = 4000) -> str:
    lines = []
    for line in report_md.split("\n"):
        stripped = line.strip()
        if not stripped:
            lines.append(""); continue
        if stripped.startswith("# "):
            lines.append(f"**{stripped[2:]}**")
        elif stripped.startswith("## "):
            lines.append(f"**{stripped[3:]}**")
        elif stripped.startswith("### "):
            lines.append(f"**{stripped[4:]}**")
        elif stripped.startswith("---"):
            lines.append("─" * 20)
        elif stripped.startswith("> "):
            lines.append(stripped[2:])
        else:
            lines.append(stripped)
    result = "\n".join(lines)
    if len(result) > max_len:
        result = result[:max_len - 20] + "\n\n…（内容过长已截断）"
    return result


def push_report(report_md: str, title_prefix: str = "🎯 推广候选",
                card_only: bool = False, template: str = "blue") -> str:
    app_id = os.getenv("FEISHU_APP_ID", "")
    app_secret = os.getenv("FEISHU_APP_SECRET", "")
    chat_id = os.getenv("FEISHU_CHAT_ID", "")
    if not app_id or not app_secret:
        return "SKIP: 缺少 FEISHU_APP_ID 或 FEISHU_APP_SECRET"
    if not chat_id:
        return "SKIP: 缺少 FEISHU_CHAT_ID"

    now = datetime.now().strftime("%Y-%m-%d %H:%M")
    title = f"{title_prefix}（{now}）"
    try:
        token = _get_tenant_token(app_id, app_secret)
        if card_only:
            _send_card_message(token, chat_id, title, _md_to_lark_md(report_md), template=template)
            return "OK: 已发送卡片消息（card-only）"
        try:
            doc_id, doc_url = _create_document(token, title)
            blocks = md_to_feishu_blocks(report_md)
            if blocks:
                _write_blocks(token, doc_id, blocks)
            summary = "\n".join([l.strip() for l in report_md.split("\n") if l.strip()][:5])
            _send_card_message(token, chat_id, title, summary, doc_url, template)
            return f"OK: 文档已创建并推送通知 → {doc_url}"
        except Exception as doc_err:
            es = str(doc_err)
            if "99991672" in es or "scope" in es.lower() or "permission" in es.lower():
                pass
            else:
                raise
        _send_card_message(token, chat_id, title, _md_to_lark_md(report_md), template=template)
        return "OK: 已通过卡片消息推送报告（文档权限不足，降级为卡片模式）"
    except Exception as e:
        return f"ERROR: {e}"


def main():
    parser = argparse.ArgumentParser(description="推送推广报告/卡片到飞书")
    parser.add_argument("--report-file", help="Markdown 报告文件路径")
    parser.add_argument("--stdin", action="store_true", help="从 stdin 读取报告")
    parser.add_argument("--title", default="🎯 推广候选", help="标题前缀（自动追加时间戳）")
    parser.add_argument("--card-only", action="store_true", help="只发卡片，跳过文档创建（batch/auto 通知用）")
    parser.add_argument("--template", default="blue", help="卡片色：blue/red/orange/green …")
    args = parser.parse_args()

    _load_env()
    if args.report_file:
        report_md = Path(args.report_file).read_text()
    elif args.stdin:
        report_md = sys.stdin.read()
    else:
        parser.print_help(); sys.exit(1)
    if not report_md.strip():
        print("ERROR: 报告内容为空", file=sys.stderr); sys.exit(1)

    result = push_report(report_md, title_prefix=args.title,
                         card_only=args.card_only, template=args.template)
    print(result)
    if result.startswith("ERROR"):
        sys.exit(1)


if __name__ == "__main__":
    main()
